import test from 'node:test';
import assert from 'node:assert/strict';
import {
  QualityAccumulator,
  loadCompleteEvidence,
  normalizeEvidence,
  type TrafficSelection,
} from '../packages/shared/src/quality';
import { analysisMarkdown, buildAnalysisPackage } from '../packages/shared/src/quality-brief';

const props = {
  traffic_type: 'production',
  tracking_version: 'cw-v3',
  release_version: 'quality-v3',
  calculator_type: 'bag',
};
function row(
  name: string,
  ts: number,
  metadata: Record<string, unknown> = {},
  native: Record<string, unknown> = {}
) {
  return normalizeEvidence({
    ts,
    session_id: 'session-private',
    event_type: name === 'pv' ? 'pageview' : 'event',
    event_name: name === 'pv' ? '' : `concrete_workflow_${name}`,
    event_count: 1,
    pathname: '/concrete-bag-calculator',
    device_type: 'desktop',
    browser: 'Chrome',
    event_meta: JSON.stringify({ ...props, ...metadata }),
    ...native,
  });
}
const report = (rows: ReturnType<typeof row>[], traffic: TrafficSelection = 'production') => {
  const accumulator = new QualityAccumulator();
  accumulator.add(rows);
  return accumulator.report(traffic);
};
const provider = (result: ReturnType<typeof report>, name = 'chatgpt') =>
  result.aiSources!.groups.find(group => group.provider === name)!;
const scope = {
  siteId: 'test-site',
  period: '7d',
  traffic: 'production' as const,
  from: 0,
  to: 100,
  source: 'historical' as const,
  totalGroups: 5,
  totalEvents: 5,
  cohortFilterKeys: [],
};

test('AI aggregation preserves existing acquisition and whole-session late QA/internal exclusion', () => {
  const rows = [
    row('pv', 1, {}, { referrer_hostname: 'chatgpt.com', event_count: 2 }),
    row('calculator_submit_success', 2, { ai_source: 'chatgpt', ai_source_evidence: 'referrer' }),
    row('calculator_copy_success', 3),
    row('pv', 4, {}, { session_id: 'qa', referrer_hostname: 'perplexity.ai' }),
    row('calculator_submit_success', 5, { traffic_type: 'qa' }, { session_id: 'qa' }),
    row('pv', 6, {}, { session_id: 'internal', referrer_hostname: 'claude.ai' }),
    row('page_viewed', 7, { traffic_type: 'internal' }, { session_id: 'internal' }),
  ];
  const result = report(rows);
  assert.equal(result.sessions.length, 1);
  assert.equal(result.acquisition[0].channelSource, 'chatgpt.com');
  assert.equal(result.acquisition[0].toolSuccessSessions, 1);
  assert.equal(result.aiSources!.denominatorSessions, 1);
  assert.equal(result.aiSources!.coverage.recognizedSessions, 1);
  assert.equal(provider(result).sessions, 1);
  assert.equal(provider(result).pageviews, 2);
  assert.equal(provider(result).toolSuccessSessions, 1);
  assert.equal(provider(result).resultUseSessions, 1);
  assert.equal(provider(result).provenance.producerDeclaredSessions, 1);
  assert.equal(provider(result).provenance.derivedFromNativeSessions, 1);
  assert.equal(provider(result, 'claude').sessions, 0);
});

test('native referrer / UTM observations remain distinct from producer declarations', () => {
  for (const [native, evidence] of [
    [{ referrer_hostname: 'www.chatgpt.com' }, 'referrerSessions'],
    [{ utm_source: 'ChatGPT' }, 'utmSourceSessions'],
    [{ referrer_hostname: 'chat.openai.com', utm_source: 'chatgpt.com' }, 'referrerAndUtmSessions'],
  ] as const) {
    const result = report([row('pv', 1, {}, native)]);
    assert.equal(provider(result).sessions, 1);
    assert.equal(provider(result).provenance.derivedFromNativeSessions, 1);
    assert.equal(provider(result).provenance.producerDeclaredSessions, 0);
    assert.equal(provider(result).evidence[evidence], 1);
  }
  const declared = report([
    row('pv', 1),
    row('page_viewed', 2, { ai_source: 'claude', ai_source_evidence: 'utm_source' }),
  ]);
  assert.equal(provider(declared, 'claude').sessions, 1);
  assert.equal(provider(declared, 'claude').provenance.producerDeclaredSessions, 1);
  assert.equal(provider(declared, 'claude').provenance.derivedFromNativeSessions, 0);
});

