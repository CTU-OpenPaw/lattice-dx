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

function findAllNodes(node, predicate, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (predicate(node)) out.push(node);
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      findAllNodes(child, predicate, out);
    }
  }
  return out;
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
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 2);
  assert.ok(manifest.icons.some((ic) => ic.src === '/api/dxos:icon-192.png' && ic.sizes === '192x192' && ic.type === 'image/png'));
  assert.ok(manifest.icons.some((ic) => ic.src === '/api/dxos:icon-512.png' && ic.sizes === '512x512' && ic.type === 'image/png'));
  const manifestJson = JSON.stringify(manifest).toLowerCase();
  for (const forbidden of ['password', 'secret', 'token', 'apikey', 'organizationid', 'userid', 'email']) {
    assert.equal(manifestJson.includes(forbidden), false, `Manifest must not leak ${forbidden}`);
  }

  // 2. Service Worker Script syntax + runtime Cache Storage invariants
  const swScript = buildServiceWorkerScript({ version: '0.4.2' });
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
  assert.deepEqual(cachedKeys.sort(), ['/api/dxos:icon-192.png', '/api/dxos:icon-512.png', '/api/dxos:manifest', '/v/mobile']);

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
  const activeCache = openedCaches.get('latticedx-field-pwa-v0.4.2');
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

  // Flush FIFO behavior: 200 succeeded (removed), 400 invalid (quarantined), 403 forbidden (quarantined), 503 & network error (deferred/failed)
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
  assert.equal(flushRes.quarantined, 2);
  assert.equal(flushRes.deferred, 2);
  const remaining = readOfflineQueue({ storage: flushStorage });
  assert.deepEqual(remaining.map((r) => r.id), [q2.id, q3.id, q4.id, q5.id]);
  const q2Stored = remaining.find((r) => r.id === q2.id);
  const q3Stored = remaining.find((r) => r.id === q3.id);
  const q4Stored = remaining.find((r) => r.id === q4.id);
  assert.equal(q2Stored.status, 'quarantined');
  assert.equal(q2Stored.httpStatus, 400);
  assert.match(q2Stored.lastError, /Validation failed/);
  assert.equal(q3Stored.status, 'quarantined');
  assert.equal(q3Stored.httpStatus, 403);
  assert.equal(q4Stored.status, 'failed');
  assert.equal(q4Stored.attempts, 1);
  assert.ok(!remaining.some((r) => r.id === q1.id));
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
    auth: { role: 'ldx_manager', getToken: () => 'jwt-field-test' },
    async request(req) {
      if (req.url === 'roles:check') {
        return {
          data: {
            data: {
              allowAll: false,
              resources: ['latticeOrders', 'latticeAssets', 'latticeIncidentCases', 'latticeServiceTickets'],
              actions: { 'latticeAssets:update': true, 'latticeIncidentCases:create': true },
            },
          },
        };
      }
      if ([
        'latticeNotifications:unreadCount',
        'dxosApprovals:listInbox',
        'latticeOrders:list',
        'latticeIncidentCases:list',
        'latticeServiceTickets:list',
      ].includes(req.url)) {
        return { data: { data: { items: [], unreadCount: 0 } } };
      }
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
    fetch: globalThis.fetch,
  };
  let onlineFlag = true;
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: async () => ({ ok: true, status: 200, body: null }),
  });
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
    assert.equal(findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-twin-submit'), null);
    assert.equal(findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-incident-create-toggle'), null);
    fakeReact._flushEffects();
    await new Promise((r) => setTimeout(r, 20));
    tree = fakeReact._render(MobilePage, { storage, apiClient: mockApiClient });

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
    fakeReact._unmount();
  } finally {
    Object.defineProperty(global, 'navigator', { configurable: true, writable: true, value: prevGlobals.navigator });
    Object.defineProperty(global, 'window', { configurable: true, writable: true, value: prevGlobals.window });
    Object.defineProperty(global, 'document', { configurable: true, writable: true, value: prevGlobals.document });
    Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: prevGlobals.fetch });
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
    fetch: globalThis.fetch,
  };

  let isNavigatorOnline = true;
  const windowListeners = new Map();
  const storage = makeMemoryStorage();

  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: async () => ({ ok: true, status: 200, body: null }),
  });
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

  const makeRoleGrantApi = () => ({
    auth: { role: 'ldx_manager', getToken: () => 'jwt-round1' },
    async request(req) {
      if (req.url === 'roles:check') {
        return {
          data: {
            data: {
              allowAll: false,
              resources: ['latticeOrders', 'latticeAssets', 'latticeIncidentCases', 'latticeServiceTickets'],
              actions: { 'latticeAssets:update': true, 'latticeIncidentCases:create': true },
            },
          },
        };
      }
      return { data: {} };
    },
  });

  try {
    // Part A: Important 2 — 50-item full queue & QuotaExceededError in submitEpod / submitTwinDesired never throw unhandled rejections
    for (let i = 0; i < MAX_OFFLINE_QUEUE_ITEMS; i += 1) {
      enqueueOfflineAction({ actionType: 'iot.twinSetDesired', payload: { assetId: i + 1, desiredPatch: { targetTempC: 4 } } }, { storage });
    }
    const partAApi = makeRoleGrantApi();
    const fakeReactA = createFakeReact();
    const MobilePageA = createMobileFieldPwaPage({ Plugin: class {} }, fakeReactA, {});
    // Also test Minor 4: props.testSignatureDataUrl is ignored
    let treeA = fakeReactA._render(MobilePageA, {
      storage,
      apiClient: partAApi,
      testSignatureDataUrl: 'data:image/png;base64,SHOULD_BE_IGNORED',
    });
    fakeReactA._flushEffects();
    await new Promise((r) => setTimeout(r, 20));
    isNavigatorOnline = false;
    windowListeners.get('offline')?.();
    treeA = fakeReactA._render(MobilePageA, {
      storage,
      apiClient: partAApi,
      testSignatureDataUrl: 'data:image/png;base64,SHOULD_BE_IGNORED',
    });

    findNode(treeA, (n) => n.props?.['data-testid'] === 'mobile-pwa-recipient-input').props.onChange({ target: { value: 'Anh Binh' } });
    findNode(treeA, (n) => n.props?.['data-testid'] === 'mobile-pwa-lat-input').props.onChange({ target: { value: '10.04' } });
    findNode(treeA, (n) => n.props?.['data-testid'] === 'mobile-pwa-lng-input').props.onChange({ target: { value: '105.74' } });
    treeA = fakeReactA._render(MobilePageA, {
      storage,
      apiClient: partAApi,
      testSignatureDataUrl: 'data:image/png;base64,SHOULD_BE_IGNORED',
    });
    // Without canvas signature, testSignatureDataUrl prop MUST NOT bypass signature check
    const noSigRes = await findNode(treeA, (n) => n.props?.['data-testid'] === 'mobile-pwa-epod-submit').props.onClick({ preventDefault() {} });
    assert.equal(noSigRes, null);
    treeA = fakeReactA._render(MobilePageA, { storage, apiClient: partAApi });
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
    treeA = fakeReactA._render(MobilePageA, { storage, apiClient: partAApi });

    const epodFullRes = await findNode(treeA, (n) => n.props?.['data-testid'] === 'mobile-pwa-epod-submit').props.onClick({ preventDefault() {} });
    assert.equal(epodFullRes, null);
    treeA = fakeReactA._render(MobilePageA, { storage, apiClient: partAApi });
    assert.ok(collectText(findNode(treeA, (n) => n.props?.['data-testid'] === 'mobile-pwa-status-notice')).includes('50/50'));

    findNode(treeA, (n) => n.props?.['data-testid'] === 'mobile-pwa-twin-asset-input').props.onChange({ target: { value: '12' } });
    findNode(treeA, (n) => n.props?.['data-testid'] === 'mobile-pwa-twin-temp-input').props.onChange({ target: { value: '-18' } });
    treeA = fakeReactA._render(MobilePageA, { storage, apiClient: partAApi });
    const twinFullRes = await findNode(treeA, (n) => n.props?.['data-testid'] === 'mobile-pwa-twin-submit').props.onClick({ preventDefault() {} });
    assert.equal(twinFullRes, null);
    treeA = fakeReactA._render(MobilePageA, { storage, apiClient: partAApi });
    assert.ok(collectText(findNode(treeA, (n) => n.props?.['data-testid'] === 'mobile-pwa-status-notice')).includes('đầy'));
    fakeReactA._unmount();

    // QuotaExceededError storage simulation
    const quotaStorage = {
      getItem: () => null,
      setItem() {
        throw Object.assign(new Error('DOM Exception 22'), { name: 'QuotaExceededError', code: 22 });
      },
    };
    isNavigatorOnline = true;
    const partQApi = makeRoleGrantApi();
    const fakeReactQ = createFakeReact();
    const MobilePageQ = createMobileFieldPwaPage({ Plugin: class {} }, fakeReactQ, {});
    let treeQ = fakeReactQ._render(MobilePageQ, { storage: quotaStorage, apiClient: partQApi });
    fakeReactQ._flushEffects();
    await new Promise((r) => setTimeout(r, 20));
    isNavigatorOnline = false;
    windowListeners.get('offline')?.();
    treeQ = fakeReactQ._render(MobilePageQ, { storage: quotaStorage, apiClient: partQApi });
    findNode(treeQ, (n) => n.props?.['data-testid'] === 'mobile-pwa-twin-asset-input').props.onChange({ target: { value: '12' } });
    findNode(treeQ, (n) => n.props?.['data-testid'] === 'mobile-pwa-twin-temp-input').props.onChange({ target: { value: '-18' } });
    treeQ = fakeReactQ._render(MobilePageQ, { storage: quotaStorage, apiClient: partQApi });
    const quotaRes = await findNode(treeQ, (n) => n.props?.['data-testid'] === 'mobile-pwa-twin-submit').props.onClick({ preventDefault() {} });
    assert.equal(quotaRes, null);
    treeQ = fakeReactQ._render(MobilePageQ, { storage: quotaStorage, apiClient: partQApi });
    assert.ok(collectText(findNode(treeQ, (n) => n.props?.['data-testid'] === 'mobile-pwa-status-notice')).includes('vượt dung lượng'));
    fakeReactQ._unmount();

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
      auth: { role: 'ldx_manager', getToken: () => 'jwt-part-b' },
      async request(req) {
        if (req.url === 'roles:check') {
          return {
            data: {
              data: {
                allowAll: false,
                resources: ['latticeOrders', 'latticeAssets', 'latticeIncidentCases', 'latticeServiceTickets'],
                actions: { 'latticeAssets:update': true, 'latticeIncidentCases:create': true },
              },
            },
          };
        }
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
    await new Promise((r) => setTimeout(r, 20));
    treeB = fakeReactB._render(MobilePageB, { storage: syncStorage, apiClient: syncApiClient });

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
    fakeReactB._unmount();
  } finally {
    Object.defineProperty(global, 'navigator', { configurable: true, writable: true, value: prevGlobals.navigator });
    Object.defineProperty(global, 'window', { configurable: true, writable: true, value: prevGlobals.window });
    Object.defineProperty(global, 'document', { configurable: true, writable: true, value: prevGlobals.document });
    Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: prevGlobals.fetch });
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

    // 3. Delete itemPending (2-step inline confirmation) -> removes from IndexedDB and updates badge count to 1
    await findNode(drawer, (n) => n.props?.['data-testid'] === `mobile-pwa-outbox-delete-${itemPending.id}`).props.onClick();
    tree = fakeReact._render(MobilePage, { storage, indexedDB: mockIdb, apiClient: authApi });
    await findNode(tree, (n) => n.props?.['data-testid'] === `mobile-pwa-outbox-delete-confirm-${itemPending.id}`).props.onClick();
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

