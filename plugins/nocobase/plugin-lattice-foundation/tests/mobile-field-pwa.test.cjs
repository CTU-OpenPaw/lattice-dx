/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

const PLUGIN_ROOT = join(__dirname, '..');
const REPO_ROOT = join(PLUGIN_ROOT, '..', '..', '..');

function makeMemoryStorage() {
  const map = new Map();
  return {
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(key, String(value));
    },
    removeItem(key) {
      map.delete(key);
    },
    _map: map,
  };
}

function makeHttpCtx(overrides = {}) {
  const resHeaders = {};
  return {
    method: 'GET',
    headers: {},
    request: { headers: {} },
    response: { headers: resHeaders },
    state: {},
    status: undefined,
    body: undefined,
    withoutDataWrapping: false,
    get(name) {
      return this.headers[String(name).toLowerCase()] || '';
    },
    set(name, value) {
      resHeaders[name] = value;
    },
    throw(status, message, props) {
      throw Object.assign(new Error(message || `HTTP ${status}`), { status }, props || {});
    },
    ...overrides,
  };
}

function createFakeReact() {
  let stateCursor = 0;
  const states = [];
  const refs = [];
  let refCursor = 0;
  let effectCursor = 0;
  const effectSlots = [];
  const pendingEffects = [];

  function depsChanged(prevDeps, nextDeps) {
    if (!nextDeps || !prevDeps) return true;
    if (prevDeps.length !== nextDeps.length) return true;
    for (let i = 0; i < nextDeps.length; i += 1) {
      if (!Object.is(prevDeps[i], nextDeps[i])) return true;
    }
    return false;
  }

  function resetCursors() {
    stateCursor = 0;
    refCursor = 0;
    effectCursor = 0;
    pendingEffects.length = 0;
  }

  function createElement(type, props, ...children) {
    const flatChildren = [];
    for (const c of children) {
      if (Array.isArray(c)) flatChildren.push(...c);
      else if (c !== null && c !== undefined && c !== false) flatChildren.push(c);
    }
    return { type, props: props || {}, children: flatChildren };
  }

  return {
    Fragment: Symbol.for('react.fragment'),
    createElement,
    useState(initial) {
      const idx = stateCursor++;
      if (!(idx in states)) {
        states[idx] = typeof initial === 'function' ? initial() : initial;
      }
      const setState = (next) => {
        states[idx] = typeof next === 'function' ? next(states[idx]) : next;
      };
      return [states[idx], setState];
    },
    useRef(initial) {
      const idx = refCursor++;
      if (!(idx in refs)) {
        refs[idx] = { current: initial };
      }
      return refs[idx];
    },
    useEffect(fn, deps) {
      const idx = effectCursor++;
      const prev = effectSlots[idx];
      if (!prev || depsChanged(prev.deps, deps)) {
        pendingEffects.push({ idx, fn, deps });
      }
    },
    useCallback(fn) {
      return fn;
    },
    useMemo(fn) {
      return fn();
    },
    _render(Component, props = {}) {
      resetCursors();
      return Component(props);
    },
    _flushEffects() {
      const cleanups = [];
      for (const eff of pendingEffects.splice(0)) {
        const prev = effectSlots[eff.idx];
        if (prev && typeof prev.cleanup === 'function') {
          prev.cleanup();
        }
        const nextCleanup = eff.fn();
        effectSlots[eff.idx] = { deps: eff.deps, cleanup: typeof nextCleanup === 'function' ? nextCleanup : null };
        if (typeof nextCleanup === 'function') cleanups.push(nextCleanup);
      }
      return cleanups;
    },
    _unmount() {
      for (let i = effectSlots.length - 1; i >= 0; i -= 1) {
        const slot = effectSlots[i];
        if (slot && typeof slot.cleanup === 'function') {
          slot.cleanup();
          slot.cleanup = null;
        }
      }
    },
    _refs: refs,
  };
}

function findNode(node, predicate) {
  if (!node || typeof node !== 'object') return null;
  if (predicate(node)) return node;
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      const found = findNode(child, predicate);
      if (found) return found;
    }
  }
  return null;
}

function collectText(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node.children)) return node.children.map(collectText).join(' ');
  return '';
}

test('server mobile-pwa: manifest has zero PII/secrets, sw.js headers & NetworkOnly /api/* invariant hold', async () => {
  const {
    buildPwaManifest,
    buildServiceWorkerScript,
    registerMobilePwaActions,
  } = require('../src/server/mobile-pwa');
  const { registerObservability } = require('../src/server/observability');

  // 1. W3C Web App Manifest
  const manifest = buildPwaManifest();
  assert.equal(manifest.name, 'LatticeDX Field PWA');
  assert.equal(manifest.short_name, 'LatticeField');
  assert.equal(manifest.start_url, '/v/mobile');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.background_color, '#0f172a');
  assert.equal(manifest.theme_color, '#0f172a');
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 1);
  assert.ok(manifest.icons.every((ic) => typeof ic.src === 'string' && ic.src.startsWith('data:image/svg+xml')));
  const manifestJson = JSON.stringify(manifest).toLowerCase();
  for (const forbidden of ['password', 'secret', 'token', 'apikey', 'organizationid', 'userid', 'email']) {
    assert.equal(manifestJson.includes(forbidden), false, `Manifest must not leak ${forbidden}`);
  }

  // 2. Service Worker Script syntax + runtime Cache Storage invariants
  const swScript = buildServiceWorkerScript({ version: '0.4.0' });
  assert.equal(typeof swScript, 'string');
  assert.doesNotThrow(() => new vm.Script(swScript), 'sw.js must be valid JavaScript');

  const listeners = new Map();
  const openedCaches = new Map();
  const deletedCaches = [];
  let skipWaitingCalled = false;
  let clientsClaimed = false;
  let fetchMode = 'online';
  const fetchCalls = [];

  const getOrCreateCache = (name) => {
    if (!openedCaches.has(name)) {
      const entries = new Map();
      openedCaches.set(name, {
        _entries: entries,
        async addAll(urls) {
          for (const u of urls) {
            entries.set(u, { status: 200, ok: true, type: 'basic', headers: new Map(), url: u, clone() { return this; } });
          }
        },
        async put(req, res) {
          const k = typeof req === 'string' ? req : req.url;
          entries.set(k, res);
        },
        async match(req) {
          const k = typeof req === 'string' ? req : req.url;
          return entries.get(k) || entries.get(new URL(k, 'https://field.latticedx.local').pathname) || undefined;
        },
      });
    }
    return openedCaches.get(name);
  };

  const sandbox = {
    URL,
    Promise,
    Set,
    Map,
    RegExp,
    String,
    Array,
    caches: {
      async open(name) { return getOrCreateCache(name); },
      async keys() { return [...openedCaches.keys()]; },
      async delete(name) { deletedCaches.push(name); return openedCaches.delete(name); },
      async match(req) {
        for (const c of openedCaches.values()) {
          const hit = await c.match(req);
          if (hit) return hit;
        }
        return undefined;
      },
    },
    async fetch(req) {
      const url = typeof req === 'string' ? req : req.url;
      fetchCalls.push(url);
      if (fetchMode === 'offline') throw new Error('Network offline');
      if (url.includes('private-nostore')) {
        return {
          status: 200,
          ok: true,
          type: 'basic',
          headers: { get: (k) => (k.toLowerCase() === 'cache-control' ? 'no-store' : null) },
          clone() { return this; },
        };
      }
      if (url.includes('sso-redirected')) {
        return {
          status: 200,
          ok: true,
          redirected: true,
          type: 'basic',
          url: 'https://field.latticedx.local/login',
          headers: { get: (k) => (k.toLowerCase() === 'cache-control' ? 'public, max-age=300' : null) },
          clone() { return this; },
        };
      }
      return {
        status: 200,
        ok: true,
        type: 'basic',
        url,
        headers: { get: (k) => (k.toLowerCase() === 'cache-control' ? 'public, max-age=300' : null) },
        clone() { return this; },
      };
    },
    self: {
      location: { origin: 'https://field.latticedx.local' },
      addEventListener(type, fn) { listeners.set(type, fn); },
      skipWaiting() { skipWaitingCalled = true; return Promise.resolve(); },
      clients: { claim() { clientsClaimed = true; return Promise.resolve(); } },
    },
  };
  openedCaches.set('latticedx-field-pwa-old-v0', getOrCreateCache('latticedx-field-pwa-old-v0'));
  vm.runInNewContext(swScript, sandbox);

  // Trigger install & activate
  const waitPromises = [];
  listeners.get('install')({ waitUntil: (p) => waitPromises.push(p) });
  await Promise.all(waitPromises.splice(0));
  assert.equal(skipWaitingCalled, true);

  const cachedKeys = [...openedCaches.entries()]
    .filter(([k]) => k !== 'latticedx-field-pwa-old-v0')
    .flatMap(([, c]) => [...c._entries.keys()]);
  assert.deepEqual(cachedKeys.sort(), ['/api/dxos:manifest', '/v/mobile']);

  listeners.get('activate')({ waitUntil: (p) => waitPromises.push(p) });
  await Promise.all(waitPromises.splice(0));
  assert.equal(clientsClaimed, true);
  assert.ok(deletedCaches.includes('latticedx-field-pwa-old-v0'));

  // CRITICAL INVARIANT: /api/* (except /api/dxos:manifest) MUST bypass Cache Storage completely (no respondWith!)
  for (const sensitiveApi of [
    'https://field.latticedx.local/api/auth:check',
    'https://field.latticedx.local/api/dxosWms:epodCapture',
    'https://field.latticedx.local/api/dxosWms:stockSummary',
    'https://field.latticedx.local/api/dxosApiKeys:list',
    'https://field.latticedx.local/api/dxosLedger:entries',
    'https://field.latticedx.local/api/users:list?pageSize=20',
  ]) {
    let respondedWith = null;
    listeners.get('fetch')({
      request: { method: 'GET', url: sensitiveApi, mode: 'cors' },
      respondWith(p) { respondedWith = p; },
    });
    assert.equal(respondedWith, null, `SW MUST NOT intercept or cache ${sensitiveApi}`);
  }

  // Non-GET must also bypass
  let postResponded = null;
  listeners.get('fetch')({
    request: { method: 'POST', url: 'https://field.latticedx.local/api/dxosWms:epodCapture' },
    respondWith(p) { postResponded = p; },
  });
  assert.equal(postResponded, null);

  // Offline fallback serves cached /v/mobile and /api/dxos:manifest
  fetchMode = 'offline';
  for (const shellUrl of [
    'https://field.latticedx.local/v/mobile',
    'https://field.latticedx.local/api/dxos:manifest',
  ]) {
    let responsePromise = null;
    listeners.get('fetch')({
      request: { method: 'GET', url: shellUrl, mode: 'navigate' },
      respondWith(p) { responsePromise = p; },
    });
    assert.ok(responsePromise, `SW should serve shell offline for ${shellUrl}`);
    const offlineResp = await responsePromise;
    assert.equal(offlineResp.status, 200);
  }

  // Online response with no-store or redirected: true must NEVER be written into Cache Storage
  fetchMode = 'online';
  let noStorePromise = null;
  listeners.get('fetch')({
    request: { method: 'GET', url: 'https://field.latticedx.local/v/assets/private-nostore.js', mode: 'cors' },
    respondWith(p) { noStorePromise = p; },
  });
  assert.ok(noStorePromise);
  await noStorePromise;
  const activeCache = openedCaches.get('latticedx-field-pwa-v0.4.0');
  assert.equal(activeCache._entries.has('/v/assets/private-nostore.js'), false);

  let redirectedPromise = null;
  listeners.get('fetch')({
    request: { method: 'GET', url: 'https://field.latticedx.local/v/assets/sso-redirected.js', mode: 'cors' },
    respondWith(p) { redirectedPromise = p; },
  });
  assert.ok(redirectedPromise);
  await redirectedPromise;
  assert.equal(activeCache._entries.has('/v/assets/sso-redirected.js'), false);

  // 3. Server resource registration + ACL + HTTP headers
  assert.equal(typeof registerMobilePwaActions, 'function');
  const resources = new Map();
  const aclAllows = [];
  registerObservability({
    use() {},
    resourceManager: { define(def) { resources.set(def.name, def.actions); } },
    acl: { allow(...args) { aclAllows.push(args); } },
  });
  const dxos = resources.get('dxos');
  assert.ok(dxos?.manifest && dxos['sw.js'] && dxos?.sw);
  assert.ok(aclAllows.some(([res, acts, role]) => (
    res === 'dxos'
    && acts.includes('manifest')
    && acts.includes('sw.js')
    && acts.includes('sw')
    && role === 'public'
  )));

  const mCtx = makeHttpCtx({ method: 'GET' });
  await dxos.manifest(mCtx, async () => {});
  assert.equal(mCtx.status, 200);
  assert.equal(mCtx.withoutDataWrapping, true);
  assert.equal(mCtx.response.headers['Content-Type'], 'application/manifest+json; charset=utf-8');
  assert.equal(mCtx.response.headers['Cache-Control'], 'public, max-age=300');
  assert.equal(mCtx.body.start_url, '/v/mobile');

  await assert.rejects(() => dxos.manifest(makeHttpCtx({ method: 'POST' }), async () => {}), { status: 405, code: 'METHOD_NOT_ALLOWED' });

  for (const actionKey of ['sw.js', 'sw']) {
    const sCtx = makeHttpCtx({ method: 'GET' });
    await dxos[actionKey](sCtx, async () => {});
    assert.equal(sCtx.status, 200);
    assert.equal(sCtx.withoutDataWrapping, true);
    assert.equal(sCtx.response.headers['Content-Type'], 'application/javascript; charset=utf-8');
    assert.equal(sCtx.response.headers['Service-Worker-Allowed'], '/');
    assert.equal(sCtx.response.headers['Cache-Control'], 'no-cache, no-store, must-revalidate');
    assert.doesNotThrow(() => new vm.Script(sCtx.body));
    await assert.rejects(() => dxos[actionKey](makeHttpCtx({ method: 'POST' }), async () => {}), { status: 405, code: 'METHOD_NOT_ALLOWED' });
  }

  // Confirm APISIX prod route already allows dxos:manifest & dxos:sw.js
  const apisixProd = readFileSync(join(REPO_ROOT, 'infra/config/apisix/apisix.prod.yaml'), 'utf8');
  assert.match(apisixProd, /id:\s*dxos-public-paas[\s\S]*\/api\/dxos:manifest[\s\S]*\/api\/dxos:sw\.js/);
});

