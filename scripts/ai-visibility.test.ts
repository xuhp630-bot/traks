import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aiVisibilityInputSchema,
  aiVisibilityRowSum,
  type AiVisibilityInput,
} from '../packages/shared/src/ai-visibility';
import {
  importAiVisibilitySnapshot,
  readAiVisibilitySnapshot,
  readAiVisibilitySnapshots,
} from '../apps/platform/api/src/lib/ai-visibility';

const fixture = (): AiVisibilityInput => ({
  format: 'ai-visibility-snapshot/v1',
  provider: 'google_search_ai',
  connectionMode: 'manual_snapshot',
  sourceRef: 'google_search_console_ai_report',
  property: 'https://synthetic.fixture.test/',
  capturedAt: '2026-10-10T12:00:00.000Z',
  window: {
    startDate: '2026-10-01',
    endDate: '2026-10-02',
    timezone: 'America/Los_Angeles',
    completeThrough: '2026-10-02',
    dataState: 'final',
  },
  total: { metric: 'impressions', value: 12, aggregation: 'property' },
  pageRows: [
    { page: 'https://synthetic.fixture.test/b', value: 8 },
    { page: 'https://synthetic.fixture.test/a', value: 7 },
  ],
  dateRows: [
    { date: '2026-10-01', value: 5 },
    { date: '2026-10-02', value: 7 },
  ],
  coverage: {
    availableExportComplete: true,
    platformAllRowsKnown: false,
    uiPageRows: 2,
    uiDateRows: 2,
    exportedPageRows: 2,
    exportedDateRows: 2,
    platformRowLimit: 1000,
    nullsExportedAsZero: true,
  },
  sourceArchiveSha256: 'a'.repeat(64),
});
const site = { id: 'synthetic-site', domain: 'synthetic.fixture.test' };

function memoryKv(pageSize = 16) {
  const values = new Map<string, string>();
  const writes: { key: string; value: string; options: unknown }[] = [];
  return {
    values,
    writes,
    async get(key: string) {
      return values.get(key) ?? null;
    },
    async put(key: string, value: string, options?: unknown) {
      writes.push({ key, value, options });
      values.set(key, value);
    },
    async list({ prefix, cursor }: { prefix: string; cursor?: string }) {
      const names = [...values.keys()].filter(key => key.startsWith(prefix)).sort();
      const offset = Number(cursor ?? 0);
      const selected = names.slice(offset, offset + pageSize);
      const done = offset + selected.length >= names.length;
      return {
        keys: selected.map(name => ({ name })),
        list_complete: done,
        ...(done ? {} : { cursor: String(offset + selected.length) }),
      };
    },
  };
}

test('synthetic Google property/date and page sums remain different metrics, not citations', () => {
  const input = aiVisibilityInputSchema.parse(fixture());
  assert.equal(input.total.value, 12);
  assert.equal(aiVisibilityRowSum(input.pageRows), 15);
  assert.equal(aiVisibilityRowSum(input.dateRows), 12);
  assert.equal(aiVisibilityRowSum([{ value: null }, { value: 2 }]), null);
  assert.equal(aiVisibilityRowSum([]), null);
  assert.equal(input.coverage.platformAllRowsKnown, false);
});

test('strict schema rejects fake metrics, continuous modes, free text and inconsistent row counts', () => {
  const cases = [
    { ...fixture(), total: { metric: 'citations', value: 12, aggregation: 'property' } },
    { ...fixture(), connectionMode: 'api_connected' },
    { ...fixture(), query: 'unrequested free text' },
    { ...fixture(), sourceRef: 'file:///private/report.zip' },
    { ...fixture(), coverage: { ...fixture().coverage, exportedPageRows: 1 } },
    { ...fixture(), coverage: { ...fixture().coverage, platformAllRowsKnown: true } },
    { ...fixture(), pageRows: [fixture().pageRows[0], fixture().pageRows[0]] },
    { ...fixture(), window: { ...fixture().window, startDate: '2026-02-30' } },
    {
      ...fixture(),
      dateRows: [{ date: '2026-09-01', value: 1 }],
      coverage: { ...fixture().coverage, exportedDateRows: 1, uiDateRows: 1 },
    },
    { ...fixture(), total: { ...fixture().total, value: -1 } },
  ];
  for (const candidate of cases)
    assert.equal(aiVisibilityInputSchema.safeParse(candidate).success, false);
});

test('Bing citation bundle has a distinct fixed source and no invented impressions', () => {
  const bing = {
    ...fixture(),
    provider: 'bing_ai_surfaces',
    sourceRef: 'bing_webmaster_ai_performance',
    window: { ...fixture().window, timezone: 'provider_unspecified' },
    total: { metric: 'citations', value: 4, aggregation: 'property' },
  };
  assert.equal(aiVisibilityInputSchema.safeParse(bing).success, true);
  assert.equal(
    aiVisibilityInputSchema.safeParse({ ...bing, sourceRef: 'google_search_console_ai_report' })
      .success,
    false
  );
});