test('ordinary Google/Bing/Apple and misleading hostnames / tags are never inferred AI', () => {
  for (const source of [
    'google.com',
    'bing.com',
    'apple.com',
    'openai.com',
    'aistudio.google.com',
    'pplx.ai',
    'copilot.cloud.microsoft',
    'chatgpt.com.attacker.test',
    'notchatgpt.com',
    'chatgpt-secret@example.test',
    'https://chatgpt.com/private',
    'chatgpt_campaign',
    'AI',
    '.chatgpt.com',
    'bad..chatgpt.com',
    '-bad.chatgpt.com',
  ]) {
    for (const native of [{ referrer_hostname: source }, { utm_source: source }]) {
      const result = report([row('pv', 1, {}, native)]);
      assert.equal(result.aiSources!.coverage.recognizedSessions, 0, source);
      assert.equal(result.aiSources!.coverage.unclassifiedSessions, 1);
    }
  }
});

test('conflicting native and declared sources are not assigned to a provider', () => {
  for (const rows of [
    [row('pv', 1, {}, { referrer_hostname: 'chatgpt.com', utm_source: 'perplexity' })],
    [
      row('pv', 1, {}, { referrer_hostname: 'chatgpt.com' }),
      row('page_viewed', 2, { ai_source: 'claude', ai_source_evidence: 'referrer' }),
    ],
    [row('pv', 1), row('page_viewed', 2, { ai_source_evidence: 'conflict' })],
    [
      row('pv', 1),
      row('page_viewed', 2, { ai_source: 'claude', ai_source_evidence: 'referrer' }),
      row('page_engagement', 3, { ai_source: 'chatgpt', ai_source_evidence: 'utm_source' }),
    ],
  ]) {
    const result = report(rows);
    assert.equal(result.aiSources!.coverage.recognizedSessions, 0);
    assert.equal(result.aiSources!.coverage.conflictSessions, 1);
  }
});

test('missing PV, unsupported version and malformed metadata do not manufacture attribution', () => {
  const declared = { ai_source: 'chatgpt', ai_source_evidence: 'referrer' };
  const missing = report([row('calculator_submit_success', 1, declared)]);
  assert.equal(missing.aiSources!.coverage.missingPageviewSessions, 1);
  assert.equal(missing.aiSources!.coverage.recognizedSessions, 0);
  for (const metadata of [
    { ai_source: 'chatgpt' },
    { ai_source: 'chatgpt', ai_source_evidence: 'conflict' },
    { ai_source: 'google', ai_source_evidence: 'referrer' },
    { ai_source: ['chatgpt'], ai_source_evidence: 'referrer' },
    { ai_source: 'chatgpt', ai_source_evidence: { raw: 'secret' } },
  ]) {
    const result = report([row('pv', 1), row('page_viewed', 2, metadata)]);
    assert.equal(result.aiSources!.coverage.invalidMetadataSessions, 1);
    assert.equal(result.aiSources!.coverage.recognizedSessions, 0);
  }
  const legacy = row('page_viewed', 2, declared);
  legacy.version = 'unknown';
  const result = report([row('pv', 1), legacy]);
  assert.equal(result.aiSources!.coverage.recognizedSessions, 0);
  assert.equal(result.aiSources!.coverage.unknownVersionSessions, 1);
  const malformed = report([row('pv', 1, {}, { event_meta: '{not-json' })], 'all');
  assert.equal(malformed.aiSources!.coverage.invalidMetadataSessions, 1);
  assert.equal(malformed.classification.unknown, 1);
});

test('late page-source updates cannot replace the first observed entry', () => {
  const result = report([
    row('pv', 1, {}, { referrer_hostname: 'chatgpt.com' }),
    row('page_viewed', 2, { ai_source: 'chatgpt', ai_source_evidence: 'referrer' }),
    row('pv', 3, {}, { pathname: '/next', utm_source: 'claude' }),
    row(
      'page_viewed',
      4,
      { ai_source: 'claude', ai_source_evidence: 'utm_source' },
      { pathname: '/next' }
    ),
  ]);
  assert.equal(provider(result).sessions, 1);
  assert.equal(provider(result, 'claude').sessions, 0);
  assert.equal(result.aiSources!.coverage.lateSourceChangeSessions, 1);
  const withoutFirst = report([
    row('pv', 1),
    row('pv', 2, {}, { pathname: '/next', utm_source: 'claude' }),
    row(
      'page_viewed',
      3,
      { ai_source: 'claude', ai_source_evidence: 'utm_source' },
      { pathname: '/next' }
    ),
  ]);
  assert.equal(withoutFirst.aiSources!.coverage.recognizedSessions, 0);
});

