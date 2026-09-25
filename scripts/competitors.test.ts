import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { drizzle } from 'drizzle-orm/d1';
import {
  competitorInput,
  extractLocalCompetitorResearch,
  type CompetitorSnapshot,
} from '../packages/shared/src/competitors';
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
import {
  generateCompetitorResearchDraft,
  generateCompetitorResearchIntake,
} from '../apps/platform/api/src/lib/competitor-research-draft';
import { hashToken } from '../apps/platform/api/src/lib/tokens';
import type { Bindings } from '../apps/platform/api/src/types';
import {
  evictOrphanedMembers,
  workspaceHasCompetitors,
} from '../apps/platform/api/src/lib/workspaces';

let runtime: Miniflare;
let database: Bindings['DB'];
let env: Bindings;
let defaultResearchGroupId: string | null = null;
let glmRequests = 0;
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
const draftInput = {
  homepageUrl: 'https://fixture.example.com/research',
  brandName: 'Fixture Studio',
  pageTitle: 'AI image helper',
  productSummary: 'A manually supplied image workflow note.',
  seedKeywords: ['AI image generator'],
};
const intakeInput = {
  rawInput: [
    'Title: 205+ Free Developer Tools — No Signup | PromptSpace',
    'URL: https://tools.promptspace.in/',
    'H1: Free Online Developer Tools',
    'H2: 205 tools available',
    'H3: AI Tools',
    'H3: JSON',
    'H3: Image',
    'H3: PDF',
  ].join('\n'),
  lifecycleStatus: 'inbox' as const,
};
const localResearchReport = [
  '# Market Overview & Definition',
  'PromptSpace is positioned as a free browser-based developer-tool collection for makers who need fast, no-signup utilities.',
  '',
  '## Competitive Set Summary',
  '- Direct alternatives should be verified against current pricing, product breadth, and acquisition channels.',
  '',
  '## Differentiation Opportunities',
  '- Preserve privacy-first local execution and make category discovery easier without overstating unsupported market claims.',
  '',
  '## Evidence Gaps',
  '- No checkout-flow evidence was supplied for every alternative.',
].join('\n');
const structuredLocalResearchReport = [
  'Title: CUTY AI - Visual Content Generation Platform',
  'URL: https://www.cuty.ai/',
  'H2: Sign up and get your extra discount',
  '',
  '截至 2026-09-25，依据 CUTY AI 公开页面、Terms 与前端配置：',
  '',
  '| 项目 | 结论 |',
  '| --- | --- |',
  '| 品类 | 多模型 AI 视觉内容生成平台 / All-in-one AI 创意套件，覆盖 AI 视频生成、AI 图片生成与编辑。 |',
  '| 种子词 | 品牌/导航：`CUTY AI`、`Visual Content Generation Platform`；核心工作流：`Text to Video`、`Image to Video`、`AI video generator`。 |',
  '| 定价 | 积分订阅制 + 年付折扣 + 付费用户加购 Credit Packs；公开页展示 Free、Lite、Pro 和 Max 方案。 |',
  '| 支付网关 | Web 当前真实为 Stripe Checkout；Terms 同时列出第三方支付处理方。 |',
  '| 待补证据 | 需要核验真实结账页的区域可用性。 |',
  '',
  '来源：https://www.cuty.ai/terms',
  '来源任务：codex://threads/01a0cea4-fa9c-7b41-bbc3-825d907572b7',
].join('\n');

test('extracts local Skill report fields from the Codex result table without changing the report', () => {
  const extraction = extractLocalCompetitorResearch(structuredLocalResearchReport);
  assert.equal(extraction.found, true);
  assert.equal(extraction.brandName, 'CUTY AI');
  assert.equal(extraction.homepageUrl, 'https://www.cuty.ai/');
  assert.equal(extraction.pageTitle, 'CUTY AI - Visual Content Generation Platform');
  assert.match(extraction.productSummary ?? '', /多模型 AI 视觉内容生成平台/);
  assert.deepEqual(extraction.seedKeywords, [
    'CUTY AI',
    'Visual Content Generation Platform',
    'Text to Video',
    'Image to Video',
    'AI video generator',
  ]);
  assert.match(extraction.pricingConclusion ?? '', /积分订阅制/);
  assert.deepEqual(extraction.paymentProviders, [
    {
      provider: 'Stripe',
      status: 'confirmed',
      evidence: 'Web 当前真实为 Stripe Checkout；Terms 同时列出第三方支付处理方。',
    },
  ]);
  assert.deepEqual(extraction.sources, [
    { url: 'https://www.cuty.ai/', kind: 'landing' },
    { url: 'https://www.cuty.ai/terms', kind: 'manual' },
  ]);
  assert.deepEqual(extraction.evidenceGaps, ['需要核验真实结账页的区域可用性。']);
  assert.equal(
    extraction.sourceThreadUrl,
    'codex://threads/01a0cea4-fa9c-7b41-bbc3-825d907572b7'
  );
});
const draftCompletion = (draft: object, status = 200): Response =>
  new Response(
    JSON.stringify(
      status === 200
        ? { choices: [{ message: { content: JSON.stringify(draft) } }] }
        : { error: 'fixture' }
    ),
    { status, headers: { 'content-type': 'application/json' } }
  );

const completionPayload = (payload: object): Response =>
  new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

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
    d1Databases: ['DB', 'LEGACY_DB'],
    bindings: {
      ENVIRONMENT: 'development',
      BETTER_AUTH_SECRET: 'local-fixture-only-not-a-production-secret',
      COMPETITOR_ALLOWED_HOSTS: 'fixture.example.com',
      COMPETITOR_RESEARCH_GLM_API_KEY: 'fixture-glm-key',
    },
    outboundService: request => {
      if (new URL(request.url).hostname === 'api.z.ai') {
        glmRequests += 1;
        return draftCompletion({
          brandName: 'PromptSpace',
          pageTitle: '205+ Free Developer Tools — No Signup | PromptSpace',
          productSummary: 'A free browser-based developer utility collection.',
          categoryConclusion: '面向开发者的免费在线工具集合。',
          positioningEvidence: '粘贴标题和分类展示了免费、免注册的开发者工具定位。',
          customerTasks: '开发者可在浏览器中处理 JSON、编码、文本与转换任务。',
          keywordRationale: '关键词来自页面可见的 developer tools、JSON 和 AI utilities。',
          competitionPerspective: '粘贴资料未包含直接竞品或市场份额，无法形成竞争集合判断。',
          paymentConclusion: '未提供价格页、结账页或支付服务商证据。',
          suggestedCategories: ['开发者工具站'],
          seedKeywords: ['free developer tools', 'JSON tools'],
          paymentProviderCandidates: [],
          paymentProviders: [],
          evidenceGaps: ['需要人工补充定价或结账页证据。'],
          modelMetadata: { ignored: true },
        });
      }
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
  defaultResearchGroupId = null;
  glmRequests = 0;
  await database.prepare('DELETE FROM competitor_pre_research_actions').run();
  await database.prepare('DELETE FROM competitor_pre_research_runs').run();
  await database.prepare('DELETE FROM competitor_research_profiles').run();
  await database.prepare('DELETE FROM competitor_research_groups').run();
  await database.prepare('DELETE FROM competitor_monitors').run();
  await database.prepare('DELETE FROM competitor_categories').run();
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

test('MCP competitor read tools remain scoped and a local Skill import is explicit', async () => {
  await monitor();
  const primaryGroupId = await researchGroup('Developer tools', 'developer tools');
  const list = await (
    await request('/api/mcp', 'POST', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'reader')
  ).json();
  const tools = list.result.tools.filter(tool => tool.name.includes('competitor'));
  const readTools = tools.filter(
    tool => tool.name.startsWith('get_') || tool.name === 'list_competitor_workspaces'
  );
  assert.deepEqual(readTools.map(tool => tool.name).sort(), [
    'get_competitor_categories',
    'get_competitor_history',
    'get_competitor_monitors',
    'get_competitor_pre_research',
    'get_competitor_research',
    'get_competitor_research_groups',
    'list_competitor_workspaces',
  ]);
  assert.ok(readTools.every(tool => tool.annotations.readOnlyHint));
  const importer = tools.find(tool => tool.name === 'import_competitor_research');
  assert.deepEqual(importer?.annotations, {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  });
  assert.deepEqual(importer?.inputSchema.required, [
    'workspaceId',
    'brandName',
    'homepageUrl',
    'primaryGroupId',
    'localCapabilityId',
    'sourceThreadUrl',
    'detailedAnalysis',
  ]);
  const groupsResult = await (
    await request(
      '/api/mcp',
      'POST',
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'get_competitor_research_groups', arguments: { workspaceId: 'workspace' } },
      },
      'reader'
    )
  ).json();
  assert.equal(groupsResult.result.isError, false);
  assert.deepEqual(JSON.parse(groupsResult.result.content[0].text).data.groups, [
    {
      id: primaryGroupId,
      name: 'Developer tools',
      rootTerm: 'developer tools',
      profileCount: 0,
    },
  ]);
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
  const importArguments = {
    workspaceId: 'workspace',
    brandName: 'PromptSpace',
    homepageUrl: 'https://tools.promptspace.in/',
    productSummary: 'A browser-based developer tool collection.',
    primaryGroupId,
    localCapabilityId: 'competitor-analysis',
    sourceThreadUrl: 'codex://threads/01a0cea4-fa9c-7b41-bbc3-825d907572b7',
    seedKeywords: ['free developer tools'],
    paymentProviders: [],
    sources: [{ url: 'https://tools.promptspace.in/pricing', kind: 'pricing' }],
    detailedAnalysis: localResearchReport,
    suggestedCategories: ['Developer tools'],
    evidenceGaps: ['Need payment evidence.'],
  };
  const deniedImport = await (
    await request(
      '/api/mcp',
      'POST',
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'import_competitor_research', arguments: importArguments },
      },
      'reader'
    )
  ).json();
  assert.equal(deniedImport.result.isError, true);
  const imported = await (
    await request('/api/mcp', 'POST', {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'import_competitor_research', arguments: importArguments },
    })
  ).json();
  assert.equal(imported.result.isError, false);
  const researchResult = await (
    await request(
      '/api/mcp',
      'POST',
      {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: {
          name: 'get_competitor_research',
          arguments: { workspaceId: 'workspace', groupId: primaryGroupId },
        },
      },
      'reader'
    )
  ).json();
  assert.equal(researchResult.result.isError, false);
  assert.equal(JSON.parse(researchResult.result.content[0].text).data.profiles.length, 1);
  const research = (await (await request(`${workspaceRoot}/research`)).json()).data;
  assert.equal(research.profiles[0].analysis.researchMode, 'codex_local_handoff');
  assert.equal(research.profiles[0].analysis.localCapabilityId, 'competitor-analysis');
  assert.deepEqual(await competitorHistory(database, 'monitor'), []);
});

