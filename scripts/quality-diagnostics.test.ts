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

test('resource supplier and observed network accept fixed enums only on resource errors', () => {
  for (const provider of [
    'google_tag',
    'google_tag_manager',
    'google_adsense',
    'google_ad_quality',
    'microsoft_clarity',
    'cloudflare_beacon',
    'traks',
    'other_external',
    'first_party',
    'unknown',
  ]) {
    for (const network of ['online', 'offline', 'unknown']) {
      const normalized = event('resource_load_error', 1, {
        resource_provider: provider,
        network_state: network,
      });
      assert.equal(normalized.resourceProvider, provider);
      assert.equal(normalized.networkState, network);
    }
  }
  for (const value of [
    undefined,
    null,
    [],
    {},
    1,
    true,
    'Google_tag',
    'google_tag ',
    'https://private.invalid/?SECRET_QUERY',
    'private.invalid',
    '<script>SECRET_BODY</script>',
    '__proto__',
  ]) {
    const normalized = event('resource_load_error', 1, {
      resource_provider: value,
      network_state: value,
    });
    assert.equal(normalized.resourceProvider, 'unknown');
    assert.equal(normalized.networkState, 'unknown');
    assert.doesNotMatch(JSON.stringify(normalized), /SECRET_|private.invalid|<script>/);
  }
  const unrelated = event('journey_error', 1, {
    resource_provider: 'google_tag',
    network_state: 'offline',
  });
  assert.equal(unrelated.resourceProvider, 'unknown');
  assert.equal(unrelated.networkState, 'unknown');
  const alias = normalizeEvidence({
    ts: 1,
    session_id: 'fixture',
    event_count: 1,
    event_name: 'resource_load_error',
    event_meta: JSON.stringify({ resource_provider: 'traks', network_state: 'online' }),
  });
  assert.equal(alias.resourceProvider, 'traks');
  assert.equal(alias.networkState, 'online');
});

test('new supplier/network evidence splits groups without changing legacy keys or totals', () => {
  const props = { resource_origin_kind: 'third_party', resource_asset_kind: 'external_asset' };
  const legacy = event('resource_load_error', 1, props, { count: 3 });
  const old = report([legacy]);
  const compatible = report([
    legacy,
    event(
      'resource_load_error',
      2,
      { ...props, resource_provider: 'unknown', network_state: 'unknown' },
      { count: 4 }
    ),
    event(
      'resource_load_error',
      3,
      { ...props, resource_provider: 'private.invalid', network_state: 'SECRET_NETWORK' },
      { count: 2 }
    ),
  ]);
  assert.equal(compatible.issues.length, 1);
  assert.equal(compatible.issues[0].key, old.issues[0].key);
  assert.equal(compatible.issues[0].events, 9);
  assert.equal(compatible.issues[0].resourceProvider, 'unknown');
  assert.equal(compatible.issues[0].networkState, 'unknown');

  const enriched = report([
    legacy,
    event(
      'resource_load_error',
      2,
      { ...props, resource_provider: 'google_tag', network_state: 'online' },
      { count: 4 }
    ),
    event(
      'resource_load_error',
      3,
      { ...props, resource_provider: 'google_tag', network_state: 'offline' },
      { count: 2 }
    ),
    event(
      'resource_load_error',
      4,
      { ...props, resource_provider: 'microsoft_clarity', network_state: 'online' },
      { count: 4 }
    ),
  ]);
  assert.equal(enriched.issues.length, 4);
  assert.equal(
    enriched.issues.find(issue => issue.resourceProvider === 'unknown')?.key,
    old.issues[0].key
  );
  assert.equal(enriched.issueSummary.events, 13);
  assert.equal(enriched.issueSummary.sessions, 1);
  assert.deepEqual(enriched.issueSummary.outcomes.failed, { events: 13, sessions: 1 });
  assert.deepEqual(enriched.issueSummary.resources.byOrigin.third_party, {
    events: 13,
    sessions: 1,
  });
  assert.ok(
    enriched.issues.every(issue => issue.reason === 'resource_load' && issue.outcome === 'failed')
  );
  const distinct = report([
    event('resource_load_error', 1, { resource_origin_kind: 'first_party' }),
    event('resource_load_error', 2, { resource_provider: 'first_party' }),
    event('resource_load_error', 3, { network_state: 'online' }),
  ]);
  assert.equal(
    distinct.issues.length,
    3,
    'new metadata suffix must not collide with legacy origin/asset key slots'
  );
  const { resourceProvider: _provider, networkState: _network, ...oldJson } = legacy;
  assert.equal(report([oldJson]).issues[0].key, old.issues[0].key);
});

test('thirteen historical signals remain seven unknown-supplier groups and export no raw data', () => {
  const historic = report(
    [3, 1, 2, 4, 1, 1, 1].map((count, index) =>
      event(
        'resource_load_error',
        index + 1,
        {
          resource_origin_kind: 'third_party',
          resource_asset_kind: 'external_asset',
        },
        { path: `/fixture-${index}`, count }
      )
    )
  );
  assert.equal(historic.issues.length, 7);
  assert.equal(historic.issueSummary.events, 13);
  assert.ok(
    historic.issues.every(
      issue => issue.resourceProvider === 'unknown' && issue.networkState === 'unknown'
    )
  );
  const pack = buildAnalysisPackage(
    report([
      event('resource_load_error', 1, {
        resource_provider: 'google_ad_quality',
        network_state: 'online',
        resource_url: 'https://private.invalid/?SECRET_QUERY',
        error_message: 'SECRET_MESSAGE',
      }),
    ]),
    {
      siteId: 'fixture-site',
      period: '7d',
      traffic: 'production',
      from: 0,
      to: 100,
      source: 'historical',
      totalGroups: 1,
      totalEvents: 1,
      cohortFilterKeys: [],
    }
  );
  assert.equal(pack.issues[0].resourceProvider, 'google_ad_quality');
  assert.equal(pack.issues[0].networkState, 'online');
  assert.match(pack.candidates[0].dimension, /google_ad_quality.*online/);
  assert.match(analysisMarkdown(pack), /供应商.*网络/);
  assert.match(
    issueDiagnosis(
      report([
        event('resource_load_error', 1, {
          resource_provider: 'google_tag',
          network_state: 'offline',
        }),
      ]).issues[0]
    ).evidence,
    /浏览器报告离线/
  );
  assert.doesNotMatch(
    JSON.stringify(pack),
    /SECRET_|private.invalid|fixture-one|sessionId|pageId|resource_url|error_message/
  );
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
