import test from 'node:test';
import assert from 'node:assert/strict';
import * as shared from '../packages/shared/src/index';
import {
  QualityAccumulator,
  normalizeEvidence,
  issueDiagnosis,
  issueMarkdown,
  type EvidenceEvent,
} from '../packages/shared/src/quality';
import {
  analysisMarkdown,
  buildAnalysisPackage,
  optimizationCandidates,
} from '../packages/shared/src/quality-brief';

const trust = ['trusted', 'untrusted', 'unknown'] as const;
const phases = ['loading', 'interactive', 'complete', 'unknown'] as const;
const buckets = ['known_img', 'clarity_tag', 'clarity_runtime', 'other', 'unknown'] as const;
const expected = {
  version: 'rs1',
  trust: 'trusted',
  documentPhase: 'complete',
  bucket: 'known_img',
} as const satisfies shared.ResourceSignal;
const rd1 = 'rd1|logo|mobile_navbar|attached_complete_zero|box_wide_high|live|status_200';
const wire = 'rs1|trusted|complete|known_img';
const scope = {
  siteId: 'fixture-site',
  period: 'today',
  traffic: 'production' as const,
  from: 0,
  to: 1000,
  source: 'live' as const,
  totalGroups: 1,
  totalEvents: 2,
  cohortFilterKeys: [],
};

function event(
  value: unknown,
  props: Record<string, unknown> = {},
  row: Record<string, unknown> = {}
): EvidenceEvent {
  return normalizeEvidence({
    ts: 1,
    session_id: 'fixture-only-session',
    pathname: '/',
    event_type: 'event',
    event_name: 'concrete_workflow_resource_load_error',
    event_count: 2,
    browser: 'Opera',
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
      ...props,
    }),
    ...row,
  });
}
function report(rows: EvidenceEvent[], traffic: 'production' | 'all' | 'qa' = 'production') {
  const accumulator = new QualityAccumulator();
  accumulator.add(rows);
  return accumulator.report(traffic);
}

for (const value of trust)
  for (const documentPhase of phases)
    for (const bucket of buckets)
      test(`rs1 exact enum combination ${value}/${documentPhase}/${bucket}`, () => {
        const input = `rs1|${value}|${documentPhase}|${bucket}`;
        const output = { version: 'rs1', trust: value, documentPhase, bucket };
        assert.ok(input.length <= 128);
        assert.deepEqual(shared.decodeResourceSignal(input), output);
        assert.deepEqual(shared.sanitizeResourceSignal(output), output);
        for (const resource_kind of ['img', 'script']) {
          const normalized = event(input, { resource_kind });
          assert.deepEqual(normalized.resourceSignal, output);
          assert.equal(normalized.httpStatus, 0);
          assert.equal(normalized.failureOutcome, 'failed');
          const result = report([normalized]);
          assert.deepEqual(result.issues[0].resourceSignal, output);
          assert.equal(result.issues[0].outcome, 'failed');
          assert.equal(result.issues[0].reason, 'resource_load');
          assert.equal(result.issues[0].httpStatus, 0);
          assert.deepEqual(buildAnalysisPackage(result, scope).issues[0].resourceSignal, output);
        }
      });

test('rs1 malformed/unknown wire is absent and never echoes arbitrary data', () => {
  for (const input of [
    undefined,
    null,
    0,
    false,
    [],
    {},
    '',
    ` ${wire}`,
    `${wire} `,
    `${wire}\n`,
    `${wire}|extra`,
    wire.slice(4),
    wire.replace('rs1|', 'rs2|'),
    wire.replace('trusted', 'synthetic'),
    wire.replace('trusted', 'Trusted'),
    wire.replace('trusted', 'true'),
    wire.replace('complete', 'COMPLETE'),
    wire.replace('known_img', '__proto__'),
    'rs1|trusted|complete|https://private.invalid/SECRET_ID',
    `rs1|trusted|complete|${'x'.repeat(129)}`,
    `rs1|trusted\0|complete|known_img`,
  ]) {
    assert.equal(shared.decodeResourceSignal(input), undefined);
    const observed = event(input);
    assert.equal(observed.resourceSignal, undefined);
    assert.doesNotMatch(JSON.stringify(observed), /SECRET_|private\.invalid|rs1\|/);
  }
  // JSON transport unwraps a String object; the pure decoder still never coerces it.
  assert.equal(shared.decodeResourceSignal(Object(wire)), undefined);
});