test('0031 preserves legacy monitors, snapshots, successful baselines and FK behavior without disabling foreign keys', async () => {
  const legacy = (await runtime.getD1Database('LEGACY_DB')) as unknown as Bindings['DB'];
  const folder = 'apps/platform/api/src/db/migrations';
  for (const filename of (await readdir(folder))
    .filter(name => name.endsWith('.sql') && name < '0031')
    .sort()) {
    const statements = (await readFile(`${folder}/${filename}`, 'utf8'))
      .split('--> statement-breakpoint')
      .map(part => part.trim())
      .filter(Boolean);
    for (const statement of statements) await legacy.prepare(statement).run();
  }
  await legacy.batch([
    legacy.prepare("INSERT INTO users (id, email) VALUES ('legacy-owner','legacy@fixture.test')"),
    legacy.prepare(
      "INSERT INTO workspaces (id,name,slug) VALUES ('legacy-workspace','Legacy','legacy')"
    ),
    legacy.prepare(
      "INSERT INTO sites (id,user_id,workspace_id,name,domain) VALUES ('old-site','legacy-owner',NULL,'Legacy','legacy.fixture.test'),('linked-site','legacy-owner','legacy-workspace','Linked','linked.fixture.test')"
    ),
    legacy
      .prepare(
        "INSERT INTO competitor_monitors (id,site_id,name,url,hostname,selector,cadence,created_at,next_check_at,last_checked_at,last_success_at,last_success_snapshot,lease_until) VALUES ('old','old-site','Old','https://fixture.example.com/','fixture.example.com','main','daily',10,50,40,30,?,60),('linked','linked-site','Linked','https://fixture.example.com/','fixture.example.com','main','weekly',10,70,40,30,?,0)"
      )
      .bind(JSON.stringify(snapshot), JSON.stringify(snapshot)),
    legacy
      .prepare(
        "INSERT INTO competitor_snapshots (id,monitor_id,checked_at,status,error_code,http_status,snapshot,previous,previous_checked_at,changes) VALUES ('old-check','old',30,'baseline',NULL,200,?,NULL,NULL,'[]'),('failure','old',40,'error','http_error',503,NULL,NULL,NULL,'[]'),('linked-check','linked',40,'changed',NULL,200,?,?,30,'[\"title\"]')"
      )
      .bind(
        JSON.stringify(snapshot),
        JSON.stringify({ ...snapshot, title: 'Changed' }),
        JSON.stringify(snapshot)
      ),
  ]);
  const monitorsBefore = (
    await legacy.prepare('SELECT * FROM competitor_monitors ORDER BY id').all()
  ).results;
  const checksBefore = (
    await legacy.prepare('SELECT * FROM competitor_snapshots ORDER BY id').all()
  ).results;
  const migration = await readFile(`${folder}/0031_competitor_categories.sql`, 'utf8');
  assert.doesNotMatch(migration, /foreign_keys\s*=\s*OFF/i);
  await legacy.batch(
    migration
      .split('--> statement-breakpoint')
      .map(part => part.trim())
      .filter(Boolean)
      .map(statement => legacy.prepare(statement))
  );
  assert.deepEqual(
    (await legacy.prepare('SELECT * FROM competitor_snapshots ORDER BY id').all()).results,
    checksBefore
  );
  assert.deepEqual(
    (await legacy.prepare('SELECT * FROM competitor_monitors ORDER BY id').all()).results.map(
      ({ workspace_id, category_id, ...row }) => {
        assert.equal(workspace_id, null);
        assert.equal(category_id, null);
        return row;
      }
    ),
    monitorsBefore
  );
  assert.deepEqual((await legacy.prepare('PRAGMA foreign_key_check').all()).results, []);
  await legacy.prepare("DELETE FROM sites WHERE id = 'old-site'").run();
  assert.deepEqual(
    (await legacy.prepare('SELECT id FROM competitor_snapshots ORDER BY id').all()).results,
    [{ id: 'linked-check' }]
  );
  await assert.rejects(() =>
    legacy
      .prepare(
        "INSERT INTO competitor_monitors (id,name,url,hostname,selector,created_at) VALUES ('bad','bad','https://fixture.example.com/bad','fixture.example.com','main',0)"
      )
      .run()
  );
});

const workspaceRoot = '/api/competitors/workspaces/workspace';
async function category(name = 'AI tools') {
  const response = await request(`${workspaceRoot}/categories`, 'POST', { name });
  assert.equal(response.status, 201);
  return (await response.json()).data.id as string;
}
async function researchGroup(name = 'Research fixture', rootTerm = 'research fixture') {
  const response = await request(`${workspaceRoot}/research/groups`, 'POST', { name, rootTerm });
  assert.equal(response.status, 201);
  return (await response.json()).data.id as string;
}
async function independent(extra: object = {}) {
  const response = await request(workspaceRoot, 'POST', {
    name: 'Independent',
    url: 'https://fixture.example.com/independent',
    ...extra,
  });
  assert.equal(response.status, 201);
  return (await response.json()).data.id as string;
}

async function researchProfile(extra: Record<string, unknown> = {}) {
  const { primaryGroupId: suppliedPrimaryGroupId, ...profile } = extra;
  if (!defaultResearchGroupId)
    defaultResearchGroupId = await researchGroup('Research fixture', 'research fixture');
  const primaryGroupId = suppliedPrimaryGroupId ?? defaultResearchGroupId;
  const response = await request(`${workspaceRoot}/research`, 'POST', {
    brandName: 'OpenSourceGen',
    homepageUrl: 'https://fixture.example.com/research',
    productSummary: 'Synthetic manual research only',
    lifecycleStatus: 'inbox',
    primaryGroupId,
    seedKeywords: ['AI image generator'],
    paymentProviders: [],
    sources: [],
    sourceThreadUrl: null,
    notes: null,
    ...profile,
  });
  assert.equal(response.status, 201);
  return (await response.json()).data.id as string;
}