test('immutable content-addressed imports are idempotent, private, noTTL and fully paged', async () => {
  const kv = memoryKv();
  const first = await importAiVisibilitySnapshot(kv, site, fixture());
  const reordered = { ...fixture(), pageRows: [...fixture().pageRows].reverse() };
  const duplicate = await importAiVisibilitySnapshot(kv, site, reordered);
  assert.equal(first.snapshot.snapshotId, duplicate.snapshot.snapshotId);
  assert.equal(duplicate.alreadyObserved, true);
  assert.equal(kv.writes.length, 1);
  assert.equal(kv.writes[0].options, undefined);
  assert.match(kv.writes[0].key, /^ai-visibility:v1:synthetic-site:google_search_ai:[a-f0-9]{64}$/);
  const changed = { ...fixture(), sourceArchiveSha256: 'b'.repeat(64) };
  await importAiVisibilitySnapshot(kv, site, changed);
  assert.equal(kv.values.size, 2);
  const report = await readAiVisibilitySnapshots(kv, site, false);
  assert.equal(report.snapshots.length, 2);
  assert.equal(report.coverage.pageComplete, true);
  assert.equal(report.coverage.historyComplete, true);
  assert.equal(report.canManage, false);
  assert.equal(report.continuousConnection, 'not_connected');
  assert.equal(report.snapshots[0].total.value, 12);
  assert.equal(report.snapshots[0].pageRows.length, 2);
});

test('site binding rejects offsite, private/query URLs and changed site domain', async () => {
  const kv = memoryKv();
  for (const property of [
    'https://other.fixture.test/',
    'https://user:password@synthetic.fixture.test/',
    'http://synthetic.fixture.test/',
    'https://synthetic.fixture.test/?secret=not-retained',
  ]) {
    await assert.rejects(importAiVisibilitySnapshot(kv, site, { ...fixture(), property }));
  }
  const badRows = {
    ...fixture(),
    pageRows: [{ page: 'https://synthetic.fixture.test/?query=private', value: 1 }],
    coverage: { ...fixture().coverage, exportedPageRows: 1, uiPageRows: 1 },
  };
  await assert.rejects(importAiVisibilitySnapshot(kv, site, badRows));
  assert.equal(kv.values.size, 0);
  await importAiVisibilitySnapshot(kv, site, fixture());
  await assert.rejects(
    readAiVisibilitySnapshots(kv, { ...site, domain: 'changed.fixture.test' }, true)
  );
  assert.equal(
    (await readAiVisibilitySnapshots(kv, { id: 'other', domain: site.domain }, false)).status,
    'not_connected'
  );
});

test('missing storage, failed reads, stale listings and nonadvancing cursors never turn into empty success', async () => {
  await assert.rejects(readAiVisibilitySnapshots(undefined, site, false));
  const kv = memoryKv();
  await importAiVisibilitySnapshot(kv, site, fixture());
  await assert.rejects(readAiVisibilitySnapshots({ ...kv, get: async () => null }, site, false));
  await assert.rejects(
    readAiVisibilitySnapshots(
      {
        ...kv,
        get: async () => {
          throw new Error('synthetic error');
        },
      },
      site,
      false
    )
  );
  const stalled = { ...kv, list: async () => ({ keys: [], list_complete: false, cursor: 'same' }) };
  const emptyPage = await readAiVisibilitySnapshots(stalled, site, false);
  assert.equal(emptyPage.status, 'history_page_empty');
  assert.equal(emptyPage.coverage.historyComplete, false);
  await assert.rejects(
    readAiVisibilitySnapshots(stalled, site, false, emptyPage.coverage.nextCursor!)
  );
  const report = await readAiVisibilitySnapshots(memoryKv(), site, true);
  assert.equal(report.status, 'not_connected');
  assert.equal(report.snapshots.length, 0);
});

test('concurrent duplicate writes retain identical immutable bytes without a mutable import stamp', async () => {
  const kv = memoryKv();
  const imports = await Promise.all([
    importAiVisibilitySnapshot(kv, site, fixture()),
    importAiVisibilitySnapshot(kv, site, fixture()),
  ]);
  assert.equal(imports[0].snapshot.snapshotId, imports[1].snapshot.snapshotId);
  assert.equal(kv.values.size, 1);
  assert.equal(new Set(kv.writes.map(write => write.value)).size, 1);
  assert.doesNotMatch(kv.writes[0].value, /acceptedAt|importedAt|firstImportedAt/);
});

