import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QualityAccumulator } from '../packages/shared/src/quality';
import { buildAnalysisPackage } from '../packages/shared/src/quality-brief';
import {
  BusinessHealth,
  BusinessReadStatus,
  formatBusinessTimestamp,
} from '../apps/platform/web/src/components/analytics/BusinessHealth';

const report = () =>
  buildAnalysisPackage(new QualityAccumulator().report('production'), {
    siteId: 'fixture-site',
    period: 'yesterday',
    traffic: 'production',
    from: Date.parse('2026-09-22T00:00:00.000Z'),
    to: Date.parse('2026-09-23T00:00:00.000Z'),
    source: 'historical',
    totalGroups: 0,
    totalEvents: 0,
    cohortFilterKeys: [],
  });

const readStatus = (props: Partial<React.ComponentProps<typeof BusinessReadStatus>> = {}) =>
  renderToStaticMarkup(
    <BusinessReadStatus
      label="业务聚合"
      hasData={false}
      isFetching={false}
      isError={false}
      lastUpdatedAt={0}
      {...props}
    />
  );

test('timestamps distinguish unknown from a successful UTC reading', () => {
  assert.equal(formatBusinessTimestamp(undefined), '未知');
  assert.equal(formatBusinessTimestamp('not-a-date'), '未知');
  assert.equal(formatBusinessTimestamp('2026-09-23T00:00:00.000Z'), '2026-09-23 00:00:00 UTC');
});

test('empty quality evidence is not uptime or proof of zero faults', () => {
  const html = renderToStaticMarkup(<BusinessHealth report={report()} />);
  assert.match(html, /当前窗口质量观测/);
  assert.match(html, /未观测到已分类异常/);
  assert.match(html, /不等于没有故障/);
  assert.match(html, /不提供独立可用性探测或后台告警/);
  assert.match(html, /当前未提供同口径经营趋势/);
  assert.doesNotMatch(html, /本轮未接入/);
  assert.doesNotMatch(html, /服务正常|零故障|100%/);
});

test('scope, build time and mixed-cohort gaps retain distinct labels', () => {
  const fixture = report();
  fixture.generatedAt = '2026-09-23T01:02:03.000Z';
  fixture.scope.cohortFilterKeys = ['page', 'device'];
  fixture.population.wholeCohortUnassociatedEvents = 7;
  fixture.population.selectedLimitedSessions = 2;
  const html = renderToStaticMarkup(<BusinessHealth report={fixture} />);
  assert.match(html, /数据截止/);
  assert.match(html, /报告生成/);
  assert.match(html, /2026-09-23 01:02:03 UTC/);
  assert.match(html, /当前筛选会话窗口/);
  assert.match(html, /全窗口未关联事件/);
  assert.match(html, /生产标记诊断受限会话/);
  assert.match(html, /7/);
  assert.match(html, /2/);
});

test('recent preview counts issue groups without adding overlapping session counts', () => {
  const fixture = report();
  fixture.issues = Array.from({ length: 6 }, (_, index) => ({
    path: `/fixture-${index}`,
    version: 'fixture-v1',
    locale: 'en',
    browser: 'Chrome',
    kind: 'calculator_submit_error',
    reason: 'network_unresolved' as const,
    outcome: 'failed' as const,
    httpStatus: 0,
    validationReasons: '',
    formKind: 'unknown',
    resourceKind: 'unknown',
    events: 3,
    sessions: 2,
    firstAt: Date.parse('2026-09-22T01:00:00.000Z'),
    lastAt: Date.parse('2026-09-22T02:00:00.000Z') + index * 1000,
  }));
  const html = renderToStaticMarkup(<BusinessHealth report={fixture} />);
  assert.match(html, /生产标记问题分组/);
  assert.match(html, /最近 5 组 · 共 6 组/);
  assert.doesNotMatch(html, /fixture-0/);
  assert.ok(html.indexOf('/fixture-5') < html.indexOf('/fixture-1'));
  assert.match(html, /原因线索，非根因/);
  assert.match(html, /不能相加为独立人数/);
  assert.doesNotMatch(html, /12 个受影响会话/);
});