test('API sanitization projects four own data fields without invoking accessors or toJSON', () => {
  let reads = 0;
  const polluted = {
    ...expected,
    rawUrl: 'https://private.invalid/SECRET_URL',
    get arbitrary() {
      reads++;
      throw new Error('SECRET_GETTER');
    },
    toJSON() {
      throw new Error('SECRET_TO_JSON');
    },
  };
  assert.deepEqual(shared.sanitizeResourceSignal(polluted), expected);
  assert.equal(reads, 0);
  assert.deepEqual(
    Object.keys(shared.sanitizeResourceSignal(polluted)!).sort(),
    Object.keys(expected).sort()
  );
  assert.equal(shared.sanitizeResourceSignal(Object.create(expected)), undefined);
  for (const key of Object.keys(expected)) {
    const inherited = { ...expected } as Record<string, unknown>;
    delete inherited[key];
    Object.setPrototypeOf(inherited, { [key]: expected[key as keyof typeof expected] });
    assert.equal(shared.sanitizeResourceSignal(inherited), undefined);
    const accessor = { ...expected };
    Object.defineProperty(accessor, key, {
      get() {
        reads++;
        throw new Error('SECRET_GETTER');
      },
    });
    assert.equal(shared.sanitizeResourceSignal(accessor), undefined);
  }
  assert.equal(reads, 0);
  for (const value of [
    null,
    [],
    wire,
    { ...expected, version: 'rs2' },
    { ...expected, trust: true },
    { ...expected, bucket: 'SECRET_URL' },
  ])
    assert.equal(shared.sanitizeResourceSignal(value), undefined);
  const trapped = new Proxy(
    {},
    {
      getOwnPropertyDescriptor() {
        throw new Error('SECRET_PROXY');
      },
    }
  );
  assert.equal(shared.sanitizeResourceSignal(trapped), undefined);
});

test('only the normalized canonical resource-error IMG/SCRIPT event receives rs1', () => {
  for (const name of [
    'resource_load_error',
    'resource_load_success',
    'concrete_workflow_resource_load_success',
    'concrete_workflow_journey_error',
    'image_error',
    'concrete_workflow_resource_load_error_extra',
  ]) {
    const observed = event(wire, { resource_diagnostic: rd1 }, { event_name: name });
    assert.equal(observed.resourceSignal, undefined);
    const injected = { ...observed, resourceSignal: expected };
    assert.ok(report([injected]).issues.every(issue => !issue.resourceSignal));
  }
  for (const resource_kind of ['link', 'source', 'audio', 'video', 'IMG', '', null, {}])
    assert.equal(event(wire, { resource_kind }).resourceSignal, undefined);
  const pageview = event(wire, {}, { event_type: 'pageview' });
  assert.equal(pageview.resourceSignal, undefined);
  assert.ok(
    report([{ ...pageview, resourceSignal: expected }]).issues.every(issue => !issue.resourceSignal)
  );
  for (const event_type of [undefined, null, 'engagement', 'unknown', {}, 0]) {
    const observed = event(wire, {}, { event_type });
    // Preserve the historical general fallback, but do not grant new rs1 eligibility.
    assert.equal(observed.eventType, 'event');
    assert.equal(observed.resourceSignal, undefined);
  }
  // The older rd1 alias remains independently accepted, without widening rs1.
  assert.deepEqual(
    event(wire, { resource_diagnostic: rd1 }, { event_name: 'resource_load_error' })
      .resourceDiagnostic,
    shared.decodeResourceDiagnostic(rd1)
  );
});

test('third-party script accepts rs1 without gaining rd1 or an HTTP/root-cause verdict', () => {
  const signal = 'rs1|untrusted|interactive|clarity_runtime';
  const observed = event(signal, {
    resource_kind: 'script',
    resource_origin_kind: 'third_party',
    resource_asset_kind: 'external_asset',
    resource_provider: 'microsoft_clarity',
    resource_diagnostic: rd1,
    resource_url: 'https://scripts.clarity.ms/SECRET_VERSION/clarity.js?SECRET_QUERY',
  });
  assert.deepEqual(observed.resourceSignal, {
    version: 'rs1',
    trust: 'untrusted',
    documentPhase: 'interactive',
    bucket: 'clarity_runtime',
  });
  assert.equal(observed.resourceDiagnostic, undefined);
  assert.equal(observed.httpStatus, 0);
  const issue = report([observed]).issues[0];
  assert.equal(issue.outcome, 'failed');
  assert.equal(issue.httpStatus, 0);
  assert.match(issueDiagnosis(issue).evidence, /isTrusted=false/);
  assert.match(issueDiagnosis(issue).evidence, /不是本次失败请求的已验证HTTP状态或根因/);
  assert.doesNotMatch(JSON.stringify(issue), /SECRET_|scripts\.clarity\.ms|rs1\|/);
});

