import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { hashToken } from '../apps/platform/api/src/lib/tokens';
import { AI_VISIBILITY_MAX_BYTES } from '../packages/shared/src/ai-visibility';

let runtime: Miniflare;
const source = {
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
  total: { metric: 'impressions', value: 9, aggregation: 'property' },
  pageRows: [{ page: 'https://synthetic.fixture.test/a', value: 11 }],
  dateRows: [{ date: '2026-10-01', value: 9 }],
  coverage: {
    availableExportComplete: true,
    platformAllRowsKnown: false,
    uiPageRows: 1,
    uiDateRows: 1,
    exportedPageRows: 1,
    exportedDateRows: 1,
    platformRowLimit: 1000,
    nullsExportedAsZero: true,
  },
  sourceArchiveSha256: 'c'.repeat(64),
};
const request = (
  role: string | null,
  method = 'GET',
  body?: unknown,
  id = 'synthetic-site',
  suffix = ''
) =>
  runtime.dispatchFetch(`http://localhost/api/sites/${id}/ai-visibility${suffix}`, {
    method,
    headers: {
      ...(role ? { authorization: `Bearer traks_pat_synthetic_fixture_${role}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });

before(async () => {
  const bundle = await build({
    stdin: {
      contents: `import { Hono } from 'hono';
        import { drizzle } from 'drizzle-orm/d1';
        import { sitesRoute } from './apps/platform/api/src/routes/sites';
        const app = new Hono();
        app.use('/api/*', async (c,next) => { c.set('db',drizzle(c.env.DB)); await next(); });
        app.route('/api/sites',sitesRoute);
        export default { fetch: app.fetch };`,
      resolveDir: process.cwd(),
      loader: 'ts',
    },
    bundle: true,
    write: false,
    platform: 'neutral',
    format: 'esm',
    mainFields: ['module', 'main'],
    conditions: ['workerd', 'worker', 'browser'],
    external: ['node:*', 'cloudflare:*'],
  });
  runtime = new Miniflare({
    modules: [
      {
        type: 'ESModule',
        path: 'ai-visibility-synthetic-test.mjs',
        contents: bundle.outputFiles[0].text,
      },
    ],
    compatibilityDate: '2026-07-02',
    compatibilityFlags: ['nodejs_compat'],
    d1Databases: ['DB'],
    kvNamespaces: ['R2SQL_CACHE'],
    bindings: {
      ENVIRONMENT: 'development',
      BETTER_AUTH_SECRET: 'synthetic-only-not-a-production-secret',
    },
    outboundService: () => {
      throw new Error('External calls are forbidden in synthetic API tests');
    },
  });
  const database = await runtime.getD1Database('DB');
  const statements = [
    'CREATE TABLE users (id text PRIMARY KEY, email text, is_instance_owner integer DEFAULT 0)',
    'CREATE TABLE workspaces (id text PRIMARY KEY, name text, slug text)',
    'CREATE TABLE workspace_members (id text PRIMARY KEY, workspace_id text, user_id text, role text)',
    "CREATE TABLE sites (id text PRIMARY KEY, user_id text, workspace_id text, name text, domain text, favicon text, timezone text DEFAULT 'UTC', public integer DEFAULT 0, created_at integer, updated_at integer)",
    'CREATE TABLE api_tokens (id text PRIMARY KEY, user_id text, workspace_id text, name text, token_hash text, suffix text, scope text, last_used_at integer)',
    "INSERT INTO users (id,email) VALUES ('owner','owner@synthetic.fixture.test'),('member','member@synthetic.fixture.test')",
    "INSERT INTO workspaces (id,name,slug) VALUES ('workspace','Synthetic','synthetic'),('outside','Outside','outside')",
    "INSERT INTO workspace_members (id,workspace_id,user_id,role) VALUES ('owner-membership','workspace','owner','owner'),('member-membership','workspace','member','member'),('outside-membership','outside','owner','owner')",
    "INSERT INTO sites (id,user_id,workspace_id,name,domain) VALUES ('synthetic-site','owner','workspace','Synthetic site','synthetic.fixture.test'),('second-site','owner','workspace','Second site','second.fixture.test'),('outside-site','owner','outside','Outside site','outside.fixture.test')",
  ];
  for (const statement of statements) await database.prepare(statement).run();
  for (const [label, userId, scope] of [
    ['owner', 'owner', 'manage'],
    ['member', 'member', 'manage'],
    ['reader', 'owner', 'read'],
  ]) {
    await database
      .prepare(
        'INSERT INTO api_tokens (id,user_id,workspace_id,name,token_hash,suffix,scope) VALUES (?,?,?,?,?,?,?)'
      )
      .bind(
        label,
        userId,
        'workspace',
        'Synthetic fixture',
        await hashToken(`traks_pat_synthetic_fixture_${label}`),
        'test',
        scope
      )
      .run();
  }
});
after(async () => {
  await runtime?.dispose();
});

test('API rejects missing auth and cross-workspace access without exposing stored data', async () => {
  assert.equal((await request(null)).status, 401);
  assert.equal((await request('owner', 'GET', undefined, 'outside-site')).status, 404);
  assert.equal((await request('owner', 'POST', source, 'outside-site')).status, 404);
});

test('read PAT and workspace member cannot import while owner stores and reads a real backend fixture', async () => {
  assert.equal((await request('reader', 'POST', source)).status, 403);
  assert.equal((await request('member', 'POST', source)).status, 403);
  const posted = await request('owner', 'POST', source);
  assert.equal(posted.status, 201);
  const result = (await posted.json()) as any;
  assert.equal(result.data.status, 'stored_pending_readback');
  assert.match(result.data.snapshot.snapshotId, /^[a-f0-9]{64}$/);
  for (const role of ['owner', 'reader', 'member']) {
    const response = await request(role);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    const read = (await response.json()) as any;
    assert.equal(read.data.snapshots.length, 1);
    assert.equal(read.data.snapshots[0].snapshotId, result.data.snapshot.snapshotId);
    assert.equal(read.data.canManage, role === 'owner');
    assert.equal(read.data.continuousConnection, 'not_connected');
    assert.equal(read.data.snapshots[0].total.metric, 'impressions');
    assert.equal(read.data.snapshots[0].total.value, 9);
    assert.equal(read.data.snapshots[0].pageRows[0].value, 11);
  }
  const duplicate = await request('owner', 'POST', source);
  assert.equal(duplicate.status, 201);
  assert.equal(((await duplicate.json()) as any).data.alreadyObserved, true);
});

test('API rejects malformed, cross-origin, fake citation and oversized JSON without a storage write', async () => {
  assert.equal((await request('owner', 'POST', '{')).status, 400);
  assert.equal(
    (await request('owner', 'POST', { ...source, property: 'https://other.fixture.test/' })).status,
    400
  );
  assert.equal(
    (await request('owner', 'POST', { ...source, total: { ...source.total, metric: 'citations' } }))
      .status,
    400
  );
  assert.equal(
    (await request('owner', 'POST', 'x'.repeat(AI_VISIBILITY_MAX_BYTES + 1))).status,
    413
  );
  const read = await request('owner');
  assert.equal(((await read.json()) as any).data.snapshots.length, 1);
});

test('real Worker history remains paged and authorized beyond 64; exact ID verifies a later page', async () => {
  const importedIds: string[] = [];
  for (let index = 0; index < 64; index++) {
    const response = await request('owner', 'POST', {
      ...source,
      sourceArchiveSha256: index.toString(16).padStart(64, '0'),
    });
    assert.equal(response.status, 201);
    importedIds.push(((await response.json()) as any).data.snapshot.snapshotId);
  }
  const firstResponse = await request('member');
  assert.equal(firstResponse.status, 200);
  const first = ((await firstResponse.json()) as any).data;
  assert.equal(first.format, 'ai-visibility-report/v2');
  assert.equal(first.snapshots.length, 16);
  assert.equal(first.coverage.pageComplete, true);
  assert.equal(first.coverage.historyComplete, false);
  assert.equal(first.coverage.hasMore, true);
  const firstIds = new Set(first.snapshots.map((snapshot: any) => snapshot.snapshotId));
  const laterId = importedIds.find(id => !firstIds.has(id))!;
  const exactResponse = await request(
    'reader',
    'GET',
    undefined,
    'synthetic-site',
    `/snapshot/${laterId}`
  );
  assert.equal(exactResponse.status, 200);
  const exact = ((await exactResponse.json()) as any).data;
  assert.equal(exact.format, 'ai-visibility-snapshot-read/v1');
  assert.equal(exact.snapshot.snapshotId, laterId);
  assert.equal(exact.snapshot.siteId, 'synthetic-site');
  assert.equal(
    (await request('owner', 'GET', undefined, 'outside-site', `/snapshot/${laterId}`)).status,
    404
  );
  assert.equal(
    (await request(null, 'GET', undefined, 'synthetic-site', `/snapshot/${laterId}`)).status,
    401
  );
  const seen = new Set(first.snapshots.map((snapshot: any) => snapshot.snapshotId));
  let cursor = first.coverage.nextCursor;
  while (cursor) {
    const response = await request(
      'reader',
      'GET',
      undefined,
      'synthetic-site',
      `?${new URLSearchParams({ cursor })}`
    );
    assert.equal(response.status, 200);
    const page = ((await response.json()) as any).data;
    assert.ok(page.snapshots.length <= 16);
    assert.equal(page.coverage.historyComplete, false);
    page.snapshots.forEach((snapshot: any) => seen.add(snapshot.snapshotId));
    cursor = page.coverage.nextCursor;
  }
  assert.equal(seen.size, 65);
  const wrongSite = await request(
    'owner',
    'GET',
    undefined,
    'outside-site',
    `?${new URLSearchParams({ cursor: first.coverage.nextCursor })}`
  );
  assert.equal(wrongSite.status, 404);
  assert.equal(
    (
      await request(
        'owner',
        'GET',
        undefined,
        'second-site',
        `?${new URLSearchParams({ cursor: first.coverage.nextCursor })}`
      )
    ).status,
    409
  );
  assert.equal(
    (await request('owner', 'GET', undefined, 'second-site', `/snapshot/${laterId}`)).status,
    404
  );
  const database = await runtime.getD1Database('DB');
  await database.prepare("DELETE FROM workspace_members WHERE id='member-membership'").run();
  assert.equal(
    (
      await request(
        'member',
        'GET',
        undefined,
        'synthetic-site',
        `?${new URLSearchParams({ cursor: first.coverage.nextCursor })}`
      )
    ).status,
    404
  );
  assert.equal(
    (await request('member', 'GET', undefined, 'synthetic-site', `/snapshot/${laterId}`)).status,
    404
  );
  assert.equal(
    (await request('owner', 'GET', undefined, 'synthetic-site', '?cursor=legacy-offset-1')).status,
    409
  );
});
