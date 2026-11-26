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
const Module = require('node:module');

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

function makeRes() {
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
}

test('createPublicBrandingGatewayHandler serves /v/lattice-brand.svg and /v/favicon_no_exist.ico for GET/HEAD only', async () => {
  const {
    BRAND_LOGO_PATH,
    FAVICON_FALLBACK_PATH,
    createPublicBrandingGatewayHandler,
  } = require('../src/server/public-branding');

  assert.equal(BRAND_LOGO_PATH, '/v/lattice-brand.svg');
  assert.equal(FAVICON_FALLBACK_PATH, '/v/favicon_no_exist.ico');

  const handler = createPublicBrandingGatewayHandler();
  assert.equal(await handler({ method: 'POST', url: BRAND_LOGO_PATH }, makeRes()), false);
  assert.equal(await handler({ method: 'GET', url: '/v/other.svg' }, makeRes()), false);
  assert.equal(await handler({ method: 'GET', url: '/files/main/main/attachments/1.png' }, makeRes()), false);

  for (const path of [BRAND_LOGO_PATH, FAVICON_FALLBACK_PATH, `${BRAND_LOGO_PATH}?v=1`]) {
    const resGet = makeRes();
    assert.equal(await handler({ method: 'GET', url: path }, resGet), true);
    const outGet = resGet._out();
    assert.equal(outGet.statusCode, 200);
    assert.equal(outGet.headers['content-type'], 'image/svg+xml; charset=utf-8');
    assert.equal(outGet.headers['cache-control'], 'public, max-age=86400');
    assert.equal(outGet.headers['x-content-type-options'], 'nosniff');
    assert.match(outGet.body, /<svg\b[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);

    const resHead = makeRes();
    assert.equal(await handler({ method: 'HEAD', url: path }, resHead), true);
    const outHead = resHead._out();
    assert.equal(outHead.statusCode, 200);
    assert.equal(outHead.headers['content-type'], 'image/svg+xml; charset=utf-8');
    assert.equal(outHead.body, '');
  }
});

test('createSystemSettingsBrandingMiddleware normalizes seeded nocobase-logo, 1.png, missing logo, and unauthenticated /files/* while preserving authenticated custom logos', async () => {
  const {
    BRAND_LOGO_PATH,
    createSystemSettingsBrandingMiddleware,
  } = require('../src/server/public-branding');

  const middleware = createSystemSettingsBrandingMiddleware();

  // 1. Plain object response with seeded nocobase-logo / 1.png (unauthenticated)
  const ctxSeeded = {
    action: { resourceName: 'systemSettings', actionName: 'get' },
    state: {},
    body: {
      id: 1,
      title: 'LatticeDX',
      logo: { id: 1, title: 'nocobase-logo', url: '/files/main/main/attachments/1.png', preview: '/files/main/main/attachments/1.png?preview=1' },
    },
  };
  await middleware(ctxSeeded, async () => {});
  assert.equal(ctxSeeded.body.logo.url, BRAND_LOGO_PATH);
  assert.equal(ctxSeeded.body.logo.preview, BRAND_LOGO_PATH);
  assert.equal(ctxSeeded.body.logo.title, 'LatticeDX');

  // 2. Sequelize-like model with .toJSON() and { data: { logo } } wrapper
  const ctxModel = {
    action: { resourceName: 'systemSettings', actionName: 'get' },
    state: { currentUser: { id: 1 } },
    body: {
      toJSON() {
        return {
          id: 1,
          title: 'LatticeDX',
          logo: { id: 1, title: 'nocobase-logo', url: '/files/main/main/attachments/1.png' },
        };
      },
    },
  };
  await middleware(ctxModel, async () => {});
  assert.equal(ctxModel.body.logo.url, BRAND_LOGO_PATH);

  const ctxWrapped = {
    action: { resourceName: 'systemSettings', actionName: 'get' },
    state: {},
    body: {
      data: {
        id: 1,
        title: 'LatticeDX',
        logo: null,
      },
    },
  };
  await middleware(ctxWrapped, async () => {});
  assert.equal(ctxWrapped.body.data.logo.url, BRAND_LOGO_PATH);

  // 3. Unauthenticated custom /files/* logo is rewritten to public SVG (no 403)
  const ctxUnauthCustom = {
    action: { resourceName: 'systemSettings', actionName: 'get' },
    state: {},
    body: {
      id: 1,
      title: 'Acme',
      logo: { id: 9, title: 'acme-logo', url: '/files/main/main/attachments/9.png', preview: '/files/main/main/attachments/9.png?preview=1' },
    },
  };
  await middleware(ctxUnauthCustom, async () => {});
  assert.equal(ctxUnauthCustom.body.logo.url, BRAND_LOGO_PATH);

  // 4. Authenticated custom non-default /files/* logo is preserved
  const ctxAuthCustom = {
    action: { resourceName: 'systemSettings', actionName: 'get' },
    state: { currentUser: { id: 42 } },
    body: {
      id: 1,
      title: 'Acme',
      logo: { id: 9, title: 'acme-logo', url: '/files/main/main/attachments/9.png', preview: '/files/main/main/attachments/9.png?preview=1' },
    },
  };
  await middleware(ctxAuthCustom, async () => {});
  assert.equal(ctxAuthCustom.body.logo.url, '/files/main/main/attachments/9.png');

  // 5. Other resources/actions are untouched
  const ctxOther = {
    action: { resourceName: 'attachments', actionName: 'get' },
    state: {},
    body: { logo: { url: '/files/main/main/attachments/1.png' } },
  };
  await middleware(ctxOther, async () => {});
  assert.equal(ctxOther.body.logo.url, '/files/main/main/attachments/1.png');
});

test('LatticeFoundationPlugin registers and unregisters public branding Gateway handler and systemSettings middleware', async () => {
  const gatewayHandlers = [];
  const middlewares = [];
  await withMockedNocobase(gatewayHandlers, async () => {
    delete require.cache[require.resolve('../src/server/index')];
    const PluginCls = require('../src/server/index');
    const mockApp = {
      db: {
        sequelize: { getDialect: () => 'sqlite', query: async () => [[]] },
        getRepository: () => null,
        on() {},
      },
      resourceManager: {
        define() {},
        use(fn, opts) { middlewares.push({ fn, opts }); },
      },
      acl: { allow() {}, use() {}, registerSnippet() {} },
      pubSubManager: { subscribe() {}, publish() {} },
    };
    const plugin = new PluginCls(mockApp, {});
    await plugin.load();
    assert.ok(plugin._publicBrandingGatewayHandler);
    assert.ok(gatewayHandlers.includes(plugin._publicBrandingGatewayHandler));
    assert.ok(middlewares.some((m) => m.opts?.tag === 'latticePublicBrandingLogo' && m.opts?.after === 'acl'));

    await plugin.unload();
    assert.equal(plugin._publicBrandingGatewayHandler, null);
    assert.equal(gatewayHandlers.length, 0);
  });
});

test('BrandLogo normalizes 1.png/empty url to /v/lattice-brand.svg with single-retry onError fallback, and registerSignInLogo sets skipAuthCheck on auth.signin', () => {
  const { createBrandLogo, registerSignInLogo } = require('../src/client/native-branding');

  let stateIdx = 0;
  const states = [];
  const fakeReact = {
    Fragment: 'Fragment',
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState(init) {
      const idx = stateIdx++;
      if (!(idx in states)) states[idx] = init;
      return [states[idx], (v) => { states[idx] = typeof v === 'function' ? v(states[idx]) : v; }];
    },
  };

  let mockSettings = { data: { data: { logo: { url: '/files/main/main/attachments/1.png' } } } };
  const client = { useSystemSettings: () => mockSettings };
  const BrandLogo = createBrandLogo(client, fakeReact);

  const renderBrand = () => {
    stateIdx = 0;
    return BrandLogo({ size: 72 });
  };

  // 1. 1.png normalizes to /v/lattice-brand.svg
  const img1 = renderBrand();
  assert.equal(img1.type, 'img');
  assert.equal(img1.props.src, '/v/lattice-brand.svg');

  // 2. Empty logo url also falls back to /v/lattice-brand.svg
  mockSettings = { data: { data: { logo: { url: '' } } } };
  const img2 = renderBrand();
  assert.equal(img2.type, 'img');
  assert.equal(img2.props.src, '/v/lattice-brand.svg');

  // 3. Custom URL falls back once to /v/lattice-brand.svg on error, then hides if fallback also fails
  mockSettings = { data: { data: { logo: { url: '/files/custom-logo.png' } } } };
  const customImg = renderBrand();
  assert.equal(customImg.props.src, '/files/custom-logo.png');
  customImg.props.onError();
  const retriedImg = renderBrand();
  assert.equal(retriedImg.type, 'img');
  assert.equal(retriedImg.props.src, '/v/lattice-brand.svg');
  retriedImg.props.onError();
  const afterSecondError = renderBrand();
  assert.equal(afterSecondError, null);

  // 4. registerSignInLogo sets route.skipAuthCheck = true when undefined
  const signInRoute = { path: '/signin', Component: () => null };
  registerSignInLogo({ router: { get: (n) => (n === 'auth.signin' ? signInRoute : null) } }, fakeReact, BrandLogo);
  assert.equal(signInRoute.skipAuthCheck, true);

  // Does not overwrite explicit skipAuthCheck = false
  const explicitRoute = { path: '/signin', skipAuthCheck: false, Component: () => null };
  registerSignInLogo({ router: { get: (n) => (n === 'auth.signin' ? explicitRoute : null) } }, fakeReact, BrandLogo);
  assert.equal(explicitRoute.skipAuthCheck, false);
});
