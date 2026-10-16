import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CustomEventItem } from '../packages/shared/src';
import { RevenuePanel } from '../apps/platform/web/src/components/analytics/RevenuePanel';

const render = (props: Partial<Parameters<typeof RevenuePanel>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(RevenuePanel, { events: undefined, isLoading: false, ...props })
  );
const events: CustomEventItem[] = [
  {
    name: 'Purchase Confirmed',
    count: 2,
    totalValue: 0,
    revenues: [
      { currency: 'USD', amount: 49 },
      { currency: 'EUR', amount: 30 },
    ],
  },
];

test('income is explicitly mixed Top20 declared telemetry, not production business income', () => {
  const html = render({ events });
  assert.match(html, /Declared revenue/);
  assert.match(html, /原始混合收入/);
  assert.match(html, /QA、internal 与未分类事件/);
  assert.match(html, /不是 production 经营收入/);
  assert.match(html, /Top 20/);
  assert.match(html, /不代表全量收入/);
  assert.match(html, /no exchange-rate conversion or order reconciliation/);
  assert.match(html, /Account retention, ad spend, CAC/);
  assert.match(html, /USD/);
  assert.match(html, /EUR/);
  assert.match(html, />49</);
  assert.match(html, />30</);
  assert.doesNotMatch(html, />79</);
});

test('missing/legacy backend, loaded-empty, loading, refresh and read errors stay distinct', () => {
  assert.match(render(), /Revenue data is unavailable/);
  assert.match(
    render({ events: [{ name: 'Legacy score', count: 1, totalValue: 49 }] }),
    /Revenue data is unavailable/
  );
  const empty = render({ events: [] });
  assert.match(empty, /No declared income/);
  assert.match(empty, /Legacy event values are not assumed/);
  const loading = render({ events, isLoading: true });
  assert.match(loading, /role="status"/);
  assert.match(loading, /Loading revenue/);
  assert.doesNotMatch(loading, />49</);
  const failure = render({ events, isError: true, onRetry: () => {} });
  assert.match(failure, /role="alert"/);
  assert.match(failure, /Revenue could not be loaded/);
  assert.match(failure, /Retry revenue/);
  assert.doesNotMatch(failure, />49</);
  assert.match(
    render({ events, isError: true, isLoading: true, onRetry: () => {} }),
    /<button[^>]*disabled=""/
  );
});

test('income view keeps the full explorer response but displays only Top20 names', () => {
  const rows = Array.from({ length: 23 }, (_, index) => ({
    name: `rank-${String(index).padStart(2, '0')}`,
    count: 100 - index,
    totalValue: 0,
    revenues: [{ currency: 'USD', amount: index + 1 }],
  }));
  const html = render({ events: rows });
  assert.match(html, /rank-00/);
  assert.match(html, /rank-19/);
  assert.doesNotMatch(html, /rank-20|rank-21|rank-22/);
  assert.equal(rows.length, 23);
});

test('dashboard keeps production business default, existing consumers and exact event cache key', () => {
  const source = readFileSync('apps/platform/web/src/routes/portal.site.$siteId.lazy.tsx', 'utf8');
  assert.match(source, /\[showRaw, setShowRaw\] = useState\(false\)/);
  const view = source.slice(
    source.indexOf('{!showRaw ? ('),
    source.indexOf('{/* Pages + Sources */}')
  );
  assert.ok(view.indexOf('<BusinessPanel') >= 0);
  assert.ok(view.indexOf(') : (') < view.indexOf('<RevenuePanel'));
  assert.ok(view.indexOf('<EventsPathsExplorer') < view.indexOf('<RevenuePanel'));
  for (const original of [
    '<QualityConsole',
    '<FunnelsPanel',
    '<GoalsPanel',
    '<AiVisibilitySnapshots',
  ])
    assert.ok(source.includes(original), `${original} retained`);
  assert.match(source, /queryKey: \['site-analytics', siteId, 'events-page', period, filterKey\]/);
  const query = source.slice(
    source.indexOf('const eventsQ ='),
    source.indexOf('// keepPreviousData means')
  );
  assert.match(query, /enabled: showRaw/);
  assert.doesNotMatch(query, /placeholderData/);
  assert.match(source, /isLoading=\{eventsQ.isLoading \|\| eventsQ.isFetching\}/);
  assert.match(source, /isError=\{eventsQ.isError\}/);
  assert.match(source, /onRetry=\{\(\) => void eventsQ.refetch\(\)\}/);
  assert.match(source, /invalidateQueries\(\{ queryKey: \['site-business', siteId\] \}\)/);
  assert.match(source, /invalidateQueries\(\{ queryKey: aiVisibilityQueryKey\(siteId\) \}\)/);
});