test('stale KV lists accept 65 distinct immutable records without locking history readback', async () => {
  const kv = memoryKv();
  let lagging = true;
  const store = {
    ...kv,
    list: async (options: { prefix: string; cursor?: string; limit: number }) =>
      lagging ? { keys: [], list_complete: true } : kv.list(options),
  };
  let lastId = '';
  for (let index = 0; index < 65; index++) {
    const imported = await importAiVisibilitySnapshot(store, site, {
      ...fixture(),
      sourceArchiveSha256: index.toString(16).padStart(64, '0'),
    });
    lastId = imported.snapshot.snapshotId;
  }
  assert.equal(kv.values.size, 65);
  lagging = false;
  const first = await readAiVisibilitySnapshots(store, site, true);
  assert.equal(first.snapshots.length, 16);
  assert.equal(first.coverage.pageComplete, true);
  assert.equal(first.coverage.historyComplete, false);
  assert.equal(first.coverage.hasMore, true);
  assert.ok(first.coverage.nextCursor);
  const second = await readAiVisibilitySnapshots(store, site, true, first.coverage.nextCursor!);
  assert.equal(second.snapshots.length, 16);
  assert.equal(second.coverage.historyComplete, false);
  assert.ok(second.coverage.nextCursor);
  assert.equal((await readAiVisibilitySnapshot(store, site, lastId)).snapshot.snapshotId, lastId);
});

test('63 records plus two concurrent distinct imports remain readable across bounded pages', async () => {
  const kv = memoryKv();
  for (let index = 0; index < 63; index++) {
    await importAiVisibilitySnapshot(kv, site, {
      ...fixture(),
      sourceArchiveSha256: index.toString(16).padStart(64, '0'),
    });
  }
  await Promise.all(
    ['e', 'f'].map(hex =>
      importAiVisibilitySnapshot(kv, site, {
        ...fixture(),
        sourceArchiveSha256: hex.repeat(64),
      })
    )
  );
  assert.equal(kv.values.size, 65);
  const found = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const page = await readAiVisibilitySnapshots(kv, site, false, cursor);
    assert.ok(page.snapshots.length <= 16);
    page.snapshots.forEach(snapshot => found.add(snapshot.snapshotId));
    if (!page.coverage.nextCursor) break;
    cursor = page.coverage.nextCursor;
  }
  assert.equal(found.size, 65);
});

test('history cursors reject legacy protocol, different site/domain and expired state', async () => {
  const kv = memoryKv(1);
  await importAiVisibilitySnapshot(kv, site, fixture());
  await importAiVisibilitySnapshot(kv, site, { ...fixture(), sourceArchiveSha256: 'b'.repeat(64) });
  const page = await readAiVisibilitySnapshots(kv, site, true);
  const cursor = page.coverage.nextCursor!;
  assert.ok(cursor);
  await assert.rejects(readAiVisibilitySnapshots(kv, site, true, 'legacy-offset-1'));
  await assert.rejects(
    readAiVisibilitySnapshots(kv, { ...site, id: 'another-site' }, true, cursor)
  );
  await assert.rejects(
    readAiVisibilitySnapshots(kv, { ...site, domain: 'changed.fixture.test' }, true, cursor)
  );
  const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString());
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  await assert.rejects(
    readAiVisibilitySnapshots(kv, site, true, encode({ ...decoded, protocol: 'old/v0' }))
  );
  await assert.rejects(
    readAiVisibilitySnapshots(kv, site, true, encode({ ...decoded, issuedAt: 0 }))
  );
  await assert.rejects(
    readAiVisibilitySnapshots(kv, site, true, encode({ ...decoded, extra: 'no' }))
  );
});

test('list failures cannot block imports or precise ID readback, and each failed page is explicit', async () => {
  const kv = memoryKv();
  const failedList = {
    ...kv,
    list: async () => {
      throw new Error('synthetic list delay');
    },
  };
  const accepted = await importAiVisibilitySnapshot(failedList, site, fixture());
  assert.equal(
    (await readAiVisibilitySnapshot(failedList, site, accepted.snapshot.snapshotId)).snapshot
      .snapshotId,
    accepted.snapshot.snapshotId
  );
  await assert.rejects(readAiVisibilitySnapshots(failedList, site, false));
  await assert.rejects(
    readAiVisibilitySnapshot(
      failedList,
      { ...site, id: 'another-site' },
      accepted.snapshot.snapshotId
    )
  );
  await assert.rejects(readAiVisibilitySnapshot(failedList, site, 'invalid-id'));
  await assert.rejects(
    readAiVisibilitySnapshot({ ...kv, get: async () => null }, site, accepted.snapshot.snapshotId)
  );
});

test('foreign, duplicate and oversized KV page names cannot leak payloads or look complete', async () => {
  const kv = memoryKv();
  const record = await importAiVisibilitySnapshot(kv, site, fixture());
  const key = [...kv.values.keys()][0];
  for (const keys of [
    [{ name: `ai-visibility:v1:other-site:google_search_ai:${record.snapshot.snapshotId}` }],
    [{ name: key }, { name: key }],
    Array.from({ length: 17 }, () => ({ name: key })),
  ]) {
    await assert.rejects(
      readAiVisibilitySnapshots(
        { ...kv, list: async () => ({ keys, list_complete: true }) },
        site,
        false
      )
    );
  }
});
