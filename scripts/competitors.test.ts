import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { competitorInput, type CompetitorSnapshot } from '../packages/shared/src/competitors';
import {
  publicPageUrl,
  isPublicAddress,
  limitedText,
  snapshotChanges,
  CompetitorFetchError,
} from '../apps/platform/api/src/lib/competitor-fetch';
import {
  checkCompetitor,
  competitorHistory,
  competitorReport,
  runCompetitorSchedule,
  HOST_COOLDOWN_MS,
} from '../apps/platform/api/src/lib/competitors';
import { hashToken } from '../apps/platform/api/src/lib/tokens';
import type { Bindings } from '../apps/platform/api/src/types';

let runtime: Miniflare;
let database: Bindings['DB'];
let env: Bindings;
const instant = Date.UTC(2026, 8, 1);
const snapshot: CompetitorSnapshot = {
  title: 'Fixture plan',
  h1: 'Plans',
  description: 'Public plans',
  canonical: 'https://fixture.example.com/pricing',
  robots: 'index',
  regionText: '$20 monthly',
  contentHash: 'baseline-hash',
  contentCharacters: 11,
};
const success = async () => ({ snapshot, httpStatus: 200 });
const failure = async () => {
  throw new CompetitorFetchError('http_error', 503);
};

before(async () => {
  const bundle = await build({
    entryPoints: ['scripts/competitor-worker-fixture.ts'],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    conditions: ['workerd', 'worker', 'browser'],
    target: 'es2022',
    external: ['node:*', 'cloudflare:*'],
    logLevel: 'silent',
  });
  runtime = new Miniflare({
    modules: [
      { type: 'ESModule', path: 'competitor-test.mjs', contents: bundle.outputFiles[0].text },
    ],
    compatibilityDate: '2026-07-02',
    compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'],
    d1Databases: ['DB'],
    bindings: {
      ENVIRONMENT: 'development',
      BETTER_AUTH_SECRET: 'local-fixture-only-not-a-production-secret',
      COMPETITOR_ALLOWED_HOSTS: 'fixture.example.com',
    },
    outboundService: () => {
      throw new Error('Unexpected network access in isolated tests');
    },
  });
  database = (await runtime.getD1Database('DB')) as unknown as Bindings['DB'];
  env = { DB: database, COMPETITOR_ALLOWED_HOSTS: 'fixture.example.com' } as Bindings;
  const folder = 'apps/platform/api/src/db/migrations';
  for (const filename of (await readdir(folder)).filter(name => name.endsWith('.sql')).sort()) {
    const sql = await readFile(`${folder}/${filename}`, 'utf8');
    for (const statement of sql
      .split('--> statement-breakpoint')
      .map(part => part.trim())
      .filter(Boolean)) {
      await database.prepare(statement).run();
    }
  }
  await database.batch([
    database.prepare(
      "INSERT INTO users (id,email,name,email_verified) VALUES ('owner','owner@fixture.test','Fixture owner',1),('member','member@fixture.test','Fixture member',1)"
    ),
    database.prepare(
      "INSERT INTO workspaces (id,name,slug) VALUES ('workspace','Fixture','fixture'),('outside','Outside','outside')"
    ),
    database.prepare(
      "INSERT INTO workspace_members (id,workspace_id,user_id,role) VALUES ('membership-owner','workspace','owner','owner'),('membership-member','workspace','member','member'),('membership-outside','outside','owner','owner')"
    ),
    database.prepare(
      "INSERT INTO sites (id,user_id,workspace_id,name,domain) VALUES ('site','owner','workspace','Fixture site','owned.fixture.test'),('other-site','owner','workspace','Other site','other.fixture.test'),('outside-site','owner','outside','Outside site','outside.fixture.test')"
    ),
  ]);
  for (const [label, user, scope] of [
    ['owner', 'owner', 'manage'],
    ['member', 'member', 'manage'],
    ['reader', 'owner', 'read'],
  ]) {
    await database
      .prepare(
        'INSERT INTO api_tokens (id,user_id,workspace_id,name,token_hash,suffix,scope) VALUES (?,?,?,?,?,?,?)'
      )
      .bind(
        `token-${label}`,
        user,
        'workspace',
        'Local fixture',
        await hashToken(`traks_pat_local_fixture_${label}`),
        'test',
        scope
      )
      .run();
  }
});
after(async () => {
  await runtime?.dispose();
});
beforeEach(async () => {
  await database.prepare('DELETE FROM competitor_monitors').run();
});

