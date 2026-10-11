import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QualityAccumulator, normalizeEvidence, type AiSourceReport } from '../packages/shared/src';
import { buildAnalysisPackage, analysisMarkdown } from '../packages/shared/src/quality-brief';
import { AiSourceGroups } from '../apps/platform/web/src/components/analytics/AiSourceGroups';
import { QualityWorkflow } from '../apps/platform/web/src/components/analytics/QualityWorkflow';

const window = {
  from: Date.parse('2026-10-09T00:00:00.000Z'),
  to: Date.parse('2026-10-10T00:00:00.000Z'),
  source: 'historical' as const,
};
const base = (): AiSourceReport => new QualityAccumulator().report().aiSources!;
const html = (summary?: AiSourceReport, evidenceWindow = window) =>
  renderToStaticMarkup(
    createElement(AiSourceGroups, {
      summary,
      evidenceWindow,
      traffic: 'production',
    })
  );
const row = (session: string, ts: number, source = 'chatgpt', path = '/concrete-bag-calculator') =>
  normalizeEvidence({
    ts,
    session_id: session,
    event_type: 'pageview',
    event_name: '',
    event_count: 1,
    pathname: path,
    utm_source: source,
    utm_campaign: session,
    device_type: 'desktop',
    browser: 'Chrome',
    event_meta: JSON.stringify({
      traffic_type: 'production',
      tracking_version: 'cw-v3',
      release_version: 'local-fixture',
      page_id: 'p_123456789abc',
      calculator_type: path === '/concrete-bag-calculator' ? 'bag' : 'unknown',
    }),
  });

test('old report has unavailable status, not invented provider zero cards', () => {
  const rendered = html();
  assert.match(rendered, /能力待接入/);
  assert.match(rendered, /不能把缺字段当作 0/);
  assert.doesNotMatch(rendered, /来源访问（会话）/);
  const report = new QualityAccumulator().report();
  delete report.aiSources;
  const workflow = renderToStaticMarkup(
    createElement(QualityWorkflow, { report, onExport: () => {} })
  );
  assert.match(workflow, /AI 来源观测 · 能力待接入/);
});

test('complete empty window never depicts six engines as zero citations or conversions', () => {
  const rendered = html(base());
  assert.match(rendered, /没有 collector 会话/);
  assert.match(rendered, /独立引用 \/ 曝光证据 · 未接入/);
  assert.match(rendered, /均为未知，不是 0/);
  assert.doesNotMatch(rendered, /来源访问（会话）/);
});

test('old evidence observations are unavailable; partial coverage is visible, never silently zero-filled', () => {
  const unavailable = base();
  unavailable.denominatorSessions = 4;
  unavailable.status = 'unavailable';
  unavailable.coverage.sourceObservationUnavailableSessions = 4;
  assert.match(html(unavailable), /能力待接入/);
  assert.doesNotMatch(html(unavailable), /来源访问（会话）/);
  const partial = base();
  partial.denominatorSessions = 4;
  partial.status = 'partial';
  partial.coverage.sourceObservationUnavailableSessions = 3;
  assert.match(html(partial), /3 个选定会话缺少兼容来源观测/);
  assert.match(html(partial), /不是完整 AI 流量/);
});

test('four provider rows distinguish session/PV/results from independent citation evidence', () => {
  const summary = base();
  summary.denominatorSessions = 8;
  summary.coverage.recognizedSessions = 2;
  summary.coverage.unclassifiedSessions = 6;
  Object.assign(summary.groups[0], {
    sessions: 2,
    pageviews: 5,
    toolSuccessSessions: 1,
    resultUseSessions: 1,
    goalEligibleSessions: 1,
    goalCoverage: 'known_calculator_signals_only',
  });
  const rendered = html(summary);
  assert.match(rendered, /ChatGPT/);
  assert.match(rendered, /Perplexity/);
  assert.match(rendered, /Claude/);
  assert.match(rendered, /Bing \/ Copilot（明确 AI 来源）/);
  assert.match(rendered, /已知计算器上下文覆盖 1 \/ 2 会话/);
  assert.match(rendered, /不是独立用户、多触点归因或严格顺序漏斗/);
  assert.match(rendered, /Google AI Overview \/ AI Mode/);
  assert.match(rendered, /Apple 生态搜索/);
  assert.match(rendered, /Labelled production/);
  assert.match(rendered, /Historical collector/);
  assert.match(rendered, /2026-10-09 00:00:00 UTC/);
});

