/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const vm = require('node:vm');

function withMockedNocobase(gatewayHandlers, fn) {
  const origLoad = Module._load;
  class MockPlugin {
    constructor(app, options = {}) {
      this.app = app;
      this.db = app?.db;
      this.options = options;
    }
  }
  const Gateway = {
    registerRequestHandler(h) { gatewayHandlers.push(h); },
    unregisterRequestHandler(h) {
      const idx = gatewayHandlers.indexOf(h);
      if (idx >= 0) gatewayHandlers.splice(idx, 1);
    },
  };
  Module._load = function mockedLoad(request, parent, isMain) {
    if (request === '@nocobase/server') {
      return { Plugin: MockPlugin, Gateway };
    }
    if (request === '@nocobase/database') {
      return { defineCollection: (def) => def };
    }
    return origLoad.call(this, request, parent, isMain);
  };
  return Promise.resolve()
    .then(() => fn())
    .finally(() => {
      Module._load = origLoad;
    });
}

test('public-track-html matches /v/track & /v/track/:code, serves zero-401/404 nonce-CSP HTML with lookup form & Ed25519 verify', async () => {
  const {
    matchPublicTrackPath,
    renderPublicTrackHtml,
    createPublicTrackGatewayHandler,
  } = require('../src/server/public-track-html');

  // 1. Path matching & traversal sanitization
  assert.deepEqual(matchPublicTrackPath('/v/track'), { matched: true, rawCode: '' });
  assert.deepEqual(matchPublicTrackPath('/v/track/'), { matched: true, rawCode: '' });
  assert.deepEqual(matchPublicTrackPath('/v/track/ORD-V100-001'), { matched: true, rawCode: 'ORD-V100-001' });
  assert.deepEqual(matchPublicTrackPath('/v/track/LDX-TRK-001/'), { matched: true, rawCode: 'LDX-TRK-001' });
  assert.deepEqual(matchPublicTrackPath('/track/LDX-TRK-002'), { matched: true, rawCode: 'LDX-TRK-002' });
  assert.deepEqual(matchPublicTrackPath('/v/track/..%2Fetc%2Fpasswd'), { matched: true, rawCode: '' });
  assert.deepEqual(matchPublicTrackPath('/v/signin'), { matched: false, rawCode: '' });
  assert.deepEqual(matchPublicTrackPath('/v/assets/index.js'), { matched: false, rawCode: '' });
  assert.deepEqual(matchPublicTrackPath('/api/dxosWms:publicTrack'), { matched: false, rawCode: '' });
  assert.deepEqual(matchPublicTrackPath('/v/track/a/b'), { matched: false, rawCode: '' });

  // 2. HTML invariants: exact title, inline SVG favicon, nonce CSP, zero innerHTML/on*, zero auth/AI calls
  const html = renderPublicTrackHtml({
    trackingCode: 'ORD-V100-001',
    token: '',
    nonce: 'track-nonce-123',
    apiBasePath: '/api',
  });
  assert.match(html, /<title>Tra cứu vận đơn — LatticeDX<\/title>/);
  assert.match(html, /<link rel="icon" type="image\/svg\+xml" href="data:image\/svg\+xml,/);
  assert.match(html, /<style nonce="track-nonce-123">/);
  assert.match(html, /<script type="application\/json" id="dxos-track-bootstrap" nonce="track-nonce-123">/);
  assert.match(html, /<script nonce="track-nonce-123">/);
  assert.equal(/\son[a-z]+\s*=/i.test(html), false);
  assert.equal(html.includes('innerHTML'), false);
  assert.equal(html.includes('aiConversations'), false);
  assert.equal(html.includes('aiEmployees'), false);
  assert.match(html, /public-track-lookup-form/);
  assert.match(html, /public-track-code-input/);
  assert.match(html, /public-track-token-input/);
  assert.match(html, /public-track-verify-btn/);
  assert.match(html, /dxosWms:publicTrack/);
  assert.match(html, /dxosWms:verifyTrackSignature/);
  assert.match(html, /"trackingCode":"ORD-V100-001"/);

  // 3. XSS payload in trackingCode is rejected/sanitized cleanly
  const xssHtml = renderPublicTrackHtml({
    trackingCode: '</script><script>alert(1)</script>',
    token: 'bad<script>',
    nonce: 'xss-nonce-999',
  });
  assert.equal(xssHtml.includes('<script>alert(1)</script>'), false);
  assert.match(xssHtml, /"trackingCode":""/);
  assert.match(xssHtml, /"token":""/);

  // 4. Gateway handler serves GET/HEAD with strict CSP headers and skips non-matching routes
  const handler = createPublicTrackGatewayHandler();
  const makeRes = () => {
    const headers = {};
    let statusCode = null;
    let body = '';
    return {
      writeHead(code, hdrs) {
        statusCode = code;
        for (const [k, v] of Object.entries(hdrs || {})) headers[k.toLowerCase()] = v;
      },
      setHeader(k, v) { headers[k.toLowerCase()] = v; },
      end(chunk = '') { body += String(chunk || ''); },
      _out: () => ({ statusCode, headers, body }),
    };
  };

  assert.equal(await handler({ method: 'POST', url: '/v/track/ORD-V100-001' }, makeRes()), false);
  assert.equal(await handler({ method: 'GET', url: '/v/form/cold-intake' }, makeRes()), false);
  assert.equal(await handler({ method: 'GET', url: '/api/dxosWms:publicTrack' }, makeRes()), false);

  const resGet = makeRes();
  assert.equal(await handler({ method: 'GET', url: '/v/track/ORD-V100-001?token=ldx_trk_abc' }, resGet), true);
  const outGet = resGet._out();
  assert.equal(outGet.statusCode, 200);
  assert.equal(outGet.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(outGet.headers['cache-control'], 'no-store');
  assert.match(outGet.headers['content-security-policy'], /^default-src 'none'; script-src 'nonce-[A-Za-z0-9_-]+'; style-src 'nonce-[A-Za-z0-9_-]+'; img-src data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'self'$/);
  assert.match(outGet.body, /"trackingCode":"ORD-V100-001"/);
  assert.match(outGet.body, /"token":"ldx_trk_abc"/);

  const resHead = makeRes();
  assert.equal(await handler({ method: 'HEAD', url: '/v/track' }, resHead), true);
  assert.equal(resHead._out().statusCode, 200);
  assert.equal(resHead._out().body, '');

  // 5. Client script executes cleanly without ?token= (ZERO fetch calls -> zero 401!)
  const scriptMatches = [...outGet.body.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
  const inlineJs = scriptMatches[1][1];
  const fetchCalls = [];
  const createdNodes = [];
  const makeNode = (tag) => {
    const node = {
      tagName: String(tag || '').toUpperCase(),
      attrs: {},
      children: [],
      listeners: {},
      value: '',
      textContent: '',
      className: '',
      classList: {
        add(c) { node.className += ` ${c}`; },
        remove(c) { node.className = node.className.replace(c, ''); },
      },
      setAttribute(k, v) { node.attrs[k] = v; if (k === 'value') node.value = v; },
      appendChild(c) { node.children.push(c); return c; },
      removeChild(c) { const i = node.children.indexOf(c); if (i >= 0) node.children.splice(i, 1); },
      get firstChild() { return node.children[0] || null; },
      addEventListener(ev, fn) { node.listeners[ev] = fn; },
    };
    createdNodes.push(node);
    return node;
  };
  const rootEl = makeNode('main');
  const bootWithoutToken = {
    textContent: JSON.stringify({ trackingCode: 'ORD-V100-001', token: '', apiBasePath: '/api' }),
  };
  vm.runInNewContext(inlineJs, {
    URLSearchParams,
    Date,
    Promise,
    Error,
    window: { location: { search: '' } },
    document: {
      getElementById: (id) => (id === 'dxos-public-track-root' ? rootEl : (id === 'dxos-track-bootstrap' ? bootWithoutToken : null)),
      createElement: makeNode,
    },
    fetch: async (u) => { fetchCalls.push(u); return { ok: true, json: async () => ({}) }; },
  });
  assert.equal(fetchCalls.length, 0, 'Opening /v/track/ORD-V100-001 without ?token= must make ZERO API calls');
  const lookupForm = createdNodes.find((n) => n.attrs['data-testid'] === 'public-track-lookup-form');
  const codeField = createdNodes.find((n) => n.attrs['data-testid'] === 'public-track-code-input');
  const tokenField = createdNodes.find((n) => n.attrs['data-testid'] === 'public-track-token-input');
  assert.ok(lookupForm && Object.hasOwn(lookupForm.attrs, 'novalidate'), 'Lookup form must include novalidate');
  assert.equal(codeField?.value, 'ORD-V100-001');
  assert.ok(tokenField, 'Token input box must always render');

  // Empty token submit shows inline Vietnamese error and clears on input with 0 fetch calls
  for (const fn of (Array.isArray(lookupForm.listeners.submit) ? lookupForm.listeners.submit : [lookupForm.listeners.submit]).filter(Boolean)) {
    fn({ preventDefault() {} });
  }
  assert.equal(fetchCalls.length, 0, 'Empty token submit must make ZERO fetch calls');
  const trackErr = createdNodes.find((n) => n.attrs['data-testid'] === 'public-track-error');
  const tokenErr = createdNodes.find((n) => n.attrs['data-testid'] === 'public-track-token-error');
  const codeErr = createdNodes.find((n) => n.attrs['data-testid'] === 'public-track-code-error');
  assert.ok(trackErr && trackErr.textContent.includes('Vui lòng'), 'Expected Vietnamese summary track error');
  assert.ok(tokenErr && tokenErr.textContent.includes('Vui lòng'), 'Expected Vietnamese inline token error');
  assert.ok(codeErr && codeErr.textContent === '', 'Code field is populated so code error stays empty');

  tokenField.value = 'ldx_trk_abc';
  for (const fn of (Array.isArray(tokenField.listeners.input) ? tokenField.listeners.input : [tokenField.listeners.input]).filter(Boolean)) {
    fn();
  }
  assert.equal(tokenErr.textContent, '');
});

test('LatticeFoundationPlugin registers and unregisters /v/track gateway handler across load/unload/remove/destroy', async () => {
  const gatewayHandlers = [];
  await withMockedNocobase(gatewayHandlers, async () => {
    delete require.cache[require.resolve('../src/server/index')];
    const PluginCls = require('../src/server/index');
    const mockApp = {
      db: {
        sequelize: { getDialect: () => 'sqlite', query: async () => [[]] },
        getRepository: () => null,
        on() {},
      },
      resourceManager: { define() {}, use() {} },
      acl: { allow() {}, use() {}, registerSnippet() {} },
      pubSubManager: { subscribe() {}, publish() {} },
    };
    const plugin = new PluginCls(mockApp, {});
    await plugin.load();
    assert.ok(plugin._publicFormGatewayHandler);
    assert.ok(plugin._publicTrackGatewayHandler);
    assert.ok(gatewayHandlers.includes(plugin._publicFormGatewayHandler));
    assert.ok(gatewayHandlers.includes(plugin._publicTrackGatewayHandler));

    await plugin.unload();
    assert.equal(plugin._publicTrackGatewayHandler, null);
    assert.equal(gatewayHandlers.length, 0);
  });
});

test('P0-05 & P3-05: /v/track/:code?verify=... verifies public Ed25519 proof via POST without bypassing trackingToken, and eye toggle flips token input type', async () => {
  const { createPublicTrackGatewayHandler } = require('../src/server/public-track-html');
  const handler = createPublicTrackGatewayHandler();
  const makeRes = () => {
    const headers = {};
    let statusCode = null;
    let body = '';
    return {
      writeHead(code, hdrs) {
        statusCode = code;
        for (const [k, v] of Object.entries(hdrs || {})) headers[k.toLowerCase()] = v;
      },
      setHeader(k, v) { headers[k.toLowerCase()] = v; },
      end(chunk = '') { body += String(chunk || ''); },
      _out: () => ({ statusCode, headers, body }),
    };
  };

  const resVerify = makeRes();
  assert.equal(await handler({ method: 'GET', url: '/v/track/LDX-TRK-9373FB0FE9?verify=abc123def4567890' }, resVerify), true);
  const html = resVerify._out().body;
  assert.match(html, /"trackingCode":"LDX-TRK-9373FB0FE9"/);
  assert.match(html, /"verify":"abc123def4567890"/);

  const scriptMatches = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
  const bootJson = JSON.parse(scriptMatches[0][1]);
  const inlineJs = scriptMatches[1][1];
  const fetchCalls = [];
  const createdNodes = [];
  const makeNode = (tag) => {
    const node = {
      tagName: String(tag || '').toUpperCase(),
      attrs: {},
      children: [],
      listeners: {},
      value: '',
      textContent: '',
      className: '',
      classList: {
        add(c) { node.className += ` ${c}`; },
        remove(c) { node.className = node.className.replace(c, ''); },
      },
      setAttribute(k, v) { node.attrs[k] = v; if (k === 'value') node.value = v; },
      getAttribute(k) { return node.attrs[k]; },
      appendChild(c) { node.children.push(c); return c; },
      removeChild(c) { const i = node.children.indexOf(c); if (i >= 0) node.children.splice(i, 1); },
      get firstChild() { return node.children[0] || null; },
      addEventListener(ev, fn) { (node.listeners[ev] ||= []).push(fn); },
    };
    createdNodes.push(node);
    return node;
  };
  const rootEl = makeNode('main');
  const bootEl = { textContent: JSON.stringify(bootJson) };
  vm.runInNewContext(inlineJs, {
    URLSearchParams,
    Date,
    Promise,
    Error,
    window: { location: { search: '?verify=abc123def4567890' } },
    document: {
      getElementById: (id) => (id === 'dxos-public-track-root' ? rootEl : (id === 'dxos-track-bootstrap' ? bootEl : null)),
      createElement: makeNode,
    },
    fetch: async (u, opts) => {
      fetchCalls.push({ u, opts });
      return {
        ok: true,
        json: async () => ({
          data: {
            verified: true,
            publicProofOnly: true,
            trackingCode: 'LDX-TRK-9373FB0FE9',
            keyId: 'ed25519-org-a-v1',
            ledgerEntryHash: 'sha256_proof_1234',
            signedAt: '2026-11-26T00:00:00.000Z',
            requiresTokenForDetails: true,
          },
        }),
      };
    },
  });
  await new Promise((r) => setImmediate(r));

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].u, '/api/dxosWms:verifyTrackSignature');
  assert.equal(fetchCalls[0].opts.method, 'POST');
  assert.deepEqual(JSON.parse(fetchCalls[0].opts.body), {
    code: 'LDX-TRK-9373FB0FE9',
    trackingCode: 'LDX-TRK-9373FB0FE9',
    verify: 'abc123def4567890',
  });
  assert.equal(fetchCalls.some((c) => c.u.includes('publicTrack')), false, '?verify= must NEVER bypass trackingToken to call publicTrack');

  const proofCard = createdNodes.find((n) => n.attrs['data-testid'] === 'public-track-proof-card');
  assert.ok(proofCard, 'Expected public-track-proof-card rendered for ?verify=');

  const tokenInput = createdNodes.find((n) => n.attrs['data-testid'] === 'public-track-token-input');
  const toggleBtn = createdNodes.find((n) => n.attrs['data-testid'] === 'public-track-token-toggle');
  assert.ok(toggleBtn, 'Expected eye toggle button for trackingToken input');
  assert.equal(tokenInput.attrs.type, 'password');
  for (const fn of toggleBtn.listeners.click || []) fn();
  assert.equal(tokenInput.attrs.type, 'text');
  for (const fn of toggleBtn.listeners.click || []) fn();
  assert.equal(tokenInput.attrs.type, 'password');
});

test('T4-RW-02: SSR public-track-html styles enforce >=44px touch targets on inputs and buttons', () => {
  const { renderPublicTrackHtml } = require('../src/server/public-track-html');
  const html = renderPublicTrackHtml({ trackingCode: 'LDX-TRK-SSR-44', nonce: 'ssr-touch-44' });
  assert.match(html, /\.dxos-input\s*\{[^}]*min-height:\s*44px/);
  assert.match(html, /\.dxos-eye-btn\s*\{[^}]*min-height:\s*44px[^}]*min-width:\s*44px/);
  assert.match(html, /\.dxos-btn\s*\{[^}]*min-height:\s*44px[^}]*min-width:\s*44px/);
});
