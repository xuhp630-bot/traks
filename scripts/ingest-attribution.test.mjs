import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

async function loadSource(path) {
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL(path, import.meta.url))],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'isolated-cloudflare-runtime',
        setup(build) {
          build.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
            path: 'workers',
            namespace: 'fixture',
          }));
          build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
            contents:
              'export class DurableObject { constructor(ctx, env) { this.ctx=ctx; this.env=env; } }',
          }));
        },
      },
    ],
  });
  const module = { exports: {} };
  new Function('module', 'exports', 'require', outputFiles[0].text)(
    module,
    module.exports,
    createRequire(import.meta.url)
  );
  return module.exports;
}

const { parsePlausible } = await loadSource('../apps/platform/collect/src/lib/plausible.ts');
const { trackingEventSchema } = await loadSource('../packages/shared/src/validation.ts');
const { buildAttributionMeta, mergeEventRevenue, sanitizeEventProps, sanitizeTrackingContext } =
  await loadSource('../packages/shared/src/attribution.ts');
const fixture = { n: 'Purchase Confirmed', u: 'https://example.test/paid', d: 'example.test' };

test('official Plausible short revenue preserves amount and currency', () => {
  const result = parsePlausible({ ...fixture, $: { currency: 'USD', amount: 49 } });
  assert.equal(result.event.ev, 49);
  assert.equal(result.event.rc, 'USD');
});

test('Plausible long revenue and all five campaign labels are accepted', () => {
  const result = parsePlausible({
    name: fixture.n,
    domain: fixture.d,
    url:
      fixture.u +
      '?utm_source=v2ex&utm_medium=referral&utm_campaign=launch&utm_content=banner_a&utm_term=compress',
    revenue: { currency: 'eur', amount: '9.99' },
  });
  assert.equal(result.event.rc, 'EUR');
  assert.equal(result.event.ev, 9.99);
  assert.equal(result.event.uct, 'banner_a');
  assert.equal(result.event.ut, 'compress');
});

test('native optional income/campaign fields do not require a new storage schema', () => {
  const result = trackingEventSchema.safeParse({
    t: 'event',
    s: 'fixture-site',
    en: 'Purchase Confirmed',
    ev: 12,
    rc: 'USD',
    uct: 'banner_a',
    ut: 'compress',
  });
  assert.equal(result.success, true);
});

test('invalid income never masquerades as valid zero-value revenue', () => {
  for (const revenue of [
    { currency: 'USD', amount: -1 },
    { currency: 'USDX', amount: 10 },
    { currency: 'USD', amount: null },
    { currency: 'USD', amount: '' },
    { currency: 'USD', amount: Infinity },
  ]) {
    assert.equal(parsePlausible({ ...fixture, revenue }).event.rc, undefined);
  }
});

test('currency metadata is first, protected, and bounded with malicious props', () => {
  const meta = buildAttributionMeta(
    {
      __traks_currency: 'CNY',
      0: 'reorder attack',
      plan: 'pro',
      email: 'fixture@example.test',
      user_id: 'fixture-account',
      nested: { token: 'fixture' },
      other: 'x'.repeat(3000),
    },
    { currency: 'USD', amount: 49, content: 'banner', term: 'compress' }
  );
  assert.ok(meta.startsWith('{"__traks_currency":"USD"'));
  assert.ok(meta.length <= 1024);
  assert.equal(JSON.parse(meta).plan, 'pro');
  assert.equal(JSON.parse(meta).email, undefined);
  assert.equal(JSON.parse(meta).user_id, undefined);
  assert.equal(JSON.parse(meta).__traks_utm_content, 'banner');
  assert.equal(JSON.parse(meta).__traks_utm_term, 'compress');
});

test('escaped campaign labels cannot exceed the metadata budget', () => {
  const meta = buildAttributionMeta(
    {},
    {
      currency: 'USD',
      amount: 0,
      content: '\u0000'.repeat(256),
      term: '\u0000'.repeat(256),
    }
  );
  assert.ok(meta.length <= 1024);
  assert.equal(JSON.parse(meta).__traks_currency, 'USD');
});

test('native malformed income drops currency marker but keeps business event', () => {
  for (const ev of [null, '', 'invalid', Infinity, -1]) {
    const result = trackingEventSchema.parse({
      t: 'event',
      s: 'fixture-site',
      en: 'Purchase Confirmed',
      ev,
      rc: 'USD',
    });
    assert.equal(result.rc, undefined);
    assert.equal(result.en, 'Purchase Confirmed');
  }
});

test('revenue is merged within currency and legacy generic values remain separate', () => {
  const result = mergeEventRevenue(
    [{ name: 'Purchase Confirmed', count: 4, totalValue: 12 }],
    [
      { name: 'Purchase Confirmed', currency: 'USD', total_value: '49' },
      { name: 'Purchase Confirmed', currency: 'CNY', totalValue: 100 },
      { name: 'Purchase Confirmed', currency: 'USD', totalValue: 0 },
      { name: 'Purchase Confirmed', currency: 'USD', totalValue: 1 },
    ]
  );
  assert.deepEqual(result[0].revenues, [
    { currency: 'CNY', amount: 100 },
    { currency: 'USD', amount: 50 },
  ]);
  assert.equal(result[0].totalValue, 12);
});