test('same-timestamp ambiguous native entries preserve conflict, grouped counts preserve honest units', () => {
  const result = report([
    row('pv', 1, {}, { referrer_hostname: 'chatgpt.com', event_count: 3 }),
    row('pv', 1, {}, { referrer_hostname: 'claude.ai' }),
  ]);
  assert.equal(result.aiSources!.coverage.recognizedSessions, 0);
  assert.equal(result.aiSources!.coverage.conflictSessions, 1);
  const grouped = report([
    row('pv', 1, {}, { referrer_hostname: 'chatgpt.com', event_count: 3 }),
    row('calculator_submit_success', 2, {}, { event_count: 5 }),
    row('calculator_submit_success', 2),
    row('calculator_copy_success', 2, {}, { event_count: 4 }),
  ]);
  assert.equal(provider(grouped).pageviews, 3);
  assert.equal(provider(grouped).toolSuccessSessions, 1);
  assert.equal(provider(grouped).resultUseSessions, 1);
});

test('compatible tied first-PV evidence retains its union independently of row order', () => {
  const referrer = row('pv', 1, {}, { referrer_hostname: 'chatgpt.com', event_count: 2 });
  const utm = row('pv', 1, {}, { utm_source: 'chatgpt', event_count: 3 });
  const combined = row(
    'pv',
    1,
    {},
    {
      referrer_hostname: 'chatgpt.com',
      utm_source: 'chatgpt',
      event_count: 4,
    }
  );
  const permutations = (rows: ReturnType<typeof row>[]): ReturnType<typeof row>[][] =>
    rows.length <= 1
      ? [rows]
      : rows.flatMap((item, index) =>
          permutations(rows.filter((_, otherIndex) => index !== otherIndex)).map(tail => [
            item,
            ...tail,
          ])
        );
  for (const nativeRows of [
    [referrer, utm],
    [referrer, combined],
    [utm, combined],
    [referrer, utm, combined],
  ]) {
    const results = permutations(nativeRows).map(rows =>
      report([...rows, row('calculator_submit_success', 2), row('calculator_copy_success', 3)])
    );
    const first = results[0]!;
    const group = provider(first);
    assert.deepEqual(group.evidence, {
      referrerSessions: Number(nativeRows.includes(referrer)),
      utmSourceSessions: Number(nativeRows.includes(utm)),
      referrerAndUtmSessions: Number(nativeRows.includes(combined)),
    });
    assert.equal(first.aiSources!.coverage.recognizedSessions, 1);
    assert.equal(first.aiSources!.coverage.conflictSessions, 0);
    assert.equal(group.sessions, 1);
    assert.equal(
      group.pageviews,
      nativeRows.reduce((total, event) => total + event.count, 0)
    );
    assert.equal(group.provenance.derivedFromNativeSessions, 1);
    assert.equal(group.goalEligibleSessions, 1);
    assert.equal(group.toolSuccessSessions, 1);
    assert.equal(group.resultUseSessions, 1);
    for (const result of results) assert.deepEqual(result.aiSources, first.aiSources);
  }
});

test('generic sites and unknown calculator signals retain null rather than inventing a goal adapter', () => {
  const result = report([
    row(
      'pv',
      1,
      { calculator_type: 'unknown' },
      { referrer_hostname: 'perplexity.ai', pathname: '/text-tool' }
    ),
    row('calculator_submit_success', 2, { calculator_type: 'unknown' }, { pathname: '/text-tool' }),
  ]);
  const group = provider(result, 'perplexity');
  assert.equal(group.sessions, 1);
  assert.equal(group.goalCoverage, 'not_applicable');
  assert.equal(group.toolSuccessSessions, null);
  assert.equal(group.resultUseSessions, null);
});

test('JSON and Markdown exports include conservative aggregation but not identifiers/raw metadata', () => {
  const result = report([
    row('pv', 1, {}, { referrer_hostname: 'chatgpt.com' }),
    row('page_viewed', 2, {
      ai_source: 'chatgpt',
      ai_source_evidence: 'referrer',
      raw: 'private@example.test',
    }),
  ]);
  const pack = buildAnalysisPackage(result, scope);
  assert.equal(pack.aiSources!.citationStatus, 'not_connected');
  assert.equal(pack.aiSources!.citations, null);
  const text = JSON.stringify(pack) + analysisMarkdown(pack);
  assert.ok(text.includes('AI'));
  for (const raw of ['session-private', 'private@example.test', 'utmSourceValue', 'rawMetadata'])
    assert.ok(!text.includes(raw));
  const { aiSources: _sources, ...legacyReport } = result;
  const legacyPack = buildAnalysisPackage(legacyReport, scope);
  assert.equal(legacyPack.aiSources, null);
  assert.ok(analysisMarkdown(legacyPack).includes('当前版本未提供AI来源分组'));
});

