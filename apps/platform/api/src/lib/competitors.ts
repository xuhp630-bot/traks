import { createId } from '@paralleldrive/cuid2';
import type {
  CompetitorCheck,
  CompetitorMonitor,
  CompetitorReport,
  CompetitorSnapshot,
} from '@traks/shared';
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
  'id, name, url, hostname, selector, cadence, next_check_at AS nextCheckAt, last_checked_at AS lastCheckedAt';
const CHECK_COLUMNS =
  'id, checked_at AS checkedAt, status, error_code AS errorCode, http_status AS httpStatus, snapshot, previous, previous_checked_at AS previousCheckedAt, changes';
export type Monitor = Omit<CompetitorMonitor, 'latest' | 'retainedChecks'>;
type StoredCheck = Omit<CompetitorCheck, 'snapshot' | 'previous' | 'changes'> & {
  snapshot: string | null;
  previous: string | null;
  changes: string;
};

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
  siteId: string,
  canManage: boolean
): Promise<CompetitorReport> {
  const now = Date.now();
  const rows = await env.DB.prepare(
    `SELECT ${MONITOR_COLUMNS} FROM competitor_monitors WHERE site_id = ? ORDER BY created_at, id`
  )
    .bind(siteId)
    .all<Monitor>();
  const monitors = await Promise.all(
    rows.results.map(async row => {
      const history = await competitorHistory(env.DB, row.id);
      return { ...row, latest: history[0] ?? null, retainedChecks: history.length };
    })
  );
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - 29);
  const daily = await env.DB.prepare(
    `SELECT strftime('%Y-%m-%d', checked_at / 1000, 'unixepoch') AS date, count(*) AS checks, CASE WHEN sum(status != 'error') > 0 THEN sum(status = 'changed') ELSE NULL END AS changes, sum(status = 'error') AS failures FROM competitor_snapshots WHERE monitor_id IN (SELECT id FROM competitor_monitors WHERE site_id = ?) AND checked_at >= ? AND checked_at <= ? GROUP BY date`
  )
    .bind(siteId, start.getTime(), now)
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
  return {
    source: 'public_html_observation',
    generatedAt: now,
    canManage,
    schedulerEnabled: env.COMPETITOR_SCHEDULE_ENABLED === 'true',
    allowedHosts: approvedHosts(env.COMPETITOR_ALLOWED_HOSTS),
    retentionPerMonitor: COMPETITOR_RETENTION,
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
  siteId: string,
  capture: typeof captureCompetitor = captureCompetitor,
  now = Date.now()
): Promise<CompetitorCheck | null> {
  const lease = now + 90_000;
  const monitor = await env.DB.prepare(
    `UPDATE competitor_monitors SET lease_until = ?, last_checked_at = ?, next_check_at = CASE cadence WHEN 'daily' THEN ? WHEN 'weekly' THEN ? ELSE NULL END WHERE id = ? AND site_id = ? AND lease_until <= ? AND NOT EXISTS (SELECT 1 FROM competitor_monitors AS recent WHERE recent.hostname = competitor_monitors.hostname AND recent.last_checked_at > ?) RETURNING ${MONITOR_COLUMNS}`
  )
    .bind(
      lease,
      now,
      now + 86_400_000,
      now + 7 * 86_400_000,
      monitorId,
      siteId,
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
    `SELECT id, site_id AS siteId FROM competitor_monitors WHERE next_check_at <= ? AND lease_until <= ? AND cadence != 'manual' AND hostname IN (${allowed.map(() => '?').join(',')}) AND NOT EXISTS (SELECT 1 FROM competitor_monitors AS recent WHERE recent.hostname = competitor_monitors.hostname AND recent.last_checked_at > ?) ORDER BY next_check_at, id LIMIT 3`
  )
    .bind(now, now, ...allowed, now - HOST_COOLDOWN_MS)
    .all<{ id: string; siteId: string }>();
  for (const monitor of due.results)
    await checkCompetitor(env, monitor.id, monitor.siteId, capture, now);
}