test('client-v2 offline queue: bounded 50 items, allowlisted actions only, FIFO flush & 400/403 vs 503/network handling', async () => {
  const {
    OFFLINE_QUEUE_STORAGE_KEY,
    MAX_OFFLINE_QUEUE_ITEMS,
    enqueueOfflineAction,
    readOfflineQueue,
    flushOfflineQueue,
    removeOfflineQueueItem,
  } = require('../src/client-v2/mobile-field-pwa');

  assert.equal(OFFLINE_QUEUE_STORAGE_KEY, 'latticedx:mobile:offline-queue');
  assert.equal(MAX_OFFLINE_QUEUE_ITEMS, 50);

  const storage = makeMemoryStorage();
  assert.deepEqual(readOfflineQueue({ storage }), []);

  // Corrupt JSON in storage degrades safely to []
  storage.setItem(OFFLINE_QUEUE_STORAGE_KEY, '{corrupt-json');
  assert.deepEqual(readOfflineQueue({ storage }), []);

  // Unknown action types rejected
  assert.throws(
    () => enqueueOfflineAction({ actionType: 'dxosApiKeys:issue', payload: { label: 'x' } }, { storage }),
    { code: 'UNSUPPORTED_OFFLINE_ACTION' },
  );
  assert.throws(
    () => enqueueOfflineAction({ actionType: 'wms.epodCapture', payload: null }, { storage }),
    { code: 'INVALID_OFFLINE_PAYLOAD' },
  );

  // Enqueue both allowed types + remove
  const first = enqueueOfflineAction({
    actionType: 'wms.epodCapture',
    payload: { orderCode: 'ORD-100', recipientName: 'Anh Minh', gpsLat: 10.03, gpsLng: 105.78, signatureDataUrl: 'data:image/png;base64,AAAA' },
  }, { storage });
  const second = enqueueOfflineAction({
    actionType: 'iot.twinSetDesired',
    payload: { assetId: 12, desiredPatch: { targetTempC: -18 } },
  }, { storage });
  assert.equal(readOfflineQueue({ storage }).length, 2);
  assert.equal(first.item.endpoint, 'dxosWms:epodCapture');
  assert.equal(second.item.endpoint, 'dxosBlocks:twinSetDesired');

  const afterRemove = removeOfflineQueueItem(second.item.id, { storage });
  assert.equal(afterRemove.length, 1);
  assert.equal(afterRemove[0].id, first.item.id);

  // Capacity limit at 50 items
  for (let i = 1; i < 50; i += 1) {
    enqueueOfflineAction({ actionType: 'iot.twinSetDesired', payload: { assetId: i, desiredPatch: { targetTempC: 4 } } }, { storage });
  }
  assert.equal(readOfflineQueue({ storage }).length, 50);
  assert.throws(
    () => enqueueOfflineAction({ actionType: 'iot.twinSetDesired', payload: { assetId: 999, desiredPatch: { targetTempC: 4 } } }, { storage }),
    { code: 'OFFLINE_QUEUE_FULL' },
  );

  // Flush FIFO behavior: 200 succeeded (removed), 400 invalid (removed + failed++), 403 forbidden (removed + failed++), 503 & network error (retained!)
  const flushStorage = makeMemoryStorage();
  const q1 = enqueueOfflineAction({ actionType: 'wms.epodCapture', payload: { seq: 1 } }, { storage: flushStorage }).item;
  const q2 = enqueueOfflineAction({ actionType: 'wms.epodCapture', payload: { seq: 2 } }, { storage: flushStorage }).item;
  const q3 = enqueueOfflineAction({ actionType: 'iot.twinSetDesired', payload: { seq: 3 } }, { storage: flushStorage }).item;
  const q4 = enqueueOfflineAction({ actionType: 'iot.twinSetDesired', payload: { seq: 4 } }, { storage: flushStorage }).item;
  const q5 = enqueueOfflineAction({ actionType: 'wms.epodCapture', payload: { seq: 5 } }, { storage: flushStorage }).item;

  // Offline skips network calls completely
  const offlineRes = await flushOfflineQueue({
    storage: flushStorage,
    isOnline: false,
    apiClient: { request: async () => assert.fail('Must not send requests while offline') },
  });
  assert.equal(offlineRes.deferred, 5);
  assert.equal(readOfflineQueue({ storage: flushStorage }).length, 5);

  const sentSeqs = [];
  const progressEvents = [];
  const flushRes = await flushOfflineQueue({
    storage: flushStorage,
    isOnline: true,
    onProgress: (ev) => progressEvents.push(ev),
    apiClient: {
      async request(req) {
        sentSeqs.push({ url: req.url, seq: req.data.seq });
        if (req.data.seq === 1) return { data: { trackingCode: 'LDX-TRK-001' } };
        if (req.data.seq === 2) throw Object.assign(new Error('Validation failed'), { response: { status: 400 } });
        if (req.data.seq === 3) throw Object.assign(new Error('Forbidden'), { response: { status: 403 } });
        if (req.data.seq === 4) throw Object.assign(new Error('Service Unavailable'), { response: { status: 503 } });
        throw new Error('Failed to fetch');
      },
    },
  });

  assert.deepEqual(sentSeqs, [
    { url: 'dxosWms:epodCapture', seq: 1 },
    { url: 'dxosWms:epodCapture', seq: 2 },
    { url: 'dxosBlocks:twinSetDesired', seq: 3 },
    { url: 'dxosBlocks:twinSetDesired', seq: 4 },
    { url: 'dxosWms:epodCapture', seq: 5 },
  ]);
  assert.equal(progressEvents.length, 5);
  assert.equal(flushRes.synced, 1);
  assert.equal(flushRes.failed, 2);
  assert.equal(flushRes.deferred, 2);
  const remaining = readOfflineQueue({ storage: flushStorage });
  assert.deepEqual(remaining.map((r) => r.id), [q4.id, q5.id]);
  assert.equal(remaining[0].attempts, 1);
  assert.equal(remaining[1].attempts, 1);
  assert.ok(!remaining.some((r) => r.id === q1.id || r.id === q2.id || r.id === q3.id));
});

test('client-v2 QR/barcode parser parses URN, tracking, lot, order, JSON tags and rejects unsafe/oversized payloads', () => {
  const { parseFieldQrPayload } = require('../src/client-v2/mobile-field-pwa');

  const urn = parseFieldQrPayload('urn:ngsi-ld:Asset:org-ctu:native:42');
  assert.equal(urn.valid, true);
  assert.equal(urn.kind, 'urn');
  assert.equal(urn.organizationId, 'org-ctu');
  assert.equal(urn.entityType, 'Asset');
  assert.equal(urn.entityId, '42');
  assert.equal(urn.assetId, 42);

  const trk = parseFieldQrPayload('ldx-trk-ab12cd34ef');
  assert.equal(trk.valid, true);
  assert.equal(trk.kind, 'tracking');
  assert.equal(trk.trackingCode, 'LDX-TRK-AB12CD34EF');

  const lot = parseFieldQrPayload('LOT-VAC-2026A');
  assert.equal(lot.valid, true);
  assert.equal(lot.kind, 'lot');
  assert.equal(lot.lotCode, 'LOT-VAC-2026A');

  const ord = parseFieldQrPayload('ORD-2026-0091');
  assert.equal(ord.valid, true);
  assert.equal(ord.kind, 'order');
  assert.equal(ord.orderCode, 'ORD-2026-0091');

  const jsonTag = parseFieldQrPayload('{"orderCode":"ORD-77","lotCode":"LOT-9","assetId":15,"urn":"urn:ngsi-ld:Asset:org-a:native:15"}');
  assert.equal(jsonTag.valid, true);
  assert.equal(jsonTag.kind, 'json');
  assert.equal(jsonTag.orderCode, 'ORD-77');
  assert.equal(jsonTag.lotCode, 'LOT-9');
  assert.equal(jsonTag.assetId, 15);

  for (const unsafe of [
    '',
    '   ',
    null,
    123,
    'x'.repeat(2049),
    '<script>alert(1)</script>',
    'javascript:alert(1)',
    'ORD-123\x00evil',
    '{"__proto__":{"polluted":true},"orderCode":"ORD-1"}',
    '../etc/passwd',
    'arbitrary-unrecognized-code',
  ]) {
    const bad = parseFieldQrPayload(unsafe);
    assert.equal(bad.valid, false, `Expected rejection for ${String(unsafe).slice(0, 40)}`);
  }
});

