import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

// No third-party DOM, runtime or test dependencies; this never contacts a site.
const source =
  process.env.TRAKS_TEST_BASELINE === '1'
    ? execFileSync('git', ['show', 'HEAD:packages/tracker/src/tracker.ts'], { encoding: 'utf8' })
    : readFileSync(new URL('../packages/tracker/src/tracker.ts', import.meta.url), 'utf8');
const tracker =
  process.env.TRAKS_TEST_BUNDLE === '1'
    ? readFileSync(new URL('../packages/tracker/dist/tracker.js', import.meta.url), 'utf8')
    : stripTypeScriptTypes(source);
const campaign =
  '?utm_source=v2ex&utm_medium=referral&utm_campaign=launch_oct&utm_content=sidebar_a&utm_term=image_compressor';
const expectedAttribution = {
  r: 'https://v2ex.com/t/123',
  us: 'v2ex',
  um: 'referral',
  uc: 'launch_oct',
  uct: 'sidebar_a',
  ut: 'image_compressor',
};

function storage(entries = {}) {
  const values = new Map(Object.entries(entries));
  return {
    values,
    reads: [],
    writes: [],
    throwRead: false,
    throwWrite: false,
    getItem(key) {
      this.reads.push(key);
      if (this.throwRead) throw new Error('storage read blocked');
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      this.writes.push([key, value]);
      if (this.throwWrite) throw new Error('storage write blocked');
      values.set(key, String(value));
    },
  };
}

function events() {
  const listeners = new Map();
  return {
    addEventListener(type, callback, options) {
      const list = listeners.get(type) ?? [];
      list.push({ callback, once: Boolean(options && options.once) });
      listeners.set(type, list);
    },
    emit(type, extra = {}) {
      const list = [...(listeners.get(type) ?? [])];
      for (const item of list) {
        item.callback({ type, ...extra });
        if (item.once) {
          const remaining = listeners.get(type).filter(candidate => candidate !== item);
          listeners.set(type, remaining);
        }
      }
    },
  };
}

function browser(options = {}) {
  const clock = { now: options.now ?? 1_800_000_000_000 };
  const requests = [];
  const beacons = [];
  const sessionStorage = options.sessionStorage ?? storage();
  const localStorage = options.localStorage ?? storage();
  const location = {};
  function setUrl(value) {
    const url = new URL(value, location.href || 'https://example.test');
    for (const key of ['href', 'origin', 'hostname', 'pathname', 'search', 'hash']) {
      location[key] = url[key];
    }
  }
  setUrl(options.url ?? `https://example.test/tool${campaign}`);
  const script = {
    src: 'https://collect.example.test/tracker.js',
    getAttribute(name) {
      return name === 'data-site' ? (options.siteKey ?? 'site_a') : null;
    },
    hasAttribute(name) {
      return (options.attributes ?? []).includes(name);
    },
  };
  const document = {
    ...events(),
    currentScript: script,
    referrer: options.referrer ?? 'https://v2ex.com/t/123?token=private#personal',
    visibilityState: options.visibility ?? 'visible',
    prerendering: options.prerendering ?? false,
    modelContext: options.modelContext,
  };
  if (options.modelContextGetterThrows) {
    Object.defineProperty(document, 'modelContext', {
      get() {
        throw new Error('experimental API unavailable');
      },
    });
  }
  const navigator = {
    doNotTrack: options.dnt,
    globalPrivacyControl: options.gpc,
    sendBeacon(url, body) {
      beacons.push({ url, payload: JSON.parse(body) });
      if (options.beaconThrows) throw new Error('beacon unavailable');
      return true;
    },
  };
  const window = { ...events() };
  Object.defineProperty(window, 'sessionStorage', {
    get() {
      if (options.sessionGetterThrows) throw new Error('storage inaccessible');
      return sessionStorage;
    },
  });
  Object.defineProperty(window, 'localStorage', {
    get() {
      if (options.localGetterThrows) throw new Error('storage inaccessible');
      return localStorage;
    },
  });
  const stub = function () {
    (stub.q = stub.q || []).push(arguments);
  };
  stub.event = (name, config = {}) =>
    stub(name, config.props, undefined, {
      __traksEventOptions: true,
      revenue: config.revenue,
    });
  stub.disabled = options.disabled ?? false;
  window.traks = stub;
  const history = {
    pushState(_state, _title, url) {
      if (url != null) setUrl(url);
    },
    replaceState(_state, _title, url) {
      if (url != null) setUrl(url);
    },
  };
  class ClockDate extends Date {
    static now() {
      return clock.now;
    }
  }
  const context = vm.createContext({
    window,
    document,
    navigator,
    screen: { width: 1280 },
    location,
    history,
    URL,
    URLSearchParams,
    Date: ClockDate,
    fetch(url, config) {
      requests.push({ url, config, payload: JSON.parse(config.body) });
      if (options.fetch) return options.fetch(url, config);
      if (options.fetchThrows) throw new Error('fetch unavailable');
      if (options.fetchRejects) return Promise.reject(new Error('network blocked'));
      return Promise.resolve({ ok: true });
    },
  });
  return {
    clock,
    requests,
    beacons,
    sessionStorage,
    localStorage,
    window,
    document,
    navigator,
    location,
    history,
    setUrl,
    stub,
    advance(milliseconds) {
      clock.now += milliseconds;
    },
    boot() {
      vm.runInContext(tracker, context, { filename: 'tracker.ts' });
    },
    payloads() {
      return requests.map(({ payload }) => payload);
    },
  };
}

