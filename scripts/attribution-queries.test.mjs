// Executes the actual TS builders and Durable Object SQL against isolated
// SQLite. R2-only timestamp/approx_distinct syntax is translated here; this
// verifies query semantics, not a live Cloudflare deployment or R2 dialect.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const modules = new Map();
class DurableObjectStub {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}
globalThis.WebSocketRequestResponsePair ??= class {};

function loadTs(filename) {
  if (modules.has(filename)) return modules.get(filename).exports;
  const module = { exports: {} };
  modules.set(filename, module);
  const code = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: filename,
  }).outputText;
  const localRequire = name => {
    if (name === 'cloudflare:workers') return { DurableObject: DurableObjectStub };
    if (name === '@traks/shared') return loadTs(path.join(root, 'packages/shared/src/index.ts'));
    if (name.startsWith('.')) return loadTs(path.resolve(path.dirname(filename), `${name}.ts`));
    return require(name);
  };
  new Function('require', 'module', 'exports', code)(localRequire, module, module.exports);
  return module.exports;
}

const queries = loadTs(path.join(root, 'packages/shared/src/queries.ts'));
const { SiteLiveStore } = loadTs(path.join(root, 'apps/platform/collect/src/live-store.ts'));
queries.setIngestPrune(false);
const from = Date.parse('2026-10-13T00:00:00Z');
const to = from + 24 * 60 * 60 * 1000;
const range = {
  from: new Date(from).toISOString(),
  to: new Date(to).toISOString(),
  granularity: 'hour',
  buckets: [],
  tz: 'UTC',
  days: 1,
};
const filters = { utm_source: 'demo_a' };
const goal = { id: 'g', type: 'event', target: 'Purchase Confirmed' };
const funnel = [
  { type: 'page', target: '/entry' },
  { type: 'event', target: 'Purchase Confirmed' },
];