test('client-v2 MobileFieldPwaPage renders field controls, handles QR/GPS/Canvas/ePOD offline fallback, and preserves host AMD contract', async () => {
  const { createMobileFieldPwaPage, readOfflineQueue } = require('../src/client-v2/mobile-field-pwa');

  // 1. Must NOT access React.createElement or hooks during factory creation (manifest-actions.test.cjs passes React = {})
  assert.doesNotThrow(() => createMobileFieldPwaPage({ Plugin: class {} }, {}, {}));

  // 2. Render & interact via fake React harness
  const fakeReact = createFakeReact();
  const storage = makeMemoryStorage();
  const requests = [];
  let failNetwork = false;
  const mockApiClient = {
    async request(req) {
      requests.push(req);
      if (failNetwork) throw new Error('Network unreachable');
      if (req.url === 'dxosWms:epodCapture') {
        return {
          data: {
            epod: { epodUid: 'EPOD-MOBILE-1', ledgerSeq: 7, trackingCode: 'LDX-TRK-FIELD1' },
            trackingCode: 'LDX-TRK-FIELD1',
            trackingToken: 'ldx_trk_secret_once',
          },
        };
      }
      return { data: { ok: true } };
    },
  };

  // Provide minimal global navigator/window/document mocks for useEffect & geolocation
  const registeredSw = [];
  const appendedHeadNodes = [];
  const prevGlobals = {
    navigator: global.navigator,
    window: global.window,
    document: global.document,
  };
  let onlineFlag = true;
  Object.defineProperty(global, 'navigator', {
    configurable: true,
    value: {
      onLine: true,
      serviceWorker: {
        register: async (url, opts) => {
          registeredSw.push({ url, opts });
          return {};
        },
      },
      geolocation: {
        getCurrentPosition(success) {
          success({ coords: { latitude: 10.0452, longitude: 105.7469, accuracy: 6.4 } });
        },
      },
    },
  });
  const windowListeners = new Map();
  Object.defineProperty(global, 'window', {
    configurable: true,
    value: {
      localStorage: storage,
      addEventListener(ev, fn) { windowListeners.set(ev, fn); },
      removeEventListener(ev) { windowListeners.delete(ev); },
    },
  });
  Object.defineProperty(global, 'document', {
    configurable: true,
    value: {
      head: {
        appendChild(node) { appendedHeadNodes.push(node); },
      },
      querySelector() { return null; },
      createElement(tag) { return { tagName: tag.toUpperCase(), attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } }; },
    },
  });

  try {
    const MobilePage = createMobileFieldPwaPage({ Plugin: class {} }, fakeReact, { apiClient: mockApiClient });
    let tree = fakeReact._render(MobilePage, { storage, apiClient: mockApiClient });
    fakeReact._flushEffects();

    assert.equal(registeredSw.length, 1);
    assert.equal(registeredSw[0].url, '/api/dxos:sw.js');
    assert.equal(registeredSw[0].opts.scope, '/');
    assert.ok(appendedHeadNodes.some((n) => n.rel === 'manifest' && n.href === '/api/dxos:manifest'));

    const syncBtn = findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-sync-btn');
    assert.ok(syncBtn);
    assert.ok(collectText(syncBtn).includes('Đồng bộ ngay (Sync)'));
    assert.ok(findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-queue-badge'));
    assert.ok(findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-qr-input'));
    assert.ok(findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-signature-canvas'));

    // Parse QR code
    const qrInput = findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-qr-input');
    qrInput.props.onChange({ target: { value: 'ORD-2026-888' } });
    tree = fakeReact._render(MobilePage, { storage, apiClient: mockApiClient });
    const parseBtn = findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-qr-parse-btn');
    parseBtn.props.onClick();
    tree = fakeReact._render(MobilePage, { storage, apiClient: mockApiClient });
    const orderInput = findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-order-input');
    assert.equal(orderInput.props.value, 'ORD-2026-888');

    // Capture GPS
    const gpsBtn = findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-gps-btn');
    gpsBtn.props.onClick();
    tree = fakeReact._render(MobilePage, { storage, apiClient: mockApiClient });
    const gpsDisplay = findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-gps-display');
    assert.ok(collectText(gpsDisplay).includes('10.0452'));
    assert.ok(collectText(gpsDisplay).includes('105.7469'));

    // Fill recipient, qty, and simulate canvas stroke + signature export
    findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-recipient-input').props.onChange({ target: { value: 'Nguyen Van Giao' } });
    findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-qty-input').props.onChange({ target: { value: '12' } });
    tree = fakeReact._render(MobilePage, { storage, apiClient: mockApiClient });

    const canvasNode = findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-signature-canvas');
    // Attach mock canvas context ref to simulate pointer draw
    const canvasMock = {
      width: 440,
      height: 160,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 440, height: 160 }),
      getContext: () => ({
        lineWidth: 2,
        lineCap: 'round',
        strokeStyle: '#0f172a',
        beginPath() {},
        moveTo() {},
        lineTo() {},
        stroke() {},
        clearRect() {},
      }),
      toDataURL: () => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
    };
    const canvasRef = fakeReact._refs.find((r) => r && r.current === null);
    if (canvasRef) canvasRef.current = canvasMock;
    canvasNode.props.onPointerDown({ clientX: 10, clientY: 10, pointerId: 1 });
    canvasNode.props.onPointerMove({ clientX: 50, clientY: 50, pointerId: 1 });
    canvasNode.props.onPointerUp({ pointerId: 1 });
    tree = fakeReact._render(MobilePage, { storage, apiClient: mockApiClient });

    // Submit online -> calls dxosWms:epodCapture and renders receipt
    const submitBtn = findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-epod-submit');
    await submitBtn.props.onClick({ preventDefault() {} });
    tree = fakeReact._render(MobilePage, { storage, apiClient: mockApiClient });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'dxosWms:epodCapture');
    assert.equal(requests[0].data.orderCode, 'ORD-2026-888');
    assert.equal(requests[0].data.recipientName, 'Nguyen Van Giao');
    assert.equal(requests[0].data.deliveredQty, 12);
    assert.equal(requests[0].data.gpsLat, 10.0452);
    assert.equal(requests[0].data.gpsLng, 105.7469);
    const receiptNode = findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-epod-receipt');
    assert.ok(receiptNode);
    assert.ok(collectText(receiptNode).includes('LDX-TRK-FIELD1'));

    // Submit during network failure -> automatically enqueues offline action
    failNetwork = true;
    await findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-epod-submit').props.onClick({ preventDefault() {} });
    tree = fakeReact._render(MobilePage, { storage, apiClient: mockApiClient });
    assert.equal(readOfflineQueue({ storage }).length, 1);
    const badge = findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-queue-badge');
    assert.ok(collectText(badge).includes('1'));

    // Restore network and click Sync -> drains offline queue to 0
    failNetwork = false;
    await findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-sync-btn').props.onClick();
    tree = fakeReact._render(MobilePage, { storage, apiClient: mockApiClient });
    assert.equal(readOfflineQueue({ storage }).length, 0);
    assert.ok(collectText(findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-queue-badge')).includes('0'));

    // Clear signature resets signature -> submitting without signing produces validation error without API call
    await findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-signature-clear').props.onClick();
    tree = fakeReact._render(MobilePage, { storage, apiClient: mockApiClient });
    const reqCountBeforeClearSubmit = requests.length;
    await findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-epod-submit').props.onClick({ preventDefault() {} });
    tree = fakeReact._render(MobilePage, { storage, apiClient: mockApiClient });
    assert.equal(requests.length, reqCountBeforeClearSubmit);
    assert.ok(collectText(findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-status-notice')).includes('chữ ký'));

    // Digital Twin quick setpoint offline fallback + online event auto-sync
    findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-twin-asset-input').props.onChange({ target: { value: '18' } });
    findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-twin-temp-input').props.onChange({ target: { value: '-20' } });
    tree = fakeReact._render(MobilePage, { storage, apiClient: mockApiClient });
    failNetwork = true;
    await findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-twin-submit').props.onClick({ preventDefault() {} });
    tree = fakeReact._render(MobilePage, { storage, apiClient: mockApiClient });
    assert.equal(readOfflineQueue({ storage }).length, 1);
    assert.equal(readOfflineQueue({ storage })[0].actionType, 'iot.twinSetDesired');

    failNetwork = false;
    await windowListeners.get('online')();
    assert.equal(readOfflineQueue({ storage }).length, 0);
    assert.equal(requests.at(-1).url, 'dxosBlocks:twinSetDesired');
    assert.deepEqual(requests.at(-1).data, { assetId: 18, desiredPatch: { targetTempC: -20 } });
  } finally {
    Object.defineProperty(global, 'navigator', { configurable: true, writable: true, value: prevGlobals.navigator });
    Object.defineProperty(global, 'window', { configurable: true, writable: true, value: prevGlobals.window });
    Object.defineProperty(global, 'document', { configurable: true, writable: true, value: prevGlobals.document });
    void onlineFlag;
  }

  // 3. Built dist/client-v2/index.js preserves exact AMD dependencies & registers /mobile route cleanly
  const distV2Path = join(PLUGIN_ROOT, 'dist/client-v2/index.js');
  const distV2Src = readFileSync(distV2Path, 'utf8');
  assert.doesNotMatch(distV2Src, /['"]@nocobase\/client['"]/);
  let loadedModule;
  const define = (name, deps, factory) => {
    assert.equal(name, '@latticedx/plugin-lattice-foundation/client-v2');
    assert.deepEqual(Array.from(deps), ['@nocobase/client-v2', 'react']);
    loadedModule = factory({ Plugin: class {} }, {});
  };
  define.amd = {};
  vm.runInNewContext(distV2Src, { define, sessionStorage: { getItem: () => null }, window: { location: { pathname: '/v/mobile' } } });
  const plugin = new loadedModule.default();
  const registeredRoutes = [];
  plugin.app = { router: { add: (name, route) => registeredRoutes.push({ name, ...route }) } };
  await plugin.load();
  assert.ok(registeredRoutes.some((r) => r.name === 'dxos-mobile-field' && r.path === '/mobile' && typeof r.Component === 'function'));

  // 4. SPDX Apache-2.0 header check on all Task 3.3 files
  const { addSourceHeader } = await import(pathToFileURL(join(REPO_ROOT, 'scripts/source-headers.mjs')).href);
  for (const rel of [
    'plugins/nocobase/plugin-lattice-foundation/src/server/mobile-pwa.js',
    'plugins/nocobase/plugin-lattice-foundation/src/server/observability.js',
    'plugins/nocobase/plugin-lattice-foundation/src/client-v2/mobile-offline-db.js',
    'plugins/nocobase/plugin-lattice-foundation/src/client-v2/mobile-field-pwa.js',
    'plugins/nocobase/plugin-lattice-foundation/src/client-v2/index.js',
    'plugins/nocobase/plugin-lattice-foundation/tests/mobile-field-pwa.test.cjs',
  ]) {
    const res = addSourceHeader(readFileSync(join(REPO_ROOT, rel), 'utf8'), rel);
    assert.equal(res.status, 'present', `${rel} missing valid SPDX Apache-2.0 header`);
  }
});

test('Fix Round 1 (Important 4 & Minor 4): strict numeric/URN/GPS validation & stored queue hardening', () => {
  const {
    OFFLINE_QUEUE_STORAGE_KEY,
    parseFieldQrPayload,
    buildEpodPayload,
    readOfflineQueue,
    sanitizeStoredQueueItem,
  } = require('../src/client-v2/mobile-field-pwa');

  // 1. Strict targetTempC parsing & [-80, 120] bounds
  for (const badTempTag of [
    '{"targetTempC":null}',
    '{"targetTempC":""}',
    '{"targetTempC":"   "}',
    '{"targetTempC":false}',
    '{"targetTempC":true}',
    '{"targetTempC":[]}',
    '{"targetTempC":{}}',
    '{"targetTempC":"Infinity"}',
    '{"targetTempC":"NaN"}',
    '{"targetTempC":-80.1}',
    '{"targetTempC":120.1}',
    '{"orderCode":"ORD-1","targetTempC":false}',
    '{"orderCode":"ORD-1","targetTempC":150}',
    '{"orderCode":"ORD-1","targetTempC":""}',
  ]) {
    const res = parseFieldQrPayload(badTempTag);
    assert.equal(res.valid, false, `Expected rejection for ${badTempTag}`);
  }
  const zeroTempTag = parseFieldQrPayload('{"assetId":5,"targetTempC":0}');
  assert.equal(zeroTempTag.valid, true);
  assert.equal(zeroTempTag.targetTempC, 0);
  const minTempTag = parseFieldQrPayload('{"assetId":5,"setpointC":-80}');
  assert.equal(minTempTag.valid, true);
  assert.equal(minTempTag.targetTempC, -80);
  const maxTempTag = parseFieldQrPayload('{"assetId":5,"targetTempC":120}');
  assert.equal(maxTempTag.valid, true);
  assert.equal(maxTempTag.targetTempC, 120);

  // 2. Strict URN positive integer assetId (rejects 0 & unsafe integers)
  const urnZero = parseFieldQrPayload('urn:ngsi-ld:Asset:org-ctu:native:0');
  assert.equal(urnZero.valid, true);
  assert.equal(urnZero.assetId, null);
  const urnShortZero = parseFieldQrPayload('urn:ngsi-ld:Asset:0');
  assert.equal(urnShortZero.valid, true);
  assert.equal(urnShortZero.assetId, null);
  const urnUnsafe = parseFieldQrPayload('urn:ngsi-ld:Asset:org-ctu:native:9999999999999999999');
  assert.equal(urnUnsafe.valid, true);
  assert.equal(urnUnsafe.assetId, null);
  const jsonUrnZero = parseFieldQrPayload('{"urn":"urn:ngsi-ld:Asset:org-ctu:native:0"}');
  assert.equal(jsonUrnZero.valid, true);
  assert.equal(jsonUrnZero.assetId, undefined);

  // 3. Strict buildEpodPayload GPS & qty coercion checks
  const validSig = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';
  for (const [lat, lng] of [
    [null, null],
    ['', ''],
    ['   ', '   '],
    [false, false],
    [[], []],
    [undefined, undefined],
    ['10.0452', ''],
    ['', '105.7469'],
    [Infinity, 105.7],
    [10.0, NaN],
    [91, 105],
    [10, -181],
  ]) {
    const built = buildEpodPayload({
      recipientName: 'Nguyen Van A',
      deliveredQty: 2,
      gpsLat: lat,
      gpsLng: lng,
      signatureDataUrl: validSig,
    });
    assert.equal(built.ok, false, `Expected GPS rejection for (${String(lat)}, ${String(lng)})`);
  }
  const badQty = buildEpodPayload({
    recipientName: 'Nguyen Van A',
    deliveredQty: false,
    gpsLat: 10.04,
    gpsLng: 105.74,
    signatureDataUrl: validSig,
  });
  assert.equal(badQty.ok, false);

  // Genuine (0, 0) coordinate remains valid
  const zeroGps = buildEpodPayload({
    recipientName: 'Nguyen Van A',
    deliveredQty: 0,
    gpsLat: 0,
    gpsLng: 0,
    signatureDataUrl: validSig,
  });
  assert.equal(zeroGps.ok, true);
  assert.equal(zeroGps.payload.gpsLat, 0);
  assert.equal(zeroGps.payload.gpsLng, 0);

  // 4. sanitizeStoredQueueItem & readOfflineQueue enforce 320KB cap and strip __proto__/constructor/prototype
  const storage = makeMemoryStorage();
  const oversizedSig = 'data:image/png;base64,' + 'A'.repeat(320 * 1024);
  const rawStored = JSON.stringify([
    {
      id: 'mq-oversized',
      actionType: 'wms.epodCapture',
      payload: { recipientName: 'Too Big', gpsLat: 10, gpsLng: 105, signatureDataUrl: oversizedSig },
    },
    JSON.parse('{"id":"mq-polluted","actionType":"iot.twinSetDesired","payload":{"assetId":7,"__proto__":{"polluted":true},"constructor":{"bad":1},"prototype":{"bad":2},"desiredPatch":{"targetTempC":-18,"__proto__":{"nested":1}}}}'),
  ]);
  storage.setItem(OFFLINE_QUEUE_STORAGE_KEY, rawStored);
  const sanitizedList = readOfflineQueue({ storage });
  assert.equal(sanitizedList.length, 1);
  assert.equal(sanitizedList[0].id, 'mq-polluted');
  assert.equal(Object.hasOwn(sanitizedList[0].payload, '__proto__'), false);
  assert.equal(Object.hasOwn(sanitizedList[0].payload, 'constructor'), false);
  assert.equal(Object.hasOwn(sanitizedList[0].payload, 'prototype'), false);
  assert.equal(Object.hasOwn(sanitizedList[0].payload.desiredPatch, '__proto__'), false);
  assert.equal(({}).polluted, undefined);
  assert.equal(sanitizeStoredQueueItem({
    id: 'mq-big-2',
    actionType: 'wms.epodCapture',
    payload: { signatureDataUrl: oversizedSig },
  }), null);
});

test('Fix Round 1 (Important 1): camera <video> srcObject binding & scan loop run after mount in useEffect and clean up on stop/unmount', async () => {
  const { createMobileFieldPwaPage } = require('../src/client-v2/mobile-field-pwa');
  const fakeReact = createFakeReact();
  const storage = makeMemoryStorage();
  const prevGlobals = {
    navigator: global.navigator,
    window: global.window,
    document: global.document,
    requestAnimationFrame: global.requestAnimationFrame,
    cancelAnimationFrame: global.cancelAnimationFrame,
  };

  let tracksStopped = 0;
  let playCalls = 0;
  let detectCalls = 0;
  const mockStream = {
    getTracks() {
      return [{ stop() { tracksStopped += 1; } }];
    },
  };
  let nextRafId = 1;
  const rafQueue = new Map();
  const canceledRafIds = [];

  Object.defineProperty(global, 'requestAnimationFrame', {
    configurable: true,
    value(cb) {
      const id = nextRafId++;
      rafQueue.set(id, cb);
      return id;
    },
  });
  Object.defineProperty(global, 'cancelAnimationFrame', {
    configurable: true,
    value(id) {
      canceledRafIds.push(id);
      rafQueue.delete(id);
    },
  });
  Object.defineProperty(global, 'navigator', {
    configurable: true,
    value: {
      onLine: true,
      mediaDevices: {
        getUserMedia: async () => mockStream,
      },
    },
  });
  Object.defineProperty(global, 'window', {
    configurable: true,
    value: {
      localStorage: storage,
      addEventListener() {},
      removeEventListener() {},
      BarcodeDetector: class {
        async detect(videoEl) {
          detectCalls += 1;
          assert.equal(videoEl.srcObject, mockStream);
          return [{ rawValue: 'ORD-2026-CAM1' }];
        }
      },
    },
  });
  Object.defineProperty(global, 'document', {
    configurable: true,
    value: {
      head: { appendChild() {} },
      querySelector() { return null; },
      createElement() { return {}; },
    },
  });

  try {
    const MobilePage = createMobileFieldPwaPage({ Plugin: class {} }, fakeReact, {});
    let tree = fakeReact._render(MobilePage, { storage, apiClient: { request: async () => ({ data: {} }) } });
    fakeReact._flushEffects();

    // Initially no <video> rendered
    assert.equal(findNode(tree, (n) => n.type === 'video'), null);

    // Click camera scan -> acquires stream and enables scannerActive, BEFORE <video> mounts
    const scanBtn = findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-qr-scan-btn');
    await scanBtn.props.onClick();

    // Re-render mounts <video ref={videoRef}>; simulate React populating ref before useEffect runs
    tree = fakeReact._render(MobilePage, { storage, apiClient: { request: async () => ({ data: {} }) } });
    const videoNode = findNode(tree, (n) => n.type === 'video');
    assert.ok(videoNode, '<video> must mount when scannerActive becomes true');
    const mockVideoEl = {
      srcObject: null,
      play() {
        playCalls += 1;
        return Promise.resolve();
      },
    };
    videoNode.props.ref.current = mockVideoEl;

    // Post-mount effect binds stream to videoRef.current.srcObject & starts BarcodeDetector loop
    fakeReact._flushEffects();
    assert.equal(mockVideoEl.srcObject, mockStream);
    assert.equal(playCalls, 1);
    assert.equal(rafQueue.size, 1);

    // Execute rAF scan tick -> detects ORD-2026-CAM1, fills orderCode, stops scanner & stream
    const [[, scanTick]] = [...rafQueue.entries()];
    rafQueue.clear();
    await scanTick();
    assert.equal(detectCalls, 1);
    assert.ok(tracksStopped >= 1);
    assert.equal(mockVideoEl.srcObject, null);

    tree = fakeReact._render(MobilePage, { storage, apiClient: { request: async () => ({ data: {} }) } });
    assert.equal(findNode(tree, (n) => n.type === 'video'), null);
    assert.equal(findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-order-input').props.value, 'ORD-2026-CAM1');

    // Start again and verify component unmount stops stream tracks and cancels rAF
    await findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-qr-scan-btn').props.onClick();
    tree = fakeReact._render(MobilePage, { storage, apiClient: { request: async () => ({ data: {} }) } });
    const videoNode2 = findNode(tree, (n) => n.type === 'video');
    const mockVideoEl2 = { srcObject: null, play: () => Promise.resolve() };
    videoNode2.props.ref.current = mockVideoEl2;
    fakeReact._flushEffects();
    const prevStopped = tracksStopped;
    fakeReact._unmount();
    assert.ok(tracksStopped > prevStopped);
    assert.ok(canceledRafIds.length >= 1);
  } finally {
    Object.defineProperty(global, 'navigator', { configurable: true, writable: true, value: prevGlobals.navigator });
    Object.defineProperty(global, 'window', { configurable: true, writable: true, value: prevGlobals.window });
    Object.defineProperty(global, 'document', { configurable: true, writable: true, value: prevGlobals.document });
    Object.defineProperty(global, 'requestAnimationFrame', { configurable: true, writable: true, value: prevGlobals.requestAnimationFrame });
    Object.defineProperty(global, 'cancelAnimationFrame', { configurable: true, writable: true, value: prevGlobals.cancelAnimationFrame });
  }
});

test('Fix Round 1 (Important 2, Important 3, Minor 2, Minor 3, Minor 4): quota handling, syncingRef lock, HITL/URN, 401 notice & empty online skip', async () => {
  const {
    MAX_OFFLINE_QUEUE_ITEMS,
    enqueueOfflineAction,
    readOfflineQueue,
    createMobileFieldPwaPage,
  } = require('../src/client-v2/mobile-field-pwa');

  const prevGlobals = {
    navigator: global.navigator,
    window: global.window,
    document: global.document,
  };

  let isNavigatorOnline = false;
  const windowListeners = new Map();
  const storage = makeMemoryStorage();

  Object.defineProperty(global, 'navigator', {
    configurable: true,
    value: {
      get onLine() { return isNavigatorOnline; },
    },
  });
  Object.defineProperty(global, 'window', {
    configurable: true,
    value: {
      localStorage: storage,
      addEventListener(ev, fn) { windowListeners.set(ev, fn); },
      removeEventListener(ev) { windowListeners.delete(ev); },
    },
  });
  Object.defineProperty(global, 'document', {
    configurable: true,
    value: { head: { appendChild() {} }, querySelector() { return null; }, createElement() { return {}; } },
  });

  try {
    // Part A: Important 2 — 50-item full queue & QuotaExceededError in submitEpod / submitTwinDesired never throw unhandled rejections
    for (let i = 0; i < MAX_OFFLINE_QUEUE_ITEMS; i += 1) {
      enqueueOfflineAction({ actionType: 'iot.twinSetDesired', payload: { assetId: i + 1, desiredPatch: { targetTempC: 4 } } }, { storage });
    }
    const fakeReactA = createFakeReact();
    const MobilePageA = createMobileFieldPwaPage({ Plugin: class {} }, fakeReactA, {});
    // Also test Minor 4: props.testSignatureDataUrl is ignored
    let treeA = fakeReactA._render(MobilePageA, {
      storage,
      apiClient: { request: async () => ({ data: {} }) },
      testSignatureDataUrl: 'data:image/png;base64,SHOULD_BE_IGNORED',
    });
    fakeReactA._flushEffects();

    findNode(treeA, (n) => n.props?.['data-testid'] === 'mobile-pwa-recipient-input').props.onChange({ target: { value: 'Anh Binh' } });
    findNode(treeA, (n) => n.props?.['data-testid'] === 'mobile-pwa-lat-input').props.onChange({ target: { value: '10.04' } });
    findNode(treeA, (n) => n.props?.['data-testid'] === 'mobile-pwa-lng-input').props.onChange({ target: { value: '105.74' } });
    treeA = fakeReactA._render(MobilePageA, {
      storage,
      apiClient: { request: async () => ({ data: {} }) },
      testSignatureDataUrl: 'data:image/png;base64,SHOULD_BE_IGNORED',
    });
    // Without canvas signature, testSignatureDataUrl prop MUST NOT bypass signature check
    const noSigRes = await findNode(treeA, (n) => n.props?.['data-testid'] === 'mobile-pwa-epod-submit').props.onClick({ preventDefault() {} });
    assert.equal(noSigRes, null);
    treeA = fakeReactA._render(MobilePageA, { storage, apiClient: { request: async () => ({ data: {} }) } });
    assert.ok(collectText(findNode(treeA, (n) => n.props?.['data-testid'] === 'mobile-pwa-status-notice')).includes('chữ ký'));

    // Draw signature via canvas mock, then hit OFFLINE_QUEUE_FULL cleanly on submitEpod & submitTwinDesired
    const canvasNodeA = findNode(treeA, (n) => n.props?.['data-testid'] === 'mobile-pwa-signature-canvas');
    canvasNodeA.props.ref.current = {
      width: 440,
      height: 160,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 440, height: 160 }),
      getContext: () => ({ beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, clearRect() {} }),
      toDataURL: () => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
    };
    canvasNodeA.props.onPointerDown({ clientX: 5, clientY: 5, pointerId: 1 });
    canvasNodeA.props.onPointerUp({ pointerId: 1 });
    treeA = fakeReactA._render(MobilePageA, { storage, apiClient: { request: async () => ({ data: {} }) } });

    const epodFullRes = await findNode(treeA, (n) => n.props?.['data-testid'] === 'mobile-pwa-epod-submit').props.onClick({ preventDefault() {} });
    assert.equal(epodFullRes, null);
    treeA = fakeReactA._render(MobilePageA, { storage, apiClient: { request: async () => ({ data: {} }) } });
    assert.ok(collectText(findNode(treeA, (n) => n.props?.['data-testid'] === 'mobile-pwa-status-notice')).includes('50/50'));

    findNode(treeA, (n) => n.props?.['data-testid'] === 'mobile-pwa-twin-asset-input').props.onChange({ target: { value: '12' } });
    findNode(treeA, (n) => n.props?.['data-testid'] === 'mobile-pwa-twin-temp-input').props.onChange({ target: { value: '-18' } });
    treeA = fakeReactA._render(MobilePageA, { storage, apiClient: { request: async () => ({ data: {} }) } });
    const twinFullRes = await findNode(treeA, (n) => n.props?.['data-testid'] === 'mobile-pwa-twin-submit').props.onClick({ preventDefault() {} });
    assert.equal(twinFullRes, null);
    treeA = fakeReactA._render(MobilePageA, { storage, apiClient: { request: async () => ({ data: {} }) } });
    assert.ok(collectText(findNode(treeA, (n) => n.props?.['data-testid'] === 'mobile-pwa-status-notice')).includes('đầy'));

    // QuotaExceededError storage simulation
    const quotaStorage = {
      getItem: () => null,
      setItem() {
        throw Object.assign(new Error('DOM Exception 22'), { name: 'QuotaExceededError', code: 22 });
      },
    };
    const fakeReactQ = createFakeReact();
    const MobilePageQ = createMobileFieldPwaPage({ Plugin: class {} }, fakeReactQ, {});
    let treeQ = fakeReactQ._render(MobilePageQ, { storage: quotaStorage, apiClient: { request: async () => ({ data: {} }) } });
    fakeReactQ._flushEffects();
    findNode(treeQ, (n) => n.props?.['data-testid'] === 'mobile-pwa-twin-asset-input').props.onChange({ target: { value: '12' } });
    findNode(treeQ, (n) => n.props?.['data-testid'] === 'mobile-pwa-twin-temp-input').props.onChange({ target: { value: '-18' } });
    treeQ = fakeReactQ._render(MobilePageQ, { storage: quotaStorage, apiClient: { request: async () => ({ data: {} }) } });
    const quotaRes = await findNode(treeQ, (n) => n.props?.['data-testid'] === 'mobile-pwa-twin-submit').props.onClick({ preventDefault() {} });
    assert.equal(quotaRes, null);
    treeQ = fakeReactQ._render(MobilePageQ, { storage: quotaStorage, apiClient: { request: async () => ({ data: {} }) } });
    assert.ok(collectText(findNode(treeQ, (n) => n.props?.['data-testid'] === 'mobile-pwa-status-notice')).includes('vượt dung lượng'));

    // Part B: Important 3 + Minor 2 + Minor 3 — Concurrent handleSync lock, 401 notice, empty online skip, HITL & URN
    isNavigatorOnline = true;
    const syncStorage = makeMemoryStorage();
    enqueueOfflineAction({
      actionType: 'wms.epodCapture',
      payload: { recipientName: 'Concurrent Test', deliveredQty: 1, gpsLat: 10, gpsLng: 105, signatureDataUrl: 'data:image/png;base64,AAA' },
    }, { storage: syncStorage });

    let epodPostCalls = 0;
    let releaseFirstSync;
    let mockMode = 'deferred-sync';
    const twinCalls = [];
    const syncApiClient = {
      async request(req) {
        if (req.url === 'dxosWms:epodCapture') {
          epodPostCalls += 1;
          if (mockMode === 'deferred-sync') {
            await new Promise((resolve) => { releaseFirstSync = resolve; });
            return { data: { trackingCode: 'LDX-TRK-SYNC1' } };
          }
          if (mockMode === '401') {
            throw Object.assign(new Error('Unauthorized'), { response: { status: 401 } });
          }
        }
        if (req.url === 'dxosBlocks:twinSetDesired') {
          twinCalls.push(req.data);
          return { data: { gatedByHitl: true, approvalId: 407 } };
        }
        return { data: { ok: true } };
      },
    };

    const fakeReactB = createFakeReact();
    const MobilePageB = createMobileFieldPwaPage({ Plugin: class {} }, fakeReactB, {});
    let treeB = fakeReactB._render(MobilePageB, { storage: syncStorage, apiClient: syncApiClient });
    fakeReactB._flushEffects();

    // Simultaneous Sync button click + browser 'online' event + duplicate click MUST send only 1 POST
    const syncBtn = findNode(treeB, (n) => n.props?.['data-testid'] === 'mobile-pwa-sync-btn');
    const p1 = syncBtn.props.onClick();
    const p2 = windowListeners.get('online')();
    const p3 = syncBtn.props.onClick();
    assert.equal(epodPostCalls, 1);
    releaseFirstSync();
    await Promise.all([p1, p2, p3]);
    assert.equal(epodPostCalls, 1);
    assert.equal(readOfflineQueue({ storage: syncStorage }).length, 0);

    // Minor 3: Empty queue 'online' event skips auto-sync and does NOT emit "Hàng đợi ngoại tuyến đang trống."
    treeB = fakeReactB._render(MobilePageB, { storage: syncStorage, apiClient: syncApiClient });
    findNode(treeB, (n) => n.props?.['data-testid'] === 'mobile-pwa-qr-input').props.onChange({
      target: { value: 'urn:ngsi-ld:Asset:org-ctu:edge:chiller-1' },
    });
    treeB = fakeReactB._render(MobilePageB, { storage: syncStorage, apiClient: syncApiClient });
    findNode(treeB, (n) => n.props?.['data-testid'] === 'mobile-pwa-qr-parse-btn').props.onClick();
    treeB = fakeReactB._render(MobilePageB, { storage: syncStorage, apiClient: syncApiClient });
    const noticeBeforeEmptyOnline = collectText(findNode(treeB, (n) => n.props?.['data-testid'] === 'mobile-pwa-status-notice'));
    assert.ok(noticeBeforeEmptyOnline.includes('URN'));
    await windowListeners.get('online')();
    treeB = fakeReactB._render(MobilePageB, { storage: syncStorage, apiClient: syncApiClient });
    assert.equal(
      collectText(findNode(treeB, (n) => n.props?.['data-testid'] === 'mobile-pwa-status-notice')),
      noticeBeforeEmptyOnline,
    );

    // Minor 2: Non-numeric URN populated twinAssetId, temp range validated [-80, 120], gatedByHitl renders HITL approval notice
    assert.equal(
      findNode(treeB, (n) => n.props?.['data-testid'] === 'mobile-pwa-twin-asset-input').props.value,
      'urn:ngsi-ld:Asset:org-ctu:edge:chiller-1',
    );
    findNode(treeB, (n) => n.props?.['data-testid'] === 'mobile-pwa-twin-temp-input').props.onChange({ target: { value: '150' } });
    treeB = fakeReactB._render(MobilePageB, { storage: syncStorage, apiClient: syncApiClient });
    await findNode(treeB, (n) => n.props?.['data-testid'] === 'mobile-pwa-twin-submit').props.onClick({ preventDefault() {} });
    assert.equal(twinCalls.length, 0);
    treeB = fakeReactB._render(MobilePageB, { storage: syncStorage, apiClient: syncApiClient });
    assert.ok(collectText(findNode(treeB, (n) => n.props?.['data-testid'] === 'mobile-pwa-status-notice')).includes('[-80, 120]'));

    findNode(treeB, (n) => n.props?.['data-testid'] === 'mobile-pwa-twin-temp-input').props.onChange({ target: { value: '4' } });
    treeB = fakeReactB._render(MobilePageB, { storage: syncStorage, apiClient: syncApiClient });
    const hitlRes = await findNode(treeB, (n) => n.props?.['data-testid'] === 'mobile-pwa-twin-submit').props.onClick({ preventDefault() {} });
    assert.equal(hitlRes.gatedByHitl, true);
    assert.equal(hitlRes.approvalId, 407);
    assert.deepEqual(twinCalls[0], { assetEntityId: 'urn:ngsi-ld:Asset:org-ctu:edge:chiller-1', desiredPatch: { targetTempC: 4 } });
    treeB = fakeReactB._render(MobilePageB, { storage: syncStorage, apiClient: syncApiClient });
    const hitlNotice = collectText(findNode(treeB, (n) => n.props?.['data-testid'] === 'mobile-pwa-status-notice'));
    assert.ok(hitlNotice.includes('HITL'));
    assert.ok(hitlNotice.includes('407'));

    // Minor 3: 401 deferred queue item advises re-login instead of offline notice
    mockMode = '401';
    enqueueOfflineAction({
      actionType: 'wms.epodCapture',
      payload: { recipientName: 'Auth Retry', deliveredQty: 1, gpsLat: 10, gpsLng: 105, signatureDataUrl: 'data:image/png;base64,AAA' },
    }, { storage: syncStorage });
    await findNode(treeB, (n) => n.props?.['data-testid'] === 'mobile-pwa-sync-btn').props.onClick();
    treeB = fakeReactB._render(MobilePageB, { storage: syncStorage, apiClient: syncApiClient });
    assert.equal(readOfflineQueue({ storage: syncStorage }).length, 1);
    const unauthNotice = collectText(findNode(treeB, (n) => n.props?.['data-testid'] === 'mobile-pwa-status-notice'));
    assert.ok(unauthNotice.includes('Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại'));
  } finally {
    Object.defineProperty(global, 'navigator', { configurable: true, writable: true, value: prevGlobals.navigator });
    Object.defineProperty(global, 'window', { configurable: true, writable: true, value: prevGlobals.window });
    Object.defineProperty(global, 'document', { configurable: true, writable: true, value: prevGlobals.document });
  }
});

function createMockIndexedDb({ failOpen = false, quotaExceededOnPut = false } = {}) {
  const databases = new Map();
  let lastDbHandle = null;

  function makeRequest(executor) {
    const req = { result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
    queueMicrotask(() => executor(req));
    return req;
  }

  const factory = {
    _databases: databases,
    _getLastDb: () => lastDbHandle,
    open(name, version = 1) {
      const req = { result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
      queueMicrotask(() => {
        if (failOpen) {
          const err = Object.assign(new Error('IndexedDB disabled in private mode'), { name: 'InvalidStateError' });
          req.error = err;
          req.onerror?.({ target: req });
          return;
        }
        let dbState = databases.get(name);
        const needsUpgrade = !dbState || dbState.version < version;
        if (!dbState) {
          dbState = { name, version, stores: new Map() };
          databases.set(name, dbState);
        } else {
          dbState.version = version;
        }
        const dbHandle = {
          name,
          version,
          closed: false,
          objectStoreNames: {
            contains: (storeName) => dbState.stores.has(storeName),
          },
          createObjectStore(storeName, opts = {}) {
            if (!dbState.stores.has(storeName)) {
              dbState.stores.set(storeName, { keyPath: opts.keyPath || 'id', records: new Map(), indexes: new Set() });
            }
            const storeMeta = dbState.stores.get(storeName);
            return {
              createIndex(idxName) { storeMeta.indexes.add(idxName); },
            };
          },
          close() { dbHandle.closed = true; },
          transaction(storeNames) {
            const list = Array.isArray(storeNames) ? storeNames : [storeNames];
            const tx = { oncomplete: null, onerror: null, onabort: null, error: null };
            let pendingOps = 0;
            let txFailed = false;
            const maybeComplete = () => {
              if (!txFailed && pendingOps === 0) {
                queueMicrotask(() => tx.oncomplete?.({ target: tx }));
              }
            };
            tx.objectStore = (storeName) => {
              if (!list.includes(storeName) || !dbState.stores.has(storeName)) {
                throw new Error(`Missing objectStore ${storeName}`);
              }
              const storeMeta = dbState.stores.get(storeName);
              return {
                getAll() {
                  pendingOps += 1;
                  return makeRequest((r) => {
                    r.result = Array.from(storeMeta.records.values()).map((v) => JSON.parse(JSON.stringify(v)));
                    r.onsuccess?.({ target: r });
                    pendingOps -= 1;
                    maybeComplete();
                  });
                },
                get(key) {
                  pendingOps += 1;
                  return makeRequest((r) => {
                    const hit = storeMeta.records.get(key);
                    r.result = hit ? JSON.parse(JSON.stringify(hit)) : undefined;
                    r.onsuccess?.({ target: r });
                    pendingOps -= 1;
                    maybeComplete();
                  });
                },
                put(value) {
                  pendingOps += 1;
                  return makeRequest((r) => {
                    if (quotaExceededOnPut) {
                      const err = Object.assign(new Error('DOM Exception 22'), { name: 'QuotaExceededError', code: 22 });
                      r.error = err;
                      tx.error = err;
                      txFailed = true;
                      r.onerror?.({ target: r });
                      tx.onerror?.({ target: tx });
                      return;
                    }
                    const k = value[storeMeta.keyPath];
                    storeMeta.records.set(k, JSON.parse(JSON.stringify(value)));
                    r.result = k;
                    r.onsuccess?.({ target: r });
                    pendingOps -= 1;
                    maybeComplete();
                  });
                },
                delete(key) {
                  pendingOps += 1;
                  return makeRequest((r) => {
                    storeMeta.records.delete(key);
                    r.result = undefined;
                    r.onsuccess?.({ target: r });
                    pendingOps -= 1;
                    maybeComplete();
                  });
                },
              };
            };
            return tx;
          },
        };
        lastDbHandle = dbHandle;
        req.result = dbHandle;
        if (needsUpgrade && typeof req.onupgradeneeded === 'function') {
          req.onupgradeneeded({ target: req, oldVersion: 0, newVersion: version });
        }
        req.onsuccess?.({ target: req });
      });
      return req;
    },
  };
  return factory;
}

test('Task 17 (mobile-offline-db): IndexedDB outbox CRUD, status transitions, quota handling & localStorage/memory fallback', async () => {
  const {
    OUTBOX_DB_NAME,
    OUTBOX_STORE_NAME,
    MAX_OUTBOX_ITEMS,
    enqueueOutboxItem,
    listOutboxItems,
    removeOutboxItem,
    updateOutboxStatus,
    resetMemoryOutboxStore,
  } = require('../src/client-v2/mobile-offline-db');

  assert.equal(OUTBOX_DB_NAME, 'latticedx-mobile-outbox');
  assert.equal(OUTBOX_STORE_NAME, 'outbox');
  assert.equal(MAX_OUTBOX_ITEMS, 50);

  // 1. IndexedDB path when globalThis.indexedDB is present
  const prevIdb = globalThis.indexedDB;
  const mockIdb = createMockIndexedDb();
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, writable: true, value: mockIdb });
  try {
    const item1 = await enqueueOutboxItem({
      actionType: 'wms.epodCapture',
      payload: {
        orderCode: 'ORD-IDB-1',
        recipientName: 'Tran Thi B',
        deliveredQty: 4,
        gpsLat: 10.03,
        gpsLng: 105.78,
        signatureDataUrl: 'data:image/png;base64,AAAA',
        evidencePhotoDataUrl: 'data:image/jpeg;base64,PHOTO_DATA_1',
      },
    });
    assert.ok(item1.id.startsWith('mq-'));
    assert.equal(item1.status, 'pending');
    assert.equal(item1.endpoint, 'dxosWms:epodCapture');
    assert.equal(item1.payload.evidencePhotoDataUrl, 'data:image/jpeg;base64,PHOTO_DATA_1');

    const item2 = await enqueueOutboxItem({
      actionType: 'iot.twinSetDesired',
      payload: { assetId: 99, desiredPatch: { targetTempC: -18 } },
    });
    const list1 = await listOutboxItems();
    assert.equal(list1.length, 2);
    assert.equal(list1[0].id, item1.id);
    assert.equal(list1[1].id, item2.id);

    const updated = await updateOutboxStatus(item1.id, {
      status: 'failed',
      attempts: 2,
      lastError: '503 Service Unavailable',
      httpStatus: 503,
    });
    assert.equal(updated.status, 'failed');
    assert.equal(updated.attempts, 2);
    assert.equal(updated.lastError, '503 Service Unavailable');
    assert.equal(updated.httpStatus, 503);

    const failedOnly = await listOutboxItems({ status: 'failed' });
    assert.equal(failedOnly.length, 1);
    assert.equal(failedOnly[0].id, item1.id);

    const remaining = await removeOutboxItem(item1.id);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].id, item2.id);

    // Rejects unsupported action & prototype pollution
    await assert.rejects(
      () => enqueueOutboxItem({ actionType: 'dxosApiKeys:issue', payload: {} }),
      { code: 'UNSUPPORTED_OFFLINE_ACTION' },
    );
    await assert.rejects(
      () => enqueueOutboxItem({ actionType: 'wms.epodCapture', payload: null }),
      { code: 'INVALID_OFFLINE_PAYLOAD' },
    );
  } finally {
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, writable: true, value: prevIdb });
  }

  // 2. IndexedDB QuotaExceededError propagates cleanly as OFFLINE_STORAGE_QUOTA_EXCEEDED
  const quotaIdb = createMockIndexedDb({ quotaExceededOnPut: true });
  await assert.rejects(
    () => enqueueOutboxItem({ actionType: 'iot.twinSetDesired', payload: { assetId: 1, desiredPatch: { targetTempC: 2 } } }, { indexedDB: quotaIdb }),
    { code: 'OFFLINE_STORAGE_QUOTA_EXCEEDED' },
  );

  // 3. Fallback to localStorage when IndexedDB open fails (e.g. private browsing)
  const failingIdb = createMockIndexedDb({ failOpen: true });
  const fallbackStorage = makeMemoryStorage();
  const lsItem = await enqueueOutboxItem(
    { actionType: 'wms.epodCapture', payload: { orderCode: 'ORD-LS-1', recipientName: 'Anh C', gpsLat: 10, gpsLng: 105, signatureDataUrl: 'data:image/png;base64,AAA' } },
    { indexedDB: failingIdb, storage: fallbackStorage },
  );
  assert.equal((await listOutboxItems({ indexedDB: failingIdb, storage: fallbackStorage })).length, 1);
  await updateOutboxStatus(lsItem.id, 'failed', { indexedDB: failingIdb, storage: fallbackStorage });
  assert.equal((await listOutboxItems({ indexedDB: failingIdb, storage: fallbackStorage }))[0].status, 'failed');
  await removeOutboxItem(lsItem.id, { indexedDB: failingIdb, storage: fallbackStorage });
  assert.equal((await listOutboxItems({ indexedDB: failingIdb, storage: fallbackStorage })).length, 0);

  // 4. Fallback to in-memory store when both IndexedDB and localStorage are unavailable
  resetMemoryOutboxStore();
  const prevWin = global.window;
  Object.defineProperty(global, 'window', { configurable: true, writable: true, value: undefined });
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, writable: true, value: undefined });
  try {
    const memItem = await enqueueOutboxItem({
      actionType: 'iot.twinSetDesired',
      payload: { assetId: 7, desiredPatch: { targetTempC: -20 } },
    });
    assert.equal((await listOutboxItems()).length, 1);
    await updateOutboxStatus(memItem.id, { status: 'failed', lastError: 'Offline' });
    assert.equal((await listOutboxItems())[0].status, 'failed');
    await removeOutboxItem(memItem.id);
    assert.equal((await listOutboxItems()).length, 0);
  } finally {
    Object.defineProperty(global, 'window', { configurable: true, writable: true, value: prevWin });
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, writable: true, value: prevIdb });
  }
});

