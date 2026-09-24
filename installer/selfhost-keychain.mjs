#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVICE = 'com.traks.release';

function keychainSecret(name) {
  if (process.platform !== 'darwin') {
    console.error('Keychain self-host deployment is available only on macOS.');
    process.exit(1);
  }
  try {
    return execFileSync('security', ['find-generic-password', '-s', SERVICE, '-a', name, '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    console.error(`${name}: not readable from the macOS Keychain (${SERVICE})`);
    process.exit(1);
  }
}

function optionalKeychainSecret(name) {
  try {
    return execFileSync('security', ['find-generic-password', '-s', SERVICE, '-a', name, '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

function refreshedWranglerEnvironment() {
  const environment = { ...process.env };
  for (const key of [
    'ALL_PROXY',
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'all_proxy',
    'https_proxy',
    'http_proxy',
  ]) {
    if (/^socks\d?h?:/i.test(environment[key] ?? '')) delete environment[key];
  }
  return environment;
}

const apiToken = optionalKeychainSecret('CLOUDFLARE_API_TOKEN');
if (!apiToken) {
  const refresh = spawnSync('npx', ['wrangler', 'whoami'], {
    cwd: ROOT,
    env: refreshedWranglerEnvironment(),
    stdio: 'ignore',
  });
  if (refresh.status !== 0) {
    console.error(
      'No Cloudflare API token in the macOS Keychain and Wrangler OAuth could not be refreshed. Add CLOUDFLARE_API_TOKEN to com.traks.release or run `npx wrangler login` and retry.'
    );
    process.exit(1);
  }
}

const releaseBuild = spawnSync('yarn', ['traks:build'], {
  cwd: ROOT,
  env: {
    ...refreshedWranglerEnvironment(),
    ...(apiToken ? { CLOUDFLARE_API_TOKEN: apiToken } : {}),
  },
  stdio: 'inherit',
});
if (releaseBuild.status !== 0) {
  console.error('Release build failed; the existing self-hosted instance was not deployed.');
  process.exit(releaseBuild.status ?? 1);
}

const deploy = spawnSync(process.execPath, ['installer/local-provision.mjs'], {
  cwd: ROOT,
  env: {
    ...process.env,
    CLOUDFLARE_ACCOUNT_ID: keychainSecret('CLOUDFLARE_ACCOUNT_ID'),
    TRAKS_CATALOG_TOKEN: keychainSecret('CATALOG_TOKEN'),
    ...(apiToken ? { CLOUDFLARE_API_TOKEN: apiToken } : {}),
  },
  stdio: 'inherit',
});
process.exit(deploy.status ?? 1);