test('MobileFieldPwaPage renders above-the-fold approvals/deliveries/incidents/tickets cards and collapsible AI pill/drawer', async () => {
  const { createMobileFieldPwaPage } = require('../src/client-v2/mobile-field-pwa');
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

  const apiCalls = [];
  const authApi = {
    auth: { role: 'ldx_manager', getToken: () => 'jwt-ops-mobile' },
    async request(req) {
      apiCalls.push(req);
      if (req.url === 'latticeNotifications:unreadCount') return { data: { data: { unreadCount: 1 } } };
      if (req.url === 'dxosApprovals:listInbox') {
        return { data: { data: { items: [{ id: 101, source: 'approval', title: 'Duyệt đơn lạnh #ORD-V100', riskLevel: 'high', summary: 'Vượt ngưỡng 200tr' }] } } };
      }
      if (req.url === 'latticeOrders:list') {
        return { data: { data: [{ id: 55, code: 'ORD-V100-001', name: 'Giao vắc-xin Cần Thơ', destination: 'Bệnh viện Cần Thơ', status: 'in_transit' }] } };
      }
      if (req.url === 'latticeIncidentCases:list') {
        return { data: { data: [{ id: 77, code: 'INC-077', name: 'Cảnh báo nhiệt kho A2', severity: 'critical', status: 'open' }] } };
      }
      if (req.url === 'latticeServiceTickets:list') {
        return { data: { data: [{ id: 88, code: 'TKT-088', name: 'Bảo trì cảm biến cửa kho', priority: 'high', status: 'submitted' }] } };
      }
      if (req.url === 'dxosApprovals:decide') return { data: { data: { ok: true } } };
      if (req.url === 'dxosAi:agentChat') return { data: { data: { reply: 'Đơn ORD-V100-001 đang giao đúng lộ trình.' } } };
      return { data: {} };
    },
  };

  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, writable: true, value: mockIdb });
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: async (_u, init) => ({
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: () => new Promise((_, reject) => {
            init?.signal?.addEventListener?.('abort', () => {
              reject(Object.assign(new Error('BodyStreamBuffer was aborted'), { name: 'AbortError' }));
            });
          }),
          cancel: async () => { throw Object.assign(new Error('BodyStreamBuffer was aborted'), { name: 'AbortError' }); },
        }),
      },
    }),
  });
  Object.defineProperty(global, 'navigator', { configurable: true, value: { onLine: true } });
  Object.defineProperty(global, 'window', { configurable: true, value: { localStorage: storage, addEventListener() {}, removeEventListener() {} } });
  Object.defineProperty(global, 'document', { configurable: true, value: { head: { appendChild() {} }, querySelector() { return null; }, createElement() { return {}; } } });

  try {
    const MobilePage = createMobileFieldPwaPage({ Plugin: class {} }, fakeReact, {});
    let tree = fakeReact._render(MobilePage, { storage, indexedDB: mockIdb, apiClient: authApi });
    fakeReact._flushEffects();
    await new Promise((r) => setTimeout(r, 25));
    tree = fakeReact._render(MobilePage, { storage, indexedDB: mockIdb, apiClient: authApi });

    const aboveFold = findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-above-fold-cards');
    assert.ok(aboveFold, 'Above-the-fold operations cards section must render');
    const aboveText = collectText(aboveFold);
    assert.ok(aboveText.includes('Duyệt đơn lạnh #ORD-V100'));
    assert.ok(aboveText.includes('ORD-V100-001'));
    assert.ok(aboveText.includes('INC-077'));
    assert.ok(aboveText.includes('TKT-088'));

    // Select delivery order -> prefills ePOD orderCode
    await findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-delivery-select-55').props.onClick();
    tree = fakeReact._render(MobilePage, { storage, indexedDB: mockIdb, apiClient: authApi });
    assert.equal(findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-order-input').props.value, 'ORD-V100-001');

    // Approve pending item inline
    await findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-approval-approve-101').props.onClick();
    tree = fakeReact._render(MobilePage, { storage, indexedDB: mockIdb, apiClient: authApi });
    assert.ok(apiCalls.some((c) => c.url === 'dxosApprovals:decide' && c.data?.decision === 'approved'));
    assert.equal(findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-approval-card-101'), null);

    // AI assistant starts collapsed as pill, opens drawer on click
    assert.equal(findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-ai-drawer'), null);
    findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-ai-pill').props.onClick();
    tree = fakeReact._render(MobilePage, { storage, indexedDB: mockIdb, apiClient: authApi });
    assert.ok(findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-ai-drawer'));

    fakeReact._unmount();
    await new Promise((r) => setTimeout(r, 15));
  } finally {
    Object.defineProperty(global, 'navigator', { configurable: true, writable: true, value: prevGlobals.navigator });
    Object.defineProperty(global, 'window', { configurable: true, writable: true, value: prevGlobals.window });
    Object.defineProperty(global, 'document', { configurable: true, writable: true, value: prevGlobals.document });
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, writable: true, value: prevGlobals.indexedDB });
    Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: prevGlobals.fetch });
  }
});