test('Task 17 (ePOD photo capture): attaches evidencePhotoDataUrl in online submit & IndexedDB offline queue', async () => {
  const { buildEpodPayload, createMobileFieldPwaPage } = require('../src/client-v2/mobile-field-pwa');
  const { listOutboxItems } = require('../src/client-v2/mobile-offline-db');

  // 1. buildEpodPayload validates & includes evidencePhotoDataUrl
  const validSig = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';
  const validPhoto = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/';
  const okWithPhoto = buildEpodPayload({
    orderCode: 'ORD-PHOTO-1',
    recipientName: 'Le Van Anh',
    deliveredQty: 5,
    gpsLat: 10.04,
    gpsLng: 105.74,
    signatureDataUrl: validSig,
    evidencePhotoDataUrl: validPhoto,
  });
  assert.equal(okWithPhoto.ok, true);
  assert.equal(okWithPhoto.payload.evidencePhotoDataUrl, validPhoto);

  const badPhoto = buildEpodPayload({
    recipientName: 'Le Van Anh',
    deliveredQty: 5,
    gpsLat: 10.04,
    gpsLng: 105.74,
    signatureDataUrl: validSig,
    evidencePhotoDataUrl: 'javascript:alert(1)',
  });
  assert.equal(badPhoto.ok, false);

  const svgPhoto = buildEpodPayload({
    recipientName: 'Le Van Anh',
    deliveredQty: 5,
    gpsLat: 10.04,
    gpsLng: 105.74,
    signatureDataUrl: validSig,
    evidencePhotoDataUrl: 'data:image/svg+xml;base64,PHN2Zz4=',
  });
  assert.equal(svgPhoto.ok, false);

  // 2. UI photo upload + camera snapshot + online/offline persistence into IndexedDB
  const fakeReact = createFakeReact();
  const storage = makeMemoryStorage();
  const mockIdb = createMockIndexedDb();
  const requests = [];
  let failNetwork = false;
  const mockApi = {
    async request(req) {
      requests.push(req);
      if (failNetwork) throw new Error('Network offline');
      return { data: { epod: { epodUid: 'EPOD-PHOTO-1', trackingCode: 'LDX-TRK-PH1' }, trackingCode: 'LDX-TRK-PH1' } };
    },
  };

  const prevGlobals = {
    navigator: global.navigator,
    window: global.window,
    document: global.document,
    indexedDB: globalThis.indexedDB,
    FileReader: globalThis.FileReader,
  };

  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, writable: true, value: mockIdb });
  Object.defineProperty(globalThis, 'FileReader', {
    configurable: true,
    writable: true,
    value: class FakeFileReader {
      readAsDataURL(file) {
        queueMicrotask(() => {
          this.result = file._mockDataUrl || validPhoto;
          this.onload?.({ target: this });
        });
      }
    },
  });
  Object.defineProperty(global, 'navigator', {
    configurable: true,
    value: { onLine: true },
  });
  Object.defineProperty(global, 'window', {
    configurable: true,
    value: { localStorage: storage, addEventListener() {}, removeEventListener() {} },
  });
  Object.defineProperty(global, 'document', {
    configurable: true,
    value: { head: { appendChild() {} }, querySelector() { return null; }, createElement() { return {}; } },
  });

  try {
    const MobilePage = createMobileFieldPwaPage({ Plugin: class {} }, fakeReact, {});
    let tree = fakeReact._render(MobilePage, { storage, indexedDB: mockIdb, apiClient: mockApi });
    fakeReact._flushEffects();

    // Fill required fields + signature
    findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-order-input').props.onChange({ target: { value: 'ORD-PHOTO-1' } });
    findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-recipient-input').props.onChange({ target: { value: 'Le Van Anh' } });
    findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-lat-input').props.onChange({ target: { value: '10.04' } });
    findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-lng-input').props.onChange({ target: { value: '105.74' } });
    tree = fakeReact._render(MobilePage, { storage, indexedDB: mockIdb, apiClient: mockApi });

    const canvasNode = findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-signature-canvas');
    canvasNode.props.ref.current = {
      width: 440,
      height: 160,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 440, height: 160 }),
      getContext: () => ({ beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, clearRect() {} }),
      toDataURL: () => validSig,
    };
    canvasNode.props.onPointerDown({ clientX: 5, clientY: 5, pointerId: 1 });
    canvasNode.props.onPointerUp({ pointerId: 1 });

    // Attach camera photo via file input
    const photoInput = findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-photo-input');
    assert.ok(photoInput, 'Photo capture input must be rendered');
    await photoInput.props.onChange({ target: { files: [{ type: 'image/jpeg', size: 1024, _mockDataUrl: validPhoto }] } });
    await new Promise((r) => setTimeout(r, 10));

    tree = fakeReact._render(MobilePage, { storage, indexedDB: mockIdb, apiClient: mockApi });
    const preview = findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-photo-preview');
    assert.ok(preview, 'Photo preview must be rendered after capture');
    assert.equal(preview.props.src, validPhoto);

    // Online submit carries evidencePhotoDataUrl
    await findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-epod-submit').props.onClick({ preventDefault() {} });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].data.evidencePhotoDataUrl, validPhoto);

    // Offline submit persists evidencePhotoDataUrl in IndexedDB outbox
    failNetwork = true;
    await findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-epod-submit').props.onClick({ preventDefault() {} });
    const idbItems = await listOutboxItems({ indexedDB: mockIdb, storage });
    assert.equal(idbItems.length, 1);
    assert.equal(idbItems[0].payload.evidencePhotoDataUrl, validPhoto);

    // Clear photo clears preview
    tree = fakeReact._render(MobilePage, { storage, indexedDB: mockIdb, apiClient: mockApi });
    findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-photo-clear').props.onClick();
    tree = fakeReact._render(MobilePage, { storage, indexedDB: mockIdb, apiClient: mockApi });
    assert.equal(findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-photo-preview'), null);
  } finally {
    Object.defineProperty(global, 'navigator', { configurable: true, writable: true, value: prevGlobals.navigator });
    Object.defineProperty(global, 'window', { configurable: true, writable: true, value: prevGlobals.window });
    Object.defineProperty(global, 'document', { configurable: true, writable: true, value: prevGlobals.document });
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, writable: true, value: prevGlobals.indexedDB });
    Object.defineProperty(globalThis, 'FileReader', { configurable: true, writable: true, value: prevGlobals.FileReader });
  }
});