test('ordinary channels are not labelled unknown AI; missing goals remain not applicable/unknown', () => {
  const accumulator = new QualityAccumulator();
  accumulator.add([
    row('ai', 1, 'chatgpt', '/tools/image'),
    row('google', 2, 'google'),
    row('bing', 3, 'bing'),
    row('apple', 4, 'apple'),
  ]);
  const summary = accumulator.report().aiSources!;
  assert.equal(summary.coverage.recognizedSessions, 1);
  assert.equal(summary.coverage.unclassifiedSessions, 3);
  const rendered = html(summary);
  assert.match(rendered, /非AI \/ 未归因会话/);
  assert.match(rendered, /不适用 \/ 未知/);
  assert.match(rendered, /不能称为“未知 AI 流量”/);
  assert.match(rendered, /其他工具的真实任务结果需单独适配/);
});

test('unknown malformed counts/window do not crash or become zeros', () => {
  const summary = base();
  summary.denominatorSessions = 1;
  summary.groups[0].sessions = NaN;
  summary.groups[0].pageviews = -1;
  summary.coverage.recognizedSessions = NaN;
  const rendered = html(summary, { from: NaN, to: Infinity, source: 'historical' });
  assert.match(rendered, /时间未知/);
  assert.doesNotMatch(rendered, />NaN<|>Infinity<|>-1</);
  const absentWindow = renderToStaticMarkup(createElement(AiSourceGroups, { summary }));
  assert.match(absentWindow, /窗口未提供/);
  assert.match(absentWindow, /流量选择未提供/);
});

test('large acquisition preview never truncates AI/export coverage', () => {
  const accumulator = new QualityAccumulator();
  accumulator.add(Array.from({ length: 84 }, (_, index) => row('synthetic-' + index, index + 1)));
  const report = accumulator.report();
  const rendered = renderToStaticMarkup(
    createElement(QualityWorkflow, {
      report,
      onExport: () => {},
      traffic: 'production',
      evidenceWindow: window,
    })
  );
  assert.match(rendered, /显示更多渠道分组/);
  assert.match(rendered, /JSON \/ Markdown 导出保留全部来源分组/);
  const scope = {
    ...window,
    siteId: 'synthetic-only',
    period: 'yesterday',
    traffic: 'production' as const,
    totalGroups: 84,
    totalEvents: 84,
    cohortFilterKeys: [],
  };
  const pack = buildAnalysisPackage(report, scope);
  assert.equal(pack.acquisition.length, 84);
  assert.equal(pack.aiSources?.groups[0].sessions, 84);
  assert.equal(pack.aiSources?.groups.length, 4);
  assert.match(analysisMarkdown(pack), /84/);
});

test('AI panel uses existing complete read gate and passes selected scope only', () => {
  const consoleSource = readFileSync(
    new URL('../apps/platform/web/src/components/analytics/QualityConsole.tsx', import.meta.url),
    'utf8'
  );
  assert.match(consoleSource, /const ready = !!report && !scan\.isFetching && !scan\.isError/);
  assert.match(consoleSource, /\{ready && report && scan\.data && \(/);
  assert.match(consoleSource, /traffic=\{traffic\}/);
  assert.match(consoleSource, /evidenceWindow=\{scan\.data\.window\}/);
  assert.match(consoleSource, /No partial export is available/);
});
