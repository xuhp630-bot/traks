// Execute the real authenticated route in an isolated Worker. The hot store
// and cold transport are explicit fixtures, never production data or proof
// that the live R2 SQL dialect supports the builders.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { hashToken } from '../apps/platform/api/src/lib/tokens';

let runtime: Miniflare;
const request = (
  mode: string,
  period = 'today',
  source = 'fixture-a',
  authenticated = true,
  siteId = 'synthetic-site'
) =>
  runtime.dispatchFetch(
    `http://localhost/api/analytics/${siteId}/stats/events?${new URLSearchParams({ period, utmSource: source })}`,
    {
      headers: {
        'x-synthetic-fixture': mode,
        ...(authenticated ? { authorization: 'Bearer traks_pat_synthetic_income_test' } : {}),
      },
    }
  );

before(async () => {
  const queryPath = `${process.cwd()}/apps/platform/api/src/lib/queries.ts`;
  const bundle = await build({
    stdin: {
      contents: `import { Hono } from 'hono';
        import { drizzle } from 'drizzle-orm/d1';
        import { analyticsRoute } from './apps/platform/api/src/routes/analytics';
        const calls = [];
        const app = new Hono();
        app.use('/api/*', async (c,next) => {
          c.set('db',drizzle(c.env.DB));
          const mode = c.req.header('x-synthetic-fixture') || 'live';
          c.env.R2_BUCKET_NAME = mode;
          c.env.LIVE = {
            idFromName: name => name,
            get: name => ({
              async customEvents(from,to,limit,filters) {
                calls.push({source:'live-counts',site:name,from,to,limit,filters});
                return [{name:'Purchase Confirmed',count:7,totalValue:2},
                  {name:'Legacy score',count:3,totalValue:42}];
              },
              async eventRevenue(from,to,filters) {
                calls.push({source:'live-income',site:name,from,to,filters});
                if(mode.startsWith('fail-live')) throw new Error('Synthetic hot failure');
                if(mode === 'invalid-live') return [{name:'Purchase Confirmed',currency:'USD',totalValue:null}];
                return [
                  {name:'Purchase Confirmed',currency:'USD',count:2,totalValue:filters?.utm_source === 'fixture-b' ? 21 : 98},
                  {name:'Purchase Confirmed',currency:'EUR',count:1,totalValue:30},
                  {name:'Out of event list',currency:'USD',count:1,totalValue:999}
                ];
              }
            })
          };
          await next();
        });
        app.route('/api/analytics',analyticsRoute);
        app.get('/synthetic-calls', c => c.json(calls));
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
    plugins: [
      {
        name: 'synthetic-income-transport',
        setup(builder) {
          builder.onResolve({ filter: /^\.\.\/lib\/queries$/ }, args =>
            args.importer.endsWith('/routes/analytics.ts')
              ? { path: 'queries', namespace: 'synthetic-income' }
              : undefined
          );
          builder.onLoad({ filter: /.*/, namespace: 'synthetic-income' }, () => ({
            resolveDir: process.cwd(),
            loader: 'ts',
            contents: `export * from ${JSON.stringify(queryPath)};
              import { R2SqlError } from '@traks/shared';
              export async function queryR2SqlWithStats(config, buildQuery) {
                const sql = buildQuery(config.table);
                const income = /event_name AS name, currency/.test(sql);
                if(income && config.bucketName.includes('cold-error'))
                  throw new R2SqlError('Synthetic income transport failure');
                const rows = income
                  ? [{name:'Purchase Confirmed',currency:'USD',count:'1',total_value:'49'},
                     {name:'Purchase Confirmed',currency:'EUR',count:'1',total_value:'20'}]
                  : [{name:'Purchase Confirmed',count:'5',total_value:'3'},
                     {name:'Legacy score',count:'4',total_value:'42'}];
                return {rows,ms:0,status:200};
              }`,
          }));
        },
      },
    ],
  });
  runtime = new Miniflare({
    modules: [
      { type: 'ESModule', path: 'synthetic-income-api.mjs', contents: bundle.outputFiles[0].text },
    ],
    compatibilityDate: '2026-07-02',
    compatibilityFlags: ['nodejs_compat'],
    d1Databases: ['DB'],
    kvNamespaces: ['R2SQL_CACHE'],
    bindings: {
      ENVIRONMENT: 'development',
      BETTER_AUTH_SECRET: 'synthetic-only-not-a-production-secret',
      R2_ACCOUNT_ID: 'synthetic-account',
      R2_SQL_TOKEN: 'synthetic-only-unused-transport',
      PREWARM_HOURS: '0',
    },
    outboundService: () => {
      throw new Error('External calls are forbidden in synthetic income API tests');
    },
  });
  const db = await runtime.getD1Database('DB');
  for (const statement of [
    'CREATE TABLE users (id text PRIMARY KEY, email text, is_instance_owner integer DEFAULT 0)',
    'CREATE TABLE workspaces (id text PRIMARY KEY, name text, slug text)',
    'CREATE TABLE workspace_members (id text PRIMARY KEY, workspace_id text, user_id text, role text)',
    "CREATE TABLE sites (id text PRIMARY KEY, user_id text, workspace_id text, name text, domain text, timezone text DEFAULT 'UTC', public integer DEFAULT 0)",
    'CREATE TABLE api_tokens (id text PRIMARY KEY, user_id text, workspace_id text, name text, token_hash text, suffix text, scope text, last_used_at integer)',
    "INSERT INTO users (id,email) VALUES ('owner','owner@synthetic.fixture.test')",
    "INSERT INTO workspaces (id,name,slug) VALUES ('workspace','Synthetic','synthetic'),('outside','Outside','outside')",
    "INSERT INTO workspace_members (id,workspace_id,user_id,role) VALUES ('member','workspace','owner','owner')",
    "INSERT INTO sites (id,user_id,workspace_id,name,domain,public) VALUES ('synthetic-site','owner','workspace','Synthetic site','synthetic.fixture.test',1),('outside-site','owner','outside','Outside site','outside.fixture.test',1)",
  ])
    await db.prepare(statement).run();
  await db
    .prepare(
      'INSERT INTO api_tokens (id,user_id,workspace_id,name,token_hash,suffix,scope) VALUES (?,?,?,?,?,?,?)'
    )
    .bind(
      'read-token',
      'owner',
      'workspace',
      'Synthetic income API',
      await hashToken('traks_pat_synthetic_income_test'),
      'test',
      'read'
    )
    .run();
});

after(async () => {
  await runtime?.dispose();
});

test('public flag does not expose the private income route; actual read token remains site scoped', async () => {
  assert.equal((await request('live', 'today', 'auth', false)).status, 401);
  assert.equal((await request('live', 'today', 'auth', true, 'outside-site')).status, 404);
  assert.equal((await request('live', 'today', 'auth', true, 'missing-site')).status, 404);
});

test('hot source merges currencies without changing counts/generic value and preserves 500 explorer cap', async () => {
  const response = await request('live');
  assert.equal(response.status, 200);
  const result = (await response.json()) as any;
  assert.deepEqual(result.data, [
    {
      name: 'Purchase Confirmed',
      count: 7,
      totalValue: 2,
      revenues: [
        { currency: 'EUR', amount: 30 },
        { currency: 'USD', amount: 98 },
      ],
    },
    { name: 'Legacy score', count: 3, totalValue: 42, revenues: [] },
  ]);
  const calls = (await (
    await runtime.dispatchFetch('http://localhost/synthetic-calls')
  ).json()) as any[];
  const [counts, income] = calls.slice(-2);
  assert.equal(counts.limit, 500);
  assert.deepEqual(
    [counts.site, counts.from, counts.to, counts.filters],
    [income.site, income.from, income.to, income.filters]
  );
  assert.deepEqual(counts.filters, { utm_source: 'fixture-a' });
  const changed = (await (await request('live', 'today', 'fixture-b')).json()) as any;
  assert.equal(changed.data[0].revenues[1].amount, 21);
});

test('historical results keep currency strings distinct and attach generic values without implicit money', async () => {
  const response = await request('historical', 'yesterday');
  assert.equal(response.status, 200);
  const result = (await response.json()) as any;
  assert.equal(result.data[0].count, 5);
  assert.equal(result.data[0].totalValue, 3);
  assert.deepEqual(result.data[0].revenues, [
    { currency: 'EUR', amount: 20 },
    { currency: 'USD', amount: 49 },
  ]);
  assert.deepEqual(result.data[1], {
    name: 'Legacy score',
    count: 4,
    totalValue: 42,
    revenues: [],
  });
});

test('failed or invalid hot income falls back counts and revenue together, not hot/cold mixed totals', async () => {
  for (const mode of ['fail-live', 'invalid-live']) {
    const response = await request(mode, 'today', mode);
    assert.equal(response.status, 200);
    const result = (await response.json()) as any;
    assert.equal(result.data[0].count, 5);
    assert.equal(result.data[0].revenues[1].amount, 49);
  }
});

test('failed cold income returns an error, never counts with fabricated empty revenue', async () => {
  for (const [mode, period] of [
    ['cold-error', 'yesterday'],
    ['fail-live-cold-error', 'today'],
  ]) {
    const response = await request(mode, period, mode);
    assert.equal(response.status, 502);
    const result = (await response.json()) as any;
    assert.equal(result.error, 'analytics query failed');
    assert.equal(result.data, undefined);
  }
});