test('P0-02: quarantined outbox items (400/403/404/422/409) are never auto-deleted, skipped during bulk flush, editable via updateOutboxItem, exportable, and conflict-resolvable', async () => {
  const {
    enqueueOutboxItem,
    listOutboxItems,
    updateOutboxItem,
    resetMemoryOutboxStore,
  } = require('../src/client-v2/mobile-offline-db');
  const { flushOfflineQueue, createMobileFieldPwaPage } = require('../src/client-v2/mobile-field-pwa');

  resetMemoryOutboxStore();
  const storage = makeMemoryStorage();
  const q404 = await enqueueOutboxItem({
    actionType: 'wms.epodCapture',
    payload: { orderCode: 'ORD-BAD-404', recipientName: 'Khách A', deliveredQty: 2, gpsLat: 10, gpsLng: 105, signatureDataUrl: 'data:image/png;base64,AAA' },
  }, { useIndexedDB: false, storage });
  const q409 = await enqueueOutboxItem({
    actionType: 'wms.epodCapture',
    payload: { orderCode: 'ORD-CONF-409', recipientName: 'Khách B', deliveredQty: 3, gpsLat: 10, gpsLng: 105, signatureDataUrl: 'data:image/png;base64,BBB' },
  }, { useIndexedDB: false, storage });

  const sent = [];
  const res1 = await flushOfflineQueue({
    useIndexedDB: false,
    storage,
    isOnline: true,
    apiClient: {
      async request(req) {
        sent.push(req.data.orderCode);
        if (req.data.orderCode === 'ORD-BAD-404') {
          throw Object.assign(new Error('Not Found'), { response: { status: 404, data: { errors: [{ message: 'Không tìm thấy đơn ORD-BAD-404' }] } } });
        }
        throw Object.assign(new Error('Conflict'), { response: { status: 409, data: { message: 'Đơn đã được ký bởi tài xế khác', serverRecord: { status: 'delivered', recipientName: 'Server User' } } } });
      },
    },
  });
  assert.equal(res1.quarantined, 2);
  assert.equal(res1.conflicts, 1);

  const after1 = await listOutboxItems({ useIndexedDB: false, storage });
  assert.equal(after1.length, 2);
  assert.equal(after1[0].status, 'quarantined');
  assert.equal(after1[0].httpStatus, 404);
  assert.equal(after1[0].lastError, 'Không tìm thấy đơn ORD-BAD-404');
  assert.equal(after1[1].status, 'quarantined');
  assert.equal(after1[1].httpStatus, 409);
  assert.equal(after1[1].conflictData.serverRecord.recipientName, 'Server User');

  // Auto-sync skips quarantined items while syncing newly queued pending items
  const qOk = await enqueueOutboxItem({
    actionType: 'iot.twinSetDesired',
    payload: { assetId: 11, desiredPatch: { targetTempC: 3 } },
  }, { useIndexedDB: false, storage });
  sent.length = 0;
  const res2 = await flushOfflineQueue({
    useIndexedDB: false,
    storage,
    isOnline: true,
    apiClient: {
      async request(req) {
        sent.push(req.url);
        return { data: { ok: true } };
      },
    },
  });
  assert.deepEqual(sent, ['dxosBlocks:twinSetDesired']);
  assert.equal(res2.synced, 1);

  // Edit orderCode via updateOutboxItem & retry in UI
  const updated = await updateOutboxItem(q404.id, {
    payload: { ...after1[0].payload, orderCode: 'ORD-FIXED-200' },
    status: 'pending',
    lastError: null,
    httpStatus: null,
  }, { useIndexedDB: false, storage });
  assert.equal(updated.payload.orderCode, 'ORD-FIXED-200');
  assert.equal(updated.status, 'pending');

  const fakeReact = createFakeReact();
  const prevGlobals = { navigator: global.navigator, window: global.window, document: global.document };
  const retriedPayloads = [];
  const api = {
    auth: { getToken: () => 'jwt-1' },
    async request(req) {
      if (req.url === 'dxosWms:epodCapture') {
        retriedPayloads.push(req.data);
        return { data: { data: { trackingCode: 'LDX-TRK-FIXED' } } };
      }
      return { data: {} };
    },
  };
  Object.defineProperty(global, 'navigator', { configurable: true, value: { onLine: true } });
  Object.defineProperty(global, 'window', { configurable: true, value: { localStorage: storage, addEventListener() {}, removeEventListener() {} } });
  Object.defineProperty(global, 'document', { configurable: true, value: { head: { appendChild() {} }, querySelector() { return null; }, createElement() { return {}; } } });
  try {
    const MobilePage = createMobileFieldPwaPage({ Plugin: class {} }, fakeReact, {});
    let tree = fakeReact._render(MobilePage, { storage, useIndexedDB: false, apiClient: api });
    fakeReact._flushEffects();
    await new Promise((r) => setTimeout(r, 15));
    tree = fakeReact._render(MobilePage, { storage, useIndexedDB: false, apiClient: api });
    findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-queue-badge').props.onClick();
    tree = fakeReact._render(MobilePage, { storage, useIndexedDB: false, apiClient: api });

    // Conflict UI & Export JSON & OrderCode edit rendered
    assert.ok(findNode(tree, (n) => n.props?.['data-testid'] === `mobile-pwa-outbox-conflict-${q409.id}`));
    assert.ok(findNode(tree, (n) => n.props?.['data-testid'] === `mobile-pwa-outbox-export-${q404.id}`));
    const orderEdit = findNode(tree, (n) => n.props?.['data-testid'] === `mobile-pwa-outbox-edit-order-${q404.id}`);
    assert.ok(orderEdit);
    orderEdit.props.onChange({ target: { value: 'ORD-UI-999' } });
    tree = fakeReact._render(MobilePage, { storage, useIndexedDB: false, apiClient: api });
    await findNode(tree, (n) => n.props?.['data-testid'] === `mobile-pwa-outbox-save-retry-${q404.id}`).props.onClick();
    assert.equal(retriedPayloads[0].orderCode, 'ORD-UI-999');
    assert.equal((await listOutboxItems({ useIndexedDB: false, storage })).some((x) => x.id === q404.id), false);
    fakeReact._unmount();
  } finally {
    Object.defineProperty(global, 'navigator', { configurable: true, writable: true, value: prevGlobals.navigator });
    Object.defineProperty(global, 'window', { configurable: true, writable: true, value: prevGlobals.window });
    Object.defineProperty(global, 'document', { configurable: true, writable: true, value: prevGlobals.document });
    void qOk;
  }
});