test('Task 17 (cross-platform QR): camera video/canvas + manual fallback when BarcodeDetector is unavailable (Safari/iOS/Firefox)', async () => {
  const { createMobileFieldPwaPage } = require('../src/client-v2/mobile-field-pwa');
  const fakeReact = createFakeReact();
  const storage = makeMemoryStorage();
  const prevGlobals = {
    navigator: global.navigator,
    window: global.window,
    document: global.document,
  };

  let tracksStopped = 0;
  let drawImageCalls = 0;
  const mockStream = {
    getTracks() {
      return [{ stop() { tracksStopped += 1; } }];
    },
  };
  Object.defineProperty(global, 'navigator', {
    configurable: true,
    value: {
      onLine: true,
      mediaDevices: { getUserMedia: async () => mockStream },
    },
  });
  // No BarcodeDetector on window (Safari/iOS/Firefox scenario)
  Object.defineProperty(global, 'window', {
    configurable: true,
    value: { localStorage: storage, addEventListener() {}, removeEventListener() {} },
  });
  Object.defineProperty(global, 'document', {
    configurable: true,
    value: { head: { appendChild() {} }, querySelector() { return null; }, createElement() { return {}; } },
  });

  try {
    const decodedFrames = [];
    const MobilePage = createMobileFieldPwaPage({ Plugin: class {} }, fakeReact, {});
    const qrFrameDecoder = (imageData) => {
      decodedFrames.push(imageData);
      return 'ORD-SAFARI-2026';
    };
    let tree = fakeReact._render(MobilePage, { storage, apiClient: { request: async () => ({ data: {} }) }, qrFrameDecoder });
    fakeReact._flushEffects();

    // Start camera scanner without BarcodeDetector -> activates video + canvas fallback
    await findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-qr-scan-btn').props.onClick();
    tree = fakeReact._render(MobilePage, { storage, apiClient: { request: async () => ({ data: {} }) }, qrFrameDecoder });

    const videoNode = findNode(tree, (n) => n.type === 'video');
    const qrCanvasNode = findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-qr-canvas');
    const captureFrameBtn = findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-qr-capture-frame-btn');
    const fallbackBadge = findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-qr-fallback-badge');
    assert.ok(videoNode, 'Camera <video> must open even when BarcodeDetector is unavailable');
    assert.ok(qrCanvasNode, 'Fallback QR <canvas> must be rendered');
    assert.ok(captureFrameBtn, 'Capture QR frame button must be rendered in fallback mode');
    assert.ok(fallbackBadge, 'Fallback mode badge must be visible');

    videoNode.props.ref.current = { srcObject: null, videoWidth: 320, videoHeight: 240, play: () => Promise.resolve() };
    qrCanvasNode.props.ref.current = {
      width: 320,
      height: 240,
      getContext: () => ({
        drawImage() { drawImageCalls += 1; },
        getImageData: () => ({ width: 320, height: 240, data: new Uint8ClampedArray(320 * 240 * 4) }),
      }),
      toDataURL: () => 'data:image/png;base64,FRAME',
    };
    fakeReact._flushEffects();

    await captureFrameBtn.props.onClick();
    assert.equal(drawImageCalls, 1);
    assert.equal(decodedFrames.length, 1);
    assert.ok(tracksStopped >= 1);

    tree = fakeReact._render(MobilePage, { storage, apiClient: { request: async () => ({ data: {} }) }, qrFrameDecoder });
    assert.equal(findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-order-input').props.value, 'ORD-SAFARI-2026');
  } finally {
    Object.defineProperty(global, 'navigator', { configurable: true, writable: true, value: prevGlobals.navigator });
    Object.defineProperty(global, 'window', { configurable: true, writable: true, value: prevGlobals.window });
    Object.defineProperty(global, 'document', { configurable: true, writable: true, value: prevGlobals.document });
  }
});

test('Task 17 (Outbox Inspector & Notification Badge SSE): lists pending/failed items, Retry individual/all, Delete, and live SSE unread count', async () => {
  const { createMobileFieldPwaPage } = require('../src/client-v2/mobile-field-pwa');
  const { enqueueOutboxItem, updateOutboxStatus, listOutboxItems } = require('../src/client-v2/mobile-offline-db');

  const fakeReact = createFakeReact();
  const storage = makeMemoryStorage();
  const mockIdb = createMockIndexedDb();

  const itemPending = await enqueueOutboxItem({
    actionType: 'iot.twinSetDesired',
    payload: { assetId: 101, desiredPatch: { targetTempC: -18 } },
  }, { indexedDB: mockIdb, storage });
  const itemFailed = await enqueueOutboxItem({
    actionType: 'wms.epodCapture',
    payload: { orderCode: 'ORD-FAIL-1', recipientName: 'Pham D', deliveredQty: 2, gpsLat: 10, gpsLng: 105, signatureDataUrl: 'data:image/png;base64,AAA' },
  }, { indexedDB: mockIdb, storage });
  await updateOutboxStatus(itemFailed.id, { status: 'failed', attempts: 2, lastError: '503 Gateway Timeout', httpStatus: 503 }, { indexedDB: mockIdb, storage });

  const prevGlobals = {
    navigator: global.navigator,
    window: global.window,
    document: global.document,
    indexedDB: globalThis.indexedDB,
    fetch: globalThis.fetch,
  };

  const encoder = new TextEncoder();
  const fetchCalls = [];
  let pushSseChunk = null;
  let closeSseStream = null;
  const mockFetch = async (url, init) => {
    const ctrlState = { aborted: false };
    init?.signal?.addEventListener?.('abort', () => {
      ctrlState.aborted = true;
      closeSseStream?.();
    });
    fetchCalls.push({ url, init, ctrlState });
    const pending = ['event: snapshot\ndata: {"portalSlug":"mobile","revision":1}\n\n'];
    let waitingResolve = null;
    let closed = false;
    pushSseChunk = (raw) => {
      if (closed) return;
      if (waitingResolve) {
        const r = waitingResolve;
        waitingResolve = null;
        r({ done: false, value: encoder.encode(raw) });
      } else {
        pending.push(raw);
      }
    };
    closeSseStream = () => {
      closed = true;
      if (waitingResolve) {
        const r = waitingResolve;
        waitingResolve = null;
        r({ done: true });
      }
    };
    return {
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: async () => {
            if (pending.length) return { done: false, value: encoder.encode(pending.shift()) };
            if (closed) return { done: true };
            return new Promise((resolve) => { waitingResolve = resolve; });
          },
          cancel: async () => { closeSseStream(); },
        }),
      },
    };
  };

  let failRetry = false;
  let serverUnread = 3;
  const apiCalls = [];
  const authApi = {
    auth: { role: 'ldx_driver', getToken: () => 'jwt-mobile-1' },
    async request(req) {
      apiCalls.push(req);
      if (req.url === 'latticeNotifications:unreadCount') {
        return { data: { data: { unreadCount: serverUnread } } };
      }
      if (req.url === 'latticeNotifications:listMine') {
        return { data: { data: { unreadCount: serverUnread, items: [{ id: 9, category: 'alarm', severity: 'high', title: 'Cảnh báo nhiệt độ Kho A', readAt: null }] } } };
      }
      if (req.url === 'dxosWms:epodCapture' && failRetry) {
        throw Object.assign(new Error('503 Retry Failed'), { response: { status: 503 } });
      }
      return { data: { ok: true } };
    },
  };

  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, writable: true, value: mockIdb });
  Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: mockFetch });
  Object.defineProperty(global, 'navigator', { configurable: true, value: { onLine: true } });
  Object.defineProperty(global, 'window', {
    configurable: true,
    value: { localStorage: storage, addEventListener() {}, removeEventListener() {} },
  });
  Object.defineProperty(global, 'document', {
    configurable: true,
    value: { head: { appendChild() {} }, querySelector() { return null; }, createElement() { return {}; } },
  });

  try {
    const MobilePage = createMobileFieldPwaPage({ Plugin: class {} }, fakeReact, {});
    let tree = fakeReact._render(MobilePage, { storage, indexedDB: mockIdb, apiClient: authApi });
    fakeReact._flushEffects();
    await new Promise((r) => setTimeout(r, 20));
    tree = fakeReact._render(MobilePage, { storage, indexedDB: mockIdb, apiClient: authApi });

    // 1. Header notification badge shows unreadCount = 3 and updates via authenticated fetch() SSE
    const notifBadge = findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-notif-badge');
    assert.ok(notifBadge, 'Notification badge must render in header');
    assert.ok(collectText(notifBadge).includes('3'));
    assert.equal(fetchCalls.length, 1, 'Authenticated fetch SSE must subscribe');
    assert.equal(fetchCalls[0].url, '/api/dxosAi:surfaceEvents?portalSlug=mobile');
    assert.equal(fetchCalls[0].init.headers.Authorization, 'Bearer jwt-mobile-1');
    assert.equal(fetchCalls[0].init.headers.Accept, 'text/event-stream');

    pushSseChunk('event: notification\ndata: {"unreadCount":7}\n\n');
    await new Promise((r) => setTimeout(r, 15));
    tree = fakeReact._render(MobilePage, { storage, indexedDB: mockIdb, apiClient: authApi });
    assert.ok(collectText(findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-notif-badge')).includes('7'));

    serverUnread = 9;
    pushSseChunk('event: update\ndata: {"kind":"notification","type":"notification","portalSlug":"mobile"}\n\n');
    await new Promise((r) => setTimeout(r, 20));
    tree = fakeReact._render(MobilePage, { storage, indexedDB: mockIdb, apiClient: authApi });
    assert.ok(collectText(findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-notif-badge')).includes('9'));
    serverUnread = 3;

    // Click notif badge -> opens notification panel & loads listMine
    await findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-notif-badge').props.onClick();
    tree = fakeReact._render(MobilePage, { storage, indexedDB: mockIdb, apiClient: authApi });
    const notifPanel = findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-notif-panel');
    assert.ok(notifPanel);
    assert.ok(collectText(notifPanel).includes('Cảnh báo nhiệt độ Kho A'));

    // 2. Queue badge shows 2 items; clicking opens Outbox Inspector drawer
    assert.ok(collectText(findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-queue-badge')).includes('2'));
    findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-queue-badge').props.onClick();
    tree = fakeReact._render(MobilePage, { storage, indexedDB: mockIdb, apiClient: authApi });

    const drawer = findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-outbox-drawer');
    assert.ok(drawer, 'Outbox Inspector drawer must open');
    assert.ok(collectText(drawer).includes('503 Gateway Timeout'));
    assert.ok(findNode(drawer, (n) => n.props?.['data-testid'] === `mobile-pwa-outbox-item-${itemPending.id}`));
    assert.ok(findNode(drawer, (n) => n.props?.['data-testid'] === `mobile-pwa-outbox-item-${itemFailed.id}`));

    // 3. Delete itemPending -> removes from IndexedDB and updates badge count to 1
    await findNode(drawer, (n) => n.props?.['data-testid'] === `mobile-pwa-outbox-delete-${itemPending.id}`).props.onClick();
    tree = fakeReact._render(MobilePage, { storage, indexedDB: mockIdb, apiClient: authApi });
    assert.equal((await listOutboxItems({ indexedDB: mockIdb, storage })).length, 1);
    assert.ok(collectText(findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-queue-badge')).includes('1'));

    // 4. Retry individual item (failure keeps item with incremented attempts, then success drains it to 0)
    failRetry = true;
    await findNode(tree, (n) => n.props?.['data-testid'] === `mobile-pwa-outbox-retry-${itemFailed.id}`).props.onClick();
    const afterFailedRetry = await listOutboxItems({ indexedDB: mockIdb, storage });
    assert.equal(afterFailedRetry.length, 1);
    assert.equal(afterFailedRetry[0].status, 'failed');
    assert.equal(afterFailedRetry[0].attempts, 3);

    failRetry = false;
    tree = fakeReact._render(MobilePage, { storage, indexedDB: mockIdb, apiClient: authApi });
    await findNode(tree, (n) => n.props?.['data-testid'] === `mobile-pwa-outbox-retry-${itemFailed.id}`).props.onClick();
    tree = fakeReact._render(MobilePage, { storage, indexedDB: mockIdb, apiClient: authApi });
    assert.equal((await listOutboxItems({ indexedDB: mockIdb, storage })).length, 0);
    assert.ok(collectText(findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-queue-badge')).includes('0'));

    // 5. Retry all button triggers sync across remaining items
    await enqueueOutboxItem({
      actionType: 'iot.twinSetDesired',
      payload: { assetId: 202, desiredPatch: { targetTempC: 2 } },
    }, { indexedDB: mockIdb, storage });
    await findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-outbox-retry-all').props.onClick();
    assert.equal((await listOutboxItems({ indexedDB: mockIdb, storage })).length, 0);

    fakeReact._unmount();
    assert.equal(fetchCalls[0].ctrlState.aborted, true, 'Authenticated fetch SSE stream must abort on unmount');
  } finally {
    Object.defineProperty(global, 'navigator', { configurable: true, writable: true, value: prevGlobals.navigator });
    Object.defineProperty(global, 'window', { configurable: true, writable: true, value: prevGlobals.window });
    Object.defineProperty(global, 'document', { configurable: true, writable: true, value: prevGlobals.document });
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, writable: true, value: prevGlobals.indexedDB });
    Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: prevGlobals.fetch });
  }
});

test('Task 4 (Review Focus #1): MobileFieldPwaPage makes ZERO SSE or unreadCount requests when NOCOBASE_TOKEN is empty', async () => {
  const { createMobileFieldPwaPage, isAuthenticatedMobileClient } = require('../src/client-v2/mobile-field-pwa');
  const fakeReact = createFakeReact();
  const storage = makeMemoryStorage();
  const mockIdb = createMockIndexedDb();
  const prevGlobals = {
    navigator: global.navigator,
    window: global.window,
    document: global.document,
    indexedDB: globalThis.indexedDB,
    fetch: globalThis.fetch,
  };
  const fetchCalls = [];
  let apiCalls = 0;
  const unauthApi = {
    auth: { role: 'ldx_driver', getToken: () => '' },
    request: async () => { apiCalls += 1; return { data: {} }; },
  };
  assert.equal(isAuthenticatedMobileClient(unauthApi, storage), false);

  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, writable: true, value: mockIdb });
  Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: async (u, i) => { fetchCalls.push({ u, i }); return { ok: true, body: null }; } });
  Object.defineProperty(global, 'navigator', { configurable: true, value: { onLine: true } });
  Object.defineProperty(global, 'window', { configurable: true, value: { localStorage: storage, addEventListener() {}, removeEventListener() {} } });
  Object.defineProperty(global, 'document', { configurable: true, value: { head: { appendChild() {} }, querySelector() { return null; }, createElement() { return {}; } } });
  try {
    const MobilePage = createMobileFieldPwaPage({ Plugin: class {} }, fakeReact, {});
    fakeReact._render(MobilePage, { storage, indexedDB: mockIdb, apiClient: unauthApi });
    fakeReact._flushEffects();
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(fetchCalls.length, 0, 'Unauthenticated PWA must make ZERO fetch SSE calls');
    assert.equal(apiCalls, 0, 'Unauthenticated PWA must make ZERO unreadCount API calls');
    fakeReact._unmount();
  } finally {
    Object.defineProperty(global, 'navigator', { configurable: true, writable: true, value: prevGlobals.navigator });
    Object.defineProperty(global, 'window', { configurable: true, writable: true, value: prevGlobals.window });
    Object.defineProperty(global, 'document', { configurable: true, writable: true, value: prevGlobals.document });
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, writable: true, value: prevGlobals.indexedDB });
    Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: prevGlobals.fetch });
  }
});

