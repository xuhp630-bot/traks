import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  getVersionStatus,
  readLatestVersionResponse,
} from '../apps/platform/web/src/lib/version-status';

const portal = readFileSync('apps/platform/web/src/routes/portal.tsx', 'utf8');
const banner = portal.slice(
  portal.indexOf('function UpdateBanner('),
  portal.indexOf('function VersionPill(')
);
const pill = portal.slice(
  portal.indexOf('function VersionPill('),
  portal.indexOf('function UserMenu(')
);
const manual = portal.slice(
  portal.indexOf('const checkForUpdates ='),
  portal.indexOf('const email:')
);

test('update banner uses the shared ordered decision, so an older release is not an upgrade', () => {
  assert.match(banner, /getVersionStatus\(config\?\.version, latest\)/);
  assert.match(banner, /!versionStatus\.updateAvailable/);
  assert.doesNotMatch(banner, /latest === config\.version/);
});

test('version pill uses the same decision and shows an honest non-update status', () => {
  assert.match(pill, /getVersionStatus\(config\?\.version, latest\)/);
  assert.match(pill, /if \(versionStatus\.updateAvailable\)/);
  assert.match(pill, /title=\{versionStatus\.message\}/);
  assert.doesNotMatch(pill, /latest !== config\.version/);
});

test('manual update check validates the response and uses the same ordered decision', () => {
  assert.match(manual, /await readLatestVersionResponse\(res\)/);
  assert.match(manual, /getVersionStatus\(config\?\.version, version\)/);
  assert.match(manual, /setCheckNote\(versionStatus\.message\)/);
  assert.match(manual, /setCheckNote\('Check failed'\)/);
  assert.doesNotMatch(manual, /version === config\?\.version/);
});

test('running 0.1.44 never offers the older published 0.1.43', () => {
  assert.deepEqual(getVersionStatus('0.1.44', '0.1.43'), {
    state: 'ahead',
    updateAvailable: false,
    message: 'Running newer than latest release',
  });
});

for (const [current, latest, state] of [
  ['0.1.43', '0.1.44', 'update-available'],
  ['0.1.44', '0.1.44', 'up-to-date'],
  ['0.1.9', '0.1.10', 'update-available'],
  ['0.1.10', '0.1.9', 'ahead'],
  ['0.9.99', '0.10.0', 'update-available'],
  ['0.10.0', '0.9.99', 'ahead'],
  ['0.99.99', '1.0.0', 'update-available'],
  ['1.0.0', '0.99.99', 'ahead'],
  ['0.1.44', 'v0.1.44', 'up-to-date'],
  ['v0.1.43', 'v0.1.44', 'update-available'],
  ['0.1.44+local.2', '0.1.44+release.3', 'up-to-date'],
  ['v0.1.43+local', 'v0.1.44+build.1', 'update-available'],
] as const) {
  test(`${current} compared with ${latest} is ${state}`, () => {
    const status = getVersionStatus(current, latest);
    assert.equal(status.state, state);
    assert.equal(status.updateAvailable, state === 'update-available');
    assert.notEqual(status.message, 'Version status unavailable');
  });
}

for (const value of [
  undefined,
  null,
  '',
  44,
  { version: '0.1.44' },
  ['0.1.44'],
  'main',
  '0.1',
  '0.1.44.0',
  '0.1.044',
  '00.1.44',
  '-1.1.44',
  '0.1.45-beta.1',
  'v0.1.45-rc.1',
  'V0.1.44',
  ' 0.1.44 ',
  '0.1.44\n',
  '0.1.44\r',
  '0.1.44+',
  '0.1.44+build..1',
  '9007199254740992.0.0',
]) {
  test(`uncomparable ${JSON.stringify(value)} is explicitly unknown on either side`, () => {
    for (const status of [getVersionStatus(value, '0.1.44'), getVersionStatus('0.1.44', value)]) {
      assert.deepEqual(status, {
        state: 'unknown',
        updateAvailable: false,
        message: 'Version status unavailable',
      });
    }
  });
}

test('a prefixed release does not produce a doubled v in the check result', () => {
  assert.equal(getVersionStatus('0.1.43', 'v0.1.44').message, 'v0.1.44 available');
});

const releaseResponse = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });

test('a successful shaped response supplies the published version', async () => {
  assert.equal(
    await readLatestVersionResponse(releaseResponse({ data: { version: '0.1.44' } })),
    '0.1.44'
  );
});

test('HTTP errors cannot pass even when the body contains a matching release', async () => {
  for (const status of [400, 401, 403, 500, 503]) {
    await assert.rejects(
      readLatestVersionResponse(releaseResponse({ data: { version: '0.1.44' } }, status)),
      /fetch failed/
    );
  }
});

test('invalid release payloads cannot pass the manual response reader', async () => {
  for (const payload of [
    null,
    [],
    {},
    { version: '0.1.44' },
    { data: null },
    { data: [] },
    { data: {} },
    { data: { version: null } },
    { data: { version: 44 } },
    { data: { version: ['0.1.44'] } },
    { data: { version: {} } },
    { data: { version: '' } },
  ]) {
    await assert.rejects(
      readLatestVersionResponse(releaseResponse(payload)),
      /Invalid latest-version response/
    );
  }
});

test('invalid JSON cannot pass the manual response reader', async () => {
  await assert.rejects(readLatestVersionResponse(new Response('not json', { status: 200 })));
});

test('unsupported published versions stay unknown after a successful HTTP check', async () => {
  const latest = await readLatestVersionResponse(
    releaseResponse({ data: { version: '0.2.0-beta.1' } })
  );
  assert.equal(getVersionStatus('0.1.44', latest).state, 'unknown');
  assert.equal(getVersionStatus('0.1.44', latest).updateAvailable, false);
});
