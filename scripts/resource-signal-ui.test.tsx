import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QualityAccumulator, normalizeEvidence } from '../packages/shared/src/quality';
import { buildAnalysisPackage } from '../packages/shared/src/quality-brief';
import type { ResourceSignal } from '../packages/shared/src/resource-signal';
import { BusinessHealth } from '../apps/platform/web/src/components/analytics/BusinessHealth';
import { ResourceDiagnosticDetails } from '../apps/platform/web/src/components/analytics/ResourceDiagnosticDetails';

const imageWire = 'rs1|trusted|complete|known_img';
const rd1 = 'rd1|logo|mobile_navbar|attached_complete_zero|box_wide_high|live|status_200';
const signal = {
  version: 'rs1',
  trust: 'trusted',
  documentPhase: 'complete',
  bucket: 'known_img',
} as const;

function fixture(value: unknown, props: Record<string, unknown> = {}) {
  const accumulator = new QualityAccumulator();
  accumulator.add([
    normalizeEvidence({
      ts: 1000,
      session_id: 'fixture-only-session',
      pathname: '/',
      browser: 'Opera',
      event_type: 'event',
      event_name: 'concrete_workflow_resource_load_error',
      event_count: 2,
      event_meta: JSON.stringify({
        tracking_version: 'cw-v3',
        release_version: 'quality-v9-rs1',
        traffic_type: 'production',
        resource_kind: 'img',
        resource_origin_kind: 'first_party',
        resource_asset_kind: 'site_asset',
        resource_provider: 'first_party',
        network_state: 'online',
        failure_reason: 'resource_load',
        resource_signal: value,
        resource_url: 'https://private.invalid/SECRET_ID',
        ...props,
      }),
    }),
  ]);
  return buildAnalysisPackage(accumulator.report(), {
    siteId: 'fixture-site',
    period: 'today',
    traffic: 'production',
    from: 0,
    to: 2000,
    source: 'live',
    totalGroups: 1,
    totalEvents: 2,
    cohortFilterKeys: [],
  });
}

test('business preview renders bounded rs1 and independent rd1 without replacing failure', () => {
  const pack = fixture(imageWire, { resource_diagnostic: rd1 });
  const html = renderToStaticMarkup(<BusinessHealth report={pack} />);
  assert.match(html, /isTrusted=true/);
  assert.match(html, /不证明真人或原生网络请求/);
  assert.match(html, /文档观测阶段/);
  assert.match(html, /不是请求开始或失败时刻/);
  assert.match(html, /已登记图片/);
  assert.match(html, /Logo|标识/);
  assert.match(html, /移动导航/);
  assert.match(html, /1 个分组会话 · 2 个信号/);
  assert.match(html, /失败信号/);
  assert.equal(pack.issues[0].outcome, 'failed');
  assert.equal(pack.issues[0].httpStatus, 0);
  assert.doesNotMatch(html, /SECRET_|private\.invalid|rs1\||已确认原生请求|根因已确定/);
});

test('third-party Clarity script signal renders without fabricated native image diagnostics', () => {
  const pack = fixture('rs1|untrusted|interactive|clarity_runtime', {
    resource_kind: 'script',
    resource_origin_kind: 'third_party',
    resource_asset_kind: 'external_asset',
    resource_provider: 'microsoft_clarity',
    resource_diagnostic: rd1,
  });
  const html = renderToStaticMarkup(<BusinessHealth report={pack} />);
  assert.match(html, /资源事件信号明细/);
  assert.match(html, /isTrusted=false/);
  assert.match(html, /Clarity 运行脚本/);
  assert.match(html, /不等于已确认脚本或扩展/);
  assert.match(html, /不是本次失败请求的已验证HTTP状态或根因/);
  assert.equal(pack.issues[0].resourceDiagnostic, undefined);
  assert.equal(pack.issues[0].httpStatus, 0);
  assert.equal(pack.issues[0].outcome, 'failed');
  assert.doesNotMatch(html, /图片失败诊断明细|HTTP 200|SECRET_|private\.invalid/);
});

