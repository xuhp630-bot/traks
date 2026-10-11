import { z } from 'zod';

/** Internal safety bounds, not claims about provider export limits. */
export const AI_VISIBILITY_MAX_BYTES = 524_288;
export const AI_VISIBILITY_MAX_PAGE_ROWS = 5000;
export const AI_VISIBILITY_MAX_DATE_ROWS = 600;
/** A page bound, never a total-history/write quota in eventually-consistent KV. */
export const AI_VISIBILITY_PAGE_SIZE = 16;
export const AI_VISIBILITY_QUERY_KEY = 'site-ai-visibility';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a source calendar date')
  .refine(value => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, 'Invalid source calendar date');

export const aiVisibilityInputSchema = z
  .object({
    format: z.literal('ai-visibility-snapshot/v1'),
    provider: z.enum(['google_search_ai', 'bing_ai_surfaces']),
    connectionMode: z.literal('manual_snapshot'),
    sourceRef: z.enum(['google_search_console_ai_report', 'bing_webmaster_ai_performance']),
    property: z.string().min(1).max(512),
    capturedAt: z.string().datetime({ offset: true }).nullable(),
    window: z
      .object({
        startDate: date,
        endDate: date,
        timezone: z.enum(['America/Los_Angeles', 'UTC', 'provider_unspecified']),
        completeThrough: date.nullable(),
        dataState: z.enum(['final', 'preliminary', 'unknown']),
      })
      .strict(),
    total: z
      .object({
        metric: z.enum(['impressions', 'citations']),
        value: count.nullable(),
        aggregation: z.literal('property'),
      })
      .strict(),
    pageRows: z
      .array(z.object({ page: z.string().url().max(2048), value: count.nullable() }).strict())
      .max(AI_VISIBILITY_MAX_PAGE_ROWS),
    dateRows: z
      .array(z.object({ date, value: count.nullable() }).strict())
      .max(AI_VISIBILITY_MAX_DATE_ROWS),
    coverage: z
      .object({
        availableExportComplete: z.boolean(),
        platformAllRowsKnown: z.literal(false),
        uiPageRows: count.nullable(),
        uiDateRows: count.nullable(),
        exportedPageRows: count,
        exportedDateRows: count,
        platformRowLimit: count.nullable(),
        nullsExportedAsZero: z.boolean(),
      })
      .strict(),
    sourceArchiveSha256: z.string().regex(/^[a-f0-9]{64}$/, 'Expected a source archive SHA-256'),
  })
  .strict()
  .superRefine((input, context) => {
    const problem = (message: string) => context.addIssue({ code: z.ZodIssueCode.custom, message });
    const google = input.provider === 'google_search_ai';
    if (
      input.sourceRef !==
        (google ? 'google_search_console_ai_report' : 'bing_webmaster_ai_performance') ||
      input.total.metric !== (google ? 'impressions' : 'citations') ||
      (google && input.window.timezone !== 'America/Los_Angeles')
    )
      problem('Provider, official source, metric and timezone must agree');
    if (
      input.window.startDate > input.window.endDate ||
      (input.window.completeThrough !== null &&
        (input.window.completeThrough < input.window.startDate ||
          input.window.completeThrough > input.window.endDate)) ||
      input.dateRows.some(
        row => row.date < input.window.startDate || row.date > input.window.endDate
      )
    )
      problem('Source dates must be inside the declared report window');
    if (
      input.coverage.exportedPageRows !== input.pageRows.length ||
      input.coverage.exportedDateRows !== input.dateRows.length ||
      (input.coverage.uiPageRows !== null && input.coverage.uiPageRows < input.pageRows.length) ||
      (input.coverage.uiDateRows !== null && input.coverage.uiDateRows < input.dateRows.length) ||
      (input.coverage.availableExportComplete &&
        ((input.coverage.uiPageRows !== null &&
          input.coverage.uiPageRows !== input.pageRows.length) ||
          (input.coverage.uiDateRows !== null &&
            input.coverage.uiDateRows !== input.dateRows.length)))
    )
      problem('Declared row coverage must match the retained export rows');
    if (
      new Set(input.pageRows.map(row => row.page)).size !== input.pageRows.length ||
      new Set(input.dateRows.map(row => row.date)).size !== input.dateRows.length
    )
      problem('Duplicate export rows are not accepted');
  });

