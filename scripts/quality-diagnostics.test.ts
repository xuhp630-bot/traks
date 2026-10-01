import test from 'node:test';
import assert from 'node:assert/strict';
import {
  QualityAccumulator,
  normalizeEvidence,
  issueDiagnosis,
  type EvidenceEvent,
} from '../packages/shared/src/quality';
import { buildAnalysisPackage, analysisMarkdown } from '../packages/shared/src/quality-brief';

const event = (
  name: string,
  ts: number,
  props: Record<string, unknown> = {},
  overrides: Partial<EvidenceEvent> = {}
) => ({
  ...normalizeEvidence({
    ts,
    session_id: 'fixture-one',
    event_type: 'event',
    event_name: `concrete_workflow_${name}`,
    event_count: 1,
    pathname: '/concrete-bag-calculator',
    device_type: 'desktop',
    browser: 'Chrome',
    event_meta: JSON.stringify({
      traffic_type: 'production',
      tracking_version: 'cw-v3',
      release_version: 'quality-v4',
      ...props,
    }),
  }),
  ...overrides,
});
const report = (rows: EvidenceEvent[]) => {
  const accumulator = new QualityAccumulator();
  accumulator.add(rows);
  return accumulator.report('production');
};

test('resource metadata accepts only fixed enums on resource loading events', () => {
  const classified = event('resource_load_error', 1, {
    resource_kind: 'script',
    resource_origin_kind: 'first_party',
    resource_asset_kind: 'app_asset',
    resource_url: 'https://private.invalid/asset?SECRET_QUERY',
    error_message: 'SECRET_MESSAGE',
  });
  assert.equal(classified.resourceOriginKind, 'first_party');
  assert.equal(classified.resourceAssetKind, 'app_asset');
  assert.doesNotMatch(JSON.stringify(classified), /SECRET_|private.invalid/);
  const invalid = event('resource_load_error', 2, {
    resource_origin_kind: 'https://private.invalid',
    resource_asset_kind: 'critical',
  });
  assert.equal(invalid.resourceOriginKind, 'unknown');
  assert.equal(invalid.resourceAssetKind, 'unknown');
  const wrongType = event('resource_load_error', 2, {
    resource_origin_kind: { toString: 'third_party' },
    resource_asset_kind: ['app_asset'],
  });
  assert.equal(wrongType.resourceOriginKind, 'unknown');
  assert.equal(wrongType.resourceAssetKind, 'unknown');
  const unrelated = event('journey_error', 3, {
    resource_origin_kind: 'first_party',
    resource_asset_kind: 'app_asset',
  });
  assert.equal(unrelated.resourceOriginKind, 'unknown');
  assert.equal(unrelated.resourceAssetKind, 'unknown');
});

test('historical resource evidence stays unknown without guessing from script or route', () => {
  const legacy = event('resource_load_error', 1, {
    release_version: 'quality-v3',
    resource_kind: 'script',
  });
  assert.equal(legacy.resourceOriginKind, 'unknown');
  assert.equal(legacy.resourceAssetKind, 'unknown');
  const { resourceOriginKind: _origin, resourceAssetKind: _asset, ...oldJson } = legacy;
  const result = report([oldJson]);
  assert.equal(result.issues[0].resourceOriginKind, 'unknown');
  assert.equal(result.issues[0].resourceAssetKind, 'unknown');
  assert.deepEqual(result.issueSummary.resources.byOrigin.unknown, { events: 1, sessions: 1 });
  assert.deepEqual(result.issueSummary.resources.byAsset.unknown, { events: 1, sessions: 1 });
  assert.equal(
    result.issues[0].key,
    JSON.stringify([
      legacy.path,
      legacy.version,
      legacy.locale,
      legacy.browser,
      'resource_load_error',
      'resource_load',
      legacy.httpStatus,
      legacy.validationReasons,
      legacy.formKind,
      legacy.resourceKind,
    ])
  );
});