function attribution(payload) {
  return Object.fromEntries(Object.keys(expectedAttribution).map(key => [key, payload[key]]));
}

function link(href, attributes = []) {
  const url = new URL(href);
  return {
    tagName: 'A',
    parentElement: null,
    href: url.href,
    protocol: url.protocol,
    hostname: url.hostname,
    pathname: url.pathname,
    hasAttribute(name) {
      return attributes.includes(name);
    },
  };
}

test('all five campaign tags and query-free observed referrer reach page and custom events', () => {
  const page = browser();
  page.boot();
  page.window.traks('Signup Confirmed', { plan: 'free', method: 'email' });
  for (const payload of page.payloads()) {
    assert.deepEqual(attribution(payload), expectedAttribution);
    assert.equal(payload.s, 'site_a');
    assert.equal(payload.p, '/tool');
    assert.equal(payload.h, 'example.test');
  }
  assert.deepEqual(JSON.parse(page.payloads()[1].ep), { plan: 'free', method: 'email' });
  assert.doesNotMatch(JSON.stringify([...page.sessionStorage.values.values()]), /private|personal/);
});

test('first-entry attribution survives SPA navigation and query cleanup on every event kind', () => {
  const page = browser({ attributes: ['data-404'] });
  page.boot();
  const session = page.payloads()[0].sid;
  page.advance(2500);
  page.history.pushState(null, '', '/signup');
  page.history.replaceState(null, '', '/signup?utm_source=other&utm_content=other');
  page.window.traks('Signup Confirmed');
  page.document.emit('click', { target: link('https://outside.test/guide?token=secret#account') });
  page.document.emit('click', {
    target: link('https://example.test/file.pdf?email=secret@example.test'),
  });
  page.advance(2000);
  page.document.visibilityState = 'hidden';
  page.document.emit('visibilitychange');
  assert.ok(page.payloads().some(payload => payload.t === 'engagement' && payload.p === '/tool'));
  assert.ok(page.payloads().some(payload => payload.en === '404'));
  assert.ok(page.payloads().some(payload => payload.en === 'Outbound Link: Click'));
  assert.ok(page.payloads().some(payload => payload.en === 'File Download'));
  for (const payload of page.payloads()) {
    assert.equal(payload.sid, session);
    assert.deepEqual(attribution(payload), expectedAttribution);
  }
  const urls = page
    .payloads()
    .filter(payload => /^(Outbound Link: Click|File Download)$/.test(payload.en))
    .map(payload => JSON.parse(payload.ep).url);
  assert.deepEqual(urls, ['https://outside.test/guide', 'https://example.test/file.pdf']);
});