test('P0-03: JWT exp detection catches expired 3-part JWTs while preserving PAT/mock tokens, flushOfflineQueue stops on first 401, and submitEpod preserves payload on 401', async () => {
  const {
    isJwtTokenExpired,
    isAuthenticatedMobileClient,
    flushOfflineQueue,
    createMobileFieldPwaPage,
    enqueueOfflineAction,
    readOfflineQueue,
  } = require('../src/client-v2/mobile-field-pwa');

  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const nowSec = Math.floor(Date.now() / 1000);
  const expiredJwt = `${b64({ alg: 'HS256' })}.${b64({ sub: '1', exp: nowSec - 60 })}.sig`;
  const validJwt = `${b64({ alg: 'HS256' })}.${b64({ sub: '1', exp: nowSec + 3600 })}.sig`;

  assert.equal(isJwtTokenExpired(expiredJwt), true);
  assert.equal(isJwtTokenExpired(validJwt), false);
  assert.equal(isJwtTokenExpired('jwt-emp'), false);
  assert.equal(isJwtTokenExpired('ldx_pat_abc123'), false);

  assert.equal(isAuthenticatedMobileClient({ auth: { getToken: () => expiredJwt }, request: async () => ({}) }), false);
  assert.equal(isAuthenticatedMobileClient({ auth: { getToken: () => validJwt }, request: async () => ({}) }), true);
  assert.equal(isAuthenticatedMobileClient({ auth: { getToken: () => 'jwt-emp' }, request: async () => ({}) }), true);

  // flushOfflineQueue stops on first 401 without hammering remaining items
  const storage = makeMemoryStorage();
  enqueueOfflineAction({ actionType: 'wms.epodCapture', payload: { seq: 1 } }, { storage });
  enqueueOfflineAction({ actionType: 'wms.epodCapture', payload: { seq: 2 } }, { storage });
  enqueueOfflineAction({ actionType: 'wms.epodCapture', payload: { seq: 3 } }, { storage });
  let requestCount = 0;
  const res401 = await flushOfflineQueue({
    storage,
    isOnline: true,
    apiClient: {
      async request() {
        requestCount += 1;
        throw Object.assign(new Error('Unauthorized'), { response: { status: 401 } });
      },
    },
  });
  assert.equal(requestCount, 1, 'Must stop immediately on first 401');
  assert.equal(res401.unauthorized, true);
  assert.equal(res401.deferred, 3);
  assert.equal(readOfflineQueue({ storage }).length, 3);

  // submitEpod receiving 401 preserves ePOD in outbox and activates authExpired banner
  const fakeReact = createFakeReact();
  const storage2 = makeMemoryStorage();
  const prevGlobals = { navigator: global.navigator, window: global.window, document: global.document };
  const api401 = {
    auth: { getToken: () => validJwt },
    async request(req) {
      if (req.url === 'dxosWms:epodCapture') {
        throw Object.assign(new Error('Token expired'), { response: { status: 401 } });
      }
      return { data: {} };
    },
  };
  Object.defineProperty(global, 'navigator', { configurable: true, value: { onLine: true } });
  Object.defineProperty(global, 'window', { configurable: true, value: { localStorage: storage2, addEventListener() {}, removeEventListener() {} } });
  Object.defineProperty(global, 'document', { configurable: true, value: { head: { appendChild() {} }, querySelector() { return null; }, createElement() { return {}; } } });
  try {
    const MobilePage = createMobileFieldPwaPage({ Plugin: class {} }, fakeReact, {});
    let tree = fakeReact._render(MobilePage, { storage: storage2, useIndexedDB: false, apiClient: api401 });
    fakeReact._flushEffects();
    findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-recipient-input').props.onChange({ target: { value: 'Tài xế 401' } });
    findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-lat-input').props.onChange({ target: { value: '10.04' } });
    findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-lng-input').props.onChange({ target: { value: '105.74' } });
    const canvasEl = findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-signature-canvas');
    canvasEl.props.ref.current = {
      width: 440,
      height: 160,
      getContext: () => ({ beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, clearRect() {} }),
      toDataURL: () => 'data:image/png;base64,AAA',
    };
    canvasEl.props.onPointerDown({ clientX: 10, clientY: 10 });
    canvasEl.props.onPointerUp({});
    tree = fakeReact._render(MobilePage, { storage: storage2, useIndexedDB: false, apiClient: api401 });
    await findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-epod-submit').props.onClick({ preventDefault() {} });
    tree = fakeReact._render(MobilePage, { storage: storage2, useIndexedDB: false, apiClient: api401 });
    assert.equal(readOfflineQueue({ storage: storage2 }).length, 1, 'ePOD must be preserved in outbox on 401');
    assert.ok(findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-auth-banner'), '401 on submitEpod must set authExpired(true)');
    fakeReact._unmount();
  } finally {
    Object.defineProperty(global, 'navigator', { configurable: true, writable: true, value: prevGlobals.navigator });
    Object.defineProperty(global, 'window', { configurable: true, writable: true, value: prevGlobals.window });
    Object.defineProperty(global, 'document', { configurable: true, writable: true, value: prevGlobals.document });
  }
});

test('P1-15 & P2-04: PNG 192/512 icons, /v/mobile SSR shell, SW precaching, Twin ACL gate, offline incidents/tickets, GPS fallback, and >=44px touch targets + 100dvh', async () => {
  const {
    buildServiceWorkerScript,
    registerMobilePwaActions,
    createMobilePwaGatewayHandler,
  } = require('../src/server/mobile-pwa');
  const { ALLOWED_OFFLINE_ACTIONS } = require('../src/client-v2/mobile-offline-db');
  const { buildEpodPayload, createMobileFieldPwaPage } = require('../src/client-v2/mobile-field-pwa');

  // 1. PNG 192 & 512 endpoints return valid PNG magic bytes & dimensions
  const actions = registerMobilePwaActions({ version: '0.4.2' });
  for (const [actionName, expectedSize] of [['icon-192.png', 192], ['icon-512.png', 512]]) {
    const ctx = { method: 'GET', response: { headers: {} }, set(k, v) { this.response.headers[k] = v; } };
    await actions[actionName](ctx);
    assert.equal(ctx.status, 200);
    assert.equal(ctx.response.headers['Content-Type'], 'image/png');
    assert.ok(Buffer.isBuffer(ctx.body));
    assert.equal(ctx.body.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(ctx.body.readUInt32BE(16), expectedSize);
    assert.equal(ctx.body.readUInt32BE(20), expectedSize);
  }

  // 2. SSR /v/mobile Gateway injects manifest, apple-touch-icon, SW registration & discovers /v/assets/* chunks
  const fakeHtml = '<!DOCTYPE html><html><head><title>App</title><script type="module" src="/v/assets/index-abc.js"></script><link rel="stylesheet" href="/v/assets/index-xyz.css"></head><body><div id="root"></div></body></html>';
  const gw = createMobilePwaGatewayHandler({ readIndexHtml: () => fakeHtml });
  const headers = {};
  let body = '';
  let statusCode = 0;
  const handled = await gw({ method: 'GET', url: '/v/mobile' }, {
    writeHead(s, h) { statusCode = s; Object.assign(headers, h); },
    end(b) { body = String(b || ''); },
  });
  assert.equal(handled, true);
  assert.equal(statusCode, 200);
  assert.equal(headers['Cache-Control'], 'no-cache');
  assert.match(body, /<link rel="manifest" href="\/api\/dxos:manifest">/);
  assert.match(body, /<link rel="apple-touch-icon" href="\/api\/dxos:icon-192\.png">/);
  assert.match(body, /serviceWorker\.register\(['"]\/api\/dxos:sw\.js['"]/);

  const swWithChunks = buildServiceWorkerScript({ version: '0.4.2', precacheAssets: ['/v/assets/index-abc.js', '/v/assets/index-xyz.css'] });
  assert.match(swWithChunks, /\/v\/assets\/index-abc\.js/);
  assert.match(swWithChunks, /\/v\/assets\/index-xyz\.css/);

  // 3. Offline actions include service.ticketCreate & iot.incidentCreate (dxosBlocks:alarmIngest)
  assert.equal(ALLOWED_OFFLINE_ACTIONS['service.ticketCreate'].url, 'latticeServiceTickets:create');
  assert.equal(ALLOWED_OFFLINE_ACTIONS['iot.incidentCreate'].url, 'dxosBlocks:alarmIngest');

  // 4. buildEpodPayload accepts explicit gpsUnavailable:true with non-empty reason
  const coldEpod = buildEpodPayload({
    recipientName: 'Kho Lạnh Ngầm',
    deliveredQty: 5,
    gpsLat: null,
    gpsLng: null,
    gpsUnavailable: true,
    gpsUnavailableReason: 'Kho lạnh ngầm mất tín hiệu GPS',
    signatureDataUrl: 'data:image/png;base64,AAA',
  });
  assert.equal(coldEpod.ok, true);
  assert.equal(coldEpod.payload.gpsUnavailable, true);
  assert.equal(coldEpod.payload.gpsUnavailableReason, 'Kho lạnh ngầm mất tín hiệu GPS');

  // 5. Twin ACL gate hides Twin setpoint card when roles:check lacks latticeAssets:update, and all buttons have >=44px + 100dvh
  const fakeReact = createFakeReact();
  const storage = makeMemoryStorage();
  const prevGlobals = { navigator: global.navigator, window: global.window, document: global.document };
  const driverApi = {
    auth: { role: 'ldx_driver', getToken: () => 'jwt-drv' },
    async request(req) {
      if (req.url === 'roles:check') {
        return {
          data: {
            data: {
              allowAll: false,
              resources: ['latticeOrders', 'latticeAssets', 'latticeServiceTickets', 'latticeIncidentCases'],
              actions: { 'latticeOrders:view': true, 'latticeAssets:view': true, 'latticeIncidentCases:create': true },
            },
          },
        };
      }
      return { data: {} };
    },
  };
  let resizeListeners = 0;
  let removedListeners = 0;
  Object.defineProperty(global, 'navigator', { configurable: true, value: { onLine: true } });
  Object.defineProperty(global, 'window', {
    configurable: true,
    value: {
      localStorage: storage,
      addEventListener() {},
      removeEventListener() {},
      visualViewport: {
        height: 500,
        offsetTop: 0,
        addEventListener() { resizeListeners += 1; },
        removeEventListener() { removedListeners += 1; },
      },
    },
  });
  Object.defineProperty(global, 'document', { configurable: true, value: { head: { appendChild() {} }, querySelector() { return null; }, createElement() { return {}; } } });
  try {
    const MobilePage = createMobileFieldPwaPage({ Plugin: class {} }, fakeReact, {});
    let tree = fakeReact._render(MobilePage, { storage, useIndexedDB: false, apiClient: driverApi });
    fakeReact._flushEffects();
    await new Promise((r) => setTimeout(r, 25));
    tree = fakeReact._render(MobilePage, { storage, useIndexedDB: false, apiClient: driverApi });

    assert.equal(tree.props.style.minHeight, '100dvh');
    assert.ok(resizeListeners >= 1, 'Expected visualViewport listener');
    // Twin setpoint submit hidden when latticeAssets:update is missing
    assert.equal(findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-twin-submit'), null);

    // Open notif, outbox, and AI drawer to audit >=44px minHeight on all interactive elements
    findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-notif-badge').props.onClick();
    findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-queue-badge').props.onClick();
    findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-ai-pill').props.onClick();
    tree = fakeReact._render(MobilePage, { storage, useIndexedDB: false, apiClient: driverApi });

    const interactive = findAllNodes(tree, (n) => ['button', 'a', 'input', 'select'].includes(n.type) && n.props?.type !== 'checkbox');
    for (const el of interactive) {
      const mh = Number(el.props?.style?.minHeight);
      assert.ok(mh >= 44, `Control ${el.props?.['data-testid'] || el.type} minHeight must be >= 44, got ${mh}`);
    }
    fakeReact._unmount();
    assert.ok(removedListeners >= 1, 'Expected visualViewport listener cleanup');
  } finally {
    Object.defineProperty(global, 'navigator', { configurable: true, writable: true, value: prevGlobals.navigator });
    Object.defineProperty(global, 'window', { configurable: true, writable: true, value: prevGlobals.window });
    Object.defineProperty(global, 'document', { configurable: true, writable: true, value: prevGlobals.document });
  }
});

test('Remediation M2-1: /v/mobile resolves real NocoBase 2.2.50 v2 HTML (Gateway.renderV2IndexHtml & APP_PACKAGE_ROOT/dist/client/v/index.html), fails open when absent, and precaches /v/global.css + /v/browser-checker.js?v=1 while rejecting ?token=abc', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const {
    resolveDefaultIndexHtml,
    resolveDefaultV2IndexHtml,
    createMobilePwaGatewayHandler,
    extractClientV2AssetUrls,
    buildServiceWorkerScript,
  } = require('../src/server/mobile-pwa');

  assert.equal(typeof resolveDefaultV2IndexHtml, 'function');

  // 1. Fails open (returns null and gateway returns false) when no Gateway template and no disk v2 HTML exist
  const prevAppPkgRoot = process.env.APP_PACKAGE_ROOT;
  const prevAppPublicPath = process.env.APP_PUBLIC_PATH;
  const prevCwd = process.cwd();
  const tmpEmptyDir = fs.mkdtempSync(path.join(__dirname, '.tmp-empty-v2-'));
  try {
    delete process.env.APP_PACKAGE_ROOT;
    process.env.APP_PUBLIC_PATH = '/';
    process.chdir(tmpEmptyDir);

    const noHtml = await resolveDefaultV2IndexHtml({ Gateway: null });
    assert.equal(noHtml, null, 'Must never fabricate scriptless <div id="root"></div> stub');
    assert.equal(resolveDefaultIndexHtml(), null, 'Sync resolveDefaultIndexHtml must also return null when absent');

    const failOpenGw = createMobilePwaGatewayHandler({ Gateway: null });
    let endCalled = false;
    const handledEmpty = await failOpenGw({ method: 'GET', url: '/v/mobile' }, {
      writeHead() {},
      end() { endCalled = true; },
    });
    assert.equal(handledEmpty, false, 'Gateway handler must fail open (return false) when no v2 HTML exists');
    assert.equal(endCalled, false);

    // Also fail open if Gateway returns HTML without <script> tag
    const stubGateway = { getInstance: () => ({ renderV2IndexHtml: () => '<html><body><div id="root"></div></body></html>' }) };
    const noScriptGw = createMobilePwaGatewayHandler({ Gateway: stubGateway });
    const handledNoScript = await noScriptGw({ method: 'GET', url: '/v/mobile' }, {
      writeHead() {},
      end() { endCalled = true; },
    });
    assert.equal(handledNoScript, false, 'Gateway handler must fail open if resolved HTML has no <script> tag');
    assert.equal(endCalled, false);

    // 2. Resolves Gateway.getInstance().renderV2IndexHtml() (async Promise) and injects PWA tags + extracts v2 assets
    const realV2Html = '<!DOCTYPE html><html><head><link rel="stylesheet" href="/v/global.css"><script src="/v/browser-checker.js?v=1"></script><script type="module" src="/v/assets/index-real2250.js"></script><link rel="stylesheet" href="/v/assets/index-real2250.css"></head><body><div id="root"></div></body></html>';
    const liveGateway = {
      getInstance: () => ({
        renderV2IndexHtml: async () => realV2Html,
      }),
    };
    const gwLive = createMobilePwaGatewayHandler({ Gateway: liveGateway });
    let liveStatus = 0;
    let liveBody = '';
    const liveHeaders = {};
    const handledLive = await gwLive({ method: 'GET', url: '/v/mobile' }, {
      writeHead(s, h) { liveStatus = s; Object.assign(liveHeaders, h); },
      end(b) { liveBody = String(b || ''); },
    });
    assert.equal(handledLive, true);
    assert.equal(liveStatus, 200);
    assert.equal(liveHeaders['Cache-Control'], 'no-cache');
    assert.match(liveBody, /<script type="module" src="\/v\/assets\/index-real2250\.js">/);
    assert.match(liveBody, /<link rel="manifest" href="\/api\/dxos:manifest">/);
    assert.match(liveBody, /\/v\/global\.css/);
    assert.match(liveBody, /\/v\/browser-checker\.js\?v=1/);

    // 3. Resolves APP_PACKAGE_ROOT/dist/client/v/index.html when Gateway is absent
    const pkgV2Dir = path.join(tmpEmptyDir, 'dist', 'client', 'v');
    fs.mkdirSync(pkgV2Dir, { recursive: true });
    fs.writeFileSync(path.join(pkgV2Dir, 'index.html'), realV2Html, 'utf8');
    process.env.APP_PACKAGE_ROOT = tmpEmptyDir;

    const fromDisk = await resolveDefaultV2IndexHtml({ Gateway: null });
    assert.equal(fromDisk, realV2Html);
    const gwDisk = createMobilePwaGatewayHandler({ Gateway: null });
    let diskBody = '';
    const handledDisk = await gwDisk({ method: 'GET', url: '/v/mobile' }, {
      writeHead() {},
      end(b) { diskBody = String(b || ''); },
    });
    assert.equal(handledDisk, true);
    assert.match(diskBody, /index-real2250\.js/);
    assert.match(diskBody, /<link rel="manifest" href="\/api\/dxos:manifest">/);

    // 4. extractClientV2AssetUrls & SW PRECACHE_ASSETS include /v/global.css & /v/browser-checker.js?v=1 while rejecting ?token=abc & /api/users
    const extracted = extractClientV2AssetUrls(realV2Html);
    assert.ok(extracted.includes('/v/global.css'), 'Must extract /v/global.css');
    assert.ok(extracted.includes('/v/browser-checker.js?v=1'), 'Must extract /v/browser-checker.js?v=1');
    assert.ok(extracted.includes('/v/assets/index-real2250.js'));
    assert.ok(extracted.includes('/v/assets/index-real2250.css'));

    const swSrc = buildServiceWorkerScript({ version: '0.4.2', precacheAssets: extracted });
    const addedUrls = [];
    const listeners = {};
    vm.runInNewContext(swSrc, {
      self: {
        location: { origin: 'https://field.latticedx.local' },
        addEventListener: (name, fn) => { listeners[name] = fn; },
        skipWaiting: () => Promise.resolve(),
        clients: { claim: () => Promise.resolve() },
      },
      caches: {
        open: async () => ({
          addAll: async (urls) => { addedUrls.push(...urls); },
        }),
        keys: async () => [],
        delete: async () => true,
      },
      fetch: async () => ({ ok: true, headers: { get: () => '' } }),
      URL,
    });
    let waitPromise;
    listeners.message({
      data: {
        type: 'PRECACHE_ASSETS',
        assets: [
          '/v/global.css',
          '/v/browser-checker.js?v=1',
          '/v/browser-checker.js',
          '/v/browser-checker.js?token=abc',
          '/v/global.css?token=abc',
          '/assets/chunk.js?token=abc',
          '/api/users',
        ],
      },
      waitUntil: (p) => { waitPromise = p; },
    });
    await waitPromise;
    assert.deepEqual(addedUrls, ['/v/global.css', '/v/browser-checker.js?v=1', '/v/browser-checker.js']);
  } finally {
    process.chdir(prevCwd);
    if (prevAppPkgRoot === undefined) delete process.env.APP_PACKAGE_ROOT;
    else process.env.APP_PACKAGE_ROOT = prevAppPkgRoot;
    if (prevAppPublicPath === undefined) delete process.env.APP_PUBLIC_PATH;
    else process.env.APP_PUBLIC_PATH = prevAppPublicPath;
    fs.rmSync(tmpEmptyDir, { recursive: true, force: true });
  }
});

test('Remediation M2-2: 409 conflict diff masks small & large base64 photos before 4096-byte cap and preserves serverRecord fields in UI diff', async () => {
  const { sanitizeConflictData, enqueueOutboxItem, updateOutboxItem, listOutboxItems } = require('../src/client-v2/mobile-offline-db');
  const { extractConflictData, createMobileFieldPwaPage } = require('../src/client-v2/mobile-field-pwa');

  const smallPhoto = 'data:image/png;base64,SMALL_BASE64_DATA';
  const largePhoto = `data:image/jpeg;base64,${'B'.repeat(5000)}`;
  const smallSig = 'data:image/png;base64,SIG_123';

  // 1. Direct extractConflictData & sanitizeConflictData masking for both small (<=4KB) and large (>5KB) photos
  for (const [label, photo] of [['small', smallPhoto], ['large', largePhoto]]) {
    const err409 = {
      response: {
        status: 409,
        data: {
          code: 'EPOD_VERSION_CONFLICT',
          message: 'Bản ghi ePOD đã được cập nhật',
          serverRecord: {
            orderCode: `ORD-409-${label}`,
            recipientName: 'Server Recipient',
            status: 'delivered',
            deliveredAt: '2026-11-26T08:00:00Z',
            evidencePhotoDataUrl: photo,
            signatureDataUrl: smallSig,
            nested: { previewDataUrl: photo },
          },
        },
      },
    };
    const extracted = extractConflictData(err409);
    const serializedExtracted = JSON.stringify(extracted);
    assert.equal(serializedExtracted.includes('SMALL_BASE64_DATA'), false, `${label}: extractConflictData must mask small base64`);
    assert.equal(serializedExtracted.includes('BBBBBBBB'), false, `${label}: extractConflictData must mask large base64`);
    assert.equal(extracted.serverRecord.recipientName, 'Server Recipient');
    assert.equal(extracted.serverRecord.status, 'delivered');
    assert.equal(extracted.serverRecord.deliveredAt, '2026-11-26T08:00:00Z');
    assert.match(extracted.serverRecord.evidencePhotoDataUrl, /base64 đã ẩn/i);

    const sanitized = sanitizeConflictData({
      code: 'EPOD_VERSION_CONFLICT',
      message: 'Bản ghi ePOD đã được cập nhật',
      serverRecord: err409.response.data.serverRecord,
    });
    assert.ok(sanitized.serverRecord, `${label}: sanitizeConflictData must preserve serverRecord after masking`);
    assert.equal(sanitized.serverRecord.recipientName, 'Server Recipient');
    assert.equal(sanitized.serverRecord.status, 'delivered');
    assert.equal(sanitized.serverRecord.deliveredAt, '2026-11-26T08:00:00Z');
    assert.equal(JSON.stringify(sanitized).includes('SMALL_BASE64_DATA'), false);
    assert.equal(JSON.stringify(sanitized).includes('BBBBBBBB'), false);
  }

  // 2. End-to-end UI rendering of 409 diff with large >5KB photo
  const storage = makeMemoryStorage();
  const fakeReact = createFakeReact();
  const item = await enqueueOutboxItem({
    actionType: 'wms.epodCapture',
    payload: { orderCode: 'ORD-409-UI', recipientName: 'Local Driver', deliveredQty: 2 },
  }, { useIndexedDB: false, storage });
  await updateOutboxItem(item.id, {
    status: 'quarantined',
    httpStatus: 409,
    lastError: 'Conflict 409',
    conflictData: {
      code: 'EPOD_CONFLICT',
      message: 'Conflict 409',
      serverRecord: {
        orderCode: 'ORD-409-UI',
        recipientName: 'Server Recipient',
        status: 'delivered',
        deliveredAt: '2026-11-26T08:00:00Z',
        evidencePhotoDataUrl: largePhoto,
        signatureDataUrl: smallSig,
      },
    },
  }, { useIndexedDB: false, storage });

  const stored = (await listOutboxItems({ useIndexedDB: false, storage }))[0];
  assert.ok(stored.conflictData.serverRecord, 'Persisted outbox item must keep serverRecord');

  const prevGlobals = { navigator: global.navigator, window: global.window, document: global.document };
  Object.defineProperty(global, 'navigator', { configurable: true, value: { onLine: true } });
  Object.defineProperty(global, 'window', { configurable: true, value: { localStorage: storage, addEventListener() {}, removeEventListener() {} } });
  Object.defineProperty(global, 'document', { configurable: true, value: { head: { appendChild() {} }, querySelector() { return null; }, createElement() { return {}; } } });
  try {
    const MobilePage = createMobileFieldPwaPage({ Plugin: class {} }, fakeReact, {});
    let tree = fakeReact._render(MobilePage, {
      storage,
      useIndexedDB: false,
      apiClient: { auth: { getToken: () => '' }, request: async () => ({ data: {} }) },
    });
    fakeReact._flushEffects();
    await new Promise((r) => setTimeout(r, 20));
    tree = fakeReact._render(MobilePage, {
      storage,
      useIndexedDB: false,
      apiClient: { auth: { getToken: () => '' }, request: async () => ({ data: {} }) },
    });
    findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-queue-badge').props.onClick();
    tree = fakeReact._render(MobilePage, {
      storage,
      useIndexedDB: false,
      apiClient: { auth: { getToken: () => '' }, request: async () => ({ data: {} }) },
    });
    const conflictPanel = findNode(tree, (n) => n.props?.['data-testid'] === `mobile-pwa-outbox-conflict-${item.id}`);
    assert.ok(conflictPanel, 'Must render 409 conflict panel');
    const conflictDump = JSON.stringify(conflictPanel);
    assert.ok(conflictDump.includes('Server Recipient'), 'Rendered diff must preserve recipientName');
    assert.ok(conflictDump.includes('delivered'), 'Rendered diff must preserve status');
    assert.ok(conflictDump.includes('2026-11-26T08:00:00Z'), 'Rendered diff must preserve deliveredAt');
    assert.equal(conflictDump.includes('BBBBBBBB'), false, 'Rendered diff must not leak raw base64');
    assert.equal(conflictDump.includes('SIG_123'), false, 'Rendered diff must not leak raw signature base64');
    fakeReact._unmount();
  } finally {
    Object.defineProperty(global, 'navigator', { configurable: true, writable: true, value: prevGlobals.navigator });
    Object.defineProperty(global, 'window', { configurable: true, writable: true, value: prevGlobals.window });
    Object.defineProperty(global, 'document', { configurable: true, writable: true, value: prevGlobals.document });
  }
});

test('Remediation M2-3: auth401SeqRef race keeps mobile-pwa-auth-banner visible when stale unreadCount/loadNotifications 200 resolves after handleSync 401', async () => {
  const { createMobileFieldPwaPage } = require('../src/client-v2/mobile-field-pwa');
  const { enqueueOutboxItem } = require('../src/client-v2/mobile-offline-db');

  const fakeReact = createFakeReact();
  const storage = makeMemoryStorage();
  await enqueueOutboxItem({
    actionType: 'wms.epodCapture',
    payload: { orderCode: 'ORD-RACE-401', recipientName: 'Race Driver', deliveredQty: 1 },
  }, { useIndexedDB: false, storage });

  let resolveUnread;
  let resolveListMine;
  const raceApi = {
    auth: { getToken: () => 'jwt-race-valid' },
    async request(req) {
      if (req.url === 'latticeNotifications:unreadCount') {
        return new Promise((resolve) => { resolveUnread = resolve; });
      }
      if (req.url === 'latticeNotifications:listMine') {
        return new Promise((resolve) => { resolveListMine = resolve; });
      }
      if (req.url === 'dxosWms:epodCapture') {
        throw Object.assign(new Error('Unauthorized'), { response: { status: 401 } });
      }
      if (req.url === 'roles:check') return { data: { data: { allowAll: true } } };
      return { data: { data: { items: [] } } };
    },
  };

  const prevGlobals = { navigator: global.navigator, window: global.window, document: global.document };
  Object.defineProperty(global, 'navigator', { configurable: true, value: { onLine: true } });
  Object.defineProperty(global, 'window', { configurable: true, value: { localStorage: storage, addEventListener() {}, removeEventListener() {} } });
  Object.defineProperty(global, 'document', { configurable: true, value: { head: { appendChild() {} }, querySelector() { return null; }, createElement() { return {}; } } });
  try {
    const MobilePage = createMobileFieldPwaPage({ Plugin: class {} }, fakeReact, {});
    let tree = fakeReact._render(MobilePage, { storage, useIndexedDB: false, apiClient: raceApi });
    fakeReact._flushEffects();
    await new Promise((r) => setTimeout(r, 20));
    tree = fakeReact._render(MobilePage, { storage, useIndexedDB: false, apiClient: raceApi });

    // Trigger loadNotifications (in-flight) and handleSync (401) concurrently
    const notifClickPromise = findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-notif-badge').props.onClick();
    await findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-sync-btn').props.onClick();
    tree = fakeReact._render(MobilePage, { storage, useIndexedDB: false, apiClient: raceApi });
    assert.ok(findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-auth-banner'), 'handleSync 401 must show auth banner');

    // Now resolve stale 200 responses from unreadCount and listMine AFTER handleSync 401
    resolveUnread?.({ data: { data: { unreadCount: 1 } } });
    resolveListMine?.({ data: { data: { unreadCount: 1, items: [] } } });
    await notifClickPromise;
    await new Promise((r) => setTimeout(r, 10));

    tree = fakeReact._render(MobilePage, { storage, useIndexedDB: false, apiClient: raceApi });
    assert.ok(
      findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-auth-banner'),
      'Stale 200 from refreshUnreadCount/loadNotifications must NOT clear authExpired banner after handleSync 401',
    );
    fakeReact._unmount();
  } finally {
    Object.defineProperty(global, 'navigator', { configurable: true, writable: true, value: prevGlobals.navigator });
    Object.defineProperty(global, 'window', { configurable: true, writable: true, value: prevGlobals.window });
    Object.defineProperty(global, 'document', { configurable: true, writable: true, value: prevGlobals.document });
  }
});

test('T1-MOBILE-05 & T1-MOBILE-06: MobileFieldPwaPage defaults canControlTwin and canCreateIncidents fail-closed (false) before roles:check resolves and keeps both hidden for ldx_driver', async () => {
  const { createMobileFieldPwaPage } = require('../src/client-v2/mobile-field-pwa');

  const prevGlobals = {
    navigator: global.navigator,
    window: global.window,
    document: global.document,
    fetch: globalThis.fetch,
  };
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: async () => ({ ok: true, status: 200, body: null }),
  });
  Object.defineProperty(global, 'navigator', { configurable: true, value: { onLine: true } });
  Object.defineProperty(global, 'document', { configurable: true, value: { head: { appendChild() {} }, querySelector() { return null; }, createElement() { return {}; } } });

  try {
    // 1. ldx_driver with deferred roles:check -> hidden initially AND hidden after roles:check resolves
    const storageDrv = makeMemoryStorage();
    Object.defineProperty(global, 'window', { configurable: true, value: { localStorage: storageDrv, addEventListener() {}, removeEventListener() {} } });
    const fakeReactDrv = createFakeReact();
    let resolveDriverRoleCheck;
    const driverApi = {
      auth: { role: 'ldx_driver', getToken: () => 'jwt-drv-acl' },
      async request(req) {
        if (req.url === 'roles:check') {
          return new Promise((resolve) => { resolveDriverRoleCheck = resolve; });
        }
        return { data: { data: { items: [] } } };
      },
    };
    const MobilePageDrv = createMobileFieldPwaPage({ Plugin: class {} }, fakeReactDrv, {});
    let treeDrv = fakeReactDrv._render(MobilePageDrv, { storage: storageDrv, useIndexedDB: false, apiClient: driverApi });
    assert.equal(findNode(treeDrv, (n) => n.props?.['data-testid'] === 'mobile-pwa-twin-submit'), null, 'Twin submit must be hidden before roles:check completes');
    assert.equal(findNode(treeDrv, (n) => n.props?.['data-testid'] === 'mobile-pwa-incident-create-toggle'), null, 'Incident create toggle must be hidden before roles:check completes');

    fakeReactDrv._flushEffects();
    treeDrv = fakeReactDrv._render(MobilePageDrv, { storage: storageDrv, useIndexedDB: false, apiClient: driverApi });
    assert.equal(findNode(treeDrv, (n) => n.props?.['data-testid'] === 'mobile-pwa-twin-submit'), null, 'Twin submit must stay hidden while roles:check is in flight');
    assert.equal(findNode(treeDrv, (n) => n.props?.['data-testid'] === 'mobile-pwa-incident-create-toggle'), null, 'Incident create toggle must stay hidden while roles:check is in flight');

    resolveDriverRoleCheck({
      data: {
        data: {
          allowAll: false,
          resources: ['latticeOrders', 'latticeAssets', 'latticeServiceTickets'],
          actions: { 'latticeOrders:view': true, 'latticeAssets:view': true, 'latticeServiceTickets:create': true },
        },
      },
    });
    await new Promise((r) => setTimeout(r, 20));
    treeDrv = fakeReactDrv._render(MobilePageDrv, { storage: storageDrv, useIndexedDB: false, apiClient: driverApi });
    assert.equal(findNode(treeDrv, (n) => n.props?.['data-testid'] === 'mobile-pwa-twin-submit'), null, 'Twin submit must stay hidden for ldx_driver');
    assert.equal(findNode(treeDrv, (n) => n.props?.['data-testid'] === 'mobile-pwa-incident-create-toggle'), null, 'Incident create toggle must stay hidden for ldx_driver');
    fakeReactDrv._unmount();

    // 2. ldx_manager with deferred roles:check -> hidden BEFORE roles:check resolves, visible ONLY AFTER grants resolve
    const storageMgr = makeMemoryStorage();
    Object.defineProperty(global, 'window', { configurable: true, value: { localStorage: storageMgr, addEventListener() {}, removeEventListener() {} } });
    const fakeReactMgr = createFakeReact();
    let resolveManagerRoleCheck;
    const managerApi = {
      auth: { role: 'ldx_manager', getToken: () => 'jwt-mgr-acl' },
      async request(req) {
        if (req.url === 'roles:check') {
          return new Promise((resolve) => { resolveManagerRoleCheck = resolve; });
        }
        return { data: { data: { items: [] } } };
      },
    };
    const MobilePageMgr = createMobileFieldPwaPage({ Plugin: class {} }, fakeReactMgr, {});
    let treeMgr = fakeReactMgr._render(MobilePageMgr, { storage: storageMgr, useIndexedDB: false, apiClient: managerApi });
    fakeReactMgr._flushEffects();
    treeMgr = fakeReactMgr._render(MobilePageMgr, { storage: storageMgr, useIndexedDB: false, apiClient: managerApi });
    assert.equal(findNode(treeMgr, (n) => n.props?.['data-testid'] === 'mobile-pwa-twin-submit'), null, 'Twin submit must be hidden before manager roles:check resolves');
    assert.equal(findNode(treeMgr, (n) => n.props?.['data-testid'] === 'mobile-pwa-incident-create-toggle'), null, 'Incident create toggle must be hidden before manager roles:check resolves');

    resolveManagerRoleCheck({
      data: {
        data: {
          allowAll: false,
          resources: ['latticeOrders', 'latticeAssets', 'latticeIncidentCases', 'latticeServiceTickets'],
          actions: { 'latticeAssets:update': true, 'latticeIncidentCases:create': true },
        },
      },
    });
    await new Promise((r) => setTimeout(r, 20));
    treeMgr = fakeReactMgr._render(MobilePageMgr, { storage: storageMgr, useIndexedDB: false, apiClient: managerApi });
    assert.ok(findNode(treeMgr, (n) => n.props?.['data-testid'] === 'mobile-pwa-twin-submit'), 'Twin submit must render once roles:check grants latticeAssets:update');
    assert.ok(findNode(treeMgr, (n) => n.props?.['data-testid'] === 'mobile-pwa-incident-create-toggle'), 'Incident create toggle must render once roles:check grants latticeIncidentCases:create');
    fakeReactMgr._unmount();
  } finally {
    Object.defineProperty(global, 'navigator', { configurable: true, writable: true, value: prevGlobals.navigator });
    Object.defineProperty(global, 'window', { configurable: true, writable: true, value: prevGlobals.window });
    Object.defineProperty(global, 'document', { configurable: true, writable: true, value: prevGlobals.document });
    Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: prevGlobals.fetch });
  }
});

test('Bug #8 & Mobile PWA UX: onOnline clears stale offline notice with empty queue, retries transient Network Error once after settle, and renders clean UX', async () => {
  const { createMobileFieldPwaPage, enqueueOfflineAction, readOfflineQueue } = require('../src/client-v2/mobile-field-pwa');
  const prevGlobals = {
    navigator: global.navigator,
    window: global.window,
    document: global.document,
    fetch: globalThis.fetch,
  };

  try {
    let navOnline = true;
    const listeners = new Map();
    const storage1 = makeMemoryStorage();
    Object.defineProperty(global, 'navigator', {
      configurable: true,
      value: { get onLine() { return navOnline; } },
    });
    Object.defineProperty(global, 'window', {
      configurable: true,
      value: {
        localStorage: storage1,
        addEventListener(ev, fn) { listeners.set(ev, fn); },
        removeEventListener(ev) { listeners.delete(ev); },
      },
    });
    Object.defineProperty(global, 'document', {
      configurable: true,
      value: { head: { appendChild() {} }, querySelector() { return null; }, createElement() { return {}; } },
    });
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: async () => ({ ok: true, status: 200, body: null }),
    });

    // (a) Stale offline/network notice cleared on online event even when queue is empty
    const fakeReact1 = createFakeReact();
    let failNet = true;
    const api1 = {
      auth: { role: 'ldx_manager', getToken: () => 'jwt-bug8-a' },
      async request(req) {
        if (req.url === 'roles:check') return { data: { data: { allowAll: false, resources: ['latticeOrders', 'latticeIncidentCases', 'latticeServiceTickets'], actions: { 'latticeAssets:update': true } } } };
        if (req.url === 'dxosApprovals:listInbox') return { data: { data: { items: [{ id: 1, title: 'Duyệt 1', riskLevel: 'high' }] } } };
        if (req.url === 'latticeOrders:list') return { data: { data: [{ id: 2, code: 'ORD-UX-1', name: 'Đơn lạnh', status: 'in_progress' }] } };
        if (req.url === 'latticeIncidentCases:list') return { data: { data: [{ id: 3, code: 'INC-UX-1', name: 'Cảnh báo', severity: 'high', status: 'open' }] } };
        if (req.url === 'latticeServiceTickets:list') return { data: { data: [{ id: 4, code: 'TKT-UX-1', name: 'Phiếu UX', priority: 'medium', status: 'submitted' }] } };
        if (req.url === 'dxosBlocks:twinSetDesired' && failNet) throw new Error('Network Error');
        return { data: { data: { items: [] } } };
      },
    };
    const MobilePage1 = createMobileFieldPwaPage({ Plugin: class {} }, fakeReact1, {});
    let tree1 = fakeReact1._render(MobilePage1, {
      storage: storage1,
      useIndexedDB: false,
      apiClient: api1,
      onlineSettleMs: 15,
      transientRetryDelayMs: 15,
      initialApprovals: [{ id: 1, title: 'Duyệt 1', riskLevel: 'high' }],
      initialDeliveries: [{ id: 2, code: 'ORD-UX-1', name: 'Đơn lạnh', status: 'in_progress' }],
      initialIncidents: [{ id: 3, code: 'INC-UX-1', name: 'Cảnh báo', severity: 'high', status: 'open' }],
      initialTickets: [{ id: 4, code: 'TKT-UX-1', name: 'Phiếu UX', priority: 'medium', status: 'submitted' }],
    });
    fakeReact1._flushEffects();
    await new Promise((r) => setTimeout(r, 20));
    tree1 = fakeReact1._render(MobilePage1, {
      storage: storage1,
      useIndexedDB: false,
      apiClient: api1,
      onlineSettleMs: 15,
      transientRetryDelayMs: 15,
      initialApprovals: [{ id: 1, title: 'Duyệt 1', riskLevel: 'high' }],
      initialDeliveries: [{ id: 2, code: 'ORD-UX-1', name: 'Đơn lạnh', status: 'in_progress' }],
      initialIncidents: [{ id: 3, code: 'INC-UX-1', name: 'Cảnh báo', severity: 'high', status: 'open' }],
      initialTickets: [{ id: 4, code: 'TKT-UX-1', name: 'Phiếu UX', priority: 'medium', status: 'submitted' }],
    });

    // UX assertions: clean subtitle, #475569 card borders, responsive GPS inputs
    const rootText = collectText(tree1);
    assert.ok(rootText.includes('Giao nhận hiện trường'));
    assert.equal(rootText.includes('Giao nhận hiện trường · /v/mobile'), false);
    for (const cardId of ['mobile-pwa-approval-card-1', 'mobile-pwa-delivery-card-2', 'mobile-pwa-incident-card-3', 'mobile-pwa-ticket-card-4']) {
      const card = findNode(tree1, (n) => n.props?.['data-testid'] === cardId);
      assert.equal(card?.props?.style?.border, '1px solid #475569', `${cardId} must have #475569 border`);
    }
    const latInput = findNode(tree1, (n) => n.props?.['data-testid'] === 'mobile-pwa-lat-input');
    const lngInput = findNode(tree1, (n) => n.props?.['data-testid'] === 'mobile-pwa-lng-input');
    assert.equal(latInput?.props?.placeholder, 'Vĩ độ (10.0452)');
    assert.equal(lngInput?.props?.placeholder, 'Kinh độ (105.7469)');
    assert.equal(latInput?.props?.style?.minWidth, 0);
    const gpsGrid = findNode(tree1, (n) => n.type === 'div' && Array.isArray(n.children) && n.children.some((c) => c?.props?.['data-testid'] === 'mobile-pwa-lat-input'));
    assert.equal(gpsGrid?.props?.style?.gridTemplateColumns, 'repeat(auto-fit, minmax(175px, 1fr))');

    // Trigger transient failure -> stale warn notice -> drain queue manually -> offline -> online with empty queue
    findNode(tree1, (n) => n.props?.['data-testid'] === 'mobile-pwa-twin-asset-input').props.onChange({ target: { value: '10' } });
    findNode(tree1, (n) => n.props?.['data-testid'] === 'mobile-pwa-twin-temp-input').props.onChange({ target: { value: '-18' } });
    tree1 = fakeReact1._render(MobilePage1, { storage: storage1, useIndexedDB: false, apiClient: api1, onlineSettleMs: 15, transientRetryDelayMs: 15 });
    await findNode(tree1, (n) => n.props?.['data-testid'] === 'mobile-pwa-twin-submit').props.onClick({ preventDefault() {} });
    tree1 = fakeReact1._render(MobilePage1, { storage: storage1, useIndexedDB: false, apiClient: api1, onlineSettleMs: 15, transientRetryDelayMs: 15 });
    assert.ok(collectText(findNode(tree1, (n) => n.props?.['data-testid'] === 'mobile-pwa-status-notice')).includes('Mất mạng'));

    // Empty storage directly while stale notice remains, transition offline -> online
    storage1.removeItem('latticedx:mobile:offline-queue');
    listeners.get('offline')();
    navOnline = false;
    tree1 = fakeReact1._render(MobilePage1, { storage: storage1, useIndexedDB: false, apiClient: api1, onlineSettleMs: 15, transientRetryDelayMs: 15 });
    assert.ok(collectText(findNode(tree1, (n) => n.props?.['data-testid'] === 'mobile-pwa-network-banner')).includes('Ngoại tuyến'));

    navOnline = true;
    await listeners.get('online')();
    tree1 = fakeReact1._render(MobilePage1, { storage: storage1, useIndexedDB: false, apiClient: api1, onlineSettleMs: 15, transientRetryDelayMs: 15 });
    assert.ok(collectText(findNode(tree1, (n) => n.props?.['data-testid'] === 'mobile-pwa-network-banner')).includes('Trực tuyến'));
    assert.equal(findNode(tree1, (n) => n.props?.['data-testid'] === 'mobile-pwa-status-notice'), null, 'Stale offline/network notice MUST clear on online even when queue is empty');
    fakeReact1._unmount();

    // (b) Transient Network Error on initial online sync performs 1 automatic backoff retry and succeeds cleanly
    listeners.clear();
    const storage2 = makeMemoryStorage();
    enqueueOfflineAction({
      actionType: 'wms.epodCapture',
      payload: { orderCode: 'ORD-RETRY-1', recipientName: 'Anh Hung', deliveredQty: 1, gpsLat: 10, gpsLng: 105, signatureDataUrl: 'data:image/png;base64,AAA' },
    }, { storage: storage2 });
    Object.defineProperty(global, 'window', {
      configurable: true,
      value: {
        localStorage: storage2,
        addEventListener(ev, fn) { listeners.set(ev, fn); },
        removeEventListener(ev) { listeners.delete(ev); },
      },
    });
    let epodAttempts = 0;
    const api2 = {
      auth: { role: 'ldx_driver', getToken: () => 'jwt-bug8-b' },
      async request(req) {
        if (req.url === 'dxosWms:epodCapture') {
          epodAttempts += 1;
          if (epodAttempts === 1) throw new Error('Network Error');
          return { data: { trackingCode: 'LDX-TRK-RETRY-OK' } };
        }
        return { data: { data: { items: [] } } };
      },
    };
    const fakeReact2 = createFakeReact();
    const MobilePage2 = createMobileFieldPwaPage({ Plugin: class {} }, fakeReact2, {});
    let tree2 = fakeReact2._render(MobilePage2, { storage: storage2, useIndexedDB: false, apiClient: api2, onlineSettleMs: 15, transientRetryDelayMs: 15 });
    fakeReact2._flushEffects();
    navOnline = false;
    listeners.get('offline')();
    navOnline = true;
    await listeners.get('online')();
    tree2 = fakeReact2._render(MobilePage2, { storage: storage2, useIndexedDB: false, apiClient: api2, onlineSettleMs: 15, transientRetryDelayMs: 15 });
    assert.equal(epodAttempts, 2, 'Initial transient Network Error must perform 1 automatic backoff retry');
    assert.equal(readOfflineQueue({ storage: storage2 }).length, 0);
    const successNotice = collectText(findNode(tree2, (n) => n.props?.['data-testid'] === 'mobile-pwa-status-notice'));
    assert.ok(successNotice.includes('1 thành công'), `Expected clean sync notice after retry, got: ${successNotice}`);
    assert.equal(successNotice.includes('Network Error'), false);

    // (c) If retry ALSO fails with transient Network Error, surfaces failed item cleanly
    enqueueOfflineAction({
      actionType: 'wms.epodCapture',
      payload: { orderCode: 'ORD-RETRY-2', recipientName: 'Anh Hung', deliveredQty: 1, gpsLat: 10, gpsLng: 105, signatureDataUrl: 'data:image/png;base64,BBB' },
    }, { storage: storage2 });
    let alwaysFailAttempts = 0;
    const api3 = {
      auth: { role: 'ldx_driver', getToken: () => 'jwt-bug8-c' },
      async request(req) {
        if (req.url === 'dxosWms:epodCapture') {
          alwaysFailAttempts += 1;
          throw new Error('Network Error');
        }
        return { data: { data: { items: [] } } };
      },
    };
    tree2 = fakeReact2._render(MobilePage2, { storage: storage2, useIndexedDB: false, apiClient: api3, onlineSettleMs: 15, transientRetryDelayMs: 15 });
    await findNode(tree2, (n) => n.props?.['data-testid'] === 'mobile-pwa-sync-btn').props.onClick();
    assert.equal(alwaysFailAttempts, 2, 'Should try once + 1 backoff retry before surfacing failed');
    const rem = readOfflineQueue({ storage: storage2 });
    assert.equal(rem.length, 1);
    assert.equal(rem[0].status, 'failed');
    assert.equal(rem[0].lastError, 'Network Error');
    fakeReact2._unmount();
  } finally {
    Object.defineProperty(global, 'navigator', { configurable: true, writable: true, value: prevGlobals.navigator });
    Object.defineProperty(global, 'window', { configurable: true, writable: true, value: prevGlobals.window });
    Object.defineProperty(global, 'document', { configurable: true, writable: true, value: prevGlobals.document });
    Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: prevGlobals.fetch });
  }
});