test('Task 16 baseline (mobile-offline-db): preserves deterministic FIFO order for items enqueued in the same millisecond', async () => {
  const {
    enqueueOutboxItem,
    listOutboxItems,
    resetMemoryOutboxStore,
  } = require('../src/client-v2/mobile-offline-db');

  const origNow = Date.now;
  const fixedTs = 1795500000000;
  Date.now = () => fixedTs;
  try {
    // 1. IndexedDB same-ms ordering (10 rapid enqueues)
    const mockIdb = createMockIndexedDb();
    const idbIds = [];
    for (let i = 0; i < 10; i += 1) {
      const item = await enqueueOutboxItem({
        actionType: 'iot.twinSetDesired',
        payload: { assetId: 1000 + i, desiredPatch: { targetTempC: -18 } },
      }, { indexedDB: mockIdb });
      idbIds.push(item.id);
    }
    const idbListed = await listOutboxItems({ indexedDB: mockIdb });
    assert.deepEqual(idbListed.map((x) => x.id), idbIds);
    assert.deepEqual(idbListed.map((x) => x.payload.assetId), Array.from({ length: 10 }, (_, i) => 1000 + i));

    // 2. localStorage fallback same-ms ordering
    const storage = makeMemoryStorage();
    const failingIdb = createMockIndexedDb({ failOpen: true });
    const lsIds = [];
    for (let i = 0; i < 6; i += 1) {
      const item = await enqueueOutboxItem({
        actionType: 'iot.twinSetDesired',
        payload: { assetId: 2000 + i, desiredPatch: { targetTempC: -15 } },
      }, { indexedDB: failingIdb, storage });
      lsIds.push(item.id);
    }
    const lsListed = await listOutboxItems({ indexedDB: failingIdb, storage });
    assert.deepEqual(lsListed.map((x) => x.id), lsIds);

    // 3. In-memory fallback same-ms ordering
    resetMemoryOutboxStore();
    const memIds = [];
    for (let i = 0; i < 6; i += 1) {
      const item = await enqueueOutboxItem({
        actionType: 'iot.twinSetDesired',
        payload: { assetId: 3000 + i, desiredPatch: { targetTempC: -12 } },
      }, { useIndexedDB: false });
      memIds.push(item.id);
    }
    const memListed = await listOutboxItems({ useIndexedDB: false });
    assert.deepEqual(memListed.map((x) => x.id), memIds);
  } finally {
    Date.now = origNow;
  }
});