async function monitor(
  id = 'monitor',
  hostname = 'fixture.example.com',
  cadence = 'manual',
  due: number | null = null,
  siteId = 'site'
) {
  await database
    .prepare(
      'INSERT INTO competitor_monitors (id,site_id,name,url,hostname,selector,cadence,created_at,next_check_at) VALUES (?,?,?,?,?,?,?,?,?)'
    )
    .bind(
      id,
      siteId,
      `Fixture ${id}`,
      `https://${hostname}/${id}`,
      hostname,
      'main',
      cadence,
      instant,
      due
    )
    .run();
}
async function request(
  path: string,
  method = 'GET',
  body?: unknown,
  token = 'owner',
  headers: Record<string, string> = {}
) {
  return runtime.dispatchFetch(`http://localhost${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer traks_pat_local_fixture_${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
async function capture(input: object) {
  return (
    await request('/__fixture/capture', 'POST', {
      url: 'https://fixture.example.com/pricing',
      ...input,
    })
  ).json() as Promise<{
    error?: string;
    httpStatus?: number;
    snapshot?: CompetitorSnapshot;
    calls: { url: string; headers: Record<string, string>; redirect: string; hasSignal: boolean }[];
  }>;
}

test('URL and selector contract permits only bounded public HTTPS page definitions', () => {
  assert.equal(
    publicPageUrl('https://fixture.example.com/pricing').href,
    'https://fixture.example.com/pricing'
  );
  for (const url of [
    'http://fixture.example.com/',
    'https://localhost/',
    'https://127.0.0.1/',
    'https://2130706433/',
    'https://[::1]/',
    'https://a.internal/',
    'https://user:pass@fixture.example.com/',
    'https://fixture.example.com:8443/',
    'https://fixture.example.com/?key=test',
    'https://fixture.example.com/#token',
    'https://fixture.example.com/admin',
    'https://fixture.example.com/%2561dmin',
    'https://fixture.example.com/%2fauth/callback',
    'https://fixture.example.com/\\login',
    'https://fixture.example.com/log\nin',
  ]) {
    assert.throws(() => publicPageUrl(url), CompetitorFetchError, url);
  }
  for (const selector of ['main', '.pricing', '#plans'])
    assert.equal(
      competitorInput.safeParse({ name: 'Pricing', url: 'https://fixture.example.com/', selector })
        .success,
      true
    );
  for (const selector of ['main script', '*', '', '[data-secret]', 'main, body'])
    assert.equal(
      competitorInput.safeParse({ name: 'Pricing', url: 'https://fixture.example.com/', selector })
        .success,
      false
    );
  assert.equal(
    competitorInput.safeParse({ name: 'Pricing', url: 'https://fixture.example.com/', headers: {} })
      .success,
    false
  );
});

test('network classification blocks private, mapped, multicast, link-local and reserved addresses', () => {
  for (const address of [
    '127.0.0.1',
    '10.1.2.3',
    '172.16.1.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.1.1',
    '224.0.0.1',
    '0.0.0.0',
    '::1',
    'fc00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '2001:db8::1',
    'not-an-ip',
  ])
    assert.equal(isPublicAddress(address), false, address);
  for (const address of ['93.184.216.34', '2606:4700:4700::1111'])
    assert.equal(isPublicAddress(address), true, address);
});

test('bounded streaming rejects declared and actual excessive bytes', async () => {
  await assert.rejects(
    limitedText(new Response('short', { headers: { 'content-length': '100' } }), 10),
    { code: 'response_too_large' }
  );
  await assert.rejects(limitedText(new Response('01234567890'), 10), {
    code: 'response_too_large',
  });
  assert.equal(await limitedText(new Response('hello'), 10), 'hello');
});

for (const [name, input, error, requests] of [
  ['unapproved host', { allowed: [] }, 'host_not_approved', 0],
  ['private DNS', { addresses: ['93.184.216.34', '127.0.0.1'] }, 'dns_non_public', 1],
  ['no DNS answers', { addresses: null }, 'dns_unavailable', 2],
  ['DNS error', { dnsStatus: 3 }, 'dns_unavailable', 1],
  ['truncated DNS', { truncated: true }, 'dns_unavailable', 1],
  ['robots denial', { robots: 'User-agent: *\nDisallow: /' }, 'robots_denied', 3],
  ['robots redirect', { robotsStatus: 301 }, 'robots_unavailable', 3],
  ['robots server error', { robotsStatus: 500 }, 'robots_unavailable', 3],
  ['robots HTML fallback', { robotsType: 'text/html' }, 'robots_unavailable', 3],
  [
    'crawl delay',
    { robots: 'User-agent: *\nCrawl-delay: 1' },
    'crawl_delay_requires_external_service',
    3,
  ],
  ['page redirect', { status: 302 }, 'redirect_not_followed', 4],
  ['page 404', { status: 404 }, 'http_error', 4],
  ['page 429', { status: 429 }, 'rate_limited', 4],
  ['not HTML', { contentType: 'application/pdf' }, 'html_required', 4],
  ['large page', { contentLength: 600_000 }, 'response_too_large', 4],
  ['missing selector', { html: '<body>JS shell</body>' }, 'selector_missing_or_empty', 4],
  ['empty selector', { html: '<main> </main>' }, 'selector_missing_or_empty', 4],
  ['timeout', { timeout: true }, 'TimeoutError', 4],
] as const) {
  test(`capture fails closed: ${name}`, async () => {
    const result = await capture(input);
    assert.equal(result.error, error);
    assert.equal(result.calls.length, requests);
    assert.equal(result.snapshot, undefined);
  });
}

test('Worker HTMLRewriter extracts evidence, removes hidden/script text and never forwards credentials', async () => {
  const result = await capture({
    html: '<title> Public title </title><meta name="description" content="Public description"><meta name="robots" content="noindex"><link rel="canonical" href="/pricing?tracking=omit"><main><h1>Plans</h1> Visible <script>private-script</script><p hidden>hidden-text</p><span aria-hidden="true">invisible</span><p>$20 monthly</p></main>',
  });
  assert.equal(result.error, undefined);
  assert.equal(result.snapshot?.title, 'Public title');
  assert.equal(result.snapshot?.h1, 'Plans');
  assert.equal(result.snapshot?.description, 'Public description');
  assert.equal(result.snapshot?.robots, 'noindex');
  assert.equal(result.snapshot?.canonical, 'https://fixture.example.com/pricing');
  assert.match(result.snapshot!.contentHash, /^[a-f0-9]{64}$/);
  assert.ok(!/private-script|hidden-text|invisible/.test(result.snapshot!.regionText));
  for (const call of result.calls) {
    assert.equal(call.redirect, 'manual');
    assert.equal(call.hasSignal, true);
    assert.equal(call.headers.cookie, undefined);
    assert.equal(call.headers.authorization, undefined);
  }
  assert.equal(result.calls.at(-1)?.headers['user-agent'], 'TraksCompetitorMonitor/1.0');
  assert.equal((await capture({ robotsStatus: 404 })).error, undefined);
});

test('normalization avoids whitespace noise but detects changes beyond retained excerpts', async () => {
  const first = (await capture({ html: `<main>${'a'.repeat(650)} first</main>` })).snapshot!;
  const spaced = (await capture({ html: `<main>  ${'a'.repeat(650)}    first  </main>` }))
    .snapshot!;
  const second = (await capture({ html: `<main>${'a'.repeat(650)} second</main>` })).snapshot!;
  assert.equal(first.regionText.length, 600);
  assert.deepEqual(snapshotChanges(first, spaced), []);
  assert.ok(snapshotChanges(first, second).includes('contentHash'));
  assert.equal(first.regionText, second.regionText);
});

test('D1 history preserves baseline, unchanged, changed, failed and recovered states', async () => {
  await monitor();
  assert.equal(
    (await checkCompetitor(env, 'monitor', 'site', success, instant))?.status,
    'baseline'
  );
  assert.equal(
    (await checkCompetitor(env, 'monitor', 'site', success, instant + HOST_COOLDOWN_MS))?.status,
    'unchanged'
  );
  const updated = { ...snapshot, title: 'New plan' };
  const changed = await checkCompetitor(
    env,
    'monitor',
    'site',
    async () => ({ snapshot: updated, httpStatus: 200 }),
    instant + HOST_COOLDOWN_MS * 2
  );
  assert.deepEqual(changed?.changes, ['title']);
  assert.equal(changed?.previousCheckedAt, instant + HOST_COOLDOWN_MS);
  assert.equal(
    (await checkCompetitor(env, 'monitor', 'site', failure, instant + HOST_COOLDOWN_MS * 3))
      ?.status,
    'error'
  );
  const recovered = await checkCompetitor(
    env,
    'monitor',
    'site',
    success,
    instant + HOST_COOLDOWN_MS * 4
  );
  assert.equal(recovered?.previous?.title, 'New plan');
  assert.equal(recovered?.previousCheckedAt, instant + HOST_COOLDOWN_MS * 2);
  assert.equal((await competitorHistory(database, 'monitor')).length, 5);
});

test('atomic lease prevents duplicate and concurrent same-host scans, including cross-site scans', async () => {
  await monitor();
  await monitor('same-host', 'fixture.example.com', 'manual', null, 'other-site');
  let captures = 0;
  const counted = async () => {
    captures++;
    return success();
  };
  const results = await Promise.all([
    checkCompetitor(env, 'monitor', 'site', counted, instant),
    checkCompetitor(env, 'monitor', 'site', counted, instant),
    checkCompetitor(env, 'same-host', 'other-site', counted, instant),
  ]);
  assert.equal(captures, 1);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(
    await checkCompetitor(env, 'monitor', 'wrong-site', counted, instant + HOST_COOLDOWN_MS),
    null
  );
});

test('expired worker cannot overwrite a newer lease or publish stale evidence', async () => {
  await monitor();
  const capture = async () => {
    await database
      .prepare('UPDATE competitor_monitors SET lease_until = ? WHERE id = ?')
      .bind(instant + 200_000, 'monitor')
      .run();
    return success();
  };
  assert.equal(await checkCompetitor(env, 'monitor', 'site', capture, instant), null);
  assert.deepEqual(await competitorHistory(database, 'monitor'), []);
  assert.equal(
    (
      await database
        .prepare('SELECT last_success_snapshot AS snapshot FROM competitor_monitors')
        .first()
    )?.snapshot,
    null
  );
});

test('60-record retention never erases the successful comparison baseline during outages', async () => {
  await monitor();
  await checkCompetitor(env, 'monitor', 'site', success, instant);
  for (let index = 1; index <= 61; index++)
    await checkCompetitor(env, 'monitor', 'site', failure, instant + index * HOST_COOLDOWN_MS);
  const retained = await competitorHistory(database, 'monitor');
  assert.equal(retained.length, 60);
  assert.ok(retained.every(check => check.status === 'error'));
  const recovered = await checkCompetitor(
    env,
    'monitor',
    'site',
    success,
    instant + 62 * HOST_COOLDOWN_MS
  );
  assert.equal(recovered?.status, 'unchanged');
  assert.equal(recovered?.previousCheckedAt, instant);
  await database.prepare('DELETE FROM competitor_monitors WHERE id = ?').bind('monitor').run();
  assert.deepEqual(await competitorHistory(database, 'monitor'), []);
});

test('scheduler is opt-in, allows only approved due targets and respects daily/weekly cadence', async () => {
  await monitor('daily', 'daily.example.com', 'daily', instant);
  await monitor('weekly', 'weekly.example.com', 'weekly', instant);
  await monitor('manual', 'manual.example.com');
  await monitor('future', 'future.example.com', 'daily', instant + 1);
  await monitor('unapproved', 'unapproved.example.com', 'daily', instant);
  const allowed = 'daily.example.com,weekly.example.com,manual.example.com,future.example.com';
  await runCompetitorSchedule({ ...env, COMPETITOR_ALLOWED_HOSTS: allowed }, success, instant);
  await runCompetitorSchedule(
    { ...env, COMPETITOR_ALLOWED_HOSTS: '', COMPETITOR_SCHEDULE_ENABLED: 'true' },
    success,
    instant
  );
  assert.equal(
    (await database.prepare('SELECT count(*) AS count FROM competitor_snapshots').first())?.count,
    0
  );
  await runCompetitorSchedule(
    { ...env, COMPETITOR_ALLOWED_HOSTS: allowed, COMPETITOR_SCHEDULE_ENABLED: 'true' },
    success,
    instant
  );
  assert.equal((await competitorHistory(database, 'daily')).length, 1);
  assert.equal((await competitorHistory(database, 'weekly')).length, 1);
  for (const id of ['manual', 'future', 'unapproved'])
    assert.deepEqual(await competitorHistory(database, id), []);
  assert.equal(
    (
      await database
        .prepare("SELECT next_check_at AS due FROM competitor_monitors WHERE id = 'daily'")
        .first()
    )?.due,
    instant + 86_400_000
  );
  assert.equal(
    (
      await database
        .prepare("SELECT next_check_at AS due FROM competitor_monitors WHERE id = 'weekly'")
        .first()
    )?.due,
    instant + 7 * 86_400_000
  );
});

test('trend distinguishes unobserved days and all-failed days from unchanged content', async () => {
  await monitor();
  const empty = await competitorReport(env, 'site', true);
  assert.equal(empty.trend.length, 30);
  assert.ok(empty.trend.every(day => day.changes === null && day.failures === null));
  await checkCompetitor(env, 'monitor', 'site', failure, Date.now());
  const failed = await competitorReport(env, 'site', true);
  const today = failed.trend.at(-1)!;
  assert.equal(today.checks, 1);
  assert.equal(today.changes, null);
  assert.equal(today.failures, 1);
  assert.equal((await competitorReport(env, 'other-site', false)).monitors.length, 0);
});

test('API enforces authentication, workspace/site boundaries, roles and read-only tokens', async () => {
  assert.equal((await request('/api/competitors/site', 'GET', undefined, '')).status, 401);
  assert.equal((await request('/api/competitors/site', 'GET', undefined, 'invalid')).status, 401);
  assert.equal((await request('/api/competitors/outside-site')).status, 404);
  const input = { name: 'Public fixture', url: 'https://fixture.example.com/pricing' };
  assert.equal((await request('/api/competitors/site', 'POST', input, 'member')).status, 403);
  assert.equal((await request('/api/competitors/site', 'POST', input, 'reader')).status, 403);
  await monitor();
  for (const [method, suffix, body] of [
    ['POST', '/check', undefined],
    ['PATCH', '', { cadence: 'daily' }],
    ['DELETE', '', undefined],
  ] as const) {
    for (const token of ['member', 'reader'])
      assert.equal(
        (await request(`/api/competitors/site/monitor${suffix}`, method, body, token)).status,
        403
      );
  }
  assert.equal((await request('/api/competitors/other-site/monitor/history')).status, 404);
  assert.equal((await request('/api/competitors/other-site/monitor/check', 'POST')).status, 404);
  const member = await (await request('/api/competitors/site', 'GET', undefined, 'member')).json();
  assert.equal(member.data.canManage, false);
  assert.equal(member.data.monitors.length, 1);
  const reader = await (await request('/api/competitors/site', 'GET', undefined, 'reader')).json();
  assert.equal(reader.data.canManage, false);
});

test('API validates bounded input, duplicate URLs, cross-origin writes and a 20-page site limit', async () => {
  const input = { name: 'Public fixture', url: 'https://fixture.example.com/pricing' };
  assert.equal(
    (
      await request('/api/competitors/site', 'POST', input, 'owner', {
        origin: 'https://unrelated.example.com',
      })
    ).status,
    403
  );
  assert.equal(
    (await request('/api/competitors/site', 'POST', { ...input, url: 'https://127.0.0.1/' }))
      .status,
    400
  );
  assert.equal(
    (await request('/api/competitors/site', 'POST', { ...input, name: 'x'.repeat(3000) })).status,
    413
  );
  assert.equal(
    (
      await runtime.dispatchFetch('http://localhost/api/competitors/site', {
        method: 'POST',
        headers: {
          authorization: 'Bearer traks_pat_local_fixture_owner',
          'content-type': 'application/json',
        },
        body: '{',
      })
    ).status,
    400
  );
  assert.equal((await request('/api/competitors/site', 'POST', input)).status, 201);
  assert.equal((await request('/api/competitors/site', 'POST', input)).status, 409);
  const results = await Promise.all(
    Array.from({ length: 21 }, (_, index) =>
      request('/api/competitors/site', 'POST', {
        ...input,
        url: `https://fixture.example.com/public-${index}`,
      })
    )
  );
  assert.equal(results.filter(response => response.status === 201).length, 19);
  assert.equal(
    (
      await database
        .prepare("SELECT count(*) AS count FROM competitor_monitors WHERE site_id = 'site'")
        .first()
    )?.count,
    20
  );
});

