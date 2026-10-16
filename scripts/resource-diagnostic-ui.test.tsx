import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QualityAccumulator, normalizeEvidence } from '../packages/shared/src/quality';
import { buildAnalysisPackage } from '../packages/shared/src/quality-brief';
import { BusinessHealth } from '../apps/platform/web/src/components/analytics/BusinessHealth';

function fixture(wire?: string) {
  const accumulator = new QualityAccumulator();
  accumulator.add([
    normalizeEvidence({
      ts: Date.parse('2026-10-16T00:00:01Z'),
      session_id: 'fixture-resource-only',
      event_type: 'event',
      event_name: 'concrete_workflow_resource_load_error',
      event_count: 2,
      pathname: '/',
      device_type: 'desktop',
      browser: 'Opera',
      event_meta: JSON.stringify({
        traffic_type: 'production',
        tracking_version: 'cw-v3',
        release_version: 'fixture-rd1',
        page_id: 'p_123456789abc',
        resource_kind: 'img',
        resource_origin_kind: 'first_party',
        resource_asset_kind: 'site_asset',
        resource_provider: 'first_party',
        network_state: 'online',
        failure_reason: 'resource_load',
        failure_outcome: 'failed',
        resource_diagnostic: wire,
        resource_url: 'https://private.invalid/?SECRET_QUERY',
        error_message: 'SECRET_ERROR',
      }),
    }),
  ]);
  return buildAnalysisPackage(accumulator.report('production'), {
    siteId: 'fixture-only',
    period: 'today',
    traffic: 'production',
    from: Date.parse('2026-10-16T00:00:00Z'),
    to: Date.parse('2026-10-16T01:00:00Z'),
    source: 'live',
    totalGroups: 1,
    totalEvents: 2,
    cohortFilterKeys: [],
  });
}

test('business issue preview shows known image, source slot and qualified timing hint', () => {
  const report = fixture('rd1|logo|navbar|attached_complete_zero|box_wide_high|live|status_404');
  const html = renderToStaticMarkup(<BusinessHealth report={report} />);
  assert.match(html, /Logo|标识/i);
  assert.match(html, /导航|navbar/i);
  assert.match(html, /404/);
  assert.match(html, /非.*(?:失败请求|HTTP)|不(?:等于|代表).*失败/);
  assert.match(html, /1 个分组会话 · 2 个信号/);
  assert.equal(report.issues[0].httpStatus, 0);
  assert.equal(report.issues[0].outcome, 'failed');
  assert.equal(report.issues[0].reason, 'resource_load');
  assert.doesNotMatch(html, /SECRET_|private\.invalid|已确认拦截|根因已确定/);
});

test('a 200 same-URL candidate still displays an observed failed image', () => {
  const report = fixture(
    'rd1|worksheet_webp_688|hero|attached_complete_zero|box_narrow_high|live|status_200'
  );
  const html = renderToStaticMarkup(<BusinessHealth report={report} />);
  assert.match(html, /200/);
  assert.match(html, /失败信号/);
  assert.equal(report.issues[0].httpStatus, 0);
  assert.equal(report.issues[0].outcome, 'failed');
  assert.doesNotMatch(html, /加载成功|已修复|已确认解码失败/);
});

test('legacy and rejected diagnostic values are labelled unavailable rather than filled in', () => {
  for (const wire of [undefined, 'rd2|logo|navbar', 'rd1|https://private.invalid/?SECRET_QUERY']) {
    const html = renderToStaticMarkup(<BusinessHealth report={fixture(wire)} />);
    assert.match(html, /诊断明细未采集|资源明细未采集/);
    assert.doesNotMatch(html, /SECRET_|private\.invalid|status_404|品牌标识/);
  }
});

test('both recent-preview and detailed issue cards share the same diagnostic renderer', () => {
  for (const file of ['BusinessHealth.tsx', 'QualityConsole.tsx']) {
    const source = readFileSync(
      new URL(`../apps/platform/web/src/components/analytics/${file}`, import.meta.url),
      'utf8'
    );
    assert.match(source, /<ResourceDiagnosticDetails/);
    assert.match(source, /diagnostic=\{issue\.resourceDiagnostic\}/);
  }
});
