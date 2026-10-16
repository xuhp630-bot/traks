import test from 'node:test';
import assert from 'node:assert/strict';
import * as shared from '../packages/shared/src/index';
import {
  normalizeEvidence,
  QualityAccumulator,
  issueDiagnosis,
  issueMarkdown,
  type EvidenceEvent,
} from '../packages/shared/src/quality';
import { buildAnalysisPackage, analysisMarkdown } from '../packages/shared/src/quality-brief';

const wire = (
  key = 'logo',
  slot = 'navbar',
  imageState = 'attached_complete_zero',
  renderContext = 'box_wide_high',
  timingHint = 'status_200'
) => `rd1|${key}|${slot}|${imageState}|${renderContext}|live|${timingHint}`;

const expected = {
  version: 'rd1',
  key: 'logo',
  slot: 'navbar',
  imageState: 'attached_complete_zero',
  renderContext: 'box_wide_high',
  capturePhase: 'live',
  timingHint: 'status_200',
} as const satisfies shared.ResourceDiagnostic;

const api = shared;

function event(
  ts: number,
  diagnostic: unknown = null,
  props: Record<string, unknown> = {},
  row: Record<string, unknown> = {}
): EvidenceEvent {
  return normalizeEvidence({
    ts,
    session_id: 'fixture-one',
    pathname: '/concrete-bag-calculator',
    event_type: 'event',
    event_name: 'concrete_workflow_resource_load_error',
    event_count: 1,
    browser: 'Opera',
    event_meta: JSON.stringify({
      tracking_version: 'cw-v3',
      release_version: 'resource-diagnostic-v1',
      traffic_type: 'production',
      resource_kind: 'img',
      resource_origin_kind: 'first_party',
      resource_asset_kind: 'site_asset',
      resource_diagnostic: diagnostic,
      ...props,
    }),
    ...row,
  });
}

function report(rows: EvidenceEvent[], traffic: 'production' | 'qa' | 'all' = 'production') {
  const accumulator = new QualityAccumulator();
  accumulator.add(rows);
  return accumulator.report(traffic);
}

test('native first-party IMG normalizes the exact seven sanitized fields', () => {
  const normalized = event(1, wire(), {
    resource_url: 'https://private.invalid/avatar?SECRET_QUERY',
    error_message: 'SECRET_MESSAGE',
    slot: 'SECRET_SLOT',
  });
  assert.deepEqual(normalized.resourceDiagnostic, expected);
  assert.deepEqual(
    Object.keys(normalized.resourceDiagnostic!).sort(),
    Object.keys(expected).sort()
  );
  assert.doesNotMatch(
    JSON.stringify(normalized),
    /rd1\||SECRET_|private\.invalid|resource_diagnostic/
  );
  assert.deepEqual(
    event(1, wire(), {}, { event_name: 'resource_load_error' }).resourceDiagnostic,
    expected
  );
});

test('pure decoder accepts only the complete bounded v1 enum vocabulary', () => {
  assert.equal(typeof api.decodeResourceDiagnostic, 'function');
  assert.deepEqual(api.decodeResourceDiagnostic(wire()), expected);
  for (const key of [
    'logo',
    'worksheet_png',
    'worksheet_webp_688',
    'worksheet_webp_1376',
    'other',
    'unknown',
  ])
    assert.equal(api.decodeResourceDiagnostic(wire(key))?.key, key);
  for (const slot of ['navbar', 'mobile_navbar', 'footer', 'hero', 'ssr_preview', 'unknown'])
    assert.equal(api.decodeResourceDiagnostic(wire('logo', slot))?.slot, slot);
  for (const attached of ['attached', 'detached'])
    for (const complete of ['complete', 'pending'])
      for (const width of ['zero', 'nonzero']) {
        const state = `${attached}_${complete}_${width}`;
        assert.equal(api.decodeResourceDiagnostic(wire('logo', 'hero', state))?.imageState, state);
      }
  assert.equal(
    api.decodeResourceDiagnostic(wire('logo', 'hero', 'unknown'))?.imageState,
    'unknown'
  );
  for (const box of ['box', 'no_box', 'unknown'])
    for (const viewport of ['narrow', 'mid', 'wide', 'unknown'])
      for (const dpr of ['standard', 'high', 'unknown']) {
        const render = `${box}_${viewport}_${dpr}`;
        assert.equal(
          api.decodeResourceDiagnostic(wire('logo', 'hero', 'unknown', render))?.renderContext,
          render
        );
      }
  for (const hint of ['unsupported', 'none', 'ambiguous', 'zero_or_hidden', 'unknown'])
    assert.equal(
      api.decodeResourceDiagnostic(wire('logo', 'hero', 'unknown', 'unknown_unknown_unknown', hint))
        ?.timingHint,
      hint
    );
  for (let status = 100; status <= 599; status++)
    assert.equal(
      api.decodeResourceDiagnostic(
        wire('logo', 'hero', 'unknown', 'unknown_unknown_unknown', `status_${status}`)
      )?.timingHint,
      `status_${status}`
    );
  assert.ok(
    wire(
      'worksheet_webp_1376',
      'mobile_navbar',
      'detached_complete_nonzero',
      'unknown_unknown_standard',
      'zero_or_hidden'
    ).length <= 128
  );
});

