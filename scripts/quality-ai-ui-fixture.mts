import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// Isolated, synthetic-only UI. No API proxy, credentials, D1 or collector writes.
const fixtureModule = 'virtual:quality-ai-ui-fixture';
const fixtureCode = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { QualityAccumulator, normalizeEvidence } from '@traks/shared';
import { QualityConsole } from '/src/components/analytics/QualityConsole.tsx';
import { QualityWorkflow } from '/src/components/analytics/QualityWorkflow.tsx';
import { AiVisibilitySnapshots } from '/src/components/analytics/AiVisibilitySnapshots.tsx';
import { api, ApiError } from '/src/lib/api.ts';
import '/src/styles/index.css';

const from = Date.parse('2026-10-09T00:00:00.000Z');
const to = Date.parse('2026-10-10T00:00:00.000Z');
const evidenceWindow = { from, to, source: 'historical' };
let scenario = 'normal';
let requestCount = 0;
let visibilitySnapshots = [];
const providers = ['chatgpt', 'perplexity', 'claude', 'copilot'];
function rowsFor(kind) {
  if (kind === 'empty') return [];
  const rows = [];
  const add = (name, session, offset, provider, traffic = 'production', index = 0) => rows.push(normalizeEvidence({
    ts: from + offset,
    session_id: session,
    event_type: name === 'pv' ? 'pageview' : 'event',
    event_name: name === 'pv' ? '' : 'concrete_workflow_' + name,
    event_count: 1,
    pathname: kind === 'noncalculator' ? '/tools/image-tool' : '/concrete-bag-calculator',
    utm_source: name === 'pv' ? provider : null,
    utm_medium: name === 'pv' ? 'referral' : null,
    utm_campaign: name === 'pv' ? 'synthetic-' + index : null,
    device_type: index % 2 ? 'mobile' : 'desktop',
    browser: 'Chrome',
    event_meta: kind === 'unknown' ? '{}' : JSON.stringify({
      traffic_type: traffic,
      tracking_version: 'cw-v3',
      release_version: 'fixture-local',
      page_id: 'p_123456789abc',
      calculator_type: kind === 'noncalculator' ? 'unknown' : 'bag',
    }),
  }));
  const total = kind === 'large' ? 84 : 8;
  for (let index = 0; index < total; index++) {
    const provider = providers[index % providers.length];
    const session = 'synthetic-' + index;
    add('pv', session, index * 10 + 1, provider, 'production', index);
    add('calculator_submit_success', session, index * 10 + 2, provider, 'production', index);
    if (index % 2 === 0) add('calculator_copy_success', session, index * 10 + 3, provider, 'production', index);
  }
  // Ordinary Google/Bing/Apple are explicitly not AI providers.
  for (const [index, ordinary] of ['google', 'bing', 'apple', 'direct'].entries())
    add('pv', 'ordinary-' + index, total * 10 + index + 1, ordinary, 'production', index);
  // Late QA must exclude the entire first AI-labelled session.
  add('pv', 'late-qa', total * 10 + 10, 'chatgpt', 'production');
  add('page_engagement', 'late-qa', total * 10 + 11, '', 'qa');
  add('pv', 'internal', total * 10 + 12, 'perplexity', 'internal');
  // A mixed deployment can read all rows while still lacking source capability.
  if (kind === 'partial')
    for (const row of rows)
      if (row.sessionId === 'synthetic-0') delete row.aiSource;
  return rows;
}
const abortableDelay = (milliseconds, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, milliseconds);
  signal?.addEventListener('abort', () => {
    clearTimeout(timer);
    reject(new Error('Synthetic scan cancelled'));
  }, { once: true });
});
api.getQualityEvidence = async (_siteId, _period, _filters, cursor, signal) => {
  requestCount++;
  if (scenario === 'error') throw new Error('Synthetic evidence read failed');
  const rows = rowsFor(scenario);
  const start = Number(cursor || 0);
  const pageSize = 7;
  if (scenario === 'loading') await abortableDelay(20000, signal);
  else await abortableDelay(100, signal);
  const stop = Math.min(rows.length, start + pageSize);
  return {
    ...evidenceWindow,
    data: rows.slice(start, stop),
    nextCursor: stop < rows.length ? String(stop) : null,
    totalGroups: rows.length,
    totalEvents: rows.length,
    scannedGroups: stop,
  };
};
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
api.getAiVisibilitySnapshots = async (_siteId, signal) => {
  if (scenario === 'error') throw new ApiError(503, 'Synthetic snapshot read failure');
  if (scenario === 'old') throw new ApiError(404, 'Synthetic old API capability');
  if (scenario === 'loading') await abortableDelay(20000, signal);
  else await abortableDelay(100, signal);
  return { data: {
    format: 'ai-visibility-report/v2', connectionMode: 'manual_snapshot',
    continuousConnection: 'not_connected', canManage: scenario !== 'unknown',
    status: visibilitySnapshots.length ? 'snapshots_available' : 'not_connected',
    readAt: new Date().toISOString(), snapshots: visibilitySnapshots,
    coverage: { pageComplete: true, historyComplete: true,
      snapshotCount: visibilitySnapshots.length, pageSize: 16,
      hasMore: false, nextCursor: null,
      consistency: 'eventually_consistent', visibilityDelaySeconds: 60 },
  }};
};
api.importAiVisibilitySnapshot = async (_siteId, input) => {
  await abortableDelay(100);
  const snapshot = { ...input, snapshotId: 'a'.repeat(64),
    siteId: 'synthetic-site', origin: 'https://example.invalid' };
  visibilitySnapshots = [snapshot];
  return { data: { status: 'stored_pending_readback', snapshot,
    acceptedAt: new Date().toISOString(), alreadyObserved: false } };
};
api.getAiVisibilitySnapshot = async (_siteId, id, signal) => {
  await abortableDelay(100, signal);
  const snapshot = visibilitySnapshots.find(item => item.snapshotId === id);
  if (!snapshot) throw new ApiError(404, 'Synthetic exact snapshot not yet visible');
  return { data: { format: 'ai-visibility-snapshot-read/v1',
    connectionMode: 'manual_snapshot', continuousConnection: 'not_connected',
    readAt: new Date().toISOString(), snapshot } };
};
function Fixture() {
  const [current, setCurrent] = useState('normal');
  const [run, setRun] = useState(0);
  const oldAccumulator = new QualityAccumulator();
  oldAccumulator.add(rowsFor('normal'));
  const oldReport = oldAccumulator.report();
  delete oldReport.aiSources;
  return <QueryClientProvider client={client}>
    <main className="mx-auto max-w-6xl p-4 text-[#3D3B4F] sm:p-6">
      <h1 className="text-xl font-semibold">本地合成 QA · AI 来源分组</h1>
      <p className="mt-2 text-sm">所有数值和来源均为隔离合成数据，不是真实流量、引用或生产验收；未连接任何外部数据源。</p>
      <label className="mt-4 block text-sm">合成场景
        <select aria-label="合成场景" value={current} className="ml-2 min-h-11 rounded-xl border p-2"
          onChange={event => {
            scenario = event.target.value;
            visibilitySnapshots = [];
            client.removeQueries({ queryKey: ['site-ai-visibility'] });
            setCurrent(scenario);
            setRun(value => value + 1);
          }}>
          <option value="normal">完整多页 · 四类来源与晚到 QA</option>
          <option value="large">84 个渠道分组 · UI 预览与完整导出</option>
          <option value="loading">读取中 / 取消</option>
          <option value="error">读取失败 / 重试</option>
          <option value="empty">完整空窗口</option>
          <option value="partial">混合版本 · 部分来源能力缺失</option>
          <option value="unknown">历史未知流量（切换 Historical / unknown）</option>
          <option value="noncalculator">非计算器任务 · 目标不可推断</option>
          <option value="old">旧报告 · 无 AI 字段</option>
        </select>
      </label>
      <div className="my-4">
        <AiVisibilitySnapshots key={'visibility:' + current + ':' + run}
          siteId="synthetic-site" isOwner={current !== 'unknown'} />
      </div>
      {current === 'old'
        ? <QualityWorkflow report={oldReport} traffic="production" evidenceWindow={evidenceWindow}
            onExport={() => {}} />
        : <QualityConsole key={current + ':' + run} siteId="synthetic-site" period="yesterday" />}
      <button className="mt-4 min-h-11 rounded-xl border px-4" onClick={() => setRun(value => value + 1)}>
        重置本地场景
      </button>
    </main>
  </QueryClientProvider>;
}
window.fixtureEvidence = { source: 'synthetic-only', requestCount: () => requestCount };
createRoot(document.getElementById('root')).render(<Fixture />);
`;

const server = await createServer({
  root: 'apps/platform/web',
  configFile: false,
  resolve: { alias: { '@': path.resolve('apps/platform/web/src') } },
  server: { host: '127.0.0.1', port: 5198, strictPort: true },
  plugins: [
    react(),
    {
      name: 'synthetic-ai-source-ui-fixture',
      resolveId(id) {
        if (id === fixtureModule) return '\0' + fixtureModule;
      },
      load(id) {
        if (id === '\0' + fixtureModule) return { code: fixtureCode, map: null };
      },
      configureServer(vite) {
        vite.middlewares.use((request, response, next) => {
          const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
          if (pathname.startsWith('/api/')) {
            response.writeHead(503, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ error: 'External API disabled in synthetic fixture' }));
            return;
          }
          if (pathname !== '/') return next();
          void vite
            .transformIndexHtml(
              '/',
              '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic-only AI source QA</title></head><body><div id="root"></div><script type="module" src="/@id/virtual:quality-ai-ui-fixture"></script></body></html>'
            )
            .then(html => {
              response.writeHead(200, {
                'content-type': 'text/html; charset=utf-8',
                'cache-control': 'no-store',
              });
              response.end(html);
            })
            .catch(() => {
              response.writeHead(500);
              response.end('Synthetic fixture failed');
            });
        });
      },
      transform(code, id) {
        if (id === '\0' + fixtureModule)
          return import('esbuild').then(({ transform }) =>
            transform(code, { loader: 'tsx', jsx: 'automatic', sourcemap: false })
          );
      },
    },
  ],
});
await server.listen();
console.log('Synthetic-only AI source UI: http://127.0.0.1:5198/');
const close = async () => {
  await server.close();
  process.exit(0);
};
process.once('SIGINT', close);
process.once('SIGTERM', close);