test('shared renderer preserves exact unavailable legacy markup and does not echo malformed signal', () => {
  const legacy = renderToStaticMarkup(<ResourceDiagnosticDetails />);
  assert.equal(
    legacy,
    '<p class="mt-2 break-words text-xs text-[#6E6C7C]">资源明细未采集（历史或未识别记录，保持未知）。</p>'
  );
  for (const value of [
    Object.create(signal),
    { ...signal, version: 'rs2' },
    { ...signal, bucket: 'https://private.invalid/SECRET_ID' },
    {
      ...signal,
      get trust() {
        throw new Error('SECRET_GETTER');
      },
    },
  ]) {
    assert.equal(
      renderToStaticMarkup(
        <ResourceDiagnosticDetails signal={value as ResourceSignal} resourceKind="img" />
      ),
      legacy
    );
  }
  for (const value of [undefined, 'rs2|trusted|complete|known_img', 'rs1|SECRET_ID']) {
    const html = renderToStaticMarkup(<BusinessHealth report={fixture(value)} />);
    assert.match(html, /资源明细未采集/);
    assert.doesNotMatch(html, /isTrusted=|SECRET_|rs1\|/);
  }
});

test('API object extras and toJSON never enter either shared-renderer or business markup', () => {
  const polluted = {
    ...signal,
    rawUrl: 'https://private.invalid/SECRET_ID',
    toJSON() {
      throw new Error('SECRET_TO_JSON');
    },
  };
  const pack = fixture(imageWire);
  pack.issues[0].resourceSignal = polluted;
  for (const html of [
    renderToStaticMarkup(<ResourceDiagnosticDetails signal={polluted} resourceKind="img" />),
    renderToStaticMarkup(<BusinessHealth report={pack} />),
  ]) {
    assert.match(html, /isTrusted=true/);
    assert.doesNotMatch(html, /SECRET_|private\.invalid|rawUrl|toJSON/);
  }
});

test('both card paths share a strict resource-kind gate, including forged API IMG/SCRIPT exclusions', () => {
  for (const resourceKind of [undefined, 'link', 'video', 'audio', 'source', 'IMG', 'unknown']) {
    const direct = renderToStaticMarkup(
      <ResourceDiagnosticDetails signal={signal} resourceKind={resourceKind} />
    );
    assert.match(direct, /资源明细未采集/);
    assert.doesNotMatch(direct, /isTrusted=|文档观测阶段/);
    const pack = fixture(imageWire);
    pack.issues[0].resourceKind = resourceKind ?? '';
    const actualCard = renderToStaticMarkup(<BusinessHealth report={pack} />);
    assert.doesNotMatch(actualCard, /isTrusted=|文档观测阶段/);
    assert.equal(pack.issues[0].events, 2);
    assert.equal(pack.issues[0].outcome, 'failed');
  }
});

test('actual detailed and recent card callsites pass rs1 separately through the same safe renderer', () => {
  for (const name of ['QualityConsole.tsx', 'BusinessHealth.tsx']) {
    const source = readFileSync(
      new URL(`../apps/platform/web/src/components/analytics/${name}`, import.meta.url),
      'utf8'
    );
    const calls = source.match(/<ResourceDiagnosticDetails\b[^>]*\/>/g) ?? [];
    assert.equal(calls.length, 1);
    assert.match(calls[0], /diagnostic=\{issue\.resourceDiagnostic\}/);
    assert.match(calls[0], /signal=\{issue\.resourceSignal\}/);
    assert.match(calls[0], /resourceKind=\{issue\.resourceKind\}/);
    assert.match(source, /issue\.kind === 'resource_load_error'/);
    assert.doesNotMatch(calls[0], /resource_signal|JSON\.stringify|\.\.\.issue/);
  }
});