test('same-tab document reload restores source despite an internal referrer and absent query', () => {
  const first = browser();
  first.boot();
  const second = browser({
    url: 'https://example.test/signup',
    referrer: 'https://example.test/tool?token=hidden',
    sessionStorage: first.sessionStorage,
    now: first.clock.now + 1000,
  });
  second.boot();
  second.window.traks('Signup Confirmed');
  for (const payload of second.payloads()) {
    assert.equal(payload.sid, first.payloads()[0].sid);
    assert.deepEqual(attribution(payload), expectedAttribution);
  }
});

test('site keys isolate sessions and campaign labels in shared tab storage', () => {
  const first = browser();
  first.boot();
  const second = browser({
    siteKey: 'site_b',
    sessionStorage: first.sessionStorage,
    url: 'https://example.test/other',
    referrer: 'https://example.test/tool',
  });
  second.boot();
  assert.notEqual(second.payloads()[0].sid, first.payloads()[0].sid);
  assert.equal(second.payloads()[0].us, '');
  assert.equal(second.payloads()[0].r, '');
  assert.deepEqual([...first.sessionStorage.values.keys()].sort(), [
    '_pb_s:site_a',
    '_pb_s:site_b',
  ]);
});

test('activity extends the thirty-minute session; a long-open expiry cannot resurrect old UTM', () => {
  const page = browser();
  page.boot();
  const original = page.payloads()[0].sid;
  page.advance(29 * 60_000);
  page.window.traks('Tool Completed');
  page.advance(29 * 60_000);
  page.window.traks('Tool Completed');
  assert.equal(page.payloads().at(-1).sid, original);
  page.advance(30 * 60_000);
  page.window.traks('Tool Completed');
  const expired = page.payloads().at(-1);
  assert.notEqual(expired.sid, original);
  assert.deepEqual(attribution(expired), { r: '', us: '', um: '', uc: '', uct: '', ut: '' });
});

test('a genuinely new tagged document after expiry can capture its new entrance', () => {
  const first = browser();
  first.boot();
  const second = browser({
    sessionStorage: first.sessionStorage,
    now: first.clock.now + 31 * 60_000,
    url: 'https://example.test/?utm_source=newsletter',
    referrer: '',
  });
  second.boot();
  assert.notEqual(first.payloads()[0].sid, second.payloads()[0].sid);
  assert.equal(second.payloads()[0].us, 'newsletter');
  assert.equal(second.payloads()[0].uc, '');
});

for (const failure of ['getter', 'read', 'write']) {
  test(`blocked sessionStorage ${failure} keeps events and a bounded memory session`, () => {
    const blocked = storage();
    blocked.throwRead = failure === 'read';
    blocked.throwWrite = failure === 'write';
    const page = browser({ sessionStorage: blocked, sessionGetterThrows: failure === 'getter' });
    assert.doesNotThrow(() => page.boot());
    page.history.pushState(null, '', '/result');
    page.window.traks('Tool Completed');
    const ids = new Set(page.payloads().map(payload => payload.sid));
    assert.equal(ids.size, 1);
    for (const payload of page.payloads())
      assert.deepEqual(attribution(payload), expectedAttribution);
    page.advance(31 * 60_000);
    page.window.traks('Tool Completed');
    assert.notEqual(page.payloads().at(-1).sid, page.payloads()[0].sid);
    assert.equal(page.payloads().at(-1).us, '');
  });
}

test('a failing storage write preserves a successfully restored session', () => {
  const first = browser();
  first.boot();
  first.sessionStorage.throwWrite = true;
  const second = browser({
    sessionStorage: first.sessionStorage,
    url: 'https://example.test/result',
    referrer: '',
  });
  second.boot();
  assert.equal(second.payloads()[0].sid, first.payloads()[0].sid);
  assert.equal(second.payloads()[0].us, 'v2ex');
});

