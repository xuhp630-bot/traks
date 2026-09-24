import type {
  CompetitorPreResearchAction,
  CompetitorPreResearchDetail,
  CompetitorPreResearchFilters,
  CompetitorPreResearchReport,
  CompetitorPreResearchRun,
} from '@traks/shared';
import { COMPETITOR_LIMITS } from '@traks/shared';

type StoredRun = Omit<CompetitorPreResearchRun, 'seedKeywords'> & { seedKeywords: string };
type StoredAction = Omit<CompetitorPreResearchAction, 'references'> & { references: string };

const RUN_COLUMNS = `
  run.id,
  run.workspace_id AS workspaceId,
  run.source,
  run.source_job_id AS sourceJobId,
  run.source_job_url AS sourceJobUrl,
  run.source_version AS sourceVersion,
  run.title,
  run.current_query AS currentQuery,
  run.harvest_status AS harvestStatus,
  run.stage,
  run.seed_keywords AS seedKeywords,
  run.summary,
  run.source_thread_url AS sourceThreadUrl,
  run.created_at AS createdAt,
  run.updated_at AS updatedAt,
  COUNT(action.id) AS actionCount,
  MAX(action.occurred_at) AS latestActionAt
`;

function json<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function storedRun(run: StoredRun): CompetitorPreResearchRun {
  return {
    ...run,
    source: 'keyword_harvester',
    seedKeywords: json<string[]>(run.seedKeywords, []),
    actionCount: Number(run.actionCount),
    latestActionAt: run.latestActionAt === null ? null : Number(run.latestActionAt),
  };
}

export function keywordHarvesterJobId(sourceJobUrl: string): string {
  return new URL(sourceJobUrl).searchParams.get('job')!;
}

export async function preResearchRunExists(
  db: D1Database,
  workspaceId: string,
  runId: string
): Promise<boolean> {
  return Boolean(
    await db
      .prepare('SELECT id FROM competitor_pre_research_runs WHERE id = ? AND workspace_id = ?')
      .bind(runId, workspaceId)
      .first()
  );
}

export async function competitorPreResearchReport(
  db: D1Database,
  workspaceId: string,
  filters: CompetitorPreResearchFilters,
  canManage: boolean
): Promise<CompetitorPreResearchReport> {
  const clauses = ['run.workspace_id = ?'];
  const values = [workspaceId];
  if (filters.stage) {
    clauses.push('run.stage = ?');
    values.push(filters.stage);
  }
  const rows = await db
    .prepare(
      `SELECT ${RUN_COLUMNS} FROM competitor_pre_research_runs AS run LEFT JOIN competitor_pre_research_actions AS action ON action.run_id = run.id WHERE ${clauses.join(' AND ')} GROUP BY run.id ORDER BY run.updated_at DESC, run.id DESC`
    )
    .bind(...values)
    .all<StoredRun>();
  return {
    source: 'keyword_harvester_import',
    generatedAt: Date.now(),
    canManage,
    scope: { workspaceId, ...filters },
    limits: {
      preResearchRuns: COMPETITOR_LIMITS.preResearchRuns,
      preResearchActions: COMPETITOR_LIMITS.preResearchActions,
    },
    runs: rows.results.map(storedRun),
    limitations: [
      'The browser extension keeps its own local job storage; this archive records only data explicitly submitted through this workspace.',
      'No extension storage, browser session, Google result page, credential, or full competitor page is read by the service.',
      'A Codex task URL is a provenance reference only. Traks does not write to Codex tasks or create monitors automatically.',
    ],
  };
}

export async function competitorPreResearchDetail(
  db: D1Database,
  workspaceId: string,
  runId: string
): Promise<CompetitorPreResearchDetail | null> {
  const run = await db
    .prepare(
      `SELECT ${RUN_COLUMNS} FROM competitor_pre_research_runs AS run LEFT JOIN competitor_pre_research_actions AS action ON action.run_id = run.id WHERE run.id = ? AND run.workspace_id = ? GROUP BY run.id`
    )
    .bind(runId, workspaceId)
    .first<StoredRun>();
  if (!run) return null;
  const actions = await db
    .prepare(
      'SELECT id, kind, outcome, title, detail, "references", occurred_at AS occurredAt FROM competitor_pre_research_actions WHERE run_id = ? ORDER BY occurred_at, id'
    )
    .bind(runId)
    .all<StoredAction>();
  return {
    ...storedRun(run),
    actions: actions.results.map(action => ({
      ...action,
      references: json<string[]>(action.references, []),
    })),
  };
}
