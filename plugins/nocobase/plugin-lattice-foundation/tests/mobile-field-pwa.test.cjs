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
  const effects = [];

  function resetCursors() {
    stateCursor = 0;
    refCursor = 0;
    effects.length = 0;
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
    useEffect(fn) {
      effects.push(fn);
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
      for (const fn of effects.splice(0)) {
        const res = fn();
        if (typeof res === 'function') cleanups.push(res);
      }
      return cleanups;
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
  const swScript = buildServiceWorkerScript({ version: '1.0.0' });
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

  // Online response with no-store must NEVER be written into Cache Storage
  fetchMode = 'online';
  let noStorePromise = null;
  listeners.get('fetch')({
    request: { method: 'GET', url: 'https://field.latticedx.local/v/assets/private-nostore.js', mode: 'cors' },
    respondWith(p) { noStorePromise = p; },
  });
  assert.ok(noStorePromise);
  await noStorePromise;
  const activeCache = openedCaches.get('latticedx-field-pwa-v1.0.0');
  assert.equal(activeCache._entries.has('/v/assets/private-nostore.js'), false);

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
    'plugins/nocobase/plugin-lattice-foundation/src/client-v2/mobile-field-pwa.js',
    'plugins/nocobase/plugin-lattice-foundation/src/client-v2/index.js',
    'plugins/nocobase/plugin-lattice-foundation/tests/mobile-field-pwa.test.cjs',
  ]) {
    const res = addSourceHeader(readFileSync(join(REPO_ROOT, rel), 'utf8'), rel);
    assert.equal(res.status, 'present', `${rel} missing valid SPDX Apache-2.0 header`);
  }
});
