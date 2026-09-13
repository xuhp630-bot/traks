import test from 'node:test';
import assert from 'node:assert/strict';
import { QualityAccumulator, normalizeEvidence } from '../packages/shared/src/quality';
import { buildAnalysisPackage } from '../packages/shared/src/quality-brief';
import { readCrmQuality } from '../apps/platform/api/src/lib/crm-quality';

const event = (name: string, ts: number, overrides = {}) => ({
  ...normalizeEvidence({
    ts,
    session_id: 'test-session',
    event_type: name === 'pv' ? 'pageview' : 'event',
    event_name: name === 'pv' ? '' : `concrete_workflow_${name}`,
    event_count: 1,
    pathname: '/concrete-bag-calculator',
    device_type: 'desktop',
    browser: 'Chrome',
    event_meta: JSON.stringify({
      traffic_type: 'production',
      tracking_version: 'cw-v3',
      release_version: 'quality-v3',
      page_id: 'p_123456789abc',
      calculator_type: 'bag',
    }),
  }),
  ...overrides,
});
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
const run = (rows: ReturnType<typeof event>[]) => {
  const accumulator = new QualityAccumulator();
  accumulator.add(rows);
  return buildAnalysisPackage(accumulator.report(), scope);
};

test('production denominator, pageviews and goals exclude entire late-QA sessions', () => {
  const report = run([
    event('pv', 1),
    event('calculator_submit_success', 2),
    event('page_engagement', 3, { traffic: 'qa' }),
    event('pv', 4, { sessionId: 'customer' }),
    event('calculator_submit_success', 5, { sessionId: 'customer' }),
    event('pv', 6, { sessionId: 'historical', traffic: 'unknown', version: 'unknown' }),
    event('pv', 7, { sessionId: 'owner', traffic: 'internal' }),
  ]);
  assert.deepEqual(report.population.wholeCohortClassification, {
    production: 1,
    qa: 1,
    internal: 1,
    unknown: 1,
  });
  assert.equal(report.business.sessions, 1);
  assert.equal(report.business.pageviews, 1);
  assert.equal(report.business.goals[0].sessions, 1);
  assert.equal(report.business.goals[0].rate, 1);
  assert.ok(!JSON.stringify(report).includes('test-session'));
});

for (const [path, entry] of [
  ['/blog/bag-cover', 'article'],
  ['/concrete-bag-calculator', 'tool_direct'],
  ['/concrete-calculators', 'directory'],
  ['/es/mini-mix-concrete-pricing-calculator', 'tool_direct'],
]) {
  test(`ordered funnel supports ${entry} from ${path}`, () => {
    const report = run([
      event('pv', 1, { path }),
      event('page_viewed', 2),
      event('calculator_submit_click', 3),
      event('calculator_submit_success', 4),
      event('save_project_success', 5),
    ]);
    assert.deepEqual(report.entryFunnels[0], { entry, stages: [1, 1, 1, 1, 1], completionRate: 1 });
  });
}

test('empty selection has no invented rate or registered user count', () => {
  const report = run([]);
  assert.equal(report.business.sessions, 0);
  assert.ok(report.business.goals.every(goal => goal.rate === null));
  assert.deepEqual(report.entryFunnels, []);
});

