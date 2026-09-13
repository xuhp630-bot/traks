#!/usr/bin/env node
/**
 * Fully local Traks provisioner.
 *
 * Reads release artifacts from installer/dist and talks only to Cloudflare
 * APIs. Unlike the public wizard, this path never contacts traks.dev.
 *
 * Required environment:
 *   CLOUDFLARE_ACCOUNT_ID
 *   CLOUDFLARE_API_TOKEN or CLOUDFLARE_OAUTH_TOKEN
 *   TRAKS_CATALOG_TOKEN (R2 write, R2 Catalog write, R2 Catalog SQL read)
 *
 * The management token may fall back to the local Wrangler OAuth session.
 * TRAKS_VALIDATE_ONLY=1 checks local artifacts without touching Cloudflare.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'https://api.cloudflare.com/client/v4';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'installer/dist');
const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const CATALOG_TOKEN = process.env.TRAKS_CATALOG_TOKEN;
const INSTANCE = process.env.TRAKS_INSTANCE || 'traks-selfhost';
const UPDATE_ONLY = process.env.TRAKS_UPDATE_ONLY === '1';
const VERSION = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

const us = INSTANCE.replaceAll('-', '_');
const N = {
  apiWorker: `${INSTANCE}-api`,
  collectWorker: `${INSTANCE}-collect`,
  d1: `${INSTANCE}-db`,
  kvTitle: `${INSTANCE}-r2sql-cache`,
  bucket: `${INSTANCE}-events`,
  stream: `${us}_events_stream`,
  sink: `${us}_events_sink`,
  pipeline: `${us}_events`,
  aeDataset: `${us}_collect_metrics`,
  apiAeDataset: `${us}_api_metrics`,
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const randomHex = bytes => randomBytes(bytes).toString('hex');

function getWranglerOAuthToken() {
  const candidates = [
    process.env.WRANGLER_HOME,
    path.join(process.env.HOME || '', 'Library', 'Preferences', '.wrangler'),
    path.join(process.env.HOME || '', '.wrangler'),
  ].filter(Boolean);
  const wranglerHome = candidates.find(candidate =>
    existsSync(path.join(candidate, 'config', 'default.toml'))
  );
  if (!wranglerHome) return undefined;
  const file = readFileSync(path.join(wranglerHome, 'config', 'default.toml'), 'utf8');
  const token = file.match(/^oauth_token\s*=\s*"([^"]+)"/m)?.[1];
  if (!token) return undefined;
  const expiration = file.match(/^expiration_time\s*=\s*"([^"]+)"/m)?.[1];
  if (expiration && Date.parse(expiration) <= Date.now() + 60_000) {
    throw new Error(`Wrangler OAuth token expired at ${expiration}; run wrangler login`);
  }
  return token;
}

const API_TOKEN =
  process.env.CLOUDFLARE_API_TOKEN || process.env.CLOUDFLARE_OAUTH_TOKEN || getWranglerOAuthToken();

if (!ACCOUNT_ID || !API_TOKEN || (!UPDATE_ONLY && !CATALOG_TOKEN)) {
  console.error(
    'Missing CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN/CLOUDFLARE_OAUTH_TOKEN, or TRAKS_CATALOG_TOKEN. TRAKS_CATALOG_TOKEN is only optional with TRAKS_UPDATE_ONLY=1.'
  );
  process.exit(1);
}
if (!/^[a-z][a-z0-9-]{2,20}$/.test(INSTANCE)) {
  console.error('TRAKS_INSTANCE must match ^[a-z][a-z0-9-]{2,20}$');
  process.exit(1);
}

async function cf(method, pathname, body, { jwt, form, tolerate = [] } = {}) {
  const headers = { Authorization: `Bearer ${jwt || API_TOKEN}` };
  let payload;
  if (form) payload = form;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let response;
  let data;
  for (let attempt = 1; ; attempt++) {
    try {
      response = await fetch(`${API}${pathname}`, { method, headers, body: payload });
      data = await response.json().catch(() => null);
    } catch (error) {
      if (attempt >= 4) throw error;
      await sleep(attempt * 1000);
      continue;
    }
    if (response.ok && data?.success !== false) return data?.result ?? data;
    const transient = response.status === 429 || response.status >= 500;
    if (transient && attempt < 4) {
      await sleep(attempt * 1000);
      continue;
    }
    break;
  }
  const errors = data?.errors || [{ code: response.status, message: response.statusText }];
  if (errors.some(error => tolerate.includes(error.code))) return { tolerated: errors[0].code };
  throw new Error(
    `${method} ${pathname}: ${errors.map(error => `[${error.code}] ${error.message}`).join('; ')}`
  );
}

function step(name, fn) {
  return async (...args) => {
    process.stdout.write(`==> ${name}\n`);
    const result = await fn(...args);
    process.stdout.write('    ok\n');
    return result;
  };
}

async function subdomain() {
  const result = await cf('GET', `/accounts/${ACCOUNT_ID}/workers/subdomain`);
  if (!result?.subdomain) throw new Error('Account has no workers.dev subdomain');
  return result.subdomain;
}

async function ensureD1() {
  const list = await cf('GET', `/accounts/${ACCOUNT_ID}/d1/database?name=${N.d1}&per_page=100`);
  const existing = (Array.isArray(list) ? list : []).find(item => item.name === N.d1);
  if (existing) return existing.uuid;
  if (UPDATE_ONLY) throw new Error(`Update-only requires existing D1: ${N.d1}`);
  const created = await cf('POST', `/accounts/${ACCOUNT_ID}/d1/database`, { name: N.d1 });
  return created.uuid;
}

async function applyMigrations(d1Id) {
  const query = async sql => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await cf('POST', `/accounts/${ACCOUNT_ID}/d1/database/${d1Id}/query`, { sql });
      } catch (error) {
        const transient = error.message.includes('[429]') || error.message.includes('[500]');
        if (!transient || attempt >= 4) throw error;
        await sleep(5000);
      }
    }
  };

  if (!UPDATE_ONLY)
    await query(
      'CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT current_timestamp);'
    );
  const applied = await query('SELECT name FROM d1_migrations;');
  const names = new Set((applied?.[0]?.results || []).map(row => row.name));
  const files = readdirSync(path.join(DIST, 'migrations'))
    .filter(file => file.endsWith('.sql'))
    .sort();
  if (UPDATE_ONLY) {
    const pending = files.filter(file => !names.has(file));
    if (pending.length)
      throw new Error(`Update-only cannot apply migrations: ${pending.join(', ')}`);
    return;
  }
  for (const file of files) {
    if (names.has(file)) continue;
    const sql = readFileSync(path.join(DIST, 'migrations', file), 'utf8');
    const statements = sql
      .split('--> statement-breakpoint')
      .map(statement => statement.trim())
      .filter(Boolean)
      .map(statement => (statement.endsWith(';') ? statement : `${statement};`));
    statements.push(`INSERT INTO d1_migrations (name) VALUES ('${file.replaceAll("'", "''")}');`);
    await query(statements.join('\n'));
  }
}

async function ensureKv() {
  for (let page = 1; ; page++) {
    const list = await cf(
      'GET',
      `/accounts/${ACCOUNT_ID}/storage/kv/namespaces?per_page=100&page=${page}`
    );
    const existing = (list || []).find(item => item.title === N.kvTitle);
    if (existing) return existing.id;
    if (!list || list.length < 100) break;
  }
  if (UPDATE_ONLY) throw new Error(`Update-only requires existing KV: ${N.kvTitle}`);
  const created = await cf('POST', `/accounts/${ACCOUNT_ID}/storage/kv/namespaces`, {
    title: N.kvTitle,
  });
  return created.id;
}

async function ensureBucketAndCatalog() {
  await cf('POST', `/accounts/${ACCOUNT_ID}/r2/buckets`, { name: N.bucket }, { tolerate: [10004] });
  await cf('POST', `/accounts/${ACCOUNT_ID}/r2-catalog/${N.bucket}/enable`, undefined, {
    tolerate: [40010, 10021],
  });
  await cf(
    'POST',
    `/accounts/${ACCOUNT_ID}/r2-catalog/${N.bucket}/credential`,
    { token: CATALOG_TOKEN },
    { tolerate: [10001, 10021, 40010, 7000, 7003] }
  ).catch(() => undefined);
  await cf('POST', `/accounts/${ACCOUNT_ID}/r2-catalog/${N.bucket}/maintenance-configs`, {
    compaction: { state: 'enabled', targetSizeMb: 128 },
  }).catch(() => undefined);
  await cf('POST', `/accounts/${ACCOUNT_ID}/r2-catalog/${N.bucket}/maintenance-configs`, {
    snapshot_expiration: {
      state: 'enabled',
      max_snapshot_age: '30d',
      min_snapshots_to_keep: 5,
    },
  }).catch(() => undefined);
}

async function dropCatalogTable() {
  const base = `https://catalog.cloudflarestorage.com/${ACCOUNT_ID}/${N.bucket}`;
  const headers = { Authorization: `Bearer ${CATALOG_TOKEN}` };
  let prefix = '';
  const config = await fetch(`${base}/v1/config?warehouse=${ACCOUNT_ID}_${N.bucket}`, { headers })
    .then(response => (response.ok ? response.json() : null))
    .catch(() => null);
  if (config?.overrides?.prefix) prefix = `${encodeURIComponent(config.overrides.prefix)}/`;
  const encoded = `${prefix}namespaces/traks/tables/events`;
  const response = await fetch(`${base}/v1/${encoded}`, { method: 'DELETE', headers });
  if (!response.ok && response.status !== 404) {
    throw new Error(`catalog table drop failed (${response.status}): ${await response.text()}`);
  }
}

async function ensurePipeline() {
  const base = `/accounts/${ACCOUNT_ID}/pipelines/v1`;
  const schema = JSON.parse(readFileSync(path.join(ROOT, 'scripts/pipeline-schema.json'), 'utf8'));

  const streams = await cf('GET', `${base}/streams?per_page=100`);
  const existingStream = (streams || []).find(item => item.name === N.stream);
  const stream =
    existingStream ||
    (await cf('POST', `${base}/streams`, {
      name: N.stream,
      format: { type: 'json' },
      schema,
      http: { enabled: false, authentication: false, cors: {} },
    }));

  const sinks = await cf('GET', `${base}/sinks?per_page=100`);
  const existingSink = (sinks || []).find(item => item.name === N.sink);
  if (existingSink?.config?.namespace === 'traks' && existingSink.config.table_name === 'events') {
    return stream.id;
  }
  if (existingSink) {
    const pipelines = await cf('GET', `${base}/pipelines?per_page=100`);
    const pipeline = (pipelines || []).find(item => item.name === N.pipeline);
    if (pipeline) await cf('DELETE', `${base}/pipelines/${pipeline.id}`);
    await cf('DELETE', `${base}/sinks/${existingSink.id}`);
  }

  const createSink = () =>
    cf('POST', `${base}/sinks`, {
      name: N.sink,
      type: 'r2_data_catalog',
      format: { type: 'parquet' },
      config: {
        account_id: ACCOUNT_ID,
        bucket: N.bucket,
        namespace: 'traks',
        table_name: 'events',
        token: CATALOG_TOKEN,
        rolling_policy: { interval_seconds: 60, file_size_bytes: 100 * 1024 * 1024 },
      },
    });

  for (let attempt = 1; ; attempt++) {
    try {
      await createSink();
      break;
    } catch (error) {
      const staleTable =
        error.message.includes('[1012]') && /existing catalog table/i.test(error.message);
      const notReady = error.message.includes('[1012]') && !staleTable;
      if (staleTable) {
        await dropCatalogTable();
        await createSink();
        break;
      }
      if (notReady && attempt < 6) {
        await sleep(60000);
        continue;
      }
      throw error;
    }
  }

  const pipelines = await cf('GET', `${base}/pipelines?per_page=100`);
  if (!(pipelines || []).some(item => item.name === N.pipeline)) {
    await cf('POST', `${base}/pipelines`, {
      name: N.pipeline,
      sql: `INSERT INTO ${N.sink} SELECT * FROM ${N.stream}`,
    });
  }
  return stream.id;
}

async function findPipelineStream() {
  const streams = await cf('GET', `/accounts/${ACCOUNT_ID}/pipelines/v1/streams?per_page=100`);
  const stream = (streams || []).find(item => item.name === N.stream);
  if (!stream) throw new Error(`update-only deploy could not find Pipeline stream ${N.stream}`);
  return stream.id;
}

async function workerExists(name) {
  try {
    await cf('GET', `/accounts/${ACCOUNT_ID}/workers/services/${name}`);
    return true;
  } catch {
    return false;
  }
}

async function uploadWorker(name, metadata) {
  const form = new FormData();
  form.append(
    'metadata',
    new Blob([JSON.stringify({ ...metadata, keep_bindings: ['secret_text', 'secret_key'] })], {
      type: 'application/json',
    }),
    'metadata.json'
  );
  const workerPath = path.join(
    DIST,
    name === N.collectWorker ? 'collect/worker.js' : 'api/worker.js'
  );
  form.append(
    'worker.js',
    new Blob([readFileSync(workerPath)], { type: 'application/javascript+module' }),
    'worker.js'
  );
  await cf('PUT', `/accounts/${ACCOUNT_ID}/workers/scripts/${name}`, undefined, { form });
  await cf('POST', `/accounts/${ACCOUNT_ID}/workers/scripts/${name}/subdomain`, {
    enabled: true,
    previews_enabled: false,
  });
}

const MIME = {
  html: 'text/html',
  js: 'text/javascript',
  css: 'text/css',
  svg: 'image/svg+xml',
  png: 'image/png',
  ico: 'image/x-icon',
  json: 'application/json',
  txt: 'text/plain',
  webmanifest: 'application/manifest+json',
};

function collectAssets() {
  const walk = (dir, prefix = '') => {
    const assets = [];
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      const route = prefix ? `${prefix}/${entry}` : `/${entry}`;
      if (statSync(full).isDirectory()) assets.push(...walk(full, route));
      else {
        const bytes = readFileSync(full);
        const extension = entry.includes('.') ? entry.split('.').pop() : '';
        assets.push({ route, bytes, extension, contentType: MIME[extension] || null });
      }
    }
    return assets;
  };
  return walk(path.join(DIST, 'web'));
}

async function hashAsset(asset) {
  const createRequire = (await import('node:module')).createRequire;
  const require = createRequire(path.join(ROOT, 'apps/platform/api/package.json'));
  const wranglerPath = require.resolve('wrangler/package.json');
  const blake3 = createRequire(wranglerPath)('blake3-wasm');
  return blake3
    .hash(asset.bytes.toString('base64') + asset.extension)
    .toString('hex')
    .slice(0, 32);
}

async function prepareAssets() {
  const assets = collectAssets();
  if (!assets.length) throw new Error('dashboard release has no web assets');
  for (const asset of assets) {
    asset.hash = await hashAsset(asset);
  }
  return assets;
}

function validateArtifacts() {
  const required = [
    path.join(DIST, 'api', 'worker.js'),
    path.join(DIST, 'collect', 'worker.js'),
    path.join(ROOT, 'scripts', 'pipeline-schema.json'),
  ];
  for (const file of required) {
    if (!existsSync(file)) {
      throw new Error(`missing release artifact ${file}; run \`yarn traks:build\` first`);
    }
  }
  JSON.parse(readFileSync(path.join(ROOT, 'scripts', 'pipeline-schema.json'), 'utf8'));
}

async function uploadAssets(assets) {
  const manifest = {};
  for (const asset of assets) {
    manifest[asset.route] = { hash: asset.hash, size: asset.bytes.length };
  }
  const byHash = new Map(assets.map(asset => [asset.hash, asset]));
  const session = await cf(
    'POST',
    `/accounts/${ACCOUNT_ID}/workers/scripts/${N.apiWorker}/assets-upload-session`,
    { manifest }
  );
  if (!session?.jwt) throw new Error('assets upload session returned no JWT');
  let completionJwt = session.buckets?.length ? '' : session.jwt;
  for (const hashes of session.buckets || []) {
    const form = new FormData();
    for (const hash of hashes) {
      const asset = byHash.get(hash);
      if (!asset) throw new Error(`unknown asset hash ${hash}`);
      form.append(
        hash,
        new Blob([asset.bytes.toString('base64')], {
          type: asset.contentType || 'application/null',
        }),
        hash
      );
    }
    const result = await cf(
      'POST',
      `/accounts/${ACCOUNT_ID}/workers/assets/upload?base64=true`,
      undefined,
      { jwt: session.jwt, form }
    );
    if (result?.jwt) completionJwt = result.jwt;
  }
  if (!completionJwt) throw new Error('asset upload did not return a completion JWT');
  return completionJwt;
}

async function existingSecrets(worker) {
  try {
    const list = await cf('GET', `/accounts/${ACCOUNT_ID}/workers/scripts/${worker}/secrets`);
    return new Set((list || []).map(item => item.name));
  } catch {
    return new Set();
  }
}

async function putSecret(worker, name, text) {
  await cf('PUT', `/accounts/${ACCOUNT_ID}/workers/scripts/${worker}/secrets`, {
    name,
    text,
    type: 'secret_text',
  });
}

async function smoke(apiUrl, collectUrl) {
  const probe = async (url, pathname, expected) => {
    for (let attempt = 1; attempt <= 9; attempt++) {
      try {
        const response = await fetch(`${url}${pathname}`);
        const body = await response.text();
        if (response.ok && body.includes(expected)) return;
        process.stdout.write(`    retry ${attempt}: ${pathname} HTTP ${response.status}\n`);
      } catch (error) {
        process.stdout.write(`    retry ${attempt}: ${pathname} ${error.message}\n`);
      }
      await sleep(10000);
    }
    throw new Error(`${url}${pathname} did not become healthy`);
  };
  await probe(apiUrl, '/api/health', '"ok"');
  await probe(apiUrl, '/api/config', collectUrl);
  await probe(collectUrl, '/t.js', 'traks');
}

async function claimToken(apiUrl) {
  if (UPDATE_ONLY) return undefined;
  try {
    const response = await fetch(`${apiUrl}/api/claim-status`);
    const data = await response.json();
    if (!response.ok || data?.claimed !== false) return undefined;
  } catch {
    return undefined;
  }
  const code = randomHex(12);
  await putSecret(N.apiWorker, 'CLAIM_TOKEN', code);
  return code;
}

async function ownerEmail() {
  try {
    const result = await cf('GET', '/user');
    const email = result?.email;
    return typeof email === 'string' && email.includes('@') ? email : undefined;
  } catch {
    return undefined;
  }
}

async function main() {
  validateArtifacts();
  const assets = await prepareAssets();
  if (process.env.TRAKS_VALIDATE_ONLY === '1') {
    console.log(`Local Traks ${VERSION} release artifacts validated (${assets.length} assets).`);
    return;
  }
  await step('Validate local release artifacts', async () => {
    if (!assets.length) throw new Error('dashboard release has no web assets');
  })();
  const workers = await step('Check workers.dev subdomain', subdomain)();
  const apiUrl = `https://${N.apiWorker}.${workers}.workers.dev`;
  const collectUrl = `https://${N.collectWorker}.${workers}.workers.dev`;

  const d1Id = await step('Ensure D1', ensureD1)();
  await step(UPDATE_ONLY ? 'Verify existing migrations (read-only)' : 'Apply migrations', () =>
    applyMigrations(d1Id)
  )();
  const kvId = await step('Ensure KV cache', ensureKv)();
  let streamId;
  if (UPDATE_ONLY) {
    streamId = await step('Reuse Pipelines', findPipelineStream)();
  } else {
    await step('Ensure R2 bucket and catalog', ensureBucketAndCatalog)();
    streamId = await step('Ensure Pipelines', ensurePipeline)();
  }
  const collectExisted = await workerExists(N.collectWorker);
  if (UPDATE_ONLY && (!collectExisted || !(await workerExists(N.apiWorker))))
    throw new Error('Update-only requires both existing Workers');
  const apiSecrets = await existingSecrets(N.apiWorker);
  const collectSecrets = await existingSecrets(N.collectWorker);
  if (UPDATE_ONLY) {
    const missing = [
      !apiSecrets.has('BETTER_AUTH_SECRET') && `${N.apiWorker}:BETTER_AUTH_SECRET`,
      !apiSecrets.has('R2_SQL_TOKEN') && `${N.apiWorker}:R2_SQL_TOKEN`,
      !collectSecrets.has('VISITOR_HASH_SECRET') && `${N.collectWorker}:VISITOR_HASH_SECRET`,
    ].filter(Boolean);
    if (missing.length)
      throw new Error(`Update-only requires existing secrets: ${missing.join(', ')}`);
  }

  await step('Deploy collect Worker', () =>
    uploadWorker(N.collectWorker, {
      main_module: 'worker.js',
      compatibility_date: '2026-06-01',
      compatibility_flags: ['nodejs_compat'],
      bindings: [
        { type: 'd1', name: 'DB', id: d1Id },
        { type: 'analytics_engine', name: 'METRICS', dataset: N.aeDataset },
        {
          type: 'ratelimit',
          name: 'RATE_LIMIT',
          namespace_id: '1001',
          simple: { limit: 6000, period: 60 },
        },
        { type: 'durable_object_namespace', name: 'LIVE', class_name: 'SiteLiveStore' },
        { type: 'pipelines', name: 'EVENTS', stream: streamId },
        { type: 'plain_text', name: 'ENVIRONMENT', text: 'production' },
      ],
      ...(collectExisted
        ? {}
        : { migrations: { new_tag: 'v1', new_sqlite_classes: ['SiteLiveStore'] } }),
    })
  )();

  const owner = await ownerEmail();
  const assetsJwt = await step('Upload dashboard assets', () => uploadAssets(assets))();
  await step('Deploy dashboard Worker', () =>
    uploadWorker(N.apiWorker, {
      main_module: 'worker.js',
      compatibility_date: '2026-06-01',
      compatibility_flags: ['nodejs_compat', 'global_fetch_strictly_public'],
      placement: { mode: 'smart' },
      bindings: [
        { type: 'd1', name: 'DB', id: d1Id },
        { type: 'kv_namespace', name: 'R2SQL_CACHE', namespace_id: kvId },
        { type: 'analytics_engine', name: 'METRICS', dataset: N.apiAeDataset },
        {
          type: 'ratelimit',
          name: 'AUTH_LIMIT',
          namespace_id: '1004',
          simple: { limit: 20, period: 60 },
        },
        {
          type: 'durable_object_namespace',
          name: 'LIVE',
          class_name: 'SiteLiveStore',
          script_name: N.collectWorker,
        },
        { type: 'assets', name: 'ASSETS' },
        { type: 'plain_text', name: 'ENVIRONMENT', text: 'production' },
        { type: 'plain_text', name: 'R2_BUCKET_NAME', text: N.bucket },
        { type: 'plain_text', name: 'R2_ACCOUNT_ID', text: ACCOUNT_ID },
        { type: 'plain_text', name: 'COLLECT_URL', text: collectUrl },
        ...(owner ? [{ type: 'plain_text', name: 'OWNER_EMAIL', text: owner }] : []),
        { type: 'plain_text', name: 'TRAKS_INSTANCE', text: INSTANCE },
        { type: 'plain_text', name: 'TRAKS_VERSION', text: VERSION },
      ],
      assets: {
        jwt: assetsJwt,
        config: {
          not_found_handling: 'single-page-application',
          run_worker_first: ['/api/*'],
        },
      },
    })
  )();
  await step('Set minute prewarm cron', () =>
    cf('PUT', `/accounts/${ACCOUNT_ID}/workers/scripts/${N.apiWorker}/schedules`, [
      { cron: '* * * * *' },
    ])
  )();

  await step('Set secrets', async () => {
    if (UPDATE_ONLY) {
      return;
    }
    if (!apiSecrets.has('BETTER_AUTH_SECRET')) {
      await putSecret(N.apiWorker, 'BETTER_AUTH_SECRET', randomHex(32));
    }
    if (!apiSecrets.has('R2_SQL_TOKEN')) {
      await putSecret(N.apiWorker, 'R2_SQL_TOKEN', CATALOG_TOKEN);
    }
    if (!collectSecrets.has('VISITOR_HASH_SECRET')) {
      await putSecret(N.collectWorker, 'VISITOR_HASH_SECRET', randomHex(32));
    }
  })();

  await step('Smoke test', () => smoke(apiUrl, collectUrl))();
  const claimCode = await step('Secure first sign-up', () => claimToken(apiUrl))();

  console.log('\nTraks self-host deployed');
  console.log(`account: ${ACCOUNT_ID}`);
  console.log(`instance: ${INSTANCE}`);
  console.log(`version: ${VERSION}`);
  console.log(`dashboard: ${apiUrl}/login?claim=${claimCode || 'CLAIM_TOKEN_ALREADY_SET'}`);
  console.log(`collect: ${collectUrl}`);
}

await main();