test('legacy values stay generic while the explicit event method carries revenue currency', () => {
  const page = browser();
  page.boot();
  page.window.traks(
    'Legacy duration',
    { currency: 'USD', revenue: 49, props: 'a scalar legacy prop' },
    250
  );
  page.window.traks.event('Purchase Confirmed', {
    props: { plan: 'pro' },
    revenue: { currency: 'usd', amount: 49 },
  });
  const [legacy, revenue] = page.payloads().filter(payload => payload.t === 'event');
  assert.equal(legacy.ev, 250);
  assert.equal(legacy.rc, undefined);
  assert.deepEqual(JSON.parse(legacy.ep), {
    currency: 'USD',
    revenue: 49,
    props: 'a scalar legacy prop',
  });
  assert.equal(revenue.ev, 49);
  assert.equal(revenue.rc, 'USD');
  assert.deepEqual(JSON.parse(revenue.ep), { plan: 'pro' });
});

test('invalid revenue never creates currency-tagged money or drops the plain event', () => {
  const page = browser();
  page.boot();
  for (const revenue of [
    { currency: 'USDX', amount: 49 },
    { currency: 'USD', amount: -1 },
    { currency: 'USD', amount: Infinity },
    { currency: 'USD', amount: 1_000_001 },
    { currency: 'USD', amount: '49' },
    { currency: 'USD', amount: NaN },
  ])
    page.window.traks.event('Invalid revenue', { revenue });
  const events = page.payloads().filter(payload => payload.t === 'event');
  assert.equal(events.length, 6);
  for (const payload of events) {
    assert.equal(payload.rc, undefined);
    assert.equal(payload.ev, 0);
  }
});

test('old and new stub calls replay in order without treating ordinary props as options', () => {
  const page = browser();
  page.stub('Early CTA', { revenue: 10, props: 'legacy' }, 2);
  page.stub.event('Early Purchase', {
    props: { plan: 'pro' },
    revenue: { currency: 'EUR', amount: 19 },
  });
  page.boot();
  const queued = page.payloads().filter(payload => payload.t === 'event');
  assert.deepEqual(
    queued.map(payload => payload.en),
    ['Early CTA', 'Early Purchase']
  );
  assert.equal(queued[0].ev, 2);
  assert.equal(queued[0].rc, undefined);
  assert.equal(queued[1].ev, 19);
  assert.equal(queued[1].rc, 'EUR');
  for (const payload of queued) assert.deepEqual(attribution(payload), expectedAttribution);
});

test('PII, free text, nested values and forged reserved metadata cannot bypass props sanitation', () => {
  const page = browser({
    url: 'https://example.test/tool?utm_source=person%40example.test&utm_campaign=https%3A%2F%2Fprivate.test',
  });
  page.boot();
  const circular = {
    plan: 'pro',
    method: 'email',
    user_id: 'private_user',
    email: 'private@example.test',
    orderId: 'private_order',
    token: 'secret',
    message: 'free text',
    phone: '1234567890',
    __traks_currency: 'USD',
    nested: { email: 'private@example.test' },
    label: 'private@example.test',
    url: 'https://outside.test/file?token=secret#private',
  };
  circular.circular = circular;
  Object.defineProperty(circular, 'throwing', {
    enumerable: true,
    get() {
      throw new Error('getter');
    },
  });
  assert.doesNotThrow(() => page.window.traks('Safe event', circular));
  const payload = page.payloads().at(-1);
  assert.deepEqual(JSON.parse(payload.ep), {
    plan: 'pro',
    method: 'email',
    url: 'https://outside.test/file',
  });
  assert.equal(payload.us, '');
  assert.equal(payload.uc, '');
  assert.equal(payload.rc, undefined);
  assert.doesNotMatch(
    JSON.stringify(page.payloads()),
    /private@example|private_user|private_order|free text|secret|1234567890/
  );
});