test('AI research draft uses GLM-5.3 first and keeps payment candidates unconfirmed', async () => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const result = await generateCompetitorResearchDraft(
    { COMPETITOR_RESEARCH_GLM_API_KEY: 'fixture-glm-key' } as Bindings,
    draftInput,
    {
      now: () => instant,
      fetcher: (async (url, init) => {
        calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return draftCompletion({
          brandName: 'Fixture Studio',
          pageTitle: 'AI image helper',
          productSummary: 'An AI image workflow draft.',
          seedKeywords: ['AI image generator', 'AI image generator'],
          paymentProviderCandidates: ['Stripe', 'stripe'],
          evidenceGaps: ['Verify pricing and checkout manually'],
        });
      }) as typeof fetch,
    }
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.provider, 'glm');
  assert.equal(result.data.model, 'glm-5.3');
  assert.equal(result.data.generatedAt, instant);
  assert.deepEqual(result.data.draft.seedKeywords, ['AI image generator']);
  assert.deepEqual(result.data.draft.paymentProviders, [{ provider: 'Stripe', status: 'unknown' }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.z.ai/api/paas/v4/chat/completions');
  assert.equal(calls[0].body.model, 'glm-5.3');
  assert.deepEqual(calls[0].body.response_format, { type: 'json_object' });
});

test('pasted research intake generates detailed evidence-bound analysis without browsing', async () => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const result = await generateCompetitorResearchIntake(
    { COMPETITOR_RESEARCH_GLM_API_KEY: 'fixture-glm-key' } as Bindings,
    intakeInput,
    {
      now: () => instant,
      fetcher: (async (url, init) => {
        calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return draftCompletion({
          brandName: 'PromptSpace',
          pageTitle: '205+ Free Developer Tools — No Signup | PromptSpace',
          productSummary: 'A free browser-based developer utility collection.',
          categoryConclusion: '面向开发者的免费在线工具集合。',
          positioningEvidence: '输入展示开发者工具分类与工具数量。',
          customerTasks: '可处理 JSON、AI utilities 等页面明确列出的工具任务。',
          keywordRationale: '关键词来自 free developer tools、JSON tools 和 AI utilities。',
          competitionPerspective:
            '输入没有列出直接竞品、市场份额或用户反馈，不能给出竞争强弱结论。',
          paymentConclusion: '未提供价格页、结账页或支付服务商证据。',
          suggestedCategories: ['开发者工具站', '在线工具导航'],
          seedKeywords: ['free developer tools', 'JSON tools', 'AI utilities'],
          paymentProviders: [],
          evidenceGaps: ['需要人工补充定价或结账页证据，才能判断支付网关。'],
          modelMetadata: { generatedBy: 'fixture' },
        });
      }) as typeof fetch,
    }
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.provider, 'glm');
  assert.equal(result.data.model, 'glm-5.3');
  assert.equal(result.data.generatedAt, instant);
  assert.equal(result.data.workflow, 'competitor-analysis-evidence-bound-v1');
  assert.deepEqual(result.data.draft.suggestedCategories, ['开发者工具站', '在线工具导航']);
  assert.deepEqual(result.data.draft.paymentProviders, []);
  assert.match(result.data.draft.detailedAnalysis, /未提供价格页/);
  assert.equal('modelMetadata' in result.data.draft, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.z.ai/api/paas/v4/chat/completions');
  assert.equal(calls[0].body.max_tokens, 6000);
  assert.match(JSON.stringify(calls[0].body.messages), /PromptSpace/);
  assert.match(JSON.stringify(calls[0].body.messages), /competitor-analysis/);
  assert.match(JSON.stringify(calls[0].body.messages), /single most important/);
  assert.match(JSON.stringify(calls[0].body.messages), /competitionPerspective/);
});

test('AI research intake accepts GLM-compatible JSON response variants', async () => {
  const draft = {
    brandName: 'BrandGene',
    pageTitle: '',
    productSummary: '',
    categoryConclusion: '基于粘贴内容的 AI 品牌工具。',
    positioningEvidence: '输入提供了品牌生成相关页面信息。',
    customerTasks: '用户可完成品牌命名与视觉探索任务。',
    keywordRationale: '关键词来自 AI brand generator。',
    competitionPerspective: '未提供市场或竞争者来源，不能给出竞争集合结论。',
    paymentConclusion: '支付和定价信息需要人工核验。',
    suggestedCategories: ['AI 品牌工具'],
    seedKeywords: ['AI brand generator'],
    paymentProviders: [],
    evidenceGaps: ['未提供支付证据。'],
  };
  const variants = [
    { choices: [{ message: { content: `\`\`\`json\n${JSON.stringify(draft)}\n\`\`\`` } }] },
    { choices: [{ message: { content: [{ type: 'text', text: JSON.stringify(draft) }] } }] },
    { choices: [{ message: { parsed: draft, content: null } }] },
  ];
  for (const payload of variants) {
    const result = await generateCompetitorResearchIntake(
      { COMPETITOR_RESEARCH_GLM_API_KEY: 'fixture-glm-key' } as Bindings,
      intakeInput,
      { fetcher: (async () => completionPayload(payload)) as typeof fetch }
    );
    assert.equal(result.ok, true);
    if (!result.ok) continue;
    assert.equal(result.data.draft.pageTitle, null);
    assert.match(result.data.draft.productSummary ?? '', /^品类：基于粘贴内容的 AI 品牌工具。/);
    assert.equal(result.data.draft.brandName, 'BrandGene');
  }
});

test('AI research intake retries a truncated GLM response with compact JSON constraints', async () => {
  const calls: Record<string, unknown>[] = [];
  const result = await generateCompetitorResearchIntake(
    { COMPETITOR_RESEARCH_GLM_API_KEY: 'fixture-glm-key' } as Bindings,
    intakeInput,
    {
      fetcher: (async (_url, init) => {
        calls.push(JSON.parse(String(init?.body)));
        if (calls.length === 1)
          return completionPayload({
            choices: [{ finish_reason: 'length', message: { content: '{"brandName":"BrandGene"' } }],
          });
        return draftCompletion({
          brandName: 'PromptSpace',
          pageTitle: '205+ Free Developer Tools — No Signup | PromptSpace',
          productSummary: '面向开发者的免费在线工具集合，页面强调免注册的浏览器内工具使用。',
          categoryConclusion: '免费在线开发者工具集合。',
          positioningEvidence: '标题、H1 与工具分类说明其提供免注册的浏览器工具。',
          customerTasks: '用户可处理 JSON、编码、文本和图片相关任务。',
          keywordRationale: '关键词来自 developer tools、JSON、AI Tools 和 Image。',
          competitionPerspective: '粘贴资料没有直接竞品证据，无法判断竞争集合。',
          paymentConclusion: '未提供价格、结账或支付服务商证据。',
          suggestedCategories: ['开发者工具站'],
          seedKeywords: ['free developer tools', 'JSON tools'],
          paymentProviders: [],
          evidenceGaps: ['需要补充定价或结账页证据。'],
        });
      }) as typeof fetch,
    }
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.data.attempts, [
    { provider: 'glm', model: 'glm-5.3', outcome: 'failed', reason: 'truncated_response' },
    { provider: 'glm', model: 'glm-5.3', outcome: 'succeeded' },
  ]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].max_tokens, 6000);
  assert.equal(calls[1].max_tokens, 3600);
  assert.match(JSON.stringify(calls[1].messages), /RETRY_OUTPUT_CONSTRAINTS/);
});