test('decoder rejects malformed, arbitrary, overlong and unknown-version wire without echoing it', () => {
  const invalid = [
    undefined,
    null,
    false,
    1,
    [],
    {},
    '',
    ` ${wire()}`,
    `${wire()}\n`,
    `${wire()}|extra`,
    wire().replace('rd1|', 'rd2|'),
    wire().replace('|live|', '|buffered|'),
    wire('avatar'),
    wire('logo', '__proto__'),
    wire('logo', 'hero', 'attached_pending_broken'),
    wire('logo', 'hero', 'unknown', 'unknown'),
    wire('logo', 'hero', 'unknown', 'box_1024_2'),
    ...[
      'status_0',
      'status_099',
      'status_600',
      'status_999',
      'status_0200',
      'status_200.0',
      'status_2e2',
      'status_+200',
    ].map(hint => wire('logo', 'hero', 'unknown', 'box_wide_high', hint)),
    wire('https://private.invalid/?SECRET_QUERY'),
    wire('x'.repeat(129)),
    wire().replace('logo', 'logo\u0000'),
  ];
  for (const value of invalid) {
    assert.equal(api.decodeResourceDiagnostic(value), undefined);
    assert.equal(event(1, value).resourceDiagnostic, undefined);
  }
});

test('unrelated events, pageviews, non-IMG and non-first-party errors cannot gain a diagnostic', () => {
  for (const name of [
    'journey_error',
    'calculator_submit_error',
    'image_error',
    'resource_load_success',
  ])
    assert.equal(event(1, wire(), {}, { event_name: name }).resourceDiagnostic, undefined);
  assert.equal(event(1, wire(), {}, { event_type: 'pageview' }).resourceDiagnostic, undefined);
  for (const kind of ['script', 'source', 'video', 'audio', 'link', 'IMG', '', {}, null])
    assert.equal(event(1, wire(), { resource_kind: kind }).resourceDiagnostic, undefined);
  for (const origin of ['third_party', 'unknown', '', {}, null])
    assert.equal(event(1, wire(), { resource_origin_kind: origin }).resourceDiagnostic, undefined);
});

test('missing or unrecognized diagnostics retain byte-for-byte legacy grouping keys', () => {
  const legacy = event(1, undefined);
  const baseline = report([legacy]);
  const compatible = report([
    legacy,
    event(2, null),
    event(3, 'rd2|SECRET_RAW'),
    event(4, wire('avatar')),
    event(5, wire().replace('|live|', '|unknown|')),
  ]);
  assert.equal(compatible.issues.length, 1);
  assert.equal(compatible.issues[0].key, baseline.issues[0].key);
  assert.equal(compatible.issues[0].resourceDiagnostic, undefined);
  assert.equal(compatible.issues[0].events, 5);
  assert.equal(compatible.issueSummary.sessions, 1);
});

test('asset and native slot split only recognized v1 groups while summary units remain unchanged', () => {
  const rows = [
    event(1, undefined, {}, { event_count: 3 }),
    event(2, wire(), {}, { event_count: 2 }),
    event(3, wire('worksheet_webp_688', 'hero'), {}, { event_count: 4 }),
    event(4, wire('logo', 'footer'), {}, { event_count: 1 }),
    event(5, wire(), {}, { session_id: 'fixture-two', event_count: 2 }),
  ];
  const enriched = report(rows);
  const stripped = report(rows.map(({ resourceDiagnostic: _diagnostic, ...row }) => row));
  assert.equal(enriched.issues.length, 4);
  assert.equal(stripped.issues.length, 1);
  assert.equal(
    enriched.issues.find(issue => !issue.resourceDiagnostic)?.key,
    stripped.issues[0].key
  );
  assert.equal(
    enriched.issues.find(issue => issue.resourceDiagnostic?.slot === 'navbar')?.sessions,
    2
  );
  assert.equal(
    enriched.issues.find(issue => issue.resourceDiagnostic?.slot === 'navbar')?.events,
    4
  );
  assert.deepEqual(enriched.issueSummary, stripped.issueSummary);
  assert.deepEqual(enriched.classification, stripped.classification);
  assert.deepEqual(enriched.funnels, stripped.funnels);
  assert.equal(enriched.issueSummary.events, 12);
  assert.equal(enriched.issueSummary.sessions, 2);
});

test('a 200 timing candidate never replaces observed failure, HTTP status or unknown reason fields', () => {
  const normalized = event(1, wire());
  assert.equal(normalized.resourceDiagnostic?.timingHint, 'status_200');
  assert.equal(normalized.httpStatus, 0);
  assert.equal(normalized.failureReason, 'unknown');
  assert.equal(normalized.failureOutcome, 'failed');
  const issue = report([normalized]).issues[0];
  assert.equal(issue.httpStatus, 0);
  assert.equal(issue.reason, 'resource_load');
  assert.equal(issue.outcome, 'failed');
  assert.match(issueDiagnosis(issue).evidence, /HTTP 200/);
  assert.match(issueDiagnosis(issue).evidence, /不是|不代表/);
  assert.match(issueDiagnosis(issue).evidence, /本次失败.*HTTP.*状态.*根因/);
});

