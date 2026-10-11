import {
  AI_VISIBILITY_MAX_BYTES,
  AI_VISIBILITY_PAGE_SIZE,
  aiVisibilityInputSchema,
  canonicalAiVisibilityInput,
  type AiVisibilityInput,
  type AiVisibilityImportResult,
  type AiVisibilityReport,
  type AiVisibilitySnapshot,
  type AiVisibilitySnapshotRead,
} from '@traks/shared';
import { z } from 'zod';

type SiteBinding = { id: string; domain: string };
/** Narrow structural API also supports deterministic KV pagination/failure tests. */
export interface AiVisibilityStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<unknown>;
  list(options: { prefix: string; cursor?: string; limit: number }): Promise<{
    keys: { name: string }[];
    list_complete: boolean;
    cursor?: string;
  }>;
}

export class AiVisibilityStoreError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 413 | 502 | 503,
    message: string
  ) {
    super(message);
  }
}

const PREFIX = 'ai-visibility:v1:';
const READ_BUDGET_MS = 10_000;
const PROVIDERS = new Set(['google_search_ai', 'bing_ai_surfaces']);
const CURSOR_TTL_MS = 10 * 60_000;
const cursorSchema = z
  .object({
    protocol: z.literal('ai-visibility-history/v1'),
    siteId: z.string().max(80),
    origin: z.string().max(512),
    kvCursor: z.string().min(1).max(4096),
    issuedAt: z.number().int().nonnegative(),
  })
  .strict();

function decodeCursor(cursor: string | undefined, site: SiteBinding) {
  if (!cursor) return null;
  try {
    if (cursor.length > 8192 || !/^[a-zA-Z0-9_-]+$/.test(cursor)) throw new Error();
    const decoded = atob(cursor.replace(/-/g, '+').replace(/_/g, '/'));
    const value = cursorSchema.parse(JSON.parse(decoded));
    if (
      value.siteId !== site.id ||
      value.origin !== originFor(site) ||
      value.issuedAt > Date.now() + 60_000 ||
      Date.now() - value.issuedAt > CURSOR_TTL_MS
    )
      throw new Error();
    return value;
  } catch {
    throw new AiVisibilityStoreError(
      409,
      'History cursor is expired, incompatible or outside this site; restart page one'
    );
  }
}