test('AI research intake rejects two truncated responses without returning partial data', async () => {
  let calls = 0;
  const result = await generateCompetitorResearchIntake(
    { COMPETITOR_RESEARCH_GLM_API_KEY: 'fixture-glm-key' } as Bindings,
    intakeInput,
    {
      fetcher: (async () => {
        calls += 1;
        return completionPayload({
          choices: [{ finish_reason: 'length', message: { content: '{"brandName":"BrandGene"' } }],
        });
      }) as typeof fetch,
    }
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(calls, 2);
  assert.deepEqual(result.attempts, [
    { provider: 'glm', model: 'glm-5.3', outcome: 'failed', reason: 'truncated_response' },
    { provider: 'glm', model: 'glm-5.3', outcome: 'failed', reason: 'truncated_response' },
    { provider: 'terra', model: 'unconfigured', outcome: 'skipped', reason: 'not_configured' },
  ]);
});

test('AI research intake honors an explicit GLM-5.3 choice without falling back to Terra', async () => {
  const calls: string[] = [];
  const result = await generateCompetitorResearchIntake(
    {
      COMPETITOR_RESEARCH_GLM_API_KEY: 'fixture-glm-key',
      COMPETITOR_RESEARCH_TERRA_API_KEY: 'fixture-terra-key',
      COMPETITOR_RESEARCH_TERRA_API_URL: 'https://terra.fixture.test/v1/chat/completions',
      COMPETITOR_RESEARCH_TERRA_MODEL: 'gpt-5.6-terra',
    } as Bindings,
    intakeInput,
    {
      modelPreference: 'glm',
      fetcher: (async url => {
        calls.push(String(url));
        return draftCompletion({}, 503);
      }) as typeof fetch,
    }
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(result.attempts, [
    { provider: 'glm', model: 'glm-5.3', outcome: 'failed', reason: 'unavailable' },
  ]);
  assert.deepEqual(calls, ['https://api.z.ai/api/paas/v4/chat/completions']);
});

test('pasted research intake saves source and detailed analysis without creating a monitor', async () => {
  const primaryGroupId = await researchGroup('Developer tools', 'developer tools');
  const response = await request(`${workspaceRoot}/research/intake`, 'POST', {
    ...intakeInput,
    primaryGroupId,
  });
  assert.equal(response.status, 201);
  const created = (await response.json()).data;
  assert.equal(created.source, 'pasted_site_research');
  assert.equal(created.provider, 'glm');
  const report = (await (await request(`${workspaceRoot}/research`)).json()).data;
  assert.equal(report.profiles.length, 1);
  assert.deepEqual(report.profiles[0].primaryGroup, {
    id: primaryGroupId,
    name: 'Developer tools',
    rootTerm: 'developer tools',
  });
  assert.deepEqual(report.profiles[0].categories, []);
  assert.equal(report.profiles[0].rawInput, intakeInput.rawInput);
  assert.match(
    report.profiles[0].analysis.detailedAnalysis,
    /^产品类别与定位：面向开发者的免费在线工具集合。/
  );
  assert.match(
    report.profiles[0].analysis.detailedAnalysis,
    /竞争与差异化边界：粘贴资料未包含直接竞品/
  );
  assert.equal(report.profiles[0].analysis.workflow, 'competitor-analysis-evidence-bound-v1');
  assert.equal('modelMetadata' in report.profiles[0].analysis, false);
  assert.equal(
    (
      await database
        .prepare('SELECT count(*) AS count FROM competitor_monitors WHERE workspace_id = ?')
        .bind('workspace')
        .first<{ count: number }>()
    )?.count,
    0
  );
});

test('research intake reuses an existing URL without another model request until explicitly regenerated', async () => {
  const primaryGroupId = await researchGroup('Developer tools', 'developer tools');
  const created = await request(`${workspaceRoot}/research/intake`, 'POST', {
    ...intakeInput,
    primaryGroupId,
  });
  assert.equal(created.status, 201);
  const profileId = (await created.json()).data.profileId as string;
  const requestsAfterCreate = glmRequests;
  const updatedInput = `${intakeInput.rawInput}\nH3: Developer Utilities`;
  const duplicate = await request(`${workspaceRoot}/research/intake`, 'POST', {
    ...intakeInput,
    primaryGroupId,
    rawInput: updatedInput,
    modelPreference: 'glm',
  });
  assert.equal(duplicate.status, 200);
  assert.deepEqual((await duplicate.json()).data, {
    source: 'existing_research_profile',
    profileId,
    existing: true,
    limitations: [
      'An existing research profile already uses this homepage URL; no model request was made and no saved data was changed.',
      'Use the explicit regeneration action to apply the current input while preserving its root-term grouping, links, sources, and notes.',
      'No competitor monitor or scheduler was created or changed.',
    ],
  });
  assert.equal(glmRequests, requestsAfterCreate);
  const preserved = (await (await request(`${workspaceRoot}/research`)).json()).data.profiles[0];
  assert.equal(preserved.rawInput, intakeInput.rawInput);

  const regenerated = await request(`${workspaceRoot}/research/${profileId}/regenerate`, 'POST', {
    rawInput: updatedInput,
    modelPreference: 'glm',
  });
  assert.equal(regenerated.status, 200);
  assert.equal(glmRequests, requestsAfterCreate + 1);
  const updated = (await (await request(`${workspaceRoot}/research`)).json()).data.profiles[0];
  assert.equal(updated.rawInput, updatedInput);
  assert.equal(updated.analysis.model, 'glm-5.3');
});

test('research profiles edit saved input, regenerate derived conclusions, and delete without deleting monitors', async () => {
  const primaryGroupId = await researchGroup('Developer tools', 'developer tools');
  const categoryId = await category('AI tools');
  const monitorId = await independent({ categoryId, cadence: 'manual' });
  const created = await request(`${workspaceRoot}/research/intake`, 'POST', {
    ...intakeInput,
    primaryGroupId,
  });
  assert.equal(created.status, 201);
  const profileId = (await created.json()).data.profileId as string;
  for (const [suffix, ids] of [
    ['categories', [categoryId]],
    ['sites', ['site']],
    ['monitors', [monitorId]],
  ] as const)
    assert.equal(
      (await request(`${workspaceRoot}/research/${profileId}/${suffix}`, 'PUT', { ids })).status,
      200
    );
  const updatedInput = `${intakeInput.rawInput}\nH3: Developer Utilities`;
  assert.equal(
    (
      await request(`${workspaceRoot}/research/${profileId}`, 'PATCH', {
        notes: 'Preserve this manual note.',
        sourceThreadUrl: 'codex://threads/fixture-research',
      })
    ).status,
    200
  );
  const regenerated = await request(`${workspaceRoot}/research/${profileId}/regenerate`, 'POST', {
    rawInput: updatedInput,
    modelPreference: 'auto',
  });
  assert.equal(regenerated.status, 200);
  const generated = (await regenerated.json()).data;
  assert.equal(generated.provider, 'glm');
  const profile = (await (await request(`${workspaceRoot}/research`)).json()).data.profiles[0];
  assert.equal(profile.rawInput, updatedInput);
  assert.equal(profile.notes, 'Preserve this manual note.');
  assert.equal(profile.sourceThreadUrl, 'codex://threads/fixture-research');
  assert.equal(profile.analysis.provider, 'glm');
  assert.equal(profile.analysis.researchMode, 'pasted_site_research');
  assert.deepEqual(
    profile.categories.map((item: { id: string }) => item.id),
    [categoryId]
  );
  assert.deepEqual(
    profile.sites.map((item: { id: string }) => item.id),
    ['site']
  );
  assert.deepEqual(
    profile.monitors.map((item: { id: string }) => item.id),
    [monitorId]
  );
  assert.equal((await request(`${workspaceRoot}/research/${profileId}`, 'DELETE')).status, 200);
  assert.equal((await (await request(`${workspaceRoot}/research`)).json()).data.profiles.length, 0);
  assert.equal(
    (
      await database
        .prepare('SELECT count(*) AS count FROM competitor_monitors WHERE id = ?')
        .bind(monitorId)
        .first<{ count: number }>()
    )?.count,
    1
  );
  assert.equal(
    (
      await database
        .prepare(
          'SELECT count(*) AS count FROM competitor_research_monitor_links WHERE monitor_id = ?'
        )
        .bind(monitorId)
        .first<{ count: number }>()
    )?.count,
    0
  );
});

test('research regeneration rejects profiles without saved input and preserves their data', async () => {
  const profileId = await researchProfile({ notes: 'Manual only' });
  const response = await request(`${workspaceRoot}/research/${profileId}/regenerate`, 'POST', {
    modelPreference: 'auto',
  });
  assert.equal(response.status, 400);
  const profile = (await (await request(`${workspaceRoot}/research`)).json()).data.profiles[0];
  assert.equal(profile.notes, 'Manual only');
  assert.equal(profile.analysis, null);
});

test('Codex deep research import requires its task link and preserves listed public evidence', async () => {
  const primaryGroupId = await researchGroup('Developer tools', 'developer tools');
  const missingTask = await request(`${workspaceRoot}/research/intake`, 'POST', {
    ...intakeInput,
    primaryGroupId,
    researchMode: 'codex_competitor_analysis',
  });
  assert.equal(missingTask.status, 400);

  const response = await request(`${workspaceRoot}/research/intake`, 'POST', {
    ...intakeInput,
    primaryGroupId,
    rawInput: `${intakeInput.rawInput}\nEvidence: https://tools.promptspace.in/pricing`,
    researchMode: 'codex_competitor_analysis',
    sourceThreadUrl: 'codex://threads/01a0cea4-fa9c-7b41-bbc3-825d907572b7',
  });
  assert.equal(response.status, 201);
  const created = (await response.json()).data;
  assert.equal(created.source, 'codex_competitor_analysis');
  const report = (await (await request(`${workspaceRoot}/research`)).json()).data;
  assert.equal(report.profiles[0].analysis.researchMode, 'codex_competitor_analysis');
  assert.equal(
    report.profiles[0].sourceThreadUrl,
    'codex://threads/01a0cea4-fa9c-7b41-bbc3-825d907572b7'
  );
  assert.deepEqual(
    report.profiles[0].sources.map((source: { url: string; kind: string }) => [
      source.url,
      source.kind,
    ]),
    [
      ['https://tools.promptspace.in/', 'landing'],
      ['https://tools.promptspace.in/pricing', 'pricing'],
    ]
  );
  assert.equal(
    (
      await request(`${workspaceRoot}/research/${created.profileId}/regenerate`, 'POST', {
        modelPreference: 'auto',
      })
    ).status,
    200
  );
  const regeneratedReport = (await (await request(`${workspaceRoot}/research`)).json()).data;
  assert.equal(regeneratedReport.profiles[0].analysis.researchMode, 'codex_competitor_analysis');
  assert.equal(
    regeneratedReport.profiles[0].sourceThreadUrl,
    'codex://threads/01a0cea4-fa9c-7b41-bbc3-825d907572b7'
  );
});

test('structured local Skill imports preserve the complete report without requesting a model', async () => {
  const primaryGroupId = await researchGroup('Developer tools', 'developer tools');
  const requestsBeforeImport = glmRequests;
  const response = await request(`${workspaceRoot}/research/import`, 'POST', {
    brandName: 'PromptSpace',
    homepageUrl: 'https://tools.promptspace.in/',
    pageTitle: '205+ Free Developer Tools — No Signup | PromptSpace',
    productSummary: '面向开发者的免登录在线工具集合，核心价值是浏览器端的即时可用工具。',
    lifecycleStatus: 'focus',
    primaryGroupId,
    localCapabilityId: 'competitor-analysis',
    sourceThreadUrl: 'codex://threads/01a0cea4-fa9c-7b41-bbc3-825d907572b7',
    seedKeywords: ['free developer tools', 'JSON tools', 'AI utilities'],
    paymentProviders: [
      { provider: 'Stripe', status: 'evidence_only', evidence: '公开定价页待进一步核验。' },
    ],
    sources: [{ url: 'https://tools.promptspace.in/pricing', kind: 'pricing' }],
    detailedAnalysis: localResearchReport,
    suggestedCategories: ['Developer tools'],
    evidenceGaps: ['需要继续核验实际支付和竞品定价页面。'],
  });
  assert.equal(response.status, 201);
  const created = (await response.json()).data;
  assert.equal(created.source, 'codex_local_handoff');
  assert.equal(created.replaced, undefined);
  assert.equal(glmRequests, requestsBeforeImport);

  const report = (await (await request(`${workspaceRoot}/research`)).json()).data;
  const profile = report.profiles[0];
  assert.equal(profile.rawInput, localResearchReport);
  assert.equal(profile.analysis.provider, 'local_skill');
  assert.equal(profile.analysis.model, null);
  assert.equal(profile.analysis.workflow, 'local-skill-evidence-import-v1');
  assert.equal(profile.analysis.detailedAnalysis, localResearchReport);
  assert.deepEqual(profile.analysis.evidenceGaps, ['需要继续核验实际支付和竞品定价页面。']);
  assert.deepEqual(
    profile.sources.map((source: { url: string; kind: string }) => [source.url, source.kind]),
    [
      ['https://tools.promptspace.in/', 'landing'],
      ['https://tools.promptspace.in/pricing', 'pricing'],
    ]
  );
  assert.equal(
    (await request(`${workspaceRoot}/research/${created.profileId}/regenerate`, 'POST')).status,
    409
  );
  assert.equal(glmRequests, requestsBeforeImport);
  assert.equal(
    (
      await database
        .prepare('SELECT count(*) AS count FROM competitor_monitors WHERE workspace_id = ?')
        .bind('workspace')
        .first<{ count: number }>()
    )?.count,
    0
  );
});

test('local Skill reports can be replaced without a model request', async () => {
  const primaryGroupId = await researchGroup('Developer tools', 'developer tools');
  const created = await request(`${workspaceRoot}/research/import`, 'POST', {
    brandName: 'PromptSpace',
    homepageUrl: 'https://tools.promptspace.in/',
    productSummary: '初始本机深度研究。',
    lifecycleStatus: 'focus',
    primaryGroupId,
    localCapabilityId: 'competitor-analysis',
    sourceThreadUrl: 'codex://threads/01a0cea4-fa9c-7b41-bbc3-825d907572b7',
    seedKeywords: ['free developer tools'],
    paymentProviders: [],
    sources: [{ url: 'https://tools.promptspace.in/pricing', kind: 'pricing' }],
    detailedAnalysis: localResearchReport,
    suggestedCategories: ['Developer tools'],
    evidenceGaps: ['Need payment evidence.'],
  });
  const profileId = (await created.json()).data.profileId as string;
  const requestsBeforeReplacement = glmRequests;
  const replacementReport = `${localResearchReport}\n\n## Follow-up\n- Updated after a fresh local Skill run.`;
  const replacement = await request(`${workspaceRoot}/research/${profileId}/import`, 'PUT', {
    brandName: 'PromptSpace',
    homepageUrl: 'https://tools.promptspace.in/',
    productSummary: '更新后的本机深度研究仍保留完整证据和结论。',
    lifecycleStatus: 'watch',
    primaryGroupId,
    localCapabilityId: 'competitor-analysis',
    sourceThreadUrl: 'codex://threads/01a0cea4-fa9c-7b41-bbc3-825d907572b7',
    seedKeywords: ['free developer tools'],
    paymentProviders: [],
    sources: [{ url: 'https://tools.promptspace.in/pricing', kind: 'pricing' }],
    detailedAnalysis: replacementReport,
    suggestedCategories: ['Developer tools'],
    evidenceGaps: ['Need payment evidence.'],
  });
  assert.equal(replacement.status, 200);
  assert.equal((await replacement.json()).data.replaced, true);
  const replacedProfile = (await (await request(`${workspaceRoot}/research`)).json()).data.profiles[0];
  assert.equal(replacedProfile.lifecycleStatus, 'watch');
  assert.equal(replacedProfile.rawInput, replacementReport);
  assert.equal(replacedProfile.analysis.detailedAnalysis, replacementReport);
  assert.equal(glmRequests, requestsBeforeReplacement);
});

test('AI research draft falls back to the configured Terra bridge after GLM fails', async () => {
  const calls: string[] = [];
  const result = await generateCompetitorResearchDraft(
    {
      COMPETITOR_RESEARCH_GLM_API_KEY: 'fixture-glm-key',
      COMPETITOR_RESEARCH_TERRA_API_KEY: 'fixture-terra-key',
      COMPETITOR_RESEARCH_TERRA_API_URL: 'https://terra.fixture.test/v1/chat/completions',
      COMPETITOR_RESEARCH_TERRA_MODEL: 'gpt-5.6-terra',
    } as Bindings,
    draftInput,
    {
      fetcher: (async url => {
        calls.push(String(url));
        if (calls.length === 1) return draftCompletion({}, 503);
        return draftCompletion({
          brandName: 'Fixture Studio',
          pageTitle: null,
          productSummary: 'Fallback draft.',
          seedKeywords: ['image workflow'],
          paymentProviderCandidates: [],
          evidenceGaps: [],
        });
      }) as typeof fetch,
    }
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.provider, 'terra');
  assert.deepEqual(result.data.attempts, [
    { provider: 'glm', model: 'glm-5.3', outcome: 'failed', reason: 'unavailable' },
    { provider: 'terra', model: 'gpt-5.6-terra', outcome: 'succeeded' },
  ]);
  assert.deepEqual(calls, [
    'https://api.z.ai/api/paas/v4/chat/completions',
    'https://terra.fixture.test/v1/chat/completions',
  ]);
});

test('AI research draft reports missing providers and timeouts without silently saving', async () => {
  const unconfigured = await generateCompetitorResearchDraft({} as Bindings, draftInput);
  assert.equal(unconfigured.ok, false);
  if (unconfigured.ok) return;
  assert.deepEqual(unconfigured.attempts, [
    { provider: 'glm', model: 'glm-5.3', outcome: 'skipped', reason: 'not_configured' },
    { provider: 'terra', model: 'unconfigured', outcome: 'skipped', reason: 'not_configured' },
  ]);
  const timeout = await generateCompetitorResearchDraft(
    { COMPETITOR_RESEARCH_GLM_API_KEY: 'fixture-glm-key' } as Bindings,
    draftInput,
    {
      timeoutMs: 1,
      fetcher: ((_, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('', 'AbortError')));
        })) as typeof fetch,
    }
  );
  assert.equal(timeout.ok, false);
  if (timeout.ok) return;
  assert.equal(timeout.attempts[0].reason, 'timeout');
  assert.equal(timeout.attempts[1].reason, 'not_configured');
});