test('existing collector validation retains rs1 inside its unchanged1024 boundary and no foreign event gain', () => {
  const metadata = JSON.stringify({
    tracking_version: 'cw-v3',
    release_version: 'quality-v9-rs1',
    traffic_type: 'production',
    resource_kind: 'script',
    resource_origin_kind: 'third_party',
    resource_asset_kind: 'external_asset',
    resource_provider: 'microsoft_clarity',
    resource_signal: 'rs1|trusted|loading|clarity_tag',
  });
  const exactLimit = metadata + ' '.repeat(1024 - metadata.length);
  const packet = (t: string, ep: string) =>
    shared.trackingEventSchema.parse({
      t,
      s: 'fixture-site',
      p: '/',
      sid: 'fixture-only-session',
      en: 'concrete_workflow_resource_load_error',
      ep,
    });
  const normalized = (payload: ReturnType<typeof packet>) =>
    normalizeEvidence({
      ts: 1,
      session_id: payload.sid,
      pathname: payload.p,
      event_type: payload.t,
      event_name: payload.en,
      event_meta: payload.ep,
      event_count: 1,
    });
  const accepted = packet('event', exactLimit);
  assert.equal(accepted.ep?.length, 1024);
  assert.deepEqual(normalized(accepted).resourceSignal, {
    version: 'rs1',
    trust: 'trusted',
    documentPhase: 'loading',
    bucket: 'clarity_tag',
  });
  assert.equal(packet('event', exactLimit + ' ').ep, '');
  assert.equal(normalized(packet('event', exactLimit + ' ')).resourceSignal, undefined);
  assert.equal(normalized(packet('engagement', exactLimit)).resourceSignal, undefined);
  assert.equal(normalized(packet('pageview', exactLimit)).resourceSignal, undefined);
});

test('malformed/missing rs1 preserves byte-identical legacy and rd1 grouping keys', () => {
  for (const diagnostic of [undefined, rd1]) {
    const base = event(undefined, { resource_diagnostic: diagnostic });
    const baseline = report([base]);
    const rows = [
      base,
      ...[null, 'rs2|trusted|complete|known_img', 'rs1|SECRET_URL'].map((value, i) => ({
        ...event(value, { resource_diagnostic: diagnostic }),
        ts: i + 2,
      })),
    ];
    const actual = report(rows);
    assert.equal(actual.issues.length, 1);
    assert.equal(actual.issues[0].key, baseline.issues[0].key);
    assert.equal(actual.issues[0].events, 8);
    assert.equal(actual.issues[0].resourceSignal, undefined);
    assert.equal(actual.issueSummary.sessions, 1);
  }
});

test('valid signal signatures split groups, never diagnostic signal/session totals', () => {
  const rows = [event(undefined, { resource_diagnostic: rd1 })];
  for (const value of trust)
    for (const phase of phases)
      for (const bucket of buckets)
        rows.push({
          ...event(`rs1|${value}|${phase}|${bucket}`, { resource_diagnostic: rd1 }),
          ts: rows.length + 1,
        });
  const enriched = report(rows);
  const stripped = report(rows.map(({ resourceSignal: _signal, ...row }) => row));
  assert.equal(enriched.issues.length, 61);
  assert.equal(stripped.issues.length, 1);
  assert.equal(enriched.issues.find(issue => !issue.resourceSignal)?.key, stripped.issues[0].key);
  assert.deepEqual(enriched.issueSummary, stripped.issueSummary);
  assert.deepEqual(enriched.classification, stripped.classification);
  assert.deepEqual(enriched.funnels, stripped.funnels);
  assert.deepEqual(enriched.operations, stripped.operations);
  assert.equal(enriched.issueSummary.events, 122);
  assert.equal(enriched.issueSummary.sessions, 1);
});

test('accumulator/API reports sanitize four fields and do not expose a mutable state reference', () => {
  const polluted = {
    ...expected,
    rawUrl: 'SECRET_URL',
    toJSON() {
      throw new Error('SECRET_TO_JSON');
    },
  };
  const accumulator = new QualityAccumulator();
  accumulator.add([{ ...event(wire), resourceSignal: polluted }]);
  const first = accumulator.report();
  assert.deepEqual(first.issues[0].resourceSignal, expected);
  (first.issues[0].resourceSignal as unknown as Record<string, unknown>).rawUrl = 'SECRET_LATER';
  const second = accumulator.report();
  assert.deepEqual(second.issues[0].resourceSignal, expected);
  assert.doesNotMatch(JSON.stringify(second), /SECRET_|rawUrl/);
  const legacyKey = report([event(undefined)]).issues[0].key;
  for (const value of [Object.create(expected), { ...expected, trust: 'SECRET_TRUST' }, []]) {
    const injected = { ...event(undefined), resourceSignal: value } as EvidenceEvent;
    assert.equal(report([injected]).issues[0].key, legacyKey);
    assert.equal(report([injected]).issues[0].resourceSignal, undefined);
  }
});