function r2SqlToSqlite(sql) {
  return sql
    .replace(/TIMESTAMP '([^']+)'/g, (_, value) => String(Date.parse(value)))
    .replace(/\bapprox_distinct\(/g, 'COUNT(DISTINCT ');
}

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE cold_events (
    site_id TEXT NOT NULL, ts INTEGER NOT NULL, date_key TEXT NOT NULL,
    hour_key TEXT NOT NULL, week_key TEXT NOT NULL DEFAULT '',
    event_type TEXT NOT NULL, pathname TEXT NOT NULL DEFAULT '',
    referrer_hostname TEXT NOT NULL DEFAULT '',
    utm_source TEXT NOT NULL DEFAULT '', utm_medium TEXT NOT NULL DEFAULT '',
    utm_campaign TEXT NOT NULL DEFAULT '', country TEXT NOT NULL DEFAULT '',
    region TEXT NOT NULL DEFAULT '', city TEXT NOT NULL DEFAULT '',
    browser TEXT NOT NULL DEFAULT '', os TEXT NOT NULL DEFAULT '',
    device_type TEXT NOT NULL DEFAULT '', screen_width INTEGER NOT NULL DEFAULT 0,
    session_id TEXT NOT NULL DEFAULT '', visitor_id TEXT NOT NULL DEFAULT '',
    event_name TEXT NOT NULL DEFAULT '', event_value REAL NOT NULL DEFAULT 0,
    event_meta TEXT NOT NULL DEFAULT ''
  )`);
  const storageSql = {
    exec(sql, ...args) {
      let rows;
      if (/^\s*CREATE TABLE/.test(sql)) {
        db.exec(sql);
        rows = [];
      } else {
        rows = db
          .prepare(sql)
          .all(...args)
          .map(row => ({ ...row }));
      }
      return { toArray: () => rows, one: () => rows[0] };
    },
  };
  const live = new SiteLiveStore(
    {
      storage: { sql: storageSql },
      setWebSocketAutoResponse() {},
    },
    {}
  );
  const columns = db
    .prepare("SELECT name FROM pragma_table_info('events')")
    .all()
    .map(r => r.name);
  const seed = overrides => {
    const ts = overrides.ts ?? from + 1000;
    const row = {
      site_id: 'demo_site',
      ts,
      date_key: new Date(ts).toISOString().slice(0, 10),
      hour_key: new Date(ts).toISOString().slice(0, 13),
      event_type: 'pageview',
      pathname: '/entry',
      referrer_hostname: '',
      utm_source: '',
      utm_medium: '',
      utm_campaign: '',
      country: 'US',
      region: '',
      city: '',
      browser: 'Chrome',
      os: 'Linux',
      device_type: 'desktop',
      screen_width: 1440,
      session_id: 'demo_session',
      visitor_id: 'demo_visitor',
      event_name: '',
      event_value: 0,
      event_meta: '',
      ...overrides,
    };
    const coldCols = Object.keys(row);
    db.prepare(
      `INSERT INTO cold_events (${coldCols.join(',')}) VALUES (${coldCols.map(() => '?').join(',')})`
    ).run(...coldCols.map(column => row[column]));
    if (row.site_id === 'demo_site') {
      const liveCols = columns.filter(column => row[column] !== undefined);
      db.prepare(
        `INSERT INTO events (${liveCols.join(',')}) VALUES (${liveCols.map(() => '?').join(',')})`
      ).run(...liveCols.map(column => row[column]));
    }
  };
  const pv = overrides => seed({ utm_source: 'demo_a', ...overrides });
  const event = overrides =>
    seed({
      ts: from + 2000,
      event_type: 'event',
      pathname: '/done',
      event_name: 'Purchase Confirmed',
      event_meta: '{"plan":"pro"}',
      ...overrides,
    });
  const cold = builder =>
    db
      .prepare(r2SqlToSqlite(builder('cold_events')))
      .all()
      .map(r => ({ ...r }));
  return { db, live, seed, pv, event, cold };
}

async function expectConversions(f, count, selectedFilters = filters, selectedRange = range) {
  const cold = f.cold(
    queries.buildGoalEventsQuery('demo_site', selectedRange, [goal.target], selectedFilters)
  );
  assert.equal(cold[0]?.events ?? 0, count);
  const rows = await f.live.goalStats(
    Date.parse(selectedRange.from),
    Date.parse(selectedRange.to),
    [goal],
    selectedFilters
  );
  assert.equal(rows[0]?.events ?? 0, count);
  const coldEvents = f.cold(queries.buildEventsQuery('demo_site', selectedRange, selectedFilters));
  const liveEvents = await f.live.customEvents(
    Date.parse(selectedRange.from),
    Date.parse(selectedRange.to),
    20,
    selectedFilters
  );
  assert.equal(coldEvents.find(r => r.name === goal.target)?.count ?? 0, count);
  assert.equal(liveEvents.find(r => r.name === goal.target)?.count ?? 0, count);
}

test('legacy blank event recovers only the existing visitor/session entry channel', async t => {
  const f = fixture(t);
  f.pv({ referrer_hostname: 'demo.example', utm_medium: 'referral' });
  f.event();
  await expectConversions(f, 1, {
    ...filters,
    referrer_hostname: 'demo.example',
    utm_medium: 'referral',
  });
  assert.equal((await f.live.totals(from, to, filters)).visitors, 1);
  assert.equal(f.cold(queries.buildFunnelQuery('demo_site', range, funnel, filters))[0].c1, 1);
});

test('property and consolidated special goals retain channel recovery', async t => {
  const f = fixture(t);
  f.pv();
  f.event();
  const propGoal = { ...goal, propKey: 'plan', propValue: 'pro' };
  assert.equal(
    f.cold(
      queries.buildGoalEventPropQuery('demo_site', range, goal.target, 'plan', 'pro', filters)
    )[0].events,
    1
  );
  assert.equal(
    f.cold(queries.buildSpecialGoalsQuery('demo_site', range, [propGoal], filters))[0].events_0,
    1
  );
  assert.equal((await f.live.goalStats(from, to, [propGoal], filters))[0].events, 1);
});

test('session-id collision never joins different visitor identities', async t => {
  const f = fixture(t);
  f.pv();
  f.event({ visitor_id: 'different_visitor' });
  await expectConversions(f, 0);
});

test('missing visitor or session leaves untagged events unknown', async t => {
  const f = fixture(t);
  f.pv();
  f.event({ visitor_id: '' });
  f.event({ session_id: '' });
  await expectConversions(f, 0);
  await expectConversions(f, 2, {});
});

test('future pageview cannot attribute an earlier event', async t => {
  const f = fixture(t);
  f.pv({ ts: from + 3000 });
  f.event();
  await expectConversions(f, 0);
});

test('entry pageview outside the report window cannot silently extend attribution', async t => {
  const f = fixture(t);
  f.pv({ ts: from - 1000 });
  f.event();
  await expectConversions(f, 0);
});

test('same ids on different dates do not cross-join attribution', async t => {
  const f = fixture(t);
  f.pv();
  f.event({ ts: to + 2000 });
  const twoDay = { ...range, to: new Date(to + 86400000).toISOString(), days: 2 };
  await expectConversions(f, 0, filters, twoDay);
});

test('different first touches at the same timestamp are ambiguous', async t => {
  const f = fixture(t);
  f.pv();
  f.pv({ utm_source: 'demo_b' });
  f.event();
  await expectConversions(f, 0);
});

test('conflicting later nonempty channel touches reject legacy fallback', async t => {
  const f = fixture(t);
  f.pv();
  f.pv({ ts: from + 1500, utm_source: 'demo_b' });
  f.event();
  await expectConversions(f, 0);
});

test('later missing navigation tags are not invented as a new touch', async t => {
  const f = fixture(t);
  f.pv();
  f.pv({ ts: from + 1500, utm_source: '', pathname: '/next' });
  f.event();
  await expectConversions(f, 1);
});

test('ongoing session is not incorrectly capped to 30-minute total lifetime', async t => {
  const f = fixture(t);
  f.pv();
  f.event({ ts: from + 7200000 });
  await expectConversions(f, 1);
});

test('explicit event touch takes precedence and does not mix missing fields', async t => {
  const f = fixture(t);
  f.pv({ referrer_hostname: 'demo.example' });
  f.event({ utm_source: 'demo_b' });
  await expectConversions(f, 0, { referrer_hostname: 'demo.example' });
  await expectConversions(f, 0);
  await expectConversions(f, 1, { utm_source: 'demo_b' });
});

test('duplicate identical entry rows do not multiply event counts', async t => {
  const f = fixture(t);
  f.pv();
  f.pv();
  f.event();
  await expectConversions(f, 1);
});

test('pathname filter remains a strict event-step filter, not a cohort rewrite', async t => {
  const f = fixture(t);
  f.pv();
  f.event();
  await expectConversions(f, 0, { ...filters, pathname: '/entry' });
  assert.equal(
    f.cold(
      queries.buildFunnelQuery('demo_site', range, funnel, { ...filters, pathname: '/entry' })
    )[0].c1,
    0
  );
  await expectConversions(f, 1, { ...filters, pathname: '/done' });
});

test('site boundary is preserved in historical fallback', async t => {
  const f = fixture(t);
  f.pv({ site_id: 'another_site' });
  f.event();
  await expectConversions(f, 0);
});

test('channel filter values are escaped/bound instead of becoming SQL', async t => {
  const f = fixture(t);
  f.pv();
  f.event();
  await expectConversions(f, 0, { utm_source: "demo_a' OR 1=1 --" });
});

test('funnel cannot merge steps from different visitors sharing a session id', t => {
  const f = fixture(t);
  f.pv();
  f.event({ visitor_id: 'different_visitor' });
  const row = f.cold(queries.buildFunnelQuery('demo_site', range, funnel))[0];
  assert.equal(row.c0, 1);
  assert.equal(row.c1, 0);
});

test('funnel cannot merge steps across calendar days', t => {
  const f = fixture(t);
  f.pv();
  f.event({ ts: to + 2000 });
  const twoDay = { ...range, to: new Date(to + 86400000).toISOString(), days: 2 };
  assert.equal(f.cold(queries.buildFunnelQuery('demo_site', twoDay, funnel))[0].c1, 0);
});

test('funnel still rejects reversed first-occurrence ordering', t => {
  const f = fixture(t);
  f.pv({ ts: from + 3000 });
  f.event();
  assert.equal(f.cold(queries.buildFunnelQuery('demo_site', range, funnel))[0].c1, 0);
});

test('same-timestamp funnel steps do not prove an ordered completion', t => {
  const f = fixture(t);
  f.pv();
  f.event({ ts: from + 1000 });
  for (const selectedFilters of [undefined, filters]) {
    const row = f.cold(queries.buildFunnelQuery('demo_site', range, funnel, selectedFilters))[0];
    assert.equal(row.c0, 1);
    assert.equal(row.c1, 0);
  }
});

test('duplicate funnel steps cannot reuse one first occurrence as two ordered steps', t => {
  const f = fixture(t);
  f.event({ ts: from + 1000 });
  f.event({ ts: from + 2000 });
  const repeated = [
    { type: 'event', target: goal.target },
    { type: 'event', target: goal.target },
  ];
  const row = f.cold(queries.buildFunnelQuery('demo_site', range, repeated))[0];
  assert.equal(row.c0, 1);
  assert.equal(row.c1, 0);
});

test('overlapping funnel predicates cannot turn one pageview into an ordered path', t => {
  const f = fixture(t);
  f.pv();
  const overlapping = [
    { type: 'page', target: '/entry' },
    { type: 'page', target: '/entry/*' },
  ];
  const row = f.cold(queries.buildFunnelQuery('demo_site', range, overlapping, filters))[0];
  assert.equal(row.c0, 1);
  assert.equal(row.c1, 0);
});

test('first-occurrence approximation does not replay a later successful retry', t => {
  const f = fixture(t);
  f.event({ ts: from + 1000 });
  f.pv({ ts: from + 2000 });
  f.event({ ts: from + 3000 });
  const row = f.cold(queries.buildFunnelQuery('demo_site', range, funnel))[0];
  assert.equal(row.c0, 1);
  assert.equal(row.c1, 0);
});

test('revenue groups by original currency and is excluded from generic value sums', async t => {
  const f = fixture(t);
  f.pv();
  f.event({ event_meta: '{"__traks_currency":"USD","plan":"pro"}', event_value: 49 });
  f.event({ event_meta: '{"__traks_currency":"USD","plan":"team"}', event_value: 10 });
  f.event({ event_meta: '{"__traks_currency":"CNY"}', event_value: 100 });
  f.event({ event_meta: '{"plan":"pro"}', event_value: 7 });
  const cold = f.cold(queries.buildEventRevenueQuery('demo_site', range, filters));
  const live = await f.live.eventRevenue(from, to, filters);
  assert.deepEqual(cold, [
    { name: goal.target, currency: 'CNY', count: 1, total_value: 100 },
    { name: goal.target, currency: 'USD', count: 2, total_value: 59 },
  ]);
  assert.deepEqual(
    live
      .map(r => ({ ...r, total_value: r.totalValue, totalValue: undefined }))
      .map(({ totalValue, ...r }) => r),
    cold
  );
  assert.equal(f.cold(queries.buildEventsQuery('demo_site', range, filters))[0].total_value, 7);
  assert.equal((await f.live.customEvents(from, to, 20, filters))[0].totalValue, 7);
});

test('zero revenue is retained without treating it as an absent currency', async t => {
  const f = fixture(t);
  f.pv();
  f.event({ event_meta: '{"__traks_currency":"USD"}', event_value: 0 });
  assert.equal(f.cold(queries.buildEventRevenueQuery('demo_site', range, filters))[0].count, 1);
  assert.equal((await f.live.eventRevenue(from, to, filters))[0].totalValue, 0);
});

test('malformed/noncanonical currency markers stay generic rather than false income', async t => {
  const f = fixture(t);
  f.pv();
  for (const meta of [
    '{"__traks_currency":"usd"}',
    '{"__traks_currency":"USDD"}',
    '{"__traks_currency":"U1D"}',
    '{"plan":"pro","__traks_currency":"USD"}',
    '{"__traks_currency":"USD"bad}',
  ])
    f.event({ event_meta: meta, event_value: 1 });
  assert.deepEqual(f.cold(queries.buildEventRevenueQuery('demo_site', range, filters)), []);
  assert.deepEqual(await f.live.eventRevenue(from, to, filters), []);
  assert.equal(f.cold(queries.buildEventsQuery('demo_site', range, filters))[0].total_value, 5);
});

test('income aggregation is not truncated by high-cardinality nonpersonal props', async t => {
  const f = fixture(t);
  f.pv();
  for (let i = 0; i < 520; i++)
    f.event({
      event_meta: JSON.stringify({ __traks_currency: 'USD', variant: `demo_${i}` }),
      event_value: 1,
    });
  assert.equal(
    f.cold(queries.buildEventRevenueQuery('demo_site', range, filters))[0].total_value,
    520
  );
  assert.equal((await f.live.eventRevenue(from, to, filters))[0].totalValue, 520);
});

test('Top-N limits event names but preserves every currency for each selected name', async t => {
  const f = fixture(t);
  f.pv();
  for (const currency of ['USD', 'CNY', 'EUR'])
    f.event({
      event_meta: JSON.stringify({ __traks_currency: currency }),
      event_value: 1,
    });
  f.event({ event_name: 'Other', event_meta: '{"__traks_currency":"GBP"}', event_value: 10 });
  assert.equal(
    f.cold(queries.buildEventsQuery('demo_site', range, filters, 1))[0].name,
    goal.target
  );
  const revenues = f.cold(queries.buildEventRevenueQuery('demo_site', range, filters, 1));
  assert.equal(revenues.length, 3);
  assert.ok(revenues.every(r => r.name === goal.target));
});

test('event meta and outbound-link panels share channel-filter event population', async t => {
  const f = fixture(t);
  f.pv();
  f.event({ event_name: 'Outbound Link: Click', event_meta: '{"url":"https://demo.example"}' });
  assert.equal(
    f.cold(queries.buildLinkEventsQuery('demo_site', range, 'Outbound Link: Click', filters))[0]
      .clicks,
    1
  );
  assert.equal(
    (await f.live.linkClicks('Outbound Link: Click', from, to, 10, filters))[0].clicks,
    1
  );
  assert.equal(
    f.cold(queries.buildEventMetaQuery('demo_site', range, 'Outbound Link: Click', filters))[0]
      .events,
    1
  );
  assert.equal(
    (await f.live.eventMetaGroups('Outbound Link: Click', from, to, 10, filters))[0].events,
    1
  );
});

test('engagement comparison windows use the same event channel scope', async t => {
  const f = fixture(t);
  f.pv({ ts: from - 2000 });
  f.event({ ts: from - 1000, event_type: 'engagement', event_value: 3 });
  f.pv();
  f.event({ event_type: 'engagement', event_value: 4 });
  const cold = f.cold(queries.buildEngagementStatsQuery('demo_site', range, filters));
  assert.equal(cold.find(row => row.period === 'previous').engaged, 3);
  assert.equal(cold.find(row => row.period === 'current').engaged, 4);
  const live = await f.live.mainStats(from - 86400000, from, to, filters, from);
  assert.equal(live.previous.engagedSeconds, 3);
  assert.equal(live.current.engagedSeconds, 4);
});

test('WebMCP duration panel retains channel recovery without changing tool metadata', async t => {
  const f = fixture(t);
  f.pv();
  f.event({
    event_name: 'WebMCP: Tool Call',
    event_meta: '{"tool":"demo_tool","status":"ok"}',
    event_value: 42,
  });
  const cold = f.cold(queries.buildWebmcpQuery('demo_site', range, filters));
  const live = await f.live.webmcpMeta(from, to, filters);
  assert.equal(cold[0].calls, 1);
  assert.equal(cold[0].total_ms, 42);
  assert.equal(live[0].calls, 1);
  assert.equal(live[0].totalMs, 42);
  assert.equal(live[0].meta, '{"tool":"demo_tool","status":"ok"}');
});

test('production page-event coverage retains attribution and excludes monetary values', async t => {
  const f = fixture(t);
  f.pv({ referrer_hostname: 'demo.example', utm_medium: 'referral', utm_campaign: 'launch' });
  f.event({ event_meta: '{"__traks_currency":"USD"}', event_value: 49 });
  f.event({ event_meta: '{"__traks_currency":"CNY"}', event_value: 100 });
  f.event({ event_meta: '{"plan":"pro"}', event_value: 7 });
  const selected = {
    referrer_hostname: 'demo.example',
    utm_source: 'demo_a',
    utm_medium: 'referral',
    utm_campaign: 'launch',
  };
  const cold = f.cold(queries.buildEventPagesQuery('demo_site', range, selected));
  const live = await f.live.eventPages(from, to, 1000, selected);
  assert.deepEqual(cold, [{ name: goal.target, pathname: '/done', count: 3, total_value: 7 }]);
  assert.deepEqual(live, [{ name: goal.target, pathname: '/done', count: 3, totalValue: 7 }]);
});

test('production event explorer and revenue preserve the 500 event-name scope', async t => {
  const f = fixture(t);
  f.pv();
  for (let i = 0; i < 150; i++)
    f.event({
      event_name: `Event ${String(i).padStart(3, '0')}`,
      event_meta: '{"__traks_currency":"USD"}',
      event_value: 1,
    });
  assert.equal(f.cold(queries.buildEventsQuery('demo_site', range, filters, 500)).length, 150);
  assert.equal((await f.live.customEvents(from, to, 500, filters)).length, 150);
  assert.equal(
    f.cold(queries.buildEventRevenueQuery('demo_site', range, filters, 500)).length,
    150
  );
  assert.equal((await f.live.eventRevenue(from, to, filters)).length, 150);
});