test('unknown counts and missing issue coverage are not rendered as zero', () => {
  const fixture = report();
  const partial = {
    ...fixture,
    issues: undefined,
    population: { ...fixture.population, selectedLimitedSessions: null },
  } as unknown as ReturnType<typeof report>;
  const html = renderToStaticMarkup(<BusinessHealth report={partial} />);
  assert.match(html, /异常覆盖未知/);
  assert.match(html, /未知/);
  assert.doesNotMatch(html, /未观测到已分类异常/);
});

test('failure, business limits, cancellations and validation remain separate signals', () => {
  const fixture = report();
  fixture.issues = [
    ['failed', 'server_error'],
    ['blocked', 'login_required'],
    ['cancelled', 'operation_cancelled'],
    ['invalid', 'validation_rejected'],
  ].map(([outcome, reason], index) => ({
    path: `/fixture-${index}`,
    version: 'fixture-v1',
    locale: 'en',
    browser: 'Chrome',
    kind: 'journey_error',
    reason,
    outcome,
    httpStatus: 0,
    validationReasons: '',
    formKind: 'unknown',
    resourceKind: 'unknown',
    events: 1,
    sessions: 1,
    firstAt: Date.parse('2026-09-22T01:00:00.000Z'),
    lastAt: Date.parse('2026-09-22T02:00:00.000Z'),
  })) as ReturnType<typeof report>['issues'];
  const html = renderToStaticMarkup(<BusinessHealth report={fixture} />);
  for (const label of ['失败信号', '业务受限', '取消操作', '输入校验'])
    assert.match(html, new RegExp(label));
  assert.match(html, /fixture-v1/);
  assert.doesNotMatch(html, /失败率|流失率/);
});

test('read status distinguishes initial reading and background refresh', () => {
  assert.match(readStatus({ isFetching: true }), /正在读取业务聚合/);
  const html = readStatus({
    hasData: true,
    isFetching: true,
    lastUpdatedAt: Date.parse('2026-09-23T01:00:00.000Z'),
  });
  assert.match(html, /更新中/);
  assert.match(html, /保留上次完整读数/);
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /motion-reduce:animate-none/);
  assert.match(html, /上次成功读取/);
});

test('failed refresh preserves the last complete reading with an explicit warning', () => {
  const html = readStatus({
    hasData: true,
    isError: true,
    lastUpdatedAt: Date.parse('2026-09-23T01:00:00.000Z'),
    onRetry: () => {},
  });
  assert.match(html, /role="alert"/);
  assert.match(html, /上次完整读数/);
  assert.match(html, /未将读取失败记为零/);
  assert.match(html, /重试业务聚合/);
  assert.match(html, /min-h-11/);
});

test('decision errors request the correct action instead of pointless retries', () => {
  for (const [statusCode, message] of [
    [401, '重新登录'],
    [403, '无权读取'],
    [404, '站点不存在'],
  ] as const) {
    const html = readStatus({ isError: true, statusCode, onRetry: () => {} });
    assert.match(html, new RegExp(message));
    assert.doesNotMatch(html, /重试业务聚合/);
  }
  assert.match(readStatus({ isError: true, statusCode: 409 }), /完整统计窗口/);
});

test('CRM retry has its own loading state and disabled touch-sized control', () => {
  const html = readStatus({ isError: true, isFetching: true, onRetry: () => {} });
  assert.match(html, /正在读取业务聚合/);
  assert.match(html, /disabled=""/);
  assert.match(html, /animate-spin/);
  assert.match(html, /min-h-11/);
});

test('diagnostics action is opt-in and never exports arbitrary error text', () => {
  const fixture = report();
  const contaminated = { ...fixture, errorText: 'PRIVATE_ERROR_BODY' };
  const html = renderToStaticMarkup(
    <BusinessHealth report={contaminated} onInspectQuality={() => {}} />
  );
  assert.match(html, /查看质量明细/);
  assert.match(html, /min-h-11/);
  assert.match(html, /<button[^>]*class="[^"]*text-base sm:text-sm/);
  assert.doesNotMatch(html, /PRIVATE_ERROR_BODY/);
  assert.doesNotMatch(renderToStaticMarkup(<BusinessHealth report={fixture} />), /查看质量明细/);
});