export type AiVisibilityInput = z.infer<typeof aiVisibilityInputSchema>;
export type AiVisibilitySnapshot = AiVisibilityInput & {
  snapshotId: string;
  siteId: string;
  origin: string;
};
export interface AiVisibilityReport {
  format: 'ai-visibility-report/v2';
  connectionMode: 'manual_snapshot';
  continuousConnection: 'not_connected';
  status: 'not_connected' | 'snapshots_available' | 'history_page_empty';
  canManage: boolean;
  readAt: string;
  snapshots: AiVisibilitySnapshot[];
  coverage: {
    pageComplete: true;
    /** Available directory enumeration only; not a frozen, strongly-consistent history. */
    historyComplete: boolean;
    snapshotCount: number;
    pageSize: typeof AI_VISIBILITY_PAGE_SIZE;
    hasMore: boolean;
    nextCursor: string | null;
    consistency: 'eventually_consistent';
    visibilityDelaySeconds: 60;
  };
}
export interface AiVisibilitySnapshotRead {
  format: 'ai-visibility-snapshot-read/v1';
  connectionMode: 'manual_snapshot';
  continuousConnection: 'not_connected';
  readAt: string;
  snapshot: AiVisibilitySnapshot;
}
export interface AiVisibilityImportResult {
  status: 'stored_pending_readback';
  snapshot: AiVisibilitySnapshot;
  /** Request acceptance time, not a mutable first-import timestamp in KV. */
  acceptedAt: string;
  /** True only when this request actually read an existing identical record. */
  alreadyObserved: boolean;
}

const snapshotSchema = z
  .object({
    snapshotId: z.string().regex(/^[a-f0-9]{64}$/),
    siteId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
    origin: z.string().url(),
  })
  .passthrough()
  .transform((value, context): AiVisibilitySnapshot => {
    const { snapshotId, siteId, origin, ...input } = value;
    const parsed = aiVisibilityInputSchema.safeParse(input);
    if (!parsed.success) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid snapshot payload' });
      return z.NEVER;
    }
    return { ...parsed.data, snapshotId, siteId, origin };
  });

export const aiVisibilityReportSchema = z
  .object({
    format: z.literal('ai-visibility-report/v2'),
    connectionMode: z.literal('manual_snapshot'),
    continuousConnection: z.literal('not_connected'),
    status: z.enum(['not_connected', 'snapshots_available', 'history_page_empty']),
    canManage: z.boolean(),
    readAt: z.string().datetime(),
    snapshots: z.array(snapshotSchema).max(AI_VISIBILITY_PAGE_SIZE),
    coverage: z
      .object({
        pageComplete: z.literal(true),
        historyComplete: z.boolean(),
        snapshotCount: count,
        pageSize: z.literal(AI_VISIBILITY_PAGE_SIZE),
        hasMore: z.boolean(),
        nextCursor: z.string().min(1).max(8192).nullable(),
        consistency: z.literal('eventually_consistent'),
        visibilityDelaySeconds: z.literal(60),
      })
      .strict(),
  })
  .strict()
  .superRefine((report, context) => {
    if (
      report.coverage.snapshotCount !== report.snapshots.length ||
      report.coverage.hasMore !== (report.coverage.nextCursor !== null) ||
      (report.coverage.historyComplete && report.coverage.hasMore) ||
      (report.status === 'snapshots_available') !== report.snapshots.length > 0
    )
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid snapshot page coverage' });
  });

export const aiVisibilitySnapshotReadSchema = z
  .object({
    format: z.literal('ai-visibility-snapshot-read/v1'),
    connectionMode: z.literal('manual_snapshot'),
    continuousConnection: z.literal('not_connected'),
    readAt: z.string().datetime(),
    snapshot: snapshotSchema,
  })
  .strict();

/** Missing rows or an unknown cell are not zero and not a complete source total. */
export function aiVisibilityRowSum(rows: readonly { value: number | null }[]): number | null {
  if (!rows.length || rows.some(row => row.value === null)) return null;
  const sum = rows.reduce((total, row) => total + (row.value ?? 0), 0);
  return Number.isSafeInteger(sum) ? sum : null;
}

/** Stable ordering makes re-importing the same data independent of table sorting. */
export function canonicalAiVisibilityInput(input: AiVisibilityInput): string {
  const parsed = aiVisibilityInputSchema.parse(input);
  parsed.pageRows.sort((a, b) => (a.page < b.page ? -1 : a.page > b.page ? 1 : 0));
  parsed.dateRows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return JSON.stringify(parsed);
}