test('category rename/delete and same-workspace reassignment preserve all evidence and the success baseline', async () => {
  const categoryId = await category();
  const id = await independent({ categoryId });
  await checkCompetitor(env, id, { workspaceId: 'workspace' }, success, instant);
  const before = await competitorHistory(database, id);
  assert.equal(
    (
      await request(`${workspaceRoot}/categories/${categoryId}`, 'PATCH', {
        name: 'AI video',
      })
    ).status,
    200
  );
  for (const siteId of ['site', 'other-site', null]) {
    assert.equal((await request(`${workspaceRoot}/${id}`, 'PATCH', { siteId })).status, 200);
    assert.deepEqual(await competitorHistory(database, id), before);
    const regrouped = await competitorReport(
      env,
      { workspaceId: 'workspace', siteId: siteId ?? 'unlinked', categoryId },
      true
    );
    assert.equal(
      regrouped.trend.reduce((total, day) => total + day.checks, 0),
      1
    );
    const previousGroup = await competitorReport(
      env,
      { workspaceId: 'workspace', siteId: siteId === 'site' ? 'unlinked' : 'site', categoryId },
      true
    );
    assert.equal(
      previousGroup.trend.reduce((total, day) => total + day.checks, 0),
      0
    );
    const row = await database
      .prepare(
        'SELECT site_id, workspace_id, last_success_snapshot, next_check_at FROM competitor_monitors WHERE id=?'
      )
      .bind(id)
      .first();
    assert.equal(row?.site_id, siteId);
    assert.equal(row?.workspace_id, siteId ? null : 'workspace');
    assert.equal(row?.last_success_snapshot, JSON.stringify(snapshot));
    assert.equal(row?.next_check_at, null);
  }
  assert.equal((await request(`${workspaceRoot}/categories/${categoryId}`, 'DELETE')).status, 200);
  assert.deepEqual(await competitorHistory(database, id), before);
  const report = (
    await (await request(`${workspaceRoot}?categoryId=uncategorized&siteId=unlinked`)).json()
  ).data;
  assert.deepEqual(
    report.monitors.map(item => item.id),
    [id]
  );
  assert.equal(report.monitors[0].categoryId, null);
  assert.equal(report.monitors[0].latest.status, 'baseline');
  assert.equal((await request(`${workspaceRoot}/${id}`, 'PATCH', {})).status, 400);
  assert.equal(
    (await request(`/api/competitors/site/${id}`, 'PATCH', { siteId: null })).status,
    400
  );
});

