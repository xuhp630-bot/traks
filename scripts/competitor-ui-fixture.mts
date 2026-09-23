import { createServer } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  CompetitorCheck,
  CompetitorMonitor,
  CompetitorReport,
  CompetitorSnapshot,
} from '../packages/shared/src/competitors';

const now = Date.now();
const before: CompetitorSnapshot = {
  title: 'Fixture pricing',
  h1: 'Plans',
  description: 'Synthetic public plans',
  canonical: 'https://fixture.example.com/pricing',
  robots: 'index, follow',
  regionText: 'Starter $20 monthly',
  contentHash: 'synthetic-before',
  contentCharacters: 19,
};
const current = {
  ...before,
  title: 'Fixture pricing · New plan',
  regionText: 'Starter $25 monthly',
  contentHash: 'synthetic-after',
};
const checks: CompetitorCheck[] = [
  {
    id: 'failed',
    checkedAt: now,
    status: 'error',
    errorCode: 'rate_limited',
    httpStatus: 429,
    snapshot: null,
    previous: null,
    previousCheckedAt: null,
    changes: [],
  },
  {
    id: 'changed',
    checkedAt: now - 86_400_000,
    status: 'changed',
    errorCode: null,
    httpStatus: 200,
    snapshot: current,
    previous: before,
    previousCheckedAt: now - 172_800_000,
    changes: ['title', 'regionText', 'contentHash'],
  },
  {
    id: 'baseline',
    checkedAt: now - 172_800_000,
    status: 'baseline',
    errorCode: null,
    httpStatus: 200,
    snapshot: before,
    previous: null,
    previousCheckedAt: null,
    changes: [],
  },
];
const seed: CompetitorMonitor = {
  id: 'fixture-monitor',
  name: '合成竞品 · 定价页',
  url: 'https://fixture.example.com/pricing',
  hostname: 'fixture.example.com',
  selector: 'main',
  cadence: 'manual',
  nextCheckAt: null,
  lastCheckedAt: now,
  retainedChecks: 3,
  latest: checks[0],
};
let monitors = [{ ...seed }];
let scenario = 'normal';
let nextId = 0;
const histories = new Map<string, CompetitorCheck[]>([[seed.id, checks]]);
const send = (response: ServerResponse, body: unknown, status = 200) => {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
};
async function readBody(request: IncomingMessage) {
  let text = '';
  for await (const chunk of request) text += String(chunk);
  return text ? JSON.parse(text) : {};
}
async function fixture(request: IncomingMessage, response: ServerResponse, next: () => void) {
  const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  if (path === '/__fixture/state') {
    const body = await readBody(request);
    scenario = body.scenario ?? 'normal';
    if (body.reset) {
      monitors = [{ ...seed }];
      histories.clear();
      histories.set(seed.id, checks);
    }
    return send(response, { fixtureOnly: true, scenario });
  }
  if (!path.startsWith('/api/')) return next();
  if (path === '/api/auth/get-session')
    return send(response, {
      session: {
        id: 'fixture-session',
        userId: 'fixture-user',
        expiresAt: new Date(now + 86_400_000).toISOString(),
      },
      user: {
        id: 'fixture-user',
        name: 'LOCAL QA FIXTURE',
        email: 'qa@fixture.test',
        emailVerified: true,
      },
    });
  if (path === '/api/config')
    return send(response, { collectUrl: 'http://127.0.0.1/disabled-fixture' });
  if (path === '/api/workspaces')
    return send(response, {
      data: [
        {
          id: 'fixture-workspace',
          name: '本地合成QA · 非生产',
          role: scenario === 'member' ? 'member' : 'owner',
          siteCount: 2,
        },
      ],
    });
  if (path === '/api/sites')
    return send(response, {
      data: [
        { id: 'fixture-site', name: '本地合成站点', domain: 'owned.fixture.test' },
        { id: 'empty-site', name: '另一隔离站点', domain: 'other.fixture.test' },
      ],
    });
  if (path.startsWith('/api/competitors/')) {
    const [, , , siteId, monitorId, action] = path.split('/');
    if (scenario === 'error') return send(response, { error: '合成读取失败，请重试' }, 503);
    if (scenario === 'loading') await new Promise(resolve => setTimeout(resolve, 1800));
    if (action === 'history')
      return scenario === 'history-error'
        ? send(response, { error: '合成历史读取失败' }, 503)
        : send(response, {
            data: {
              source: 'public_html_observation',
              retentionPerMonitor: 60,
              checks: histories.get(monitorId) ?? [],
            },
          });
    if (request.method === 'GET') {
      const visible = scenario === 'empty' || siteId === 'empty-site' ? [] : monitors;
      const trend = Array.from({ length: 30 }, (_, index) => {
        const date = new Date(now - (29 - index) * 86_400_000).toISOString().slice(0, 10);
        const records = visible
          .flatMap(item => histories.get(item.id) ?? [])
          .filter(check => new Date(check.checkedAt).toISOString().slice(0, 10) === date);
        return {
          date,
          checks: records.length,
          changes: records.some(check => check.status !== 'error')
            ? records.filter(check => check.status === 'changed').length
            : null,
          failures: records.length
            ? records.filter(check => check.status === 'error').length
            : null,
        };
      });
      const data: CompetitorReport = {
        source: 'public_html_observation',
        generatedAt: Date.now(),
        canManage: scenario !== 'member',
        schedulerEnabled: false,
        allowedHosts: ['fixture.example.com'],
        retentionPerMonitor: 60,
        monitors: visible,
        trend,
        limitations: ['Synthetic local fixture only'],
      };
      return send(response, { data });
    }
    if (scenario === 'member') return send(response, { error: 'Read only' }, 403);
    const body = await readBody(request);
    if (request.method === 'POST' && !monitorId) {
      const id = `added-${++nextId}`;
      monitors.push({
        ...seed,
        ...body,
        id,
        hostname: new URL(body.url).hostname,
        retainedChecks: 0,
        latest: null,
        lastCheckedAt: null,
      });
      return send(response, { data: { id } }, 201);
    }
    const target = monitors.find(item => item.id === monitorId);
    if (!target) return send(response, { error: 'Not found' }, 404);
    if (request.method === 'PATCH') {
      target.cadence = body.cadence;
      return send(response, { data: { id: target.id } });
    }
    if (request.method === 'DELETE') {
      monitors = monitors.filter(item => item.id !== monitorId);
      histories.delete(monitorId);
      return send(response, { data: { id: monitorId } });
    }
    if (action === 'check') {
      const check: CompetitorCheck = {
        ...checks[2],
        id: `checked-${++nextId}`,
        checkedAt: Date.now(),
      };
      histories.set(monitorId, [check, ...(histories.get(monitorId) ?? [])]);
      target.lastCheckedAt = check.checkedAt;
      target.latest = check;
      target.retainedChecks++;
      return send(response, { data: check });
    }
  }
  return send(response, { error: 'Unimplemented local fixture path' }, 404);
}

const server = await createServer({
  root: 'apps/platform/web',
  configFile: 'apps/platform/web/vite.config.ts',
  server: { host: '127.0.0.1', port: 5197, strictPort: true },
  plugins: [
    {
      name: 'isolated-competitor-ui-fixture',
      configureServer(vite) {
        vite.middlewares.use((request, response, next) => {
          void fixture(request, response, next).catch(() =>
            send(response, { error: 'Fixture failed' }, 500)
          );
        });
      },
    },
  ],
});
await server.listen();
console.log('Synthetic-only local UI: http://127.0.0.1:5197/portal/competitors');
const close = async () => {
  await server.close();
  process.exit(0);
};
process.once('SIGINT', close);
process.once('SIGTERM', close);
