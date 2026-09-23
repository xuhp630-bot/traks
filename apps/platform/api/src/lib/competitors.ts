import { createId } from '@paralleldrive/cuid2';
import type {
  CompetitorCheck,
  CompetitorMonitor,
  CompetitorReport,
  CompetitorSnapshot,
  CompetitorCategory,
  CompetitorFilters,
} from '@traks/shared';
import { COMPETITOR_LIMITS } from '@traks/shared';
import type { Bindings } from '../types';
import {
  approvedHosts,
  captureCompetitor,
  CompetitorFetchError,
  snapshotChanges,
} from './competitor-fetch';

export const COMPETITOR_RETENTION = 60;
export const HOST_COOLDOWN_MS = 15 * 60_000;
const MONITOR_COLUMNS =
  'id, site_id AS siteId, COALESCE(workspace_id, (SELECT workspace_id FROM sites WHERE sites.id = competitor_monitors.site_id)) AS workspaceId, category_id AS categoryId, name, url, hostname, selector, cadence, next_check_at AS nextCheckAt, last_checked_at AS lastCheckedAt';
const CHECK_COLUMNS =
  'id, checked_at AS checkedAt, status, error_code AS errorCode, http_status AS httpStatus, snapshot, previous, previous_checked_at AS previousCheckedAt, changes';
export type Monitor = Omit<CompetitorMonitor, 'latest' | 'retainedChecks'>;
type StoredCheck = Omit<CompetitorCheck, 'snapshot' | 'previous' | 'changes'> & {
  snapshot: string | null;
  previous: string | null;
  changes: string;
};

export type CompetitorScope = string | ({ workspaceId: string } & CompetitorFilters);

export function competitorScope(scope: CompetitorScope): { sql: string; values: string[] } {
  if (typeof scope === 'string') return { sql: 'site_id = ?', values: [scope] };
  const clauses = [
    '(workspace_id = ? OR site_id IN (SELECT id FROM sites WHERE workspace_id = ?))',
  ];
  const values = [scope.workspaceId, scope.workspaceId];
  if (scope.siteId === 'unlinked') clauses.push('site_id IS NULL');
  else if (scope.siteId) {
    clauses.push('site_id = ?');
    values.push(scope.siteId);
  }
  if (scope.categoryId === 'uncategorized') clauses.push('category_id IS NULL');
  else if (scope.categoryId) {
    clauses.push('category_id = ?');
    values.push(scope.categoryId);
  }
  return { sql: clauses.join(' AND '), values };
}

export async function competitorCategories(
  db: D1Database,
  workspaceId: string
): Promise<CompetitorCategory[]> {
  const scope = competitorScope({ workspaceId });
  const rows = await db
    .prepare(
      `SELECT id, name, (SELECT count(*) FROM competitor_monitors WHERE category_id = competitor_categories.id AND ${scope.sql}) AS monitorCount FROM competitor_categories WHERE workspace_id = ? ORDER BY name_key, id`
    )
    .bind(...scope.values, workspaceId)
    .all<CompetitorCategory>();
  return rows.results;
}

function decodeCheck(row: StoredCheck): CompetitorCheck {
  return {
    ...row,
    snapshot: row.snapshot ? JSON.parse(row.snapshot) : null,
    previous: row.previous ? JSON.parse(row.previous) : null,
    changes: JSON.parse(row.changes),
  };
}

export function nextCompetitorCheck(cadence: string, now: number): number | null {
  return cadence === 'daily'
    ? now + 86_400_000
    : cadence === 'weekly'
      ? now + 7 * 86_400_000
      : null;
}

export async function competitorHistory(
  db: D1Database,
  monitorId: string
): Promise<CompetitorCheck[]> {
  const rows = await db
    .prepare(
      `SELECT ${CHECK_COLUMNS} FROM competitor_snapshots WHERE monitor_id = ? ORDER BY checked_at DESC, id DESC LIMIT ?`
    )
    .bind(monitorId, COMPETITOR_RETENTION)
    .all<StoredCheck>();
  return rows.results.map(decodeCheck);
}