test('JSON, candidates, issue Markdown and full Markdown each revalidate rs1', () => {
  const result = report([event(wire, { resource_diagnostic: rd1 })]);
  const polluted = {
    ...expected,
    rawUrl: 'https://private.invalid/SECRET_URL',
    rawId: 'SECRET_ID',
    toJSON() {
      throw new Error('SECRET_TO_JSON');
    },
  };
  result.issues[0].resourceSignal = polluted;
  const pack = buildAnalysisPackage(result, scope);
  assert.deepEqual(pack.issues[0].resourceSignal, expected);
  assert.deepEqual(pack.candidates[0].resourceSignal, expected);
  assert.deepEqual(optimizationCandidates(result)[0].resourceSignal, expected);
  for (const text of [
    JSON.stringify(pack),
    issueMarkdown(result.issues[0], 'production', 'pending'),
    analysisMarkdown(pack),
  ]) {
    assert.match(text, /resourceSignal/);
    assert.doesNotMatch(text, /SECRET_|private\.invalid|rawUrl|rawId|rs1\||fixture-only-session/);
  }
  for (const text of [
    issueMarkdown(result.issues[0], 'production', 'pending'),
    analysisMarkdown(pack),
    pack.candidates[0].observed,
  ]) {
    assert.match(text, /isTrusted=true/);
    assert.match(text, /不证明真人或原生网络请求/);
    assert.match(text, /文档观测阶段/);
  }
  pack.issues[0].resourceSignal = polluted;
  assert.doesNotMatch(analysisMarkdown(pack), /SECRET_|private\.invalid|rawUrl|rawId/);
  for (const invalid of [Object.create(expected), { ...expected, documentPhase: 'SECRET_PHASE' }]) {
    result.issues[0].resourceSignal = invalid;
    const sanitized = buildAnalysisPackage(result, scope);
    assert.equal(sanitized.issues[0].resourceSignal, undefined);
    assert.equal(sanitized.candidates[0].resourceSignal, undefined);
    assert.doesNotMatch(
      issueMarkdown(result.issues[0], 'production', 'pending'),
      /resourceSignal|SECRET_/
    );
  }
});

test('exporters omit injected rs1 on non-resource or non-IMG/SCRIPT issue objects', () => {
  for (const overrides of [{ kind: 'journey_error' }, { resourceKind: 'link' }]) {
    const result = report([event(undefined)]);
    Object.assign(result.issues[0], overrides, { resourceSignal: expected });
    const pack = buildAnalysisPackage(result, scope);
    assert.equal(pack.issues[0].resourceSignal, undefined);
    assert.equal(pack.candidates[0].resourceSignal, undefined);
    assert.doesNotMatch(analysisMarkdown(pack), /resourceSignal|isTrusted=/);
    assert.doesNotMatch(
      issueMarkdown(result.issues[0], 'production', 'pending'),
      /resourceSignal|isTrusted=/
    );
  }
});

test('finite Chinese labels preserve observation/trust/HTTP limits without echoing invalid input', () => {
  for (const value of trust)
    for (const phase of phases)
      for (const bucket of buckets) {
        const lines = shared.resourceSignalLines({
          version: 'rs1',
          trust: value,
          documentPhase: phase,
          bucket,
        });
        assert.equal(lines.length, 3);
        assert.ok(lines.join('\n').length < 512);
        assert.match(lines[0], /isTrusted/);
        assert.match(lines[1], /不是请求开始或失败时刻/);
        assert.match(lines[2], /不是本次失败请求的已验证HTTP状态或根因/);
      }
  assert.match(shared.resourceSignalLines().join('\n'), /未知/);
  assert.doesNotMatch(
    shared
      .resourceSignalLines({ ...expected, bucket: 'SECRET_URL' } as shared.ResourceSignal)
      .join('\n'),
    /SECRET_/
  );
});

test('late QA and independent internal/unknown labels preserve selected-population exclusion', () => {
  const rows = [
    event(wire),
    { ...event(wire, { traffic_type: 'qa' }), ts: 2 },
    event(wire, { traffic_type: 'internal' }, { session_id: 'owner', ts: 3 }),
    event(wire, { traffic_type: 'unknown' }, { session_id: 'unknown', ts: 4 }),
    event(wire, {}, { session_id: 'production-two', ts: 5 }),
  ];
  assert.equal(report(rows).issueSummary.denominatorSessions, 1);
  assert.equal(report(rows).issueSummary.events, 2);
  assert.equal(report(rows, 'qa').issueSummary.events, 4);
  assert.equal(report(rows, 'all').issueSummary.events, 10);
});