test('UI labels distinguish snapshots, timing limits and unavailable historical diagnostics', () => {
  assert.equal(typeof api.resourceDiagnosticLines, 'function');
  const text = api.resourceDiagnosticLines(expected).join('\n');
  assert.match(text, /logo|Logo|标志/);
  assert.match(text, /导航/);
  assert.match(text, /状态|快照/);
  assert.match(text, /布局|框/);
  assert.match(text, /live|实时/);
  assert.match(text, /Resource Timing|资源时序/);
  assert.match(text, /非|不是|不代表/);
  assert.match(text, /本次失败.*HTTP.*状态.*根因/);
  assert.match(api.resourceDiagnosticLines().join('\n'), /不可用|未知/);
  assert.doesNotMatch(api.resourceDiagnosticLines().join('\n'), /0个|0次/);
  for (const hint of ['unsupported', 'none', 'ambiguous', 'zero_or_hidden', 'unknown'] as const)
    assert.match(
      api.resourceDiagnosticLines({ ...expected, timingHint: hint }).join('\n'),
      /本次失败.*HTTP.*状态.*根因/
    );
});

test('revalidated API JSON cannot add raw metadata or group malformed/unrelated diagnostic objects', () => {
  const polluted = {
    ...expected,
    rawUrl: 'https://private.invalid/?SECRET_QUERY',
    errorMessage: 'SECRET_MESSAGE',
  };
  assert.deepEqual(shared.sanitizeResourceDiagnostic(polluted), expected);
  const observed = { ...event(1, wire()), resourceDiagnostic: polluted };
  const result = report([observed]);
  assert.deepEqual(result.issues[0].resourceDiagnostic, expected);
  assert.doesNotMatch(JSON.stringify(result), /rawUrl|SECRET_|private\.invalid/);
  const invalid = [
    null,
    [],
    { ...expected, version: 'rd2' },
    { ...expected, timingHint: 'status_600' },
    { ...expected, key: 'avatar' },
    { ...expected, capturePhase: 'buffered' },
    {
      ...expected,
      get slot() {
        throw new Error('SECRET_GETTER');
      },
    },
  ];
  const oldKey = report([event(1, null)]).issues[0].key;
  for (const value of invalid) {
    assert.equal(shared.sanitizeResourceDiagnostic(value), undefined);
    const injected = { ...event(1, null), resourceDiagnostic: value } as EvidenceEvent;
    assert.equal(report([injected]).issues[0].key, oldKey);
    assert.equal(report([injected]).issues[0].resourceDiagnostic, undefined);
  }
  for (const overrides of [
    { resourceKind: 'script' },
    { resourceOriginKind: 'third_party' },
    { eventType: 'pageview' },
  ] as const) {
    const injected = { ...observed, ...overrides };
    assert.equal(report([injected]).issues[0].resourceDiagnostic, undefined);
  }
});

test('analysis JSON, issue Markdown and full Markdown retain sanitized diagnostics and disclaimers', () => {
  const result = report([
    event(1, wire(), {
      resource_url: 'https://private.invalid/?SECRET_QUERY',
      error_message: 'SECRET_MESSAGE',
    }),
  ]);
  const pack = buildAnalysisPackage(result, {
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
  assert.deepEqual(JSON.parse(JSON.stringify(pack)).issues[0].resourceDiagnostic, expected);
  for (const markdown of [
    issueMarkdown(result.issues[0], 'production', 'pending'),
    analysisMarkdown(pack),
  ]) {
    assert.match(markdown, /resourceDiagnostic/);
    for (const [key, value] of Object.entries(expected)) {
      assert.ok(markdown.includes(`"${key}": "${value}"`), `${key} must survive Markdown export`);
    }
    assert.match(markdown, /本次失败.*HTTP.*状态.*根因/);
    assert.doesNotMatch(
      markdown,
      /rd1\||SECRET_|private\.invalid|fixture-one|sessionId|resource_url/
    );
  }
  assert.doesNotMatch(
    JSON.stringify(pack),
    /rd1\||SECRET_|private\.invalid|fixture-one|sessionId|resource_url/
  );
});

test('new resource diagnostics retain complete-session QA/internal/unknown exclusion', () => {
  const rows = [
    event(1, wire()),
    event(2, wire(), { traffic_type: 'qa' }),
    event(3, wire(), { traffic_type: 'internal' }, { session_id: 'owner' }),
    event(4, wire(), { traffic_type: 'unknown' }, { session_id: 'legacy' }),
    event(5, wire(), {}, { session_id: 'fixture-two' }),
  ];
  const selected = report(rows);
  assert.equal(selected.issueSummary.denominatorSessions, 1);
  assert.equal(selected.issueSummary.events, 1);
  assert.equal(selected.issues[0].events, 1);
  assert.equal(report(rows, 'qa').issueSummary.events, 2);
  assert.equal(report(rows, 'all').issueSummary.events, 5);
});