test('missing or invalid revenue data fails rather than becoming zero', () => {
  for (const totalValue of [null, undefined, Infinity, '', -1]) {
    assert.throws(() =>
      mergeEventRevenue(
        [{ name: 'Purchase Confirmed' }],
        [{ name: 'Purchase Confirmed', currency: 'USD', totalValue }]
      )
    );
  }
});

test('malformed props are discarded without losing derived currency', () => {
  assert.equal(
    buildAttributionMeta('invalid JSON', { currency: 'USD', amount: 10 }),
    '{"__traks_currency":"USD"}'
  );
  assert.deepEqual(
    sanitizeEventProps({ plan: 'pro', email_address: 'fixture@example.test', x: Infinity }),
    { plan: 'pro' }
  );
});

test('receiving boundary removes private query/referrer labels from compatible events', () => {
  const parsed = parsePlausible({
    ...fixture,
    u: 'https://example.test/account/fixture%40example.test?utm_source=fixture%40example.test&utm_campaign=launch',
    r: 'https://user:pass@ref.test/article?email=fixture#secret',
  });
  const event = sanitizeTrackingContext(parsed.event);
  assert.equal(event.p, '/[redacted]');
  assert.equal(event.us, undefined);
  assert.equal(event.uc, 'launch');
  assert.equal(event.r, 'https://ref.test/article');
});

const collector = (await loadSource('../apps/platform/collect/src/index.ts')).default;

async function ingest(body, extraHeaders = {}) {
  const records = [];
  const live = [];
  const work = [];
  let reads = 0;
  const env = {
    DB: {
      prepare() {
        reads++;
        return {
          bind() {
            return {
              async first() {
                return { tz: 'UTC', site_id: 'local-fixture', domain: 'example.test' };
              },
            };
          },
        };
      },
    },
    RATE_LIMIT: {
      async limit() {
        return { success: true };
      },
    },
    VISITOR_HASH_SECRET: 'synthetic-local-fixture-only',
    EVENTS: {
      async send(batch) {
        records.push(...batch);
      },
    },
    LIVE: {
      idFromName(value) {
        return value;
      },
      get() {
        return {
          async record(event) {
            live.push(event);
          },
        };
      },
    },
    ENVIRONMENT: 'test',
  };
  const response = await collector.fetch(
    new Request('http://local-fixture/api/event', {
      method: 'POST',
      headers: {
        origin: 'https://example.test',
        'content-type': 'text/plain',
        'user-agent': 'Mozilla/5.0 TraksLocalSyntheticFixture',
        'cf-connecting-ip': '192.0.2.1',
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    }),
    env,
    {
      waitUntil(promise) {
        work.push(promise);
      },
    }
  );
  await Promise.all(work);
  return { response, records, live, reads };
}

test('actual collector writes matching native currency/source metadata to both local sinks', async () => {
  const result = await ingest({
    t: 'event',
    s: 'fixture-key',
    p: '/paid',
    h: 'example.test',
    en: 'Purchase Confirmed',
    sid: 'fixture-session',
    us: 'v2ex',
    uct: 'banner_a',
    ut: 'compress',
    ev: 49,
    rc: 'USD',
    ep: '{"0":"prefix attack","plan":"pro","email":"fixture@example.test"}',
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.records.length, 1);
  assert.equal(result.live.length, 1);
  assert.equal(result.records[0].event_meta, result.live[0].eventMeta);
  assert.ok(result.records[0].event_meta.startsWith('{"__traks_currency":"USD"'));
  assert.equal(result.records[0].event_value, 49);
  assert.equal(result.records[0].utm_source, 'v2ex');
  assert.equal(JSON.parse(result.records[0].event_meta).email, undefined);
  assert.equal(result.records[0].ip, undefined);
  assert.equal(result.records[0].user_agent, undefined);
});

test('actual compatible ingestion cleans private context and preserves short revenue', async () => {
  const result = await ingest({
    ...fixture,
    u: 'https://example.test/account/fixture%40example.test?utm_source=fixture%40example.test&utm_campaign=launch',
    $: { currency: 'USD', amount: 49 },
  });
  assert.equal(result.response.status, 202);
  assert.equal(result.records[0].pathname, '/[redacted]');
  assert.equal(result.records[0].utm_source, '');
  assert.equal(result.records[0].utm_campaign, 'launch');
  assert.equal(JSON.parse(result.records[0].event_meta).__traks_currency, 'USD');
});

test('privacy opt-out is applied before storage/auth/body processing', async () => {
  for (const headers of [{ dnt: '1' }, { 'sec-gpc': '1' }]) {
    const result = await ingest({}, headers);
    assert.equal(result.response.status, 202);
    assert.equal(result.response.headers.get('x-plausible-dropped'), '1');
    assert.equal(result.reads, 0);
    assert.equal(result.records.length, 0);
    assert.equal(result.live.length, 0);
  }
});

test('automatic link metadata stays canonical and cannot be relabeled as income', async () => {
  const result = await ingest({
    t: 'event',
    s: 'fixture-key',
    en: 'Outbound Link: Click',
    p: '/',
    h: 'example.test',
    uct: 'banner',
    rc: 'USD',
    ev: 49,
    ep: '{"url":"https://user:pass@other.test/help?token=fixture#private"}',
  });
  assert.equal(result.records[0].event_meta, '{"url":"https://other.test/help"}');
});
