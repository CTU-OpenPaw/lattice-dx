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

const PLUGIN_ROOT = join(__dirname, '..');

function createFakeReact() {
  let si = 0;
  let ei = 0;
  let mi = 0;
  let ci = 0;
  const states = [];
  const effects = [];
  const memos = [];
  const callbacks = [];
  const pendingEffects = [];
  const depsChanged = (a, b) => !a || !b || a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]));

  return {
    Fragment: 'Fragment',
    createElement(type, props, ...children) {
      return {
        type,
        props: props || {},
        children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false),
      };
    },
    useState(init) {
      const idx = si++;
      if (!(idx in states)) states[idx] = typeof init === 'function' ? init() : init;
      return [states[idx], (u) => { states[idx] = typeof u === 'function' ? u(states[idx]) : u; }];
    },
    useEffect(fn, deps) {
      const idx = ei++;
      const prev = effects[idx];
      if (!prev || depsChanged(prev.deps, deps)) {
        pendingEffects.push({ idx, fn, deps });
      }
    },
    useMemo(fn, deps) {
      const idx = mi++;
      const prev = memos[idx];
      if (!prev || depsChanged(prev.deps, deps)) {
        memos[idx] = { value: fn(), deps };
      }
      return memos[idx].value;
    },
    useCallback(fn, deps) {
      const idx = ci++;
      const prev = callbacks[idx];
      if (!prev || depsChanged(prev.deps, deps)) {
        callbacks[idx] = { fn, deps };
      }
      return callbacks[idx].fn;
    },
    _render(Comp, props = {}) {
      si = 0; ei = 0; mi = 0; ci = 0;
      return Comp(props);
    },
    async _flushEffects() {
      for (const ef of pendingEffects.splice(0)) {
        if (effects[ef.idx]?.cleanup) effects[ef.idx].cleanup();
        const cleanup = await ef.fn();
        effects[ef.idx] = { deps: ef.deps, cleanup: typeof cleanup === 'function' ? cleanup : null };
      }
      await new Promise((r) => setImmediate(r));
    },
  };
}