for (const control of [
  { label: 'DNT 1', dnt: '1' },
  { label: 'DNT yes', dnt: 'yes' },
  { label: 'GPC', gpc: true },
  { label: 'disabled API', disabled: true },
  { label: 'Traks opt-out', localStorage: storage({ traks_ignore: 'true' }) },
  { label: 'Plausible opt-out', localStorage: storage({ plausible_ignore: 'true' }) },
]) {
  test(`${control.label} prevents even session side effects and queued/automatic events`, () => {
    const page = browser(control);
    page.stub('Queued');
    page.boot();
    page.window.traks('Signup Confirmed');
    page.window.traks.event('Purchase Confirmed', { revenue: { currency: 'USD', amount: 49 } });
    page.document.emit('click', { target: link('https://outside.test/guide') });
    page.advance(5000);
    page.window.emit('pagehide');
    page.history.pushState(null, '', '/next');
    assert.equal(page.requests.length, 0);
    assert.equal(page.beacons.length, 0);
    assert.equal(page.sessionStorage.reads.length, 0);
    assert.equal(page.sessionStorage.writes.length, 0);
  });
}

test('opt-out enabled after initialization prevents further requests and late beacon fallback', async () => {
  let rejectFetch;
  const page = browser({
    fetch() {
      return new Promise((_resolve, reject) => {
        rejectFetch = reject;
      });
    },
  });
  page.boot();
  const writes = page.sessionStorage.writes.length;
  page.localStorage.setItem('traks_ignore', 'true');
  page.window.traks('Signup Confirmed');
  page.advance(5000);
  page.window.emit('pagehide');
  rejectFetch(new Error('network failed after exit'));
  await Promise.resolve();
  assert.equal(page.requests.length, 1);
  assert.equal(page.sessionStorage.writes.length, writes);
  assert.equal(page.beacons.length, 0);
});

test('throwing privacy storage does not throw or disable normal collection', () => {
  const page = browser({ localGetterThrows: true });
  assert.doesNotThrow(() => page.boot());
  assert.doesNotThrow(() => page.window.traks('Tool Completed'));
  assert.equal(page.requests.length, 2);
});

test('an unavailable DNT getter or conflicting DNT values cannot hide another opt-out signal', () => {
  const gpc = browser({ gpc: true });
  Object.defineProperty(gpc.navigator, 'doNotTrack', {
    get() {
      throw new Error('DNT unavailable');
    },
  });
  gpc.boot();
  assert.equal(gpc.requests.length, 0);
  assert.equal(gpc.sessionStorage.writes.length, 0);
  const windowDnt = browser({ dnt: '0' });
  windowDnt.window.doNotTrack = '1';
  windowDnt.boot();
  assert.equal(windowDnt.requests.length, 0);
  assert.equal(windowDnt.sessionStorage.writes.length, 0);
});

test('synchronous fetch failures and failed beacons never reach the business handler', () => {
  const page = browser({ fetchThrows: true, beaconThrows: true });
  assert.doesNotThrow(() => page.boot());
  assert.doesNotThrow(() => page.window.traks('Tool Completed'));
  assert.equal(page.requests.length, 2);
  assert.equal(page.beacons.length, 2);
});

test('network rejection has only a single beacon fallback and no telemetry retry loop', async () => {
  const page = browser({ fetchRejects: true });
  page.boot();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(page.requests.length, 1);
  assert.equal(page.beacons.length, 1);
});