test('workspace API rejects cross-tenant sites, categories, monitors and token access; members and read PATs cannot write', async () => {
  const categoryId = await category();
  const id = await independent({ categoryId });
  await database
    .prepare(
      "INSERT INTO competitor_categories (id,workspace_id,name,name_key,created_at) VALUES ('outside-category','outside','Outside','outside',0)"
    )
    .run();
  await monitor('outside-monitor', 'outside.fixture.test', 'manual', null, 'outside-site');
  assert.equal((await request(workspaceRoot, 'GET', undefined, '')).status, 401);
  assert.equal((await request('/api/competitors/workspaces/outside')).status, 404);
  const workspaces = (await (await request('/api/competitors/workspaces')).json()).data;
  assert.deepEqual(
    workspaces.map(item => item.id),
    ['workspace']
  );
  assert.equal((await request(`${workspaceRoot}/research/draft`, 'POST', draftInput)).status, 503);
  for (const filters of [
    'siteId=outside-site',
    'categoryId=outside-category',
    'categoryId=missing',
    'siteId=missing',
  ])
    assert.equal((await request(`${workspaceRoot}?${filters}`)).status, 404);
  for (const filters of ['siteId=', 'categoryId=', 'bad=true'])
    assert.equal((await request(`${workspaceRoot}?${filters}`)).status, 400);
  for (const body of [{ siteId: 'outside-site' }, { categoryId: 'outside-category' }]) {
    assert.equal(
      (
        await request(workspaceRoot, 'POST', {
          name: 'Wrong',
          url: 'https://fixture.example.com/wrong',
          ...body,
        })
      ).status,
      404
    );
    assert.equal((await request(`${workspaceRoot}/${id}`, 'PATCH', body)).status, 404);
  }
  for (const suffix of ['history', 'check'])
    assert.equal(
      (
        await request(
          `${workspaceRoot}/outside-monitor/${suffix}`,
          suffix === 'history' ? 'GET' : 'POST'
        )
      ).status,
      404
    );
  for (const token of ['member', 'reader']) {
    assert.equal(
      (await (await request(workspaceRoot, 'GET', undefined, token)).json()).data.canManage,
      false
    );
    for (const [path, method, body] of [
      [workspaceRoot, 'POST', { name: 'Wrong', url: 'https://fixture.example.com/wrong' }],
      [`${workspaceRoot}/${id}`, 'PATCH', { categoryId: null }],
      [`${workspaceRoot}/${id}/check`, 'POST', undefined],
      [`${workspaceRoot}/${id}`, 'DELETE', undefined],
      [`${workspaceRoot}/research/draft`, 'POST', draftInput],
      [`${workspaceRoot}/categories`, 'POST', { name: 'Wrong' }],
      [`${workspaceRoot}/categories/${categoryId}`, 'PATCH', { name: 'Wrong' }],
      [`${workspaceRoot}/categories/${categoryId}`, 'DELETE', undefined],
    ] as const)
      assert.equal((await request(path, method, body, token)).status, 403);
  }
  assert.equal(
    (await request(`${workspaceRoot}/categories/outside-category`, 'DELETE')).status,
    404
  );
});

test('research library keeps manual evidence workspace-scoped and only links an existing monitor', async () => {
  const categoryId = await category('AI image tools');
  const monitorId = await independent({ categoryId, cadence: 'manual' });
  const before = await database
    .prepare('SELECT count(*) AS count FROM competitor_monitors WHERE workspace_id = ?')
    .bind('workspace')
    .first<{ count: number }>();
  const profileId = await researchProfile({
    lifecycleStatus: 'focus',
    seedKeywords: ['AI image generator', 'open source image model'],
    paymentProviders: [
      { provider: 'Stripe', status: 'evidence_only', evidence: 'Manual pricing-page review' },
    ],
    sources: [
      {
        url: 'https://fixture.example.com/pricing',
        kind: 'pricing',
        note: 'Synthetic local source',
      },
    ],
    sourceThreadUrl: 'codex://threads/local-fixture',
    notes: 'Not a network capture.',
  });
  assert.deepEqual(
    await database
      .prepare('SELECT count(*) AS count FROM competitor_monitors WHERE workspace_id = ?')
      .bind('workspace')
      .first<{ count: number }>(),
    before
  );
  for (const [suffix, ids] of [
    ['categories', [categoryId]],
    ['sites', ['site']],
    ['monitors', [monitorId]],
  ] as const)
    assert.equal(
      (await request(`${workspaceRoot}/research/${profileId}/${suffix}`, 'PUT', { ids })).status,
      200
    );
  const report = (await (await request(`${workspaceRoot}/research?lifecycleStatus=focus`)).json())
    .data;
  assert.equal(report.source, 'manual_research_library');
  assert.equal(report.schedulerEnabled, undefined);
  assert.equal(report.profiles.length, 1);
  assert.deepEqual(report.profiles[0].seedKeywords, [
    'AI image generator',
    'open source image model',
  ]);
  assert.deepEqual(report.profiles[0].paymentProviders, [
    { provider: 'Stripe', status: 'evidence_only', evidence: 'Manual pricing-page review' },
  ]);
  assert.deepEqual(
    report.profiles[0].categories.map((item: { id: string }) => item.id),
    [categoryId]
  );
  assert.deepEqual(
    report.profiles[0].sites.map((item: { id: string }) => item.id),
    ['site']
  );
  assert.deepEqual(
    report.profiles[0].monitors.map((item: { id: string }) => item.id),
    [monitorId]
  );
  assert.equal((await request(`${workspaceRoot}/research/${profileId}`, 'PATCH', {})).status, 400);
  assert.equal(
    (await request(`${workspaceRoot}/research/${profileId}`, 'PATCH', { notes: 'Updated' })).status,
    200
  );
});

test('research profiles keep a root-term group as their result parent while categories remain tags', async () => {
  const initialGroupId = await researchGroup('AI image prompt tools', 'image to prompt');
  const nextGroupId = await researchGroup('AI image generation tools', 'AI image generator');
  const categoryId = await category('Freemium tools');
  const profileId = await researchProfile({ primaryGroupId: initialGroupId });

  const firstReport = (
    await (await request(`${workspaceRoot}/research?groupId=${initialGroupId}`)).json()
  ).data;
  assert.deepEqual(
    firstReport.profiles.map((profile: { id: string }) => profile.id),
    [profileId]
  );
  assert.deepEqual(firstReport.profiles[0].primaryGroup, {
    id: initialGroupId,
    name: 'AI image prompt tools',
    rootTerm: 'image to prompt',
  });

  assert.equal(
    (
      await request(`${workspaceRoot}/research/${profileId}`, 'PATCH', {
        primaryGroupId: nextGroupId,
      })
    ).status,
    200
  );
  assert.equal(
    (
      await request(`${workspaceRoot}/research/${profileId}/categories`, 'PUT', {
        ids: [categoryId],
      })
    ).status,
    200
  );
  const reassigned = (await (await request(`${workspaceRoot}/research`)).json()).data.profiles[0];
  assert.equal(reassigned.primaryGroup.id, nextGroupId);
  assert.deepEqual(
    reassigned.categories.map((item: { id: string }) => item.id),
    [categoryId]
  );

  assert.equal(
    (await request(`${workspaceRoot}/research/groups/${nextGroupId}`, 'DELETE')).status,
    200
  );
  const legacy = (await (await request(`${workspaceRoot}/research`)).json()).data.profiles[0];
  assert.equal(legacy.primaryGroup, null);
  assert.deepEqual(
    legacy.categories.map((item: { id: string }) => item.id),
    [categoryId]
  );
  assert.equal((await request(`${workspaceRoot}/research?groupId=${nextGroupId}`)).status, 404);
});

test('research library paginates saved intake metadata without creating monitors', async () => {
  for (let index = 0; index < 10; index++) {
    await researchProfile({
      brandName: `Archive ${index}`,
      homepageUrl: `https://fixture.example.com/archive-${index}`,
    });
  }
  const intakeProfileId = await researchProfile({
    brandName: 'Saved intake',
    homepageUrl: 'https://fixture.example.com/saved-intake',
  });
  await database
    .prepare('UPDATE competitor_research_profiles SET raw_input = ?, analysis = ? WHERE id = ?')
    .bind(
      intakeInput.rawInput,
      JSON.stringify({
        provider: 'glm',
        model: 'glm-5.3',
        generatedAt: instant,
        detailedAnalysis: 'Saved detailed analysis.',
        suggestedCategories: ['开发者工具站'],
        evidenceGaps: ['Verify payment evidence.'],
      }),
      intakeProfileId
    )
    .run();
  const firstPage = await (await request(`${workspaceRoot}/research?page=1&pageSize=10`)).json();
  assert.equal(firstPage.data.pagination.page, 1);
  assert.equal(firstPage.data.pagination.pageSize, 10);
  assert.equal(firstPage.data.pagination.total, 11);
  assert.equal(firstPage.data.pagination.totalPages, 2);
  assert.equal(firstPage.data.profiles.length, 10);
  assert.equal(firstPage.data.profiles[0].id, intakeProfileId);
  assert.equal(firstPage.data.profiles[0].rawInput, intakeInput.rawInput);
  assert.deepEqual(firstPage.data.profiles[0].analysis.suggestedCategories, ['开发者工具站']);
  const lastPage = await (await request(`${workspaceRoot}/research?page=2&pageSize=10`)).json();
  assert.equal(lastPage.data.pagination.page, 2);
  assert.equal(lastPage.data.profiles.length, 1);
  assert.equal(
    (
      await database
        .prepare('SELECT count(*) AS count FROM competitor_monitors WHERE workspace_id = ?')
        .bind('workspace')
        .first<{ count: number }>()
    )?.count,
    0
  );
});