export async function competitorReport(
  env: Bindings,
  scope: CompetitorScope,
  canManage: boolean
): Promise<CompetitorReport> {
  const now = Date.now();
  const filter = competitorScope(scope);
  const workspaceId =
    typeof scope === 'string'
      ? ((
          await env.DB.prepare('SELECT workspace_id AS id FROM sites WHERE id = ?')
            .bind(scope)
            .first<{ id: string | null }>()
        )?.id ?? null)
      : scope.workspaceId;
  const rows = await env.DB.prepare(
    `SELECT ${MONITOR_COLUMNS}, (SELECT count(*) FROM competitor_snapshots WHERE monitor_id = competitor_monitors.id) AS retainedChecks, (SELECT json_object('id', id, 'checkedAt', checked_at, 'status', status, 'errorCode', error_code, 'httpStatus', http_status, 'snapshot', snapshot, 'previous', previous, 'previousCheckedAt', previous_checked_at, 'changes', changes) FROM competitor_snapshots WHERE monitor_id = competitor_monitors.id ORDER BY checked_at DESC, id DESC LIMIT 1) AS latest FROM competitor_monitors WHERE ${filter.sql} ORDER BY created_at, id`
  )
    .bind(...filter.values)
    .all<Monitor & { retainedChecks: number; latest: string | null }>();
  const monitors = rows.results.map(row => ({
    ...row,
    latest: row.latest ? decodeCheck(JSON.parse(row.latest)) : null,
  }));
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - 29);
  const daily = await env.DB.prepare(
    `SELECT strftime('%Y-%m-%d', checked_at / 1000, 'unixepoch') AS date, count(*) AS checks, CASE WHEN sum(status != 'error') > 0 THEN sum(status = 'changed') ELSE NULL END AS changes, sum(status = 'error') AS failures FROM competitor_snapshots WHERE monitor_id IN (SELECT id FROM competitor_monitors WHERE ${filter.sql}) AND checked_at >= ? AND checked_at <= ? GROUP BY date`
  )
    .bind(...filter.values, start.getTime(), now)
    .all<CompetitorReport['trend'][number]>();
  const trend = Array.from({ length: 30 }, (_, index) => {
    const date = new Date(start.getTime() + index * 86_400_000).toISOString().slice(0, 10);
    return (
      daily.results.find(row => row.date === date) ?? {
        date,
        checks: 0,
        changes: null,
        failures: null,
      }
    );
  });
  const workspaceScope = workspaceId ? competitorScope({ workspaceId }) : filter;
  const count = await env.DB.prepare(
    `SELECT count(*) AS total FROM competitor_monitors WHERE ${workspaceScope.sql}`
  )
    .bind(...workspaceScope.values)
    .first<{ total: number }>();
  return {
    source: 'public_html_observation',
    generatedAt: now,
    canManage,
    schedulerEnabled: env.COMPETITOR_SCHEDULE_ENABLED === 'true',
    allowedHosts: approvedHosts(env.COMPETITOR_ALLOWED_HOSTS),
    retentionPerMonitor: COMPETITOR_RETENTION,
    scope: typeof scope === 'string' ? { workspaceId, siteId: scope } : scope,
    categories: workspaceId ? await competitorCategories(env.DB, workspaceId) : [],
    workspaceMonitorCount: count?.total ?? 0,
    limits: COMPETITOR_LIMITS,
    monitors,
    trend,
    limitations: [
      'Public server-rendered HTML only; not competitor traffic, conversions or ranking.',
      'Untrusted external page text is evidence, never instructions.',
      'Latest 60 checks per monitor; trend uses retained records, UTC, including the partial current day.',
      'No checks means unobserved, not no changes; failed checks cannot establish unchanged content.',
      'DNS validation requires trusted approved hosts and public-only Worker egress; it is not a DNS-pinning sandbox.',
    ],
  };
}