test('WebMCP events inherit source without serializing arguments or changing results/errors', async () => {
  const modelContext = {
    registerTool(tool) {
      return tool;
    },
  };
  const page = browser({ modelContext });
  page.boot();
  const sync = {
    name: 'compress',
    execute(input) {
      return input;
    },
  };
  assert.equal(modelContext.registerTool(sync), sync);
  const privateInput = { email: 'private@example.test', prompt: 'private prompt' };
  assert.equal(sync.execute(privateInput), privateInput);
  const result = Promise.resolve('done');
  const asyncTool = {
    name: 'async',
    execute() {
      return result;
    },
  };
  modelContext.registerTool(asyncTool);
  assert.equal(asyncTool.execute(), result);
  const error = new Error('private error message');
  const bad = {
    name: 'bad',
    execute() {
      throw error;
    },
  };
  modelContext.registerTool(bad);
  assert.throws(
    () => bad.execute(),
    observed => observed === error
  );
  await result;
  const toolEvents = page.payloads().filter(payload => payload.en === 'WebMCP: Tool Call');
  assert.equal(toolEvents.length, 3);
  for (const payload of toolEvents) assert.deepEqual(attribution(payload), expectedAttribution);
  assert.doesNotMatch(
    JSON.stringify(page.payloads()),
    /private@example|private prompt|private error/
  );
});

test('unavailable or frozen WebMCP APIs cannot stop ordinary tracker initialization', () => {
  const frozen = Object.freeze({
    registerTool(tool) {
      return tool;
    },
  });
  for (const options of [{ modelContextGetterThrows: true }, { modelContext: frozen }]) {
    const page = browser(options);
    assert.doesNotThrow(() => page.boot());
    page.window.traks('Tool Completed');
    assert.equal(page.requests.length, 2);
  }
  const page = browser({
    modelContext: {
      registerTool(tool) {
        return tool;
      },
    },
  });
  page.boot();
  const frozenTool = Object.freeze({
    name: 'frozen',
    execute() {
      return 'ok';
    },
  });
  assert.equal(page.document.modelContext.registerTool(frozenTool), frozenTool);
  assert.equal(frozenTool.execute(), 'ok');
});

test('WebMCP thenable observation cannot change a throwing getter result', () => {
  const page = browser({
    modelContext: {
      registerTool(tool) {
        return tool;
      },
    },
  });
  page.boot();
  const result = Object.defineProperty({}, 'then', {
    get() {
      throw new Error('unavailable then');
    },
  });
  const tool = {
    name: 'thenable',
    execute() {
      return result;
    },
  };
  page.document.modelContext.registerTool(tool);
  assert.equal(tool.execute(), result);
});

test('hash routing strips hash query secrets and automatic target URL credentials', () => {
  const page = browser({
    attributes: ['data-hash', 'data-404'],
    url: `https://example.test/tool${campaign}#/missing?token=secret`,
  });
  page.boot();
  page.document.emit('click', {
    target: link('https://user:secret@outside.test/file.pdf?token=secret#private'),
  });
  assert.ok(page.payloads().every(payload => payload.p === '/tool#/missing'));
  assert.equal(JSON.parse(page.payloads().at(-1).ep).url, 'https://outside.test/file.pdf');
  assert.doesNotMatch(JSON.stringify(page.payloads()), /secret|private|user:/);
});

test('prerendering defers initial pageviews, bfcache/duplicate initialization do not duplicate', () => {
  const page = browser({ prerendering: true });
  page.boot();
  assert.equal(page.requests.length, 0);
  page.document.prerendering = false;
  page.document.emit('prerenderingchange');
  page.window.emit('pageshow', { persisted: true });
  page.boot();
  assert.equal(page.payloads().filter(payload => payload.t === 'pageview').length, 1);
});

test('hidden background tabs get a pageview but no invisible engagement time', () => {
  const page = browser({ visibility: 'hidden' });
  page.boot();
  page.advance(10_000);
  page.window.emit('pagehide');
  assert.equal(page.payloads().filter(payload => payload.t === 'pageview').length, 1);
  assert.equal(page.payloads().filter(payload => payload.t === 'engagement').length, 0);
});

test('tracker is inert in SSR without reading absent browser globals', () => {
  assert.doesNotThrow(() => vm.runInNewContext(tracker, {}, { filename: 'tracker.ts' }));
});