test('pre-research archives a Keyword Harvester job and its action path without creating a monitor', async () => {
  const root = `${workspaceRoot}/research/pre-research`;
  const before = await database
    .prepare('SELECT count(*) AS count FROM competitor_monitors WHERE workspace_id = ?')
    .bind('workspace')
    .first<{ count: number }>();
  const sourceJobUrl =
    'chrome-extension://dpconkblakejdpcjkbapgpaajbcfbhlk/harvest.html?job=b76dd376-1f5d-4442-8999-e1897101d0d5';
  const created = await request(root, 'POST', {
    sourceJobUrl,
    sourceVersion: '0.7.15',
    title: 'image to prompt recursive harvest',
    currentQuery: 'image to prompt',
    harvestStatus: 'completed',
    seedKeywords: ['image to prompt', 'AI image prompt'],
    summary: 'All queued queries completed through the configured page boundary.',
    sourceThreadUrl: 'codex://threads/01a0cea4-fa9c-7b41-bbc3-825d907572b7',
  });
  assert.equal(created.status, 201);
  const runId = (await created.json()).data.id as string;
  assert.equal(
    (
      await request(`${root}/${runId}/actions`, 'POST', {
        kind: 'analysis',
        outcome: 'completed',
        title: 'Classified candidate domains',
        detail: 'No monitor was created during pre-research.',
        references: ['codex://threads/01a0cea4-fa9c-7b41-bbc3-825d907572b7'],
      })
    ).status,
    201
  );
  assert.equal(
    (await request(`${root}/${runId}/stage`, 'PATCH', { stage: 'reviewing' })).status,
    200
  );
  assert.deepEqual(
    await database
      .prepare('SELECT count(*) AS count FROM competitor_monitors WHERE workspace_id = ?')
      .bind('workspace')
      .first<{ count: number }>(),
    before
  );
  const list = (await (await request(`${root}?stage=reviewing`)).json()).data;
  assert.equal(list.source, 'keyword_harvester_import');
  assert.equal(list.runs.length, 1);
  assert.equal(list.runs[0].sourceJobId, 'b76dd376-1f5d-4442-8999-e1897101d0d5');
  assert.equal(list.runs[0].actionCount, 1);
  const detail = (await (await request(`${root}/${runId}`)).json()).data;
  assert.equal(detail.actions.length, 1);
  assert.equal(detail.actions[0].title, 'Classified candidate domains');
  const mcp = await (
    await request(
      '/api/mcp',
      'POST',
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: 'get_competitor_pre_research',
          arguments: { workspaceId: 'workspace', runId },
        },
      },
      'reader'
    )
  ).json();
  assert.equal(mcp.result.isError, false);
  assert.equal(JSON.parse(mcp.result.content[0].text).data.actions.length, 1);
  assert.equal(
    (await request(root, 'POST', { sourceJobUrl: 'https://fixture.example.com/' })).status,
    400
  );
  assert.equal(
    (
      await request(root, 'POST', {
        sourceJobUrl,
        sourceVersion: '0.7.15',
        title: 'Duplicate job',
        seedKeywords: [],
      })
    ).status,
    409
  );
  assert.equal(
    (await request(`${root}/missing/actions`, 'POST', { title: 'Missing' })).status,
    404
  );
  assert.equal(
    (
      await request(
        root,
        'POST',
        { sourceJobUrl, sourceVersion: '0.7.15', title: 'Blocked', seedKeywords: [] },
        'member'
      )
    ).status,
    403
  );
  assert.equal(
    (
      await request(root, 'POST', {
        sourceJobUrl:
          'chrome-extension://dpconkblakejdpcjkbapgpaajbcfbhlk/harvest.html?job=c7a4b371-1f5d-4442-8999-e1897101d0d5',
        sourceVersion: '0.7.15',
        title: 'Bounded import payload',
        seedKeywords: Array.from(
          { length: 50 },
          (_, index) => `keyword-${index}-${'x'.repeat(70)}`
        ),
        summary: 's'.repeat(1000),
      })
    ).status,
    201
  );
});

test('research profiles reject foreign links, write attempts from non-owners and duplicate workspace URLs', async () => {
  const profileId = await researchProfile();
  await database.batch([
    database.prepare(
      "INSERT INTO competitor_categories (id,workspace_id,name,name_key,created_at) VALUES ('outside-category','outside','Outside','outside',0)"
    ),
    database.prepare(
      "INSERT INTO competitor_research_profiles (id,workspace_id,brand_name,homepage_url,hostname,lifecycle_status,seed_keywords,payment_providers,sources,created_at,updated_at) VALUES ('outside-research','outside','Outside','https://outside.fixture.test/','outside.fixture.test','inbox','[]','[]','[]',0,0)"
    ),
  ]);
  await monitor('outside-monitor', 'outside.fixture.test', 'manual', null, 'outside-site');
  for (const [suffix, ids] of [
    ['categories', ['outside-category']],
    ['sites', ['outside-site']],
    ['monitors', ['outside-monitor']],
  ] as const)
    assert.equal(
      (await request(`${workspaceRoot}/research/${profileId}/${suffix}`, 'PUT', { ids })).status,
      404
    );
  assert.equal((await request(`${workspaceRoot}/research?monitorId=outside-monitor`)).status, 404);
  assert.equal(
    (
      await request(`${workspaceRoot}/research/outside-research/regenerate`, 'POST', {
        modelPreference: 'auto',
      })
    ).status,
    404
  );
  assert.equal((await request(`${workspaceRoot}/research/outside-research`, 'DELETE')).status, 404);
  assert.equal(
    (
      await request(`${workspaceRoot}/research`, 'POST', {
        brandName: 'Duplicate',
        homepageUrl: 'https://fixture.example.com/research',
        primaryGroupId: defaultResearchGroupId,
        seedKeywords: [],
        paymentProviders: [],
        sources: [],
      })
    ).status,
    409
  );
  for (const token of ['member', 'reader']) {
    assert.equal((await request(`${workspaceRoot}/research`, 'GET', undefined, token)).status, 200);
    for (const [path, method, body] of [
      [
        `${workspaceRoot}/research`,
        'POST',
        {
          brandName: 'Blocked',
          homepageUrl: 'https://fixture.example.com/blocked',
          primaryGroupId: defaultResearchGroupId,
          seedKeywords: [],
          paymentProviders: [],
          sources: [],
        },
      ],
      [`${workspaceRoot}/research/${profileId}`, 'PATCH', { notes: 'Blocked' }],
      [`${workspaceRoot}/research/${profileId}/regenerate`, 'POST', { modelPreference: 'auto' }],
      [`${workspaceRoot}/research/${profileId}`, 'DELETE', undefined],
      [`${workspaceRoot}/research/${profileId}/categories`, 'PUT', { ids: [] }],
    ] as const)
      assert.equal((await request(path, method, body, token)).status, 403);
  }
});

test('research profile limit and cascade cleanup protect bounded D1 metadata storage', async () => {
  await database.batch(
    Array.from({ length: 500 }, (_, index) =>
      database
        .prepare(
          'INSERT INTO competitor_research_profiles (id,workspace_id,brand_name,homepage_url,hostname,lifecycle_status,seed_keywords,payment_providers,sources,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
        )
        .bind(
          `research-limit-${index}`,
          'workspace',
          `Research ${index}`,
          `https://fixture.example.com/research-${index}`,
          'fixture.example.com',
          'inbox',
          '[]',
          '[]',
          '[]',
          index,
          index
        )
    )
  );
  const primaryGroupId = await researchGroup('Research limit', 'research limit');
  assert.equal(
    (
      await request(`${workspaceRoot}/research`, 'POST', {
        brandName: 'One too many',
        homepageUrl: 'https://fixture.example.com/research-overflow',
        primaryGroupId,
        seedKeywords: [],
        paymentProviders: [],
        sources: [],
      })
    ).status,
    409
  );
  await database
    .prepare("DELETE FROM competitor_research_profiles WHERE workspace_id = 'workspace'")
    .run();
  await database.batch([
    database.prepare(
      "INSERT INTO workspaces (id,name,slug) VALUES ('research-storage','Research storage','research-storage')"
    ),
    database.prepare(
      "INSERT INTO competitor_research_profiles (id,workspace_id,brand_name,homepage_url,hostname,lifecycle_status,seed_keywords,payment_providers,sources,created_at,updated_at) VALUES ('research-cascade','research-storage','Cascade','https://cascade.fixture.test/','cascade.fixture.test','inbox','[]','[]','[]',0,0)"
    ),
  ]);
  await database.prepare("DELETE FROM workspaces WHERE id = 'research-storage'").run();
  assert.equal(
    (
      await database
        .prepare(
          "SELECT count(*) AS count FROM competitor_research_profiles WHERE id = 'research-cascade'"
        )
        .first<{ count: number }>()
    )?.count,
    0
  );
});