test('API records disallowed checks without network access, prevents edit/delete during checks and cascades deletion', async () => {
  await monitor('pending', 'unapproved.example.com');
  const response = await request('/api/competitors/site/pending/check', 'POST');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.errorCode, 'host_not_approved');
  assert.equal((await request('/api/competitors/site/pending/check', 'POST')).status, 409);
  await database
    .prepare("UPDATE competitor_monitors SET lease_until = ? WHERE id = 'pending'")
    .bind(Date.now() + 90_000)
    .run();
  assert.equal(
    (await request('/api/competitors/site/pending', 'PATCH', { cadence: 'daily' })).status,
    409
  );
  assert.equal((await request('/api/competitors/site/pending', 'DELETE')).status, 409);
  await database
    .prepare("UPDATE competitor_monitors SET lease_until = 0 WHERE id = 'pending'")
    .run();
  assert.equal(
    (await request('/api/competitors/site/pending', 'PATCH', { cadence: 'weekly' })).status,
    200
  );
  assert.equal((await request('/api/competitors/site/pending', 'DELETE')).status, 200);
  assert.deepEqual(await competitorHistory(database, 'pending'), []);
});

test('MCP competitor tools are scoped read-only views and never start a check', async () => {
  await monitor();
  const list = await (
    await request('/api/mcp', 'POST', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'reader')
  ).json();
  const tools = list.result.tools.filter(tool => tool.name.includes('competitor'));
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    'get_competitor_history',
    'get_competitor_monitors',
  ]);
  assert.ok(tools.every(tool => tool.annotations.readOnlyHint));
  for (const [name, argumentsValue] of [
    ['get_competitor_monitors', { siteId: 'site' }],
    ['get_competitor_history', { siteId: 'site', monitorId: 'monitor' }],
  ] as const) {
    const result = await (
      await request(
        '/api/mcp',
        'POST',
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name, arguments: argumentsValue },
        },
        'reader'
      )
    ).json();
    assert.equal(result.result.isError, false);
    assert.equal(JSON.parse(result.result.content[0].text).data.source, 'public_html_observation');
  }
  for (const argumentsValue of [{ siteId: 'outside-site' }, { siteId: 'site', runScan: true }]) {
    const result = await (
      await request(
        '/api/mcp',
        'POST',
        {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'get_competitor_monitors', arguments: argumentsValue },
        },
        'reader'
      )
    ).json();
    assert.equal(result.result.isError, true);
  }
  assert.deepEqual(await competitorHistory(database, 'monitor'), []);
});
