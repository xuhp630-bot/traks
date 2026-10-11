import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AiVisibilityReport, AiVisibilitySnapshot } from '../packages/shared/src';
import type {
  AiVisibilityExactRead,
  AiVisibilitySnapshotsViewProps,
} from '../apps/platform/web/src/components/analytics/AiVisibilitySnapshots';

type UiModule =
  typeof import('../apps/platform/web/src/components/analytics/AiVisibilitySnapshots');
let ui: UiModule;

before(async () => {
  // Compile the real component in memory; no file writes, auth or external API.
  const bundle = await build({
    entryPoints: ['apps/platform/web/src/components/analytics/AiVisibilitySnapshots.tsx'],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    target: 'es2022',
    jsx: 'automatic',
    external: ['react', 'react/jsx-runtime', '@tanstack/react-query'],
    logLevel: 'silent',
    plugins: [
      {
        name: 'no-auth-or-api-in-visibility-ssr',
        setup(builder) {
          builder.onResolve({ filter: /^@\/lib\/api$/ }, () => ({
            path: 'api',
            namespace: 'synthetic',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'synthetic' }, () => ({
            contents: `
            export class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }
            export const api = {
              getAiVisibilitySnapshots() { throw new Error('No API in isolated SSR tests'); },
              getAiVisibilitySnapshot() { throw new Error('No API in isolated SSR tests'); },
              importAiVisibilitySnapshot() { throw new Error('No production writes in isolated SSR tests'); }
            };`,
            loader: 'js',
          }));
        },
      },
    ],
  });
  const compiled = { exports: {} };
  new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(
    createRequire(import.meta.url),
    compiled,
    compiled.exports
  );
  ui = compiled.exports as UiModule;
});

const snapshot = (
  provider: AiVisibilitySnapshot['provider'] = 'google_search_ai'
): AiVisibilitySnapshot => ({
  format: 'ai-visibility-snapshot/v1',
  provider,
  connectionMode: 'manual_snapshot',
  sourceRef:
    provider === 'google_search_ai'
      ? 'google_search_console_ai_report'
      : 'bing_webmaster_ai_performance',
  property: 'https://synthetic.example.com/',
  capturedAt: '2026-10-10T01:00:00.000Z',
  window: {
    startDate: '2026-10-01',
    endDate: '2026-10-09',
    timezone: provider === 'google_search_ai' ? 'America/Los_Angeles' : 'provider_unspecified',
    completeThrough: '2026-10-09',
    dataState: 'final',
  },
  total: {
    metric: provider === 'google_search_ai' ? 'impressions' : 'citations',
    value: 29,
    aggregation: 'property',
  },
  pageRows: [{ page: 'https://synthetic.example.com/tool', value: 31 }],
  dateRows: [{ date: '2026-10-09', value: 29 }],
  coverage: {
    availableExportComplete: true,
    platformAllRowsKnown: false,
    uiPageRows: 1,
    uiDateRows: 1,
    exportedPageRows: 1,
    exportedDateRows: 1,
    platformRowLimit: null,
    nullsExportedAsZero: false,
  },
  sourceArchiveSha256: 'a'.repeat(64),
  snapshotId: 'b'.repeat(64),
  siteId: 'synthetic-site',
  origin: 'https://synthetic.example.com',
});
const report = (snapshots: AiVisibilitySnapshot[] = [], canManage = true): AiVisibilityReport => ({
  format: 'ai-visibility-report/v2',
  connectionMode: 'manual_snapshot',
  continuousConnection: 'not_connected',
  status: snapshots.length ? 'snapshots_available' : 'not_connected',
  canManage,
  readAt: '2026-10-11T06:00:00.000Z',
  snapshots,
  coverage: {
    pageComplete: true,
    historyComplete: true,
    snapshotCount: snapshots.length,
    pageSize: 16,
    hasMore: false,
    nextCursor: null,
    consistency: 'eventually_consistent',
    visibilityDelaySeconds: 60,
  },
});
const html = (props: Partial<AiVisibilitySnapshotsViewProps> = {}): string =>
  renderToStaticMarkup(
    createElement(ui.AiVisibilitySnapshotsView, {
      isOwner: true,
      siteId: 'synthetic-site',
      onRefresh: () => {},
      onExport: () => {},
      ...props,
    })
  );
const file = (
  value: string,
  name = 'synthetic.json',
  size = new TextEncoder().encode(value).byteLength
) => ({
  name,
  size,
  text: async () => value,
});

test('missing, empty and 404 capabilities remain not connected/unknown, not fake zero', () => {
  const missing = html();
  assert.match(missing, /快照能力尚未接通/);
  assert.doesNotMatch(missing, /属性总计 · impressions/);
  const empty = html({ report: report() });
  assert.match(empty, /本页尚无可核验快照/);
  assert.match(empty, /曝光与引用未知，不是 0/);
  const absentEndpoint = html({ isError: true, statusCode: 404 });
  assert.match(absentEndpoint, /当前后端快照能力或访问不可用（404）/);
  assert.doesNotMatch(absentEndpoint, /属性总计 · impressions/);
});

test('loading and read failure retain separate status and previously dated evidence', () => {
  const loading = html({ isFetching: true });
  assert.match(loading, /正在读取后端当前历史页/);
  assert.match(loading, /正在重读快照/);
  assert.match(loading, /<button[^>]+disabled=""/);
  const failed = html({ report: report([snapshot()]), isError: true, statusCode: 503 });
  assert.match(failed, /快照读取失败（503）/);
  assert.match(failed, /保留上次 2026-10-11 06:00:00.000Z 读回的当前页数据/);
  assert.match(failed, /Google Search AI · 曝光快照/);
  assert.match(failed, /当前状态未验证/);
  assert.match(failed, /<fieldset[^>]+disabled=""/);
});

test('Google official manual snapshot keeps impressions and differing aggregation truthful', () => {
  const rendered = html({ report: report([snapshot()]) });
  assert.match(rendered, /Google Search Console AI report/);
  assert.match(rendered, /America\/Los_Angeles/);
  assert.match(rendered, /2026-10-01 → 2026-10-09/);
  assert.match(rendered, /属性总计 · impressions/);
  assert.match(rendered, /impressions（曝光），不是引用、点击、CTR、查询数或访问者/);
  assert.match(rendered, /分组合计与属性总计存在差异/);
  assert.match(rendered, /持续官方 API · 未连接/);
  assert.match(rendered, /不受上方访问统计日期、渠道、流量或页面筛选影响/);
  assert.match(rendered, /四类来源观测报告中的 citations=null 不因快照自动改写/);
  assert.match(rendered, /平台全量行数是否已知/);
  assert.match(rendered, /否；本次完整不证明平台全量完整/);
  assert.match(rendered, /未声明此项风险（不证明 0 一定真实）/);
});

test('Bing citations are distinct from visits, tasks and Google impressions', () => {
  const rendered = html({ report: report([snapshot('bing_ai_surfaces')]) });
  assert.match(rendered, /Bing Webmaster AI Performance/);
  assert.match(rendered, /属性总计 · citations/);
  assert.match(rendered, /citations（引用）；不是点击、访问、AI 排名或任务完成数/);
  assert.match(rendered, /平台未指定/);
  assert.doesNotMatch(rendered, /属性总计 · impressions/);
});

test('missing rows and null cells do not become group zero; real known zero survives', () => {
  const value = snapshot();
  value.total.value = 0;
  value.pageRows = [];
  value.coverage.exportedPageRows = 0;
  value.coverage.uiPageRows = 0;
  value.dateRows[0].value = null;
  const rendered = html({ report: report([value]) });
  assert.match(rendered, /未提供页面行；合计未知/);
  assert.match(rendered, />未知</);
  assert.match(rendered, /属性总计 · impressions<\/dt><dd[^>]*>0<\/dd>/);
  assert.doesNotMatch(rendered, /分组合计与属性总计存在差异/);
});

test('unsafe grouping sums remain unknown rather than rounded fabricated counts', () => {
  const value = snapshot();
  value.pageRows = [
    { page: 'https://synthetic.example.com/a', value: Number.MAX_SAFE_INTEGER },
    { page: 'https://synthetic.example.com/b', value: Number.MAX_SAFE_INTEGER },
  ];
  value.coverage.exportedPageRows = 2;
  value.coverage.uiPageRows = 2;
  const rendered = html({ report: report([value]) });
  assert.match(rendered, /已导出页面分组合计<\/dt><dd[^>]*>未知<\/dd>/);
  assert.match(rendered, /格式校验与归档哈希不会自动核实官方报表真伪/);
});

test('source coverage, preliminary data and null-to-zero caveat remain visible', () => {
  const value = snapshot();
  value.capturedAt = null;
  value.window.completeThrough = null;
  value.window.dataState = 'preliminary';
  value.coverage.availableExportComplete = false;
  value.coverage.uiPageRows = null;
  value.coverage.nullsExportedAsZero = true;
  const rendered = html({ report: report([value]) });
  assert.match(rendered, /否 \/ 部分导出/);
  assert.match(rendered, /初步数据/);
  assert.match(rendered, /导出 0 的空值歧义/);
  assert.match(rendered, /可能存在；无法从 0 还原原始空值/);
  assert.doesNotMatch(rendered, /是；无法从这些 0/);
  assert.match(rendered, /未知 \/ 1/);
  assert.match(rendered, new RegExp('归档 SHA-256：' + value.sourceArchiveSha256));
});

test('member UI cannot import even if report says manage; owner still requires backend permission', () => {
  assert.doesNotMatch(html({ isOwner: false, report: report([snapshot()], true) }), /type="file"/);
  const deniedOwner = html({ isOwner: true, report: report([], false) });
  assert.match(deniedOwner, /<fieldset[^>]+disabled=""/);
  assert.match(deniedOwner, /导入需本站站主权限/);
  const authorized = html({ isOwner: true, report: report([], true) });
  assert.match(authorized, /type="file" accept=".json,application\/json"/);
  assert.doesNotMatch(authorized, /<fieldset[^>]+disabled=""/);
});

const exactRead = (value = snapshot()): AiVisibilityExactRead => ({
  format: 'ai-visibility-snapshot-read/v1',
  connectionMode: 'manual_snapshot',
  continuousConnection: 'not_connected',
  readAt: '2026-10-11T06:03:00.000Z',
  snapshot: value,
});

test('POST acceptance needs a successful same-site exact ID GET, not history membership', () => {
  const pendingImport = {
    snapshotId: snapshot().snapshotId,
    acceptedAt: '2026-10-11T06:02:00.000Z',
  };
  assert.match(html({ pendingImport, report: report() }), /stored_pending_readback/);
  assert.doesNotMatch(html({ pendingImport, report: report() }), /snapshot_verified/);
  assert.doesNotMatch(html({ pendingImport, report: report([snapshot()]) }), /snapshot_verified/);
  assert.match(
    html({ pendingImport, report: report(), exactRead: exactRead() }),
    /snapshot_verified/
  );
  const staleFailure = html({
    pendingImport,
    report: report(),
    exactRead: exactRead(),
    exactReadError: true,
    exactReadStatusCode: 503,
  });
  assert.match(staleFailure, /stored_pending_readback/);
  assert.doesNotMatch(staleFailure, /snapshot_verified/);
  assert.match(staleFailure, /精确读回失败（503）/);
  assert.match(staleFailure, /上次有日期的读回证据/);
  const wrongSite = snapshot();
  wrongSite.siteId = 'another-synthetic-site';
  const mismatched = html({ pendingImport, report: report(), exactRead: exactRead(wrongSite) });
  assert.doesNotMatch(mismatched, /snapshot_verified/);
  assert.match(mismatched, /精确读回范围或版本不匹配/);
  assert.doesNotMatch(mismatched, /属性总计 · impressions/);
});

const buttonAttributes = (rendered: string, label: string): string => {
  const found = Array.from(rendered.matchAll(/<button([^>]*)>([^<]*)<\/button>/g)).find(
    match => match[2].trim() === label
  );
  assert.ok(found, `Missing button ${label}`);
  return found[1];
};

test('paged history distinguishes page completeness from history and supports next/previous/reset', () => {
  const first = report([snapshot()]);
  first.coverage.historyComplete = false;
  first.coverage.hasMore = true;
  first.coverage.nextCursor = 'opaque-synthetic-next';
  const navigation = { onNext: () => {}, onPrevious: () => {}, onResetHistory: () => {} };
  const renderedFirst = html({ report: first, ...navigation });
  assert.match(renderedFirst, /当前页读取完整/);
  assert.match(renderedFirst, /全历史未完整读取；本页数量不是历史总量/);
  assert.match(renderedFirst, /翻页计数与指标不累加为历史总量/);
  assert.match(buttonAttributes(renderedFirst, '上一页快照'), /\sdisabled="/);
  assert.doesNotMatch(buttonAttributes(renderedFirst, '下一页快照'), /\sdisabled="/);
  assert.match(buttonAttributes(renderedFirst, '返回首批快照'), /\sdisabled="/);

  const second = report([snapshot()]);
  second.coverage.historyComplete = false;
  const renderedSecond = html({ report: second, pageNumber: 2, canPrevious: true, ...navigation });
  assert.doesNotMatch(buttonAttributes(renderedSecond, '上一页快照'), /\sdisabled="/);
  assert.match(buttonAttributes(renderedSecond, '下一页快照'), /\sdisabled="/);
  assert.doesNotMatch(buttonAttributes(renderedSecond, '返回首批快照'), /\sdisabled="/);
  assert.match(renderedSecond, /当前页已到列表末尾，但此前页未累计读取为完整历史/);
  const loading = html({
    report: first,
    isFetching: true,
    pageNumber: 2,
    canPrevious: true,
    ...navigation,
  });
  for (const label of ['上一页快照', '下一页快照', '返回首批快照'])
    assert.match(buttonAttributes(loading, label), /\sdisabled="/);
});

test('empty continuation page and failed page never mean all saved history is empty', () => {
  const continuation = report();
  continuation.status = 'history_page_empty';
  continuation.coverage.historyComplete = false;
  const rendered = html({ report: continuation, pageNumber: 7, canPrevious: true });
  assert.match(rendered, /不能据此判断所有保存历史为空/);
  assert.match(rendered, /曝光与引用未知，不是 0/);
  assert.doesNotMatch(rendered, /本次首批页覆盖当前可读的全部保存历史/);
  const failed = html({ isError: true, statusCode: 409, pageNumber: 7, onResetHistory: () => {} });
  assert.match(failed, /快照读取失败（409）/);
  assert.doesNotMatch(buttonAttributes(failed, '返回首批快照'), /\sdisabled="/);
  assert.doesNotMatch(failed, /属性总计 · impressions/);
});

test('legacy whole-list, malformed page and cross-site records are rejected as unavailable', () => {
  const legacy = {
    ...report([snapshot()]),
    format: 'ai-visibility-report/v1',
  } as unknown as AiVisibilityReport;
  const legacyHtml = html({ report: legacy });
  assert.match(legacyHtml, /报告版本、分页合同或站点范围不兼容/);
  assert.doesNotMatch(legacyHtml, /属性总计 · impressions|后端当前页读回/);
  assert.match(legacyHtml, /<fieldset[^>]+disabled=""/);
  const malformed = report([snapshot()]);
  malformed.coverage.snapshotCount = 2;
  assert.doesNotMatch(html({ report: malformed }), /属性总计 · impressions/);
  const oversized = report(Array.from({ length: 17 }, () => snapshot()));
  assert.match(html({ report: oversized }), /快照能力尚待接入/);
  const unscoped = snapshot();
  unscoped.siteId = 'another-synthetic-site';
  assert.doesNotMatch(html({ report: report([unscoped]) }), /属性总计 · impressions/);
  assert.equal(
    ui.compatibleAiVisibilityReport(report([snapshot()]), 'another-synthetic-site'),
    false
  );
});

test('new import can be verified beyond page one with at most sixteen page cards plus one exact card', () => {
  const page = report(
    Array.from({ length: 16 }, (_, index) => ({
      ...snapshot(),
      snapshotId: (index + 1).toString(16).padStart(64, '0'),
    }))
  );
  page.coverage.historyComplete = false;
  page.coverage.hasMore = true;
  page.coverage.nextCursor = 'opaque-synthetic-next';
  const imported = snapshot();
  const pendingImport = { snapshotId: imported.snapshotId, acceptedAt: '2026-10-11T06:02:00.000Z' };
  const rendered = html({ report: page, pendingImport, exactRead: exactRead(imported) });
  assert.equal((rendered.match(/<article\b/g) ?? []).length, 17);
  assert.match(rendered, /本次导入的精确读回快照（不属于当前历史页；不计入本页数量）/);
  assert.match(rendered, /snapshot_verified/);
  assert.match(rendered, /不证明完整历史、持续官方连接或全部引用/);
  assert.match(rendered, /本页 16 份快照/);
  const samePage = html({
    report: report([imported]),
    pendingImport,
    exactRead: exactRead(imported),
  });
  assert.equal((samePage.match(/<article\b/g) ?? []).length, 1);
  const wrongId = { ...imported, snapshotId: 'd'.repeat(64) };
  const wrongHtml = html({ report: page, pendingImport, exactRead: exactRead(wrongId) });
  assert.doesNotMatch(wrongHtml, /snapshot_verified/);
  assert.equal((wrongHtml.match(/<article\b/g) ?? []).length, 16);
  const independent = html({
    report: page,
    isError: true,
    pendingImport,
    exactRead: exactRead(imported),
  });
  assert.match(independent, /快照读取失败/);
  assert.match(independent, /snapshot_verified/);
});

test('pending exact read loading or missing record stays pending and is scoped by both site and ID', () => {
  const pendingImport = {
    snapshotId: snapshot().snapshotId,
    acceptedAt: '2026-10-11T06:02:00.000Z',
  };
  const loading = html({ pendingImport, report: report(), isExactFetching: true });
  assert.match(loading, /正在精确读回本次导入；不依赖历史第一页位置/);
  assert.doesNotMatch(loading, /snapshot_verified/);
  const notVisibleYet = html({
    pendingImport,
    report: report(),
    exactReadError: true,
    exactReadStatusCode: 404,
  });
  assert.match(notVisibleYet, /精确读回失败（404）/);
  assert.match(notVisibleYet, /stored_pending_readback/);
  assert.doesNotMatch(notVisibleYet, /snapshot_verified/);
  assert.equal(
    ui.compatibleAiVisibilityExactRead(
      exactRead(),
      'another-synthetic-site',
      snapshot().snapshotId
    ),
    false
  );
  assert.equal(
    ui.compatibleAiVisibilityExactRead(exactRead(), 'synthetic-site', 'd'.repeat(64)),
    false
  );
});

test('full JSON export retains all rows beyond the ten-row preview and is reimportable', async () => {
  const value = snapshot();
  value.pageRows = Array.from({ length: 84 }, (_, index) => ({
    page: `https://synthetic.example.com/tool-${index}`,
    value: 1,
  }));
  value.coverage.exportedPageRows = 84;
  value.coverage.uiPageRows = 84;
  const rendered = html({ report: report([value]) });
  assert.match(rendered, /已保存页面 84 行/);
  assert.doesNotMatch(rendered, /synthetic.example.com\/tool-83/);
  const output = ui.serializeAiVisibilitySnapshot(value);
  const parsed = JSON.parse(output);
  assert.equal(parsed.pageRows.length, 84);
  assert.equal(parsed.pageRows[83].page, 'https://synthetic.example.com/tool-83');
  assert.equal(parsed.sourceArchiveSha256, value.sourceArchiveSha256);
  assert.equal(parsed.snapshotId, undefined);
  assert.equal(parsed.siteId, undefined);
  assert.equal(parsed.origin, undefined);
  const validated = await ui.readAiVisibilityJsonFile(file(output));
  assert.equal(validated.pageRows.length, 84);
});

test('JSON parser rejects non-JSON, corrupt, empty, oversize and unsupported snapshots before POST', async () => {
  await assert.rejects(
    ui.readAiVisibilityJsonFile(file('{}', 'archive.zip')),
    /不解析 ZIP、CSV 或 Excel/
  );
  await assert.rejects(ui.readAiVisibilityJsonFile(file('{}', 'report.csv')), /请选择 .json/);
  await assert.rejects(ui.readAiVisibilityJsonFile(file('', 'empty.json')), /必须非空/);
  await assert.rejects(
    ui.readAiVisibilityJsonFile(file('{}', 'oversize.json', 524289)),
    /不超过 512 KiB/
  );
  await assert.rejects(
    ui.readAiVisibilityJsonFile(file('x'.repeat(524289), 'wrong-size.json', 1)),
    /内容超过允许大小/
  );
  await assert.rejects(ui.readAiVisibilityJsonFile(file('{')), /JSON 解析失败/);
  await assert.rejects(
    ui.readAiVisibilityJsonFile(file('{}')),
    /不符合 ai-visibility-snapshot\/v1 合同/
  );
  const invalid = JSON.parse(ui.serializeAiVisibilitySnapshot(snapshot()));
  invalid.provider = 'chatgpt';
  await assert.rejects(ui.readAiVisibilityJsonFile(file(JSON.stringify(invalid))), /不符合/);
});

test('import busy/error and tiny-screen layout affordances are present without source data leakage', () => {
  const rendered = html({
    report: report(),
    isImporting: true,
    importError: 'JSON 解析失败，尚未提交。',
  });
  assert.match(rendered, /正在校验或提交快照/);
  assert.match(rendered, /role="alert"[^>]*>JSON 解析失败/);
  assert.match(rendered, /<fieldset[^>]+disabled=""/);
  assert.match(rendered, /<label for="[^"]+"/);
  assert.match(rendered, /w-full max-w-full/);
  assert.match(rendered, /min-h-11/);
  assert.match(rendered, /不会解析 ZIP\/CSV、保存到 localStorage/);
});

test('actual site route mounts independently of business/raw branch, period/filter and global refresh', () => {
  const source = readFileSync(
    new URL('../apps/platform/web/src/routes/portal.site.$siteId.lazy.tsx', import.meta.url),
    'utf8'
  );
  const mounted = source.indexOf(
    "<AiVisibilitySnapshots key={siteId} siteId={siteId} isOwner={site?.role === 'owner'} />"
  );
  assert.ok(mounted > source.indexOf('{!showRaw ? ('));
  assert.ok(mounted > source.indexOf('<FunnelsPanel'));
  assert.ok(mounted < source.indexOf('<EditSiteModal\n'));
  assert.match(source, /invalidateQueries\(\{ queryKey: aiVisibilityQueryKey\(siteId\) \}\)/);
  assert.deepEqual(ui.aiVisibilityQueryKey('synthetic-site'), [
    'site-ai-visibility',
    'synthetic-site',
  ]);
  const component = readFileSync(
    new URL(
      '../apps/platform/web/src/components/analytics/AiVisibilitySnapshots.tsx',
      import.meta.url
    ),
    'utf8'
  );
  assert.match(
    component,
    /api\.getAiVisibilitySnapshots\(siteId, signal, pageCursor \?\? undefined\)/
  );
  assert.match(
    component,
    /api\.getAiVisibilitySnapshot\(siteId, pendingImport!\.snapshotId, signal\)/
  );
  assert.match(component, /api\.importAiVisibilitySnapshot\(siteId, input\)/);
  assert.doesNotMatch(component, /localStorage\.(?:setItem|getItem)|refetchInterval/);
  assert.doesNotMatch(component, /\bperiod:|\bfilters:/);
  assert.equal((component.match(/gcTime: 0/g) ?? []).length, 3);
  assert.match(component, /mutation\.reset\(\)/);
  assert.match(
    component,
    /queryKey: \[\.\.\.aiVisibilityQueryKey\(siteId\), 'history', pageCursor\]/
  );
  assert.match(
    component,
    /queryKey: \[\.\.\.aiVisibilityQueryKey\(siteId\), 'snapshot', pendingImport\?\.snapshotId\]/
  );
  assert.match(component, /\.slice\(-AI_VISIBILITY_PREVIOUS_CURSOR_LIMIT\)/);
  assert.equal(ui.AI_VISIBILITY_PREVIOUS_CURSOR_LIMIT, 16);
  assert.doesNotMatch(component, /placeholderData|useInfiniteQuery|setSnapshots/);
});