test('normalized categories, URL uniqueness and concurrent limits cannot be bypassed by changing category', async () => {
  const categoryId = await category('ＡＩ');
  assert.equal(
    (await request(`${workspaceRoot}/categories`, 'POST', { name: ' ai ' })).status,
    409
  );
  const nextCategory = await category('Different');
  assert.equal(
    (
      await request(`${workspaceRoot}/categories/${nextCategory}`, 'PATCH', {
        name: 'Ai',
      })
    ).status,
    409
  );
  const responses = await Promise.all(
    Array.from({ length: 32 }, (_, index) =>
      request(`${workspaceRoot}/categories`, 'POST', { name: `Group ${index}` })
    )
  );
  assert.equal(responses.filter(response => response.status === 201).length, 28);
  const id = await independent({ categoryId });
  assert.equal(
    (
      await request(workspaceRoot, 'POST', {
        name: 'Duplicate',
        url: 'https://fixture.example.com/independent',
        categoryId: nextCategory,
      })
    ).status,
    409
  );
  const pages = await Promise.all(
    Array.from({ length: 22 }, (_, index) =>
      request(workspaceRoot, 'POST', {
        name: `Page ${index}`,
        url: `https://fixture.example.com/page-${index}`,
      })
    )
  );
  assert.equal(pages.filter(response => response.status === 201).length, 19);
  assert.equal(
    (await request(`${workspaceRoot}/${id}`, 'PATCH', { categoryId: nextCategory })).status,
    200
  );
  const linked = await independent({ siteId: 'site', url: 'https://fixture.example.com/linked' });
  assert.equal(
    (await request(`${workspaceRoot}/${linked}`, 'PATCH', { siteId: null })).status,
    409
  );
  const duplicate = await independent({ siteId: 'site' });
  assert.equal((await request(`${workspaceRoot}/${id}`, 'PATCH', { siteId: 'site' })).status, 409);
  assert.equal((await request(`${workspaceRoot}/${duplicate}`, 'DELETE')).status, 200);
  assert.equal((await request(`${workspaceRoot}/${id}`, 'PATCH', { siteId: 'site' })).status, 200);
});

test('workspace total limit also applies to the legacy site create route', async () => {
  await database
    .prepare(
      "INSERT INTO sites (id,user_id,workspace_id,name,domain) VALUES ('limit-site','owner','workspace','Limit','limit.fixture.test')"
    )
    .run();
  for (let index = 0; index < 100; index++)
    await monitor(`total-${index}`, 'fixture.example.com', 'manual', null, 'limit-site');
  const input = { name: 'Over limit', url: 'https://fixture.example.com/overflow' };
  assert.equal((await request('/api/competitors/site', 'POST', input)).status, 409);
  assert.equal((await request(workspaceRoot, 'POST', input)).status, 409);
  assert.equal((await (await request(workspaceRoot)).json()).data.monitors.length, 100);
  await database.prepare("DELETE FROM sites WHERE id='limit-site'").run();
});

test('independent scheduled monitors retain cooldown and intersected trend populations', async () => {
  const categoryId = await category();
  const id = await independent({ categoryId, cadence: 'daily' });
  await database
    .prepare('UPDATE competitor_monitors SET next_check_at = ? WHERE id = ?')
    .bind(instant, id)
    .run();
  await runCompetitorSchedule({ ...env, COMPETITOR_SCHEDULE_ENABLED: 'true' }, success, instant);
  assert.equal((await competitorHistory(database, id)).length, 1);
  assert.equal(
    await checkCompetitor(env, id, { workspaceId: 'outside' }, success, instant + HOST_COOLDOWN_MS),
    null
  );
  assert.equal(
    await checkCompetitor(env, id, { workspaceId: 'workspace' }, success, instant + 1),
    null
  );
  await checkCompetitor(env, id, { workspaceId: 'workspace' }, failure, Date.now());
  await monitor('linked');
  await checkCompetitor(env, 'linked', 'site', success, Date.now() + HOST_COOLDOWN_MS);
  const filtered = await competitorReport(
    env,
    { workspaceId: 'workspace', siteId: 'unlinked', categoryId },
    true
  );
  assert.equal(filtered.monitors.length, 1);
  assert.equal(
    filtered.trend.reduce((sum, day) => sum + day.checks, 0),
    2
  );
  assert.equal(filtered.trend.at(-1)?.failures, 1);
  assert.equal(filtered.trend.at(-1)?.changes, null);
  const intersection = await competitorReport(
    env,
    { workspaceId: 'workspace', siteId: 'site', categoryId },
    true
  );
  assert.equal(intersection.monitors.length, 0);
  assert.ok(intersection.trend.every(day => day.checks === 0));
});

test('workspace-only competitor data survives orphan cleanup', async () => {
  const db = drizzle(database);
  await database.batch([
    database.prepare("UPDATE users SET is_instance_owner=1 WHERE id='owner'"),
    database.prepare(
      "INSERT INTO workspaces (id,name,slug) VALUES ('orphan-competitors','Orphan','orphan-competitors')"
    ),
    database.prepare(
      "INSERT INTO competitor_monitors (id,workspace_id,name,url,hostname,selector,created_at) VALUES ('orphan-monitor','orphan-competitors','Only data','https://fixture.example.com/orphan','fixture.example.com','main',0)"
    ),
  ]);
  assert.equal(await workspaceHasCompetitors(db, 'orphan-competitors'), true);
  await evictOrphanedMembers(db);
  assert.equal(
    (
      await database
        .prepare("SELECT count(*) AS total FROM competitor_monitors WHERE id='orphan-monitor'")
        .first()
    )?.total,
    1
  );
  assert.equal(
    (
      await database
        .prepare(
          "SELECT role FROM workspace_members WHERE workspace_id='orphan-competitors' AND user_id='owner'"
        )
        .first()
    )?.role,
    'owner'
  );
  await database.batch([
    database.prepare("DELETE FROM workspaces WHERE id='orphan-competitors'"),
    database.prepare("UPDATE users SET is_instance_owner=0 WHERE id='owner'"),
  ]);
});

test('workspace MCP discovers scoped categories, filters evidence and rejects malformed/foreign arguments without fetching', async () => {
  const categoryId = await category();
  const monitorId = await independent({ categoryId });
  const profileId = await researchProfile({ lifecycleStatus: 'watch' });
  async function call(name: string, args: unknown) {
    return (
      await (
        await request(
          '/api/mcp',
          'POST',
          { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
          'reader'
        )
      ).json()
    ).result;
  }
  const workspaces = await call('list_competitor_workspaces', {});
  assert.equal(workspaces.isError, false);
  assert.deepEqual(
    JSON.parse(workspaces.content[0].text).data.map(item => item.id),
    ['workspace']
  );
  for (const [name, args] of [
    ['get_competitor_categories', { workspaceId: 'workspace' }],
    ['get_competitor_monitors', { workspaceId: 'workspace', categoryId, siteId: 'unlinked' }],
    ['get_competitor_history', { workspaceId: 'workspace', monitorId }],
    ['get_competitor_research', { workspaceId: 'workspace', lifecycleStatus: 'watch' }],
  ] as const)
    assert.equal((await call(name, args)).isError, false);
  const research = await call('get_competitor_research', {
    workspaceId: 'workspace',
    lifecycleStatus: 'watch',
  });
  assert.deepEqual(
    JSON.parse(research.content[0].text).data.profiles.map((item: { id: string }) => item.id),
    [profileId]
  );
  for (const args of [
    {},
    null,
    [],
    { workspaceId: null },
    { workspaceId: 12 },
    { workspaceId: 'outside' },
    { workspaceId: 'workspace', siteId: 'outside-site' },
    { workspaceId: 'workspace', categoryId: '' },
    { siteId: 'site', categoryId },
    { workspaceId: 'workspace', runScan: true },
  ])
    assert.equal((await call('get_competitor_monitors', args)).isError, true);
  for (const args of [
    {},
    { workspaceId: 'outside' },
    { workspaceId: 'workspace', lifecycleStatus: 'invalid' },
    { workspaceId: 'workspace', monitorId: 'outside-monitor' },
    { workspaceId: 'workspace', runScan: true },
  ])
    assert.equal((await call('get_competitor_research', args)).isError, true);
  assert.equal(
    (await call('get_competitor_history', { workspaceId: 'workspace', siteId: 'site', monitorId }))
      .isError,
    true
  );
  assert.equal(
    (await call('get_competitor_history', { workspaceId: 'outside', monitorId })).isError,
    true
  );
  assert.deepEqual(await competitorHistory(database, monitorId), []);
});

test('workspace categories support independent competitors and intersect with owned-site filters', async () => {
  const root = '/api/competitors/workspaces/workspace';
  const createdCategory = await request(`${root}/categories`, 'POST', {
    name: 'AI 视频',
  });
  assert.equal(createdCategory.status, 201);
  const categoryId = (await createdCategory.json()).data.id;
  const independent = await request(root, 'POST', {
    name: 'Independent fixture',
    url: 'https://fixture.example.com/independent',
    categoryId,
  });
  assert.equal(independent.status, 201);
  const monitorId = (await independent.json()).data.id;
  assert.equal(
    (
      await request(root, 'POST', {
        name: 'Site fixture',
        url: 'https://fixture.example.com/linked',
        categoryId,
        siteId: 'site',
      })
    ).status,
    201
  );
  const all = (await (await request(`${root}?categoryId=${categoryId}`)).json()).data;
  assert.equal(all.monitors.length, 2);
  const unlinked = (
    await (await request(`${root}?categoryId=${categoryId}&siteId=unlinked`)).json()
  ).data;
  assert.deepEqual(
    unlinked.monitors.map(item => item.id),
    [monitorId]
  );
  assert.equal(unlinked.monitors[0].siteId, null);
  assert.equal((await (await request('/api/competitors/site')).json()).data.monitors.length, 1);
  assert.equal((await request(`${root}?categoryId=${categoryId}&siteId=other-site`)).status, 200);
  assert.equal(
    (await (await request(`${root}?categoryId=${categoryId}&siteId=other-site`)).json()).data
      .monitors.length,
    0
  );
});