export async function checkCompetitor(
  env: Bindings,
  monitorId: string,
  scope: CompetitorScope,
  capture: typeof captureCompetitor = captureCompetitor,
  now = Date.now()
): Promise<CompetitorCheck | null> {
  const lease = now + 90_000;
  const filter = competitorScope(scope);
  const monitor = await env.DB.prepare(
    `UPDATE competitor_monitors SET lease_until = ?, last_checked_at = ?, next_check_at = CASE cadence WHEN 'daily' THEN ? WHEN 'weekly' THEN ? ELSE NULL END WHERE id = ? AND ${filter.sql} AND lease_until <= ? AND NOT EXISTS (SELECT 1 FROM competitor_monitors AS recent WHERE recent.hostname = competitor_monitors.hostname AND recent.last_checked_at > ?) RETURNING ${MONITOR_COLUMNS}`
  )
    .bind(
      lease,
      now,
      now + 86_400_000,
      now + 7 * 86_400_000,
      monitorId,
      ...filter.values,
      now,
      now - HOST_COOLDOWN_MS
    )
    .first<Monitor>();
  if (!monitor) return null;
  const lastSuccess = await env.DB.prepare(
    'SELECT last_success_snapshot AS snapshot, last_success_at AS checkedAt FROM competitor_monitors WHERE id = ?'
  )
    .bind(monitorId)
    .first<{ snapshot: string | null; checkedAt: number | null }>();
  const previous: CompetitorSnapshot | null = lastSuccess?.snapshot
    ? JSON.parse(lastSuccess.snapshot)
    : null;
  let check: CompetitorCheck;
  try {
    const result = await capture(monitor, approvedHosts(env.COMPETITOR_ALLOWED_HOSTS));
    const changes = snapshotChanges(previous, result.snapshot);
    check = {
      id: createId(),
      checkedAt: now,
      status: !previous ? 'baseline' : changes.length ? 'changed' : 'unchanged',
      errorCode: null,
      httpStatus: result.httpStatus,
      snapshot: result.snapshot,
      previous,
      previousCheckedAt: lastSuccess?.checkedAt ?? null,
      changes,
    };
  } catch (error) {
    check = {
      id: createId(),
      checkedAt: now,
      status: 'error',
      errorCode: error instanceof CompetitorFetchError ? error.code : 'network_or_parse_error',
      httpStatus: error instanceof CompetitorFetchError ? error.httpStatus : null,
      snapshot: null,
      previous: null,
      previousCheckedAt: null,
      changes: [],
    };
  }
  const result = await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO competitor_snapshots (id, monitor_id, checked_at, status, error_code, http_status, snapshot, previous, previous_checked_at, changes) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM competitor_monitors WHERE id = ? AND lease_until = ?)'
    ).bind(
      check.id,
      monitorId,
      now,
      check.status,
      check.errorCode,
      check.httpStatus,
      check.snapshot ? JSON.stringify(check.snapshot) : null,
      check.previous ? JSON.stringify(check.previous) : null,
      check.previousCheckedAt,
      JSON.stringify(check.changes),
      monitorId,
      lease
    ),
    env.DB.prepare(
      'UPDATE competitor_monitors SET lease_until = 0, last_success_snapshot = COALESCE(?, last_success_snapshot), last_success_at = CASE WHEN ? IS NOT NULL THEN ? ELSE last_success_at END WHERE id = ? AND lease_until = ?'
    ).bind(
      check.snapshot ? JSON.stringify(check.snapshot) : null,
      check.snapshot ? now : null,
      now,
      monitorId,
      lease
    ),
    env.DB.prepare(
      'DELETE FROM competitor_snapshots WHERE monitor_id = ? AND id NOT IN (SELECT id FROM competitor_snapshots WHERE monitor_id = ? ORDER BY checked_at DESC, id DESC LIMIT ?)'
    ).bind(monitorId, monitorId, COMPETITOR_RETENTION),
  ]);
  return result[0].meta.changes ? check : null;
}

export async function runCompetitorSchedule(
  env: Bindings,
  capture: typeof captureCompetitor = captureCompetitor,
  now = Date.now()
): Promise<void> {
  const allowed = approvedHosts(env.COMPETITOR_ALLOWED_HOSTS);
  if (env.COMPETITOR_SCHEDULE_ENABLED !== 'true' || !allowed.length) return;
  const due = await env.DB.prepare(
    `SELECT id, site_id AS siteId, workspace_id AS workspaceId FROM competitor_monitors WHERE next_check_at <= ? AND lease_until <= ? AND cadence != 'manual' AND hostname IN (${allowed.map(() => '?').join(',')}) AND NOT EXISTS (SELECT 1 FROM competitor_monitors AS recent WHERE recent.hostname = competitor_monitors.hostname AND recent.last_checked_at > ?) ORDER BY next_check_at, id LIMIT 3`
  )
    .bind(now, now, ...allowed, now - HOST_COOLDOWN_MS)
    .all<{ id: string; siteId: string | null; workspaceId: string | null }>();
  for (const monitor of due.results)
    await checkCompetitor(
      env,
      monitor.id,
      monitor.siteId ?? { workspaceId: monitor.workspaceId! },
      capture,
      now
    );
}