function encodeCursor(site: SiteBinding, kvCursor: string, issuedAt: number): string {
  const value = cursorSchema.parse({
    protocol: 'ai-visibility-history/v1',
    siteId: site.id,
    origin: originFor(site),
    kvCursor,
    issuedAt,
  });
  return btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function originFor(site: SiteBinding): string {
  if (
    !/^[a-zA-Z0-9_-]{1,80}$/.test(site.id) ||
    !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(site.domain)
  )
    throw new AiVisibilityStoreError(409, 'The authorized site binding is not supported');
  return `https://${site.domain.toLowerCase()}`;
}

function validateBinding(input: AiVisibilityInput, site: SiteBinding): string {
  const origin = originFor(site);
  const fullProperty = `${origin}/`;
  if (
    input.property !== fullProperty &&
    input.property !== `sc-domain:${site.domain.toLowerCase()}`
  )
    throw new AiVisibilityStoreError(400, 'Report property must exactly match the authorized site');
  for (const row of input.pageRows) {
    const page = new URL(row.page);
    if (
      page.origin !== origin ||
      page.protocol !== 'https:' ||
      page.username ||
      page.password ||
      page.port ||
      page.search ||
      page.hash
    )
      throw new AiVisibilityStoreError(
        400,
        'Only clean canonical URLs from the authorized site are accepted'
      );
  }
  return origin;
}

function storeOrThrow(store: AiVisibilityStore | undefined): AiVisibilityStore {
  if (!store?.get || !store?.put || !store?.list)
    throw new AiVisibilityStoreError(503, 'AI visibility snapshot storage is unavailable');
  return store;
}

async function bounded<T>(operation: Promise<T>, deadline: number): Promise<T> {
  const remaining = Math.min(4000, deadline - Date.now());
  if (remaining <= 0)
    throw new AiVisibilityStoreError(503, 'Snapshot reading exceeded its bounded time window');
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new AiVisibilityStoreError(503, 'Snapshot storage is pending or unavailable; retry')
            ),
          remaining
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function hash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function keysPage(
  store: AiVisibilityStore,
  site: SiteBinding,
  deadline: number,
  cursor?: string
): Promise<{ keys: string[]; nextCursor: string | null; historyComplete: boolean }> {
  originFor(site);
  const prefix = `${PREFIX}${site.id}:`;
  const state = decodeCursor(cursor, site);
  const result = await bounded(
    store.list({
      prefix,
      cursor: state?.kvCursor,
      limit: AI_VISIBILITY_PAGE_SIZE,
    }),
    deadline
  );
  if (
    !Array.isArray(result.keys) ||
    typeof result.list_complete !== 'boolean' ||
    result.keys.length > AI_VISIBILITY_PAGE_SIZE
  )
    throw new AiVisibilityStoreError(502, 'Invalid or oversized snapshot directory page');
  const names = new Set<string>();
  for (const { name } of result.keys) {
    const suffix = name.startsWith(prefix) ? name.slice(prefix.length) : '';
    const [provider, id, extra] = suffix.split(':');
    if (!PROVIDERS.has(provider) || !/^[a-f0-9]{64}$/.test(id ?? '') || extra || names.has(name))
      throw new AiVisibilityStoreError(502, 'Snapshot directory scope or paging changed; retry');
    names.add(name);
  }
  if (!result.list_complete && (!result.cursor || result.cursor === state?.kvCursor))
    throw new AiVisibilityStoreError(502, 'Snapshot directory paging did not advance');
  return {
    keys: [...names].sort(),
    nextCursor: result.list_complete
      ? null
      : encodeCursor(site, result.cursor!, state?.issuedAt ?? Date.now()),
    // Complete available enumeration only when one first-page read reaches the
    // end. Later pages never claim global/frozen history completeness in KV.
    historyComplete: !cursor && result.list_complete,
  };
}

async function readRecord(
  store: AiVisibilityStore,
  site: SiteBinding,
  key: string,
  deadline: number,
  suppliedRaw?: string
): Promise<AiVisibilitySnapshot> {
  const raw = suppliedRaw ?? (await bounded(store.get(key), deadline));
  if (raw === null)
    throw new AiVisibilityStoreError(
      409,
      'KV listing and snapshot are not yet consistent; retry this page'
    );
  if (new TextEncoder().encode(raw).byteLength > AI_VISIBILITY_MAX_BYTES)
    throw new AiVisibilityStoreError(413, 'Stored snapshot exceeds the safe size bound');
  let input: AiVisibilityInput;
  try {
    input = aiVisibilityInputSchema.parse(JSON.parse(raw));
  } catch {
    throw new AiVisibilityStoreError(502, 'Stored snapshot validation failed');
  }
  const origin = validateBinding(input, site);
  const canonical = canonicalAiVisibilityInput(input);
  const snapshotId = await hash(canonical);
  if (key !== `${PREFIX}${site.id}:${input.provider}:${snapshotId}` || raw !== canonical)
    throw new AiVisibilityStoreError(502, 'Stored snapshot content identity failed validation');
  return { ...JSON.parse(canonical), snapshotId, siteId: site.id, origin };
}

export async function readAiVisibilitySnapshots(
  storage: AiVisibilityStore | undefined,
  site: SiteBinding,
  canManage: boolean,
  cursor?: string
): Promise<AiVisibilityReport> {
  const store = storeOrThrow(storage);
  const deadline = Date.now() + READ_BUDGET_MS;
  const page = await keysPage(store, site, deadline, cursor);
  const keys = page.keys;
  const snapshots: AiVisibilitySnapshot[] = [];
  // Bound concurrency without returning any successful-looking partial report.
  for (let index = 0; index < keys.length; index += 4)
    snapshots.push(
      ...(await Promise.all(
        keys.slice(index, index + 4).map(key => readRecord(store, site, key, deadline))
      ))
    );
  snapshots.sort(
    (a, b) =>
      b.window.endDate.localeCompare(a.window.endDate) ||
      (b.capturedAt ?? '').localeCompare(a.capturedAt ?? '') ||
      a.snapshotId.localeCompare(b.snapshotId)
  );
  return {
    format: 'ai-visibility-report/v2',
    connectionMode: 'manual_snapshot',
    continuousConnection: 'not_connected',
    status: snapshots.length
      ? 'snapshots_available'
      : cursor || page.nextCursor
        ? 'history_page_empty'
        : 'not_connected',
    canManage,
    readAt: new Date().toISOString(),
    snapshots,
    coverage: {
      pageComplete: true,
      historyComplete: page.historyComplete,
      snapshotCount: snapshots.length,
      pageSize: AI_VISIBILITY_PAGE_SIZE,
      hasMore: page.nextCursor !== null,
      nextCursor: page.nextCursor,
      consistency: 'eventually_consistent',
      visibilityDelaySeconds: 60,
    },
  };
}

/** Exact immutable readback is independent of directory visibility or page one. */
export async function readAiVisibilitySnapshot(
  storage: AiVisibilityStore | undefined,
  site: SiteBinding,
  snapshotId: string
): Promise<AiVisibilitySnapshotRead> {
  const store = storeOrThrow(storage);
  originFor(site);
  if (!/^[a-f0-9]{64}$/.test(snapshotId))
    throw new AiVisibilityStoreError(400, 'Invalid snapshot content identity');
  const deadline = Date.now() + READ_BUDGET_MS;
  const records = await Promise.all(
    [...PROVIDERS].map(async provider => {
      const key = `${PREFIX}${site.id}:${provider}:${snapshotId}`;
      return { key, raw: await bounded(store.get(key), deadline) };
    })
  );
  const found = records.filter(record => record.raw !== null);
  if (!found.length)
    throw new AiVisibilityStoreError(
      404,
      'Snapshot is not yet visible or was not found; retry exact readback'
    );
  if (found.length !== 1) throw new AiVisibilityStoreError(502, 'Snapshot identity is ambiguous');
  return {
    format: 'ai-visibility-snapshot-read/v1',
    connectionMode: 'manual_snapshot',
    continuousConnection: 'not_connected',
    readAt: new Date().toISOString(),
    snapshot: await readRecord(store, site, found[0].key, deadline, found[0].raw!),
  };
}

export async function importAiVisibilitySnapshot(
  storage: AiVisibilityStore | undefined,
  site: SiteBinding,
  value: unknown
): Promise<AiVisibilityImportResult> {
  const store = storeOrThrow(storage);
  let input: AiVisibilityInput;
  try {
    input = aiVisibilityInputSchema.parse(value);
  } catch {
    throw new AiVisibilityStoreError(400, 'Invalid AI visibility snapshot JSON');
  }
  const origin = validateBinding(input, site);
  if (input.capturedAt && Date.parse(input.capturedAt) > Date.now() + 60_000)
    throw new AiVisibilityStoreError(400, 'A future capture timestamp cannot be verified');
  const canonical = canonicalAiVisibilityInput(input);
  if (new TextEncoder().encode(canonical).byteLength > AI_VISIBILITY_MAX_BYTES)
    throw new AiVisibilityStoreError(413, 'Snapshot exceeds the safe size bound');
  const snapshotId = await hash(canonical);
  const key = `${PREFIX}${site.id}:${input.provider}:${snapshotId}`;
  const deadline = Date.now() + READ_BUDGET_MS;
  const existing = await bounded(store.get(key), deadline);
  const alreadyObserved = existing !== null;
  if (alreadyObserved && existing !== canonical)
    throw new AiVisibilityStoreError(409, 'Existing snapshot content does not match its identity');
  if (!alreadyObserved) {
    // A KV.list result cannot enforce a strong total quota. Do not couple a
    // write to eventual history counts or make older evidence unreadable.
    // KV has no compare-and-swap. Concurrent duplicate imports may both PUT,
    // but the content-addressed key receives exactly the SAME immutable bytes.
    // No latest pointer, mutable import stamp, TTL, or older record is replaced.
    await bounded(store.put(key, canonical), deadline);
  }
  return {
    status: 'stored_pending_readback',
    snapshot: { ...JSON.parse(canonical), snapshotId, siteId: site.id, origin },
    acceptedAt: new Date().toISOString(),
    alreadyObserved,
  };
}