for (const [name, overrides] of [
  ['cross page id', { pageId: 'p_abcdef123456' }],
  ['cross path', { path: '/concrete-cost-calculator' }],
  ['cross version', { version: 'cw-v3/other' }],
  ['missing page', { pageId: '' }],
  ['grouped return', { count: 2 }],
  ['cross calculator', { calculator: 'slab' }],
  ['unknown calculator', { calculator: 'unknown' }],
] as const) {
  test(`does not link ${name}`, () => {
    const report = run([
      event('pv', 1),
      event('page_viewed', 2),
      event('calculator_submit_click', 3),
      event('calculator_submit_success', 4, overrides),
      event('calculator_copy_success', 5),
    ]);
    assert.equal(report.entryFunnels[0].stages[3], 0);
    assert.equal(report.entryFunnels[0].stages[4], 0);
  });
}
test('equal timestamps and concurrent submits cannot invent successful paths', () => {
  for (const rows of [
    [event('calculator_submit_click', 3), event('calculator_submit_success', 3)],
    [
      event('calculator_submit_click', 3),
      event('calculator_submit_click', 4),
      event('calculator_submit_success', 5),
    ],
    [
      event('calculator_submit_click', 3),
      event('calculator_submit_click', 3),
      event('calculator_submit_success', 5),
    ],
  ]) {
    const report = run([
      event('pv', 1),
      event('page_viewed', 2),
      ...rows,
      event('calculator_copy_success', 6),
    ]);
    assert.equal(report.entryFunnels[0].stages[3], 0);
  }
});
test('reset prevents linking result use to an old calculation', () => {
  const report = run([
    event('pv', 1),
    event('page_viewed', 2),
    event('calculator_submit_click', 3),
    event('calculator_submit_success', 4),
    event('calculator_reset', 5),
    event('calculator_copy_success', 6),
  ]);
  assert.deepEqual(report.entryFunnels[0].stages, [1, 1, 1, 1, 0]);
});

test('result use must not attach another calculator copy to a successful calculation', () => {
  const report = run([
    event('pv', 1),
    event('page_viewed', 2),
    event('calculator_submit_click', 3),
    event('calculator_submit_success', 4),
    event('calculator_copy_success', 5, { calculator: 'slab' }),
  ]);
  assert.deepEqual(report.entryFunnels[0].stages, [1, 1, 1, 1, 0]);
});

const window = { from: '2026-09-01T00:00:00.000Z', to: '2026-09-02T00:00:00.000Z' };
const crm = (registrations?: object) => ({
  format: 'crm-quality/v1',
  ...window,
  generatedAt: window.to,
  crmConnected: true,
  followupSendingEnabled: false,
  population: 'production_labeled_requests_not_verified_humans',
  counts: {
    requests: 0,
    replyAuthorized: 0,
    ownerQualified: 0,
    ownerConfirmedReplies: 0,
    followupAccepted: 0,
    deliveredFollowups: null,
    failedFollowups: null,
    unresolvedSends: 0,
  },
  deliveryCoverage: 'not_configured',
  automaticCustomerReplies: null,
  retention: {
    definition: 'verified_account_project_save_on_exact_UTC_day_since_first_retained_save',
    cohortWindow: 'first_retained_save_day_in_requested_window',
    rows: [1, 7, 30].map(offset => ({ offset, eligible: 0, returned: 0, rate: null })),
    observationHistoryDays: 90,
  },
  registrations,
});
const accounts = {
  coverage: 'current_database_snapshot',
  asOf: window.to,
  total: 3,
  ownerAccounts: 1,
  otherAccounts: 2,
  verifiedAccounts: 2,
  unverifiedAccounts: 1,
  bannedAccounts: 0,
  createdInWindow: 1,
};
const read = (data: object) =>
  readCrmQuality(
    JSON.stringify({ site: { origin: 'https://example.test', token: 'x'.repeat(40) } }),
    { siteId: 'site', domain: 'example.test' },
    window,
    async () => Response.json(data)
  );
test('registration adapter strips personal data and preserves missing versus zero', async () => {
  const data = await read(
    crm({ ...accounts, email: 'private@example.test', users: ['private-id'] })
  );
  assert.equal(data.status, 'connected');
  assert.ok(!JSON.stringify(data).includes('private'));
  assert.deepEqual('registrations' in data && data.registrations, accounts);
  const legacy = await read(crm());
  assert.equal('registrations' in legacy && legacy.registrations, null);
  await assert.rejects(read(crm({ ...accounts, otherAccounts: 50 })), /denominator/);
});