test('complete pagination over 500 groups retains source aggregation and excludes late QA', async () => {
  const rows = Array.from({ length: 501 }, (_, index) =>
    row('pv', index + 1, {}, { session_id: `s-${index}`, referrer_hostname: 'chatgpt.com' })
  );
  rows.push(row('page_engagement', 502, { traffic_type: 'qa' }, { session_id: 's-0' }));
  const totals = {
    totalGroups: 502,
    totalEvents: 502,
    from: 0,
    to: 1000,
    source: 'historical' as const,
  };
  const loaded = await loadCompleteEvidence(
    async cursor =>
      cursor
        ? { ...totals, data: rows.slice(500), nextCursor: null, scannedGroups: 502 }
        : { ...totals, data: rows.slice(0, 500), nextCursor: 'second', scannedGroups: 500 },
    () => {},
    new AbortController().signal
  );
  const result = loaded.accumulator.report();
  assert.equal(result.aiSources!.denominatorSessions, 500);
  assert.equal(provider(result).sessions, 500);
  assert.equal(result.classification.qa, 1);
});

test('legacy evidence capability absence and mixed generations are distinct from complete zero', () => {
  const legacy = row('pv', 1, {}, { referrer_hostname: 'chatgpt.com' });
  delete legacy.aiSource;
  const old = report([legacy]);
  assert.equal(old.aiSources!.status, 'unavailable');
  assert.deepEqual(old.aiSources!.groups, []);
  assert.equal(old.aiSources!.coverage.sourceObservationUnavailableSessions, 1);
  assert.ok(
    analysisMarkdown(buildAnalysisPackage(old, scope)).includes('当前版本未提供AI来源分组')
  );
  const mixed = report([
    legacy,
    row('pv', 2, {}, { session_id: 'new', referrer_hostname: 'claude.ai' }),
  ]);
  assert.equal(mixed.aiSources!.status, 'partial');
  assert.equal(provider(mixed, 'claude').sessions, 1);
  assert.equal(report([]).aiSources!.status, 'available');
  assert.equal(report([]).aiSources!.denominatorSessions, 0);
});

test('unknown traffic native source observations stay separate, unversioned producer never overrides them', () => {
  const pv = row('pv', 1, {}, { referrer_hostname: 'chatgpt.com', event_meta: '' });
  const legacy = row('page_viewed', 2, { ai_source: 'claude', ai_source_evidence: 'referrer' });
  legacy.traffic = 'unknown';
  legacy.version = 'unknown';
  const defaultResult = report([pv, legacy]);
  assert.equal(defaultResult.aiSources!.denominatorSessions, 0);
  const unknown = report([pv, legacy], 'unknown');
  assert.equal(provider(unknown).sessions, 1);
  assert.equal(provider(unknown).toolSuccessSessions, null);
  assert.equal(unknown.aiSources!.coverage.unknownVersionSessions, 1);
  assert.equal(unknown.aiSources!.coverage.conflictSessions, 0);
});

test('producer received before native PV is provisional until matching entry exists', () => {
  const result = report([
    row('page_viewed', 1, { ai_source: 'copilot', ai_source_evidence: 'utm_source' }),
    row('pv', 2),
  ]);
  assert.equal(provider(result, 'copilot').sessions, 1);
  const wrongPage = report([
    row(
      'page_viewed',
      1,
      { ai_source: 'copilot', ai_source_evidence: 'utm_source' },
      { pathname: '/later' }
    ),
    row('pv', 2),
  ]);
  assert.equal(wrongPage.aiSources!.coverage.recognizedSessions, 0);
  assert.equal(wrongPage.aiSources!.coverage.lateSourceChangeSessions, 1);
});

test('reports are repeatable and incomplete/cancelled scans never produce a complete package', async () => {
  const accumulator = new QualityAccumulator();
  accumulator.add([row('pv', 1, {}, { referrer_hostname: 'chatgpt.com' })]);
  assert.deepEqual(accumulator.report().aiSources, accumulator.report().aiSources);
  const totals = {
    totalGroups: 2,
    totalEvents: 2,
    from: 0,
    to: 1000,
    source: 'historical' as const,
  };
  await assert.rejects(
    loadCompleteEvidence(
      async () => ({
        ...totals,
        data: [row('pv', 1)],
        nextCursor: null,
        scannedGroups: 1,
      }),
      () => {},
      new AbortController().signal
    ),
    /before completion/
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    loadCompleteEvidence(
      async () => {
        throw new Error('Must not read after cancellation');
      },
      () => {},
      controller.signal
    ),
    { name: 'AbortError' }
  );
});