function findNode(node, pred) {
  if (!node || typeof node !== 'object') return null;
  if (pred(node)) return node;
  if (Array.isArray(node.children)) {
    for (const c of node.children) {
      const hit = findNode(c, pred);
      if (hit) return hit;
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

test('public-track-page parses /v/track/:code & /track/:code safely, rejects traversal/XSS, and bridges legacy-default redirects', () => {
  const { parseTrackParams, resolveLegacyTrackRedirect } = require('../src/client-v2/public-track-page');

  const p1 = parseTrackParams({
    pathname: '/v/track/LDX-TRK-A1B2C3',
    search: '?token=ldx_trk_secret123',
  });
  assert.deepEqual(p1, { trackingCode: 'LDX-TRK-A1B2C3', token: 'ldx_trk_secret123' });

  const p2 = parseTrackParams({
    pathname: '/track/LDX-TRK-Z9',
    search: '?trackingToken=ldx_trk_999',
  });
  assert.deepEqual(p2, { trackingCode: 'LDX-TRK-Z9', token: 'ldx_trk_999' });

  // Unsafe traversal/XSS rejected
  const unsafe = parseTrackParams({
    pathname: '/v/track/..%2Fetc%2Fpasswd',
    search: '?token=<script>alert(1)</script>',
  });
  assert.equal(unsafe.trackingCode, '');
  assert.equal(unsafe.token, '');

  // Legacy redirect bridges /track/:code without colliding with /mobile*
  assert.equal(
    resolveLegacyTrackRedirect({
      __nocobase_app_client_entry_mode__: 'legacy-default',
      location: { pathname: '/track/LDX-TRK-001', search: '?token=ldx_trk_abc', hash: '' },
    }),
    '/v/track/LDX-TRK-001?token=ldx_trk_abc',
  );
  assert.equal(
    resolveLegacyTrackRedirect({
      __nocobase_app_client_entry_mode__: 'legacy-default',
      location: { pathname: '/mobile/sub', search: '', hash: '' },
    }),
    null,
  );
  assert.equal(
    resolveLegacyTrackRedirect({
      __nocobase_app_client_entry_mode__: 'legacy-default',
      location: { pathname: '/v/track/LDX-TRK-001', search: '?token=x', hash: '' },
    }),
    null,
  );
});

test('PublicTrackPage renders zero-PII shipment status via dxosWms:publicTrack and executes live dxosWms:verifyTrackSignature', async () => {
  const { createPublicTrackPage } = require('../src/client-v2/public-track-page');

  // Factory must not invoke React hooks or createElement during creation
  assert.doesNotThrow(() => createPublicTrackPage({ Plugin: class {} }, {}, {}));

  const fakeReact = createFakeReact();
  const requests = [];
  let verifyResponseMode = 'valid';
  const mockApi = {
    async request(req) {
      requests.push(req);
      if (req.url === 'dxosWms:publicTrack') {
        if (req.params?.token === 'bad_token') {
          throw Object.assign(new Error('Unauthorized'), { response: { status: 401, data: { errors: [{ message: 'Mã xác thực theo dõi không hợp lệ.' }] } } });
        }
        return {
          data: {
            data: {
              trackingCode: req.params.trackingCode,
              status: 'delivered',
              deliveredAt: '2026-11-24T10:15:00.000Z',
              orderCode: 'ORD-COLD-88',
              tempSummary: { mktCelsius: 3.9, inRange: true },
              ledgerVerification: { seq: 42, keyId: 'ed25519-org-a-v1', verifiedFormat: true },
            },
          },
        };
      }
      if (req.url === 'dxosWms:verifyTrackSignature') {
        if (verifyResponseMode === 'invalid') {
          return {
            data: {
              data: {
                verified: false,
                ledgerSeq: 42,
                entryHash: 'hash_tampered_0001',
                keyId: 'ed25519-org-a-v1',
                publicKeyFingerprint: 'fp_1234567890abcdef',
                reason: 'LEDGER_SIGNATURE_MISMATCH',
              },
            },
          };
        }
        if (verifyResponseMode === 'unauthorized') {
          throw Object.assign(new Error('Unauthorized'), {
            response: { status: 401, data: { errors: [{ message: 'Mã theo dõi không hợp lệ.' }] } },
          });
        }
        return {
          data: {
            data: {
              verified: true,
              seq: 42,
              entryHash: 'sha256_entry_deadbeef0042',
              keyId: 'ed25519-org-a-v1',
              publicKeyFingerprint: 'fp_1234567890abcdef',
              reason: '',
            },
          },
        };
      }
      return { data: {} };
    },
  };

  const PublicTrackPage = createPublicTrackPage({ Plugin: class {} }, fakeReact, { apiClient: mockApi });
  let tree = fakeReact._render(PublicTrackPage, {
    apiClient: mockApi,
    trackingCode: 'LDX-TRK-88',
    token: 'ldx_trk_valid_88',
  });
  await fakeReact._flushEffects();
  tree = fakeReact._render(PublicTrackPage, {
    apiClient: mockApi,
    trackingCode: 'LDX-TRK-88',
    token: 'ldx_trk_valid_88',
  });

  assert.ok(findNode(tree, (n) => n.props?.['data-testid'] === 'public-track-page'));
  assert.ok(requests.some((r) => r.url === 'dxosWms:publicTrack' && r.params?.trackingCode === 'LDX-TRK-88' && r.params?.token === 'ldx_trk_valid_88'));

  const statusCard = findNode(tree, (n) => n.props?.['data-testid'] === 'public-track-status-card');
  assert.ok(statusCard);
  const cardText = collectText(statusCard);
  assert.ok(cardText.includes('LDX-TRK-88'));
  assert.ok(cardText.includes('ORD-COLD-88'));
  assert.ok(cardText.includes('3.9'));
  assert.ok(cardText.includes('ed25519-org-a-v1'));

  // Zero-PII check
  for (const forbidden of ['recipientName', 'recipientPhone', 'gpsLat', 'gpsLng', 'signatureDataUrl']) {
    assert.equal(JSON.stringify(tree).includes(forbidden), false);
  }

  // Click live Ed25519 verification button -> must call public dxosWms:verifyTrackSignature (never dxosLedger:verifySignature)
  const verifyBtn = findNode(tree, (n) => n.props?.['data-testid'] === 'public-track-verify-btn');
  assert.ok(verifyBtn);
  await verifyBtn.props.onClick();
  tree = fakeReact._render(PublicTrackPage, {
    apiClient: mockApi,
    trackingCode: 'LDX-TRK-88',
    token: 'ldx_trk_valid_88',
  });
  const verifyReq = requests.find((r) => r.url === 'dxosWms:verifyTrackSignature');
  assert.ok(verifyReq);
  assert.equal(verifyReq.method, 'POST');
  assert.deepEqual(verifyReq.data, { code: 'LDX-TRK-88', token: 'ldx_trk_valid_88' });
  assert.equal(requests.some((r) => r.url === 'dxosLedger:verifySignature'), false);
  assert.equal(JSON.stringify(requests).includes('verify-public-track'), false);

  const verifyRes = findNode(tree, (n) => n.props?.['data-testid'] === 'public-track-verify-result');
  const verifyResText = collectText(verifyRes);
  assert.ok(verifyResText.includes('Chữ ký Ed25519 hợp lệ'));
  assert.ok(verifyResText.includes('Seq #42'));
  assert.ok(verifyResText.includes('ed25519-org-a-v1'));
  assert.ok(verifyResText.includes('fp_1234567890abcdef'));
  assert.ok(verifyResText.includes('sha256_entry_deadbeef0042'));

  // Tampered / failed verification displays verified=false + reason
  verifyResponseMode = 'invalid';
  const verifyBtn2 = findNode(tree, (n) => n.props?.['data-testid'] === 'public-track-verify-btn');
  await verifyBtn2.props.onClick();
  tree = fakeReact._render(PublicTrackPage, {
    apiClient: mockApi,
    trackingCode: 'LDX-TRK-88',
    token: 'ldx_trk_valid_88',
  });
  const invalidRes = findNode(tree, (n) => n.props?.['data-testid'] === 'public-track-verify-result');
  const invalidText = collectText(invalidRes);
  assert.ok(invalidText.includes('Chữ ký Ed25519 không hợp lệ'));
  assert.ok(invalidText.includes('LEDGER_SIGNATURE_MISMATCH'));
  assert.ok(invalidText.includes('hash_tampered_0001'));

  // Unauthorized token error surfaces clean message
  verifyResponseMode = 'unauthorized';
  const verifyBtn3 = findNode(tree, (n) => n.props?.['data-testid'] === 'public-track-verify-btn');
  await verifyBtn3.props.onClick();
  tree = fakeReact._render(PublicTrackPage, {
    apiClient: mockApi,
    trackingCode: 'LDX-TRK-88',
    token: 'ldx_trk_valid_88',
  });
  const errBox = findNode(tree, (n) => n.props?.['data-testid'] === 'public-track-verify-error');
  assert.ok(errBox && collectText(errBox).includes('Mã theo dõi không hợp lệ.'));
});

test('dist/client-v2/index.js & dist/client/index.js mount /mobile, /mobile/*, and /track/:code cleanly without route collisions or extra externals', async () => {
  const distV2Path = join(PLUGIN_ROOT, 'dist/client-v2/index.js');
  const distV2Src = readFileSync(distV2Path, 'utf8');
  assert.doesNotMatch(distV2Src, /['"]@nocobase\/client['"]/);

  let modV2;
  const defineV2 = (name, deps, factory) => {
    assert.equal(name, '@latticedx/plugin-lattice-foundation/client-v2');
    assert.deepEqual(Array.from(deps), ['@nocobase/client-v2', 'react']);
    modV2 = factory({ Plugin: class {} }, {});
  };
  defineV2.amd = {};
  vm.runInNewContext(distV2Src, { define: defineV2, sessionStorage: { getItem: () => null }, window: { location: { pathname: '/v/track/LDX-TRK-1' } } });

  const pluginV2 = new modV2.default();
  const routesV2 = [];
  pluginV2.app = { router: { add: (name, route) => routesV2.push({ name, ...route }) } };
  await pluginV2.load();

  assert.ok(routesV2.some((r) => r.name === 'dxos-mobile-field' && r.path === '/mobile' && typeof r.Component === 'function'));
  assert.ok(routesV2.some((r) => r.name === 'dxos-mobile-field-sub' && r.path === '/mobile/*' && typeof r.Component === 'function'));
  assert.ok(routesV2.some((r) => r.name === 'dxos-public-track' && r.path === '/track/:code' && r.skipAuthCheck === true && typeof r.Component === 'function'));
});

test('P0-05 & P3-05: PublicTrackPage handles ?verify= proof without bypassing trackingToken, renders lookup form + eye toggle', async () => {
  const { parseTrackParams, createPublicTrackPage } = require('../src/client-v2/public-track-page');
  const withVerify = parseTrackParams({
    pathname: '/v/track/LDX-TRK-9373FB0FE9',
    search: '?verify=abc123def4567890',
  });
  assert.deepEqual(withVerify, { trackingCode: 'LDX-TRK-9373FB0FE9', token: '', verify: 'abc123def4567890' });

  const fakeReact = createFakeReact();
  const requests = [];
  const mockApi = {
    async request(req) {
      requests.push(req);
      if (req.url === 'dxosWms:verifyTrackSignature') {
        return {
          data: {
            data: {
              verified: true,
              publicProofOnly: true,
              trackingCode: 'LDX-TRK-9373FB0FE9',
              keyId: 'ed25519-org-a-v1',
              ledgerEntryHash: 'sha256_proof_999',
              signedAt: '2026-11-26T01:00:00.000Z',
              requiresTokenForDetails: true,
            },
          },
        };
      }
      if (req.url === 'dxosWms:publicTrack') {
        return {
          data: {
            data: {
              trackingCode: req.params.trackingCode,
              status: 'delivered',
              orderCode: 'ORD-COLD-99',
              ledgerVerification: { seq: 11, keyId: 'ed25519-org-a-v1', verifiedFormat: true },
            },
          },
        };
      }
      return { data: {} };
    },
  };

  const PublicTrackPage = createPublicTrackPage({ Plugin: class {} }, fakeReact, { apiClient: mockApi });
  let tree = fakeReact._render(PublicTrackPage, {
    apiClient: mockApi,
    location: { pathname: '/v/track/LDX-TRK-9373FB0FE9', search: '?verify=abc123def4567890' },
  });
  await fakeReact._flushEffects();
  tree = fakeReact._render(PublicTrackPage, {
    apiClient: mockApi,
    location: { pathname: '/v/track/LDX-TRK-9373FB0FE9', search: '?verify=abc123def4567890' },
  });

  assert.equal(requests.some((r) => r.url === 'dxosWms:publicTrack'), false);
  const verifyReq = requests.find((r) => r.url === 'dxosWms:verifyTrackSignature');
  assert.ok(verifyReq && verifyReq.method === 'POST');
  assert.deepEqual(verifyReq.data, {
    code: 'LDX-TRK-9373FB0FE9',
    trackingCode: 'LDX-TRK-9373FB0FE9',
    verify: 'abc123def4567890',
  });

  const proofCard = findNode(tree, (n) => n.props?.['data-testid'] === 'public-track-proof-card');
  assert.ok(proofCard, 'Expected public-track-proof-card');
  assert.ok(collectText(proofCard).includes('ed25519-org-a-v1'));

  const codeInput = findNode(tree, (n) => n.props?.['data-testid'] === 'public-track-code-input');
  const tokenInput = findNode(tree, (n) => n.props?.['data-testid'] === 'public-track-token-input');
  const toggleBtn = findNode(tree, (n) => n.props?.['data-testid'] === 'public-track-token-toggle');
  assert.equal(codeInput?.props?.value, 'LDX-TRK-9373FB0FE9');
  assert.equal(tokenInput?.props?.type, 'password');
  assert.ok(toggleBtn);
  toggleBtn.props.onClick();
  tree = fakeReact._render(PublicTrackPage, {
    apiClient: mockApi,
    location: { pathname: '/v/track/LDX-TRK-9373FB0FE9', search: '?verify=abc123def4567890' },
  });
  assert.equal(findNode(tree, (n) => n.props?.['data-testid'] === 'public-track-token-input')?.props?.type, 'text');
});

test('T4-RW-02: PublicTrackPage interactive buttons and inputs enforce >=44px mobile touch targets', async () => {
  const { createPublicTrackPage } = require('../src/client-v2/public-track-page');
  const fakeReact = createFakeReact();
  const mockApi = {
    async request(req) {
      if (req.url === 'dxosWms:publicTrack') {
        return {
          data: {
            data: {
              trackingCode: 'LDX-TRK-TOUCH-44',
              status: 'delivered',
              orderCode: 'ORD-TOUCH-44',
              ledgerVerification: { seq: 1, keyId: 'k1', verifiedFormat: true },
            },
          },
        };
      }
      return { data: {} };
    },
  };
  const PublicTrackPage = createPublicTrackPage({ Plugin: class {} }, fakeReact, { apiClient: mockApi });
  let tree = fakeReact._render(PublicTrackPage, {
    apiClient: mockApi,
    trackingCode: 'LDX-TRK-TOUCH-44',
    token: 'ldx_trk_touch_44',
  });
  await fakeReact._flushEffects();
  tree = fakeReact._render(PublicTrackPage, {
    apiClient: mockApi,
    trackingCode: 'LDX-TRK-TOUCH-44',
    token: 'ldx_trk_touch_44',
  });

  for (const tid of [
    'public-track-code-input',
    'public-track-token-input',
    'public-track-token-toggle',
    'public-track-lookup-btn',
    'public-track-verify-btn',
  ]) {
    const el = findNode(tree, (n) => n.props?.['data-testid'] === tid);
    assert.ok(el, `Expected element ${tid}`);
    assert.ok(Number(el.props?.style?.minHeight) >= 44, `${tid} minHeight must be >= 44, got ${el.props?.style?.minHeight}`);
    if (el.type === 'button') {
      assert.ok(Number(el.props?.style?.minWidth) >= 44, `${tid} minWidth must be >= 44, got ${el.props?.style?.minWidth}`);
    }
  }
});

test('Bug #5: PublicTrackPage falls back to #verify= in loc.hash while preserving ?verify= search precedence', async () => {
  const { parseTrackParams, createPublicTrackPage } = require('../src/client-v2/public-track-page');

  assert.deepEqual(
    parseTrackParams({ pathname: '/v/track/ORD-V100-001', search: '', hash: '#verify=hashproof123456' }),
    { trackingCode: 'ORD-V100-001', token: '', verify: 'hashproof123456' },
  );
  assert.deepEqual(
    parseTrackParams({ pathname: '/v/track/ORD-V100-001', search: '', hash: '#/v/track/ORD-V100-001?verify=hashroute7890' }),
    { trackingCode: 'ORD-V100-001', token: '', verify: 'hashroute7890' },
  );
  assert.deepEqual(
    parseTrackParams({ pathname: '/v/track/ORD-V100-001', search: '?verify=searchwins111', hash: '#verify=hashloses222' }),
    { trackingCode: 'ORD-V100-001', token: '', verify: 'searchwins111' },
  );
  assert.deepEqual(
    parseTrackParams({ pathname: '/v/track/ORD-V100-001', search: '', hash: '#verify=<script>alert(1)</script>' }),
    { trackingCode: 'ORD-V100-001', token: '' },
  );
  assert.deepEqual(
    parseTrackParams({
      pathname: '/v/track/ORD-V100-001',
      search: '?__proto__=polluted&constructor=bad&prototype=bad',
      hash: '#__proto__=polluted&verify=safeproof999',
    }),
    { trackingCode: 'ORD-V100-001', token: '', verify: 'safeproof999' },
  );
  assert.equal(({}).polluted, undefined);

  const fakeReact = createFakeReact();
  const requests = [];
  const mockApi = {
    async request(req) {
      requests.push(req);
      return {
        data: {
          data: {
            verified: true,
            publicProofOnly: true,
            trackingCode: 'ORD-V100-001',
            keyId: 'ed25519-org-a-v1',
            ledgerEntryHash: 'sha256_hash_fallback',
            signedAt: '2026-11-27T02:00:00.000Z',
          },
        },
      };
    },
  };

  const PublicTrackPage = createPublicTrackPage({ Plugin: class {} }, fakeReact, { apiClient: mockApi });
  let tree = fakeReact._render(PublicTrackPage, {
    apiClient: mockApi,
    location: { pathname: '/v/track/ORD-V100-001', search: '', hash: '#verify=hashproof123456' },
  });
  await fakeReact._flushEffects();
  tree = fakeReact._render(PublicTrackPage, {
    apiClient: mockApi,
    location: { pathname: '/v/track/ORD-V100-001', search: '', hash: '#verify=hashproof123456' },
  });

  const verifyReq = requests.find((r) => r.url === 'dxosWms:verifyTrackSignature');
  assert.ok(verifyReq, 'Must trigger dxosWms:verifyTrackSignature from #verify= hash fallback');
  assert.deepEqual(verifyReq.data, {
    code: 'ORD-V100-001',
    trackingCode: 'ORD-V100-001',
    verify: 'hashproof123456',
  });
  assert.ok(findNode(tree, (n) => n.props?.['data-testid'] === 'public-track-proof-card'));
});