test('summary deduplicates selected sessions instead of adding overlapping issue rows', () => {
  const result = report([
    event(
      'resource_load_error',
      1,
      {
        resource_origin_kind: 'first_party',
        resource_asset_kind: 'app_asset',
      },
      { count: 3 }
    ),
    event(
      'resource_load_error',
      2,
      {
        resource_origin_kind: 'third_party',
        resource_asset_kind: 'external_asset',
      },
      { count: 2 }
    ),
    event('journey_error', 3),
    event('calculator_validation_error', 4),
    event('save_project_login_prompt', 5),
    event('export_pdf_error', 6, { failure_reason: 'operation_cancelled' }),
    event('resource_load_error', 7, {}, { sessionId: 'fixture-two', count: 4 }),
  ]);
  const summary = result.issueSummary;
  assert.equal(summary.population, 'selected_collector_sessions');
  assert.equal(summary.eventUnit, 'retained_event_occurrences');
  assert.equal(summary.sessionUnit, 'distinct_collector_sessions');
  assert.equal(summary.denominatorSessions, 2);
  assert.equal(summary.events, 13);
  assert.equal(summary.sessions, 2);
  assert.deepEqual(summary.outcomes, {
    failed: { events: 10, sessions: 2 },
    invalid: { events: 1, sessions: 1 },
    blocked: { events: 1, sessions: 1 },
    cancelled: { events: 1, sessions: 1 },
    unknown: { events: 0, sessions: 0 },
  });
  assert.deepEqual(summary.unknownReason, { events: 1, sessions: 1 });
  assert.equal(summary.resources.events, 9);
  assert.equal(summary.resources.sessions, 2);
  assert.deepEqual(summary.resources.byOrigin, {
    first_party: { events: 3, sessions: 1 },
    third_party: { events: 2, sessions: 1 },
    unknown: { events: 4, sessions: 1 },
  });
  assert.equal(result.issues.filter(issue => issue.reason === 'resource_load').length, 3);
  assert.equal(result.issues.find(issue => issue.reason === 'unknown')?.outcome, 'failed');
});

test('late QA and internal classification remove the entire session before summary', () => {
  const accumulator = new QualityAccumulator();
  accumulator.add([
    event('resource_load_error', 1, {}, { count: 3 }),
    event('page_engagement', 2, {}, { traffic: 'qa' }),
    event('resource_load_error', 3, {}, { sessionId: 'owner', traffic: 'internal' }),
    event(
      'resource_load_error',
      4,
      {},
      { sessionId: 'legacy', traffic: 'unknown', version: 'unknown' }
    ),
    event('resource_load_error', 5, {}, { sessionId: 'fixture-two' }),
  ]);
  const selected = accumulator.report('production').issueSummary;
  assert.equal(selected.denominatorSessions, 1);
  assert.equal(selected.events, 1);
  assert.equal(selected.sessions, 1);
  const qa = accumulator.report('qa').issueSummary;
  assert.equal(qa.denominatorSessions, 1);
  assert.equal(qa.events, 3);
  assert.equal(qa.sessions, 1);
  const all = accumulator.report('all').issueSummary;
  assert.equal(all.denominatorSessions, 4);
  assert.equal(all.events, 6);
  assert.equal(all.sessions, 4);
});

test('resource diagnosis distinguishes unknown origin from actual first-party signals', () => {
  const result = report([
    event('resource_load_error', 1, {
      resource_origin_kind: 'first_party',
      resource_asset_kind: 'app_asset',
    }),
    event('resource_load_error', 2),
  ]);
  const first = issueDiagnosis(
    result.issues.find(issue => issue.resourceOriginKind === 'first_party')!
  );
  assert.match(first.evidence, /首方/);
  assert.match(first.nextCheck, /资源响应/);
  const unknown = issueDiagnosis(
    result.issues.find(issue => issue.resourceOriginKind === 'unknown')!
  );
  assert.match(unknown.evidence, /未知/);
  assert.match(unknown.nextCheck, /第三方/);
  assert.doesNotMatch(unknown.evidence, /已确认.*故障|已确认.*拦截/);
});

test('aggregate export keeps additive summary and enums without raw identifiers', () => {
  const pack = buildAnalysisPackage(report([event('resource_load_error', 1)]), {
    siteId: 'fixture-site',
    period: '7d',
    traffic: 'production',
    from: 0,
    to: 100,
    source: 'historical',
    totalGroups: 1,
    totalEvents: 1,
    cohortFilterKeys: [],
  });
  assert.equal(pack.format, 'traks-optimization-evidence/v1');
  assert.equal(pack.issueSummary.sessions, 1);
  assert.equal(pack.issues[0].resourceOriginKind, 'unknown');
  assert.doesNotMatch(JSON.stringify(pack), /fixture-one|sessionId|resource_url/);
  const markdown = analysisMarkdown(pack);
  assert.match(markdown, /去重/);
  assert.match(markdown, /资源来源未知/);
  assert.match(markdown, /候选/);
  const { issueSummary: _summary, ...oldPack } = pack;
  assert.match(analysisMarkdown(oldPack as typeof pack), /当前版本未提供去重诊断汇总/);
  const partial = { ...pack, issueSummary: { ...pack.issueSummary, resources: undefined } };
  assert.match(analysisMarkdown(partial as typeof pack), /资源加载信号：未知个信号/);
});
