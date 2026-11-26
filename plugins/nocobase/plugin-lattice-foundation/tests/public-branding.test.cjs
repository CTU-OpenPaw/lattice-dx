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

test('P0-10: installSignInApiGuards suppresses unauthenticated 401 noise on /signin, localizes sign-in errors, and authenticators:publicList disables signup in enterprise mode', async () => {
  const { installSignInApiGuards, localizeSignInError } = require('../src/client/native-branding');
  assert.equal(typeof installSignInApiGuards, 'function');
  assert.equal(typeof localizeSignInError, 'function');
  assert.match(localizeSignInError('The username/email or password is incorrect, please re-enter'), /không đúng|sai/i);
  assert.match(localizeSignInError('Too many requests'), /quá nhiều lần/i);

  const prevWin = global.window;
  global.window = { location: { pathname: '/signin' }, localStorage: { getItem: () => '' } };
  const networkCalls = [];
  const reqInterceptors = [];
  const respErrorInterceptors = [];
  const mockApi = {
    auth: { getToken: () => '' },
    axios: {
      interceptors: {
        request: { use: (fn) => reqInterceptors.push(fn) },
        response: { use: (_ok, errFn) => respErrorInterceptors.push(errFn) },
      },
    },
    async request(cfg) {
      networkCalls.push(cfg);
      return { data: { ok: true } };
    },
  };
  try {
    installSignInApiGuards({ apiClient: mockApi });
    // Calling twice must be idempotent
    installSignInApiGuards({ apiClient: mockApi });
    assert.equal(reqInterceptors.length, 1);

    for (const url of ['aiEmployees:listByUser', 'aiConversations:unreadCounts', 'auth:check']) {
      const cfg = await reqInterceptors[0]({ url, headers: {} });
      assert.equal(typeof cfg.adapter, 'function', `Expected short-circuit adapter for ${url}`);
      const res = await cfg.adapter(cfg);
      assert.equal(res.status, 200);
    }

    // Also short-circuit direct apiClient.request calls
    const directRes = await mockApi.request({ url: 'aiEmployees:listByUser' });
    assert.deepEqual(directRes.data.data, []);
    assert.equal(networkCalls.length, 0);

    // Localizes signIn error response via response interceptor
    const err = {
      config: { url: 'auth:signIn' },
      message: 'The username/email or password is incorrect, please re-enter',
      response: { status: 401, data: { errors: [{ message: 'The username/email or password is incorrect, please re-enter' }] } },
    };
    await assert.rejects(() => respErrorInterceptors[0](err), (e) => {
      assert.match(e.response.data.errors[0].message, /không đúng|sai/i);
      return true;
    });
  } finally {
    global.window = prevWin;
  }

  // Server authenticators:publicList allowSignUp: false policy middleware in src/server/index.js
  const gatewayHandlers = [];
  const middlewares = [];
  await withMockedNocobase(gatewayHandlers, async () => {
    delete require.cache[require.resolve('../src/server/index')];
    const PluginCls = require('../src/server/index');
    const mockApp = {
      db: { sequelize: { getDialect: () => 'sqlite', query: async () => [[]] }, getRepository: () => null, on() {} },
      resourceManager: { define() {}, use(fn, opts) { middlewares.push({ fn, opts }); } },
      acl: { allow() {}, use() {}, registerSnippet() {} },
      pubSubManager: { subscribe() {}, publish() {} },
    };
    const plugin = new PluginCls(mockApp, {});
    await plugin.load();
    const policyMw = middlewares.find((m) => m.opts?.tag === 'latticePublicAuthPolicy');
    assert.ok(policyMw, 'Expected latticePublicAuthPolicy middleware registered in server/index.js');

    const ctx = {
      action: { resourceName: 'authenticators', actionName: 'publicList' },
      body: {
        data: [
          { name: 'basic', authType: 'Email/Password', options: { allowSignUp: true } },
          { name: 'native-keycloak', authType: 'lattice-keycloak', options: {} },
        ],
      },
    };
    await policyMw.fn(ctx, async () => {});
    assert.equal(ctx.body.data[0].options.allowSignUp, false);
    assert.equal(ctx.body.data[1].options.allowSignUp, false);
    await plugin.unload();
  });

  // Also verify /v/signin route suppresses unauthenticated auth:check
  const prevWinV2 = global.window;
  global.window = { location: { pathname: '/v/signin' }, localStorage: { getItem: () => '' } };
  const v2ReqInterceptors = [];
  const v2Calls = [];
  const mockV2Api = {
    auth: { getToken: () => '' },
    axios: {
      interceptors: {
        request: { use: (fn) => v2ReqInterceptors.push(fn) },
        response: { use: () => {} },
      },
    },
    async request(cfg) {
      v2Calls.push(cfg);
      return { data: { ok: true } };
    },
  };
  try {
    installSignInApiGuards({ apiClient: mockV2Api });
    const cfgV2 = await v2ReqInterceptors[0]({ url: 'auth:check', headers: {} });
    assert.equal(typeof cfgV2.adapter, 'function', 'Expected /v/signin to short-circuit auth:check');
    const directV2 = await mockV2Api.request({ url: 'auth:check' });
    assert.equal(directV2.data.data, null);
    assert.equal(v2Calls.length, 0);
  } finally {
    global.window = prevWinV2;
  }
});

test('P3-01: system-shell.js and workspace.js include unified "Quay lại Workspace v2" breadcrumb to /admin/lattice-workspace', () => {
  const { createSystemShell } = require('../src/client/system-shell');
  const { createWorkspaceComponent } = require('../src/client/workspace');

  const fakeReact = {
    Fragment: 'Fragment',
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect() {},
    useMemo: (fn) => fn(),
    useRef: (init) => ({ current: init }),
  };

  const shell = createSystemShell({ useAPIClient: () => ({ request: async () => ({ data: {} }) }) }, fakeReact);
  const frameTree = shell.Frame({
    session: {
      api: { connect: async () => '/connect', disconnect: async () => {} },
      connection: { connected: false },
      notice: '',
      busy: false,
      act: async (fn) => fn(),
      commands: {},
      workflow: {},
    },
    title: 'Studio',
    children: null,
  });
  const dumpShell = JSON.stringify(frameTree);
  assert.ok(dumpShell.includes('/admin/lattice-workspace'));
  assert.ok(dumpShell.includes('Quay lại Workspace v2'));

  const prevWin = global.window;
  global.window = { location: { pathname: '/lattice', search: '', hash: '' }, addEventListener() {}, removeEventListener() {} };
  try {
    const Workspace = createWorkspaceComponent({ useAPIClient: () => ({ auth: {}, request: async () => ({ data: {} }) }) }, fakeReact, { Application: () => null });
    const wsTree = Workspace();
    const dumpWs = JSON.stringify(wsTree);
    assert.ok(dumpWs.includes('/admin/lattice-workspace'));
    assert.ok(dumpWs.includes('Quay lại Workspace v2'));
  } finally {
    global.window = prevWin;
  }
});

test('T1-AUTH-01/02/03 & T2-AUTH-01: short-circuits blockTemplates:list, prepends response interceptor ahead of useNotificationMiddleware, and sanitizes self-referential ?redirect=/signin', async () => {
  const {
    installSignInApiGuards,
    registerSignInLogo,
    createBrandLogo,
    sanitizeSignInNavigationTarget,
  } = require('../src/client/native-branding');

  // 1. Self-referential redirect sanitization
  assert.equal(sanitizeSignInNavigationTarget('/signin?redirect=/signin'), '/signin');
  assert.equal(sanitizeSignInNavigationTarget('/signin?redirect=%2Fsignin&authenticator=basic'), '/signin?authenticator=basic');
  assert.equal(sanitizeSignInNavigationTarget('/v/signin?redirect=http%3A%2F%2F127.0.0.1%3A13015%2Fsignin'), '/v/signin');
  assert.equal(sanitizeSignInNavigationTarget('/signin?redirect=/admin/lattice-workspace'), '/signin?redirect=/admin/lattice-workspace');

  // 2. Axios handlers.unshift places localization ahead of NocoBase handleNotificationError
  const prevWin = global.window;
  const replaceHistoryCalls = [];
  global.window = {
    location: { pathname: '/signin', search: '?redirect=%2Fsignin', hash: '' },
    history: { replaceState: (_s, _t, url) => replaceHistoryCalls.push(url) },
    localStorage: { getItem: () => '' },
  };
  const notifLog = [];
  const respHandlers = [
    {
      fulfilled: (r) => r,
      rejected: (err) => {
        const msg = err?.response?.data?.errors?.[0]?.message || err?.message;
        notifLog.push(msg);
        return Promise.reject(err);
      },
    },
  ];
  const reqHandlers = [];
  const navCalls = [];
  let token = '';
  const mockApi = {
    auth: { getToken: () => token },
    axios: {
      interceptors: {
        request: { use: (fn) => { reqHandlers.push(fn); return reqHandlers.length - 1; } },
        response: {
          handlers: respHandlers,
          use(fulfilled, rejected) {
            respHandlers.push({ fulfilled, rejected });
            return respHandlers.length - 1;
          },
        },
      },
    },
    async request(cfg) {
      if (cfg.url === 'auth:signIn') {
        token = 'valid.jwt.token';
        return { data: { data: { token } }, status: 200 };
      }
      return { data: { ok: true } };
    },
  };
  const mockRouter = {
    routes: new Map(),
    get: (name) => mockRouter.routes.get(name),
    add: (name, route) => mockRouter.routes.set(name, route),
    navigate: (to, opts) => navCalls.push({ to, opts }),
  };
  try {
    const app = { apiClient: mockApi, router: mockRouter };
    installSignInApiGuards(app);

    // replaceState cleaned initial ?redirect=%2Fsignin
    assert.deepEqual(replaceHistoryCalls, ['/signin']);

    // blockTemplates:list short-circuits to { data: [] }
    const btCfg = await reqHandlers[0]({ url: 'blockTemplates:list?filter[configured][$isTruly]=true', headers: {} });
    assert.equal(typeof btCfg.adapter, 'function');
    const btRes = await btCfg.adapter(btCfg);
    assert.deepEqual(btRes.data, { data: [] });
    const btDirect = await mockApi.request({ url: 'blockTemplates:list' });
    assert.deepEqual(btDirect.data, { data: [] });

    // Response error handler must be prepended at index 0 before handleNotificationError
    assert.equal(respHandlers.length, 2);
    const err = {
      config: { url: 'auth:signIn' },
      message: 'The username/email or password is incorrect, please re-enter',
      response: { status: 401, data: { errors: [{ message: 'The username/email or password is incorrect, please re-enter' }] } },
    };
    let current = Promise.reject(err);
    for (const h of respHandlers) {
      current = current.then(h.fulfilled, h.rejected);
    }
    await assert.rejects(() => current);
    assert.equal(notifLog.length, 1);
    assert.match(notifLog[0], /không đúng|sai/i);
    assert.equal(notifLog[0].toLowerCase().includes('incorrect'), false);

    // router.navigate strips self-referential ?redirect=/signin and prevents post-signIn loop
    mockRouter.navigate('/signin?redirect=/signin', { replace: true });
    assert.deepEqual(navCalls.at(-1), { to: '/signin', opts: { replace: true } });

    await mockApi.request({ url: 'auth:signIn', method: 'post' });
    mockRouter.navigate('/signin', { replace: true });
    assert.deepEqual(navCalls.at(-1), { to: '/admin', opts: { replace: true } });

    // registerSignInLogo sets skipAuthCheck: true even when auth.signin is added late
    const fakeReact = { Fragment: 'Fragment', createElement: () => null, useState: (i) => [i, () => {}] };
    registerSignInLogo(app, fakeReact, createBrandLogo({ useSystemSettings: () => null }, fakeReact));
    mockRouter.add('auth.signin', { path: '/signin', Component: () => null });
    assert.equal(mockRouter.get('auth.signin').skipAuthCheck, true);
  } finally {
    global.window = prevWin;
  }
});

test('installSignInApiGuards safely handles getter-only app.router.navigate (NocoBase 2.2.50 RouterManager & non-configurable getters) without throwing TypeError', async () => {
  const { installSignInApiGuards } = require('../src/client/native-branding');

  // Case 1: NocoBase 2.2.50 RouterManager shape (prototype getter `get navigate() { return this.navigateWithPortalPolicy }`)
  class FakeRouterManager {
    constructor(onNav) {
      this.routes = new Map();
      this.navigateWithPortalPolicy = (to, opts) => onNav('portalPolicy', to, opts);
      this.router = {
        navigate: this.navigateWithPortalPolicy,
        _subs: [],
        subscribe(fn) { this._subs.push(fn); return () => {}; },
      };
    }
    get navigate() {
      return this.navigateWithPortalPolicy;
    }
  }

  const prevWin = global.window;
  const historyCalls = [];
  const navLog = [];
  let token = '';
  global.window = {
    location: { pathname: '/signin', search: '?redirect=%2Fsignin', hash: '', assign: (u) => navLog.push(['assign', u]) },
    history: {
      replaceState: (_s, _t, url) => historyCalls.push(['replace', url]),
      pushState: (_s, _t, url) => historyCalls.push(['push', url]),
    },
    localStorage: { getItem: () => '' },
  };
  try {
    const rm = new FakeRouterManager((kind, to, opts) => navLog.push([kind, to, opts]));
    const api = {
      auth: { getToken: () => token },
      async request(cfg) {
        if (cfg.url === 'auth:signIn') {
          token = 'valid.jwt.token';
          return { data: { data: { token } }, status: 200 };
        }
        return { data: { ok: true } };
      },
    };
    installSignInApiGuards({ apiClient: api, router: rm });
    // Calling twice must remain idempotent and never throw
    installSignInApiGuards({ apiClient: api, router: rm });

    // history.replaceState/pushState strip self-referential ?redirect=/signin
    global.window.history.pushState(null, '', '/v/signin?redirect=%2Fv%2Fsignin');
    assert.deepEqual(historyCalls.at(-1), ['push', '/v/signin']);

    // router.navigate and inner router.router.navigate both go through guardedNavigate
    rm.navigate('/signin?redirect=/signin', { replace: true });
    assert.deepEqual(navLog.at(-1), ['portalPolicy', '/signin', { replace: true }]);

    await api.request({ url: 'auth:signIn', method: 'post' });
    rm.navigate('/signin', { replace: true });
    assert.deepEqual(navLog.at(-1), ['portalPolicy', '/admin', { replace: true }]);
    rm.router.navigate('/v/signin', { replace: true });
    assert.deepEqual(navLog.at(-1), ['portalPolicy', '/admin', { replace: true }]);

    // router.subscribe strips ?redirect=/signin if location is mutated on /signin
    global.window.location.search = '?redirect=%2Fsignin';
    for (const sub of rm.router._subs) sub();
    assert.deepEqual(historyCalls.at(-1), ['replace', '/signin']);
  } finally {
    global.window = prevWin;
  }

  // Case 2: Configurable getter-only navigate on router without navigateWithPortalPolicy
  const prevWin2 = global.window;
  global.window = { location: { pathname: '/signin', search: '', hash: '' }, localStorage: { getItem: () => '' } };
  try {
    const calls2 = [];
    const getterRouter = {};
    Object.defineProperty(getterRouter, 'navigate', {
      configurable: true,
      enumerable: true,
      get() { return (to, opts) => calls2.push({ to, opts }); },
    });
    installSignInApiGuards({ router: getterRouter });
    getterRouter.navigate('/signin?redirect=/signin', { replace: true });
    assert.deepEqual(calls2.at(-1), { to: '/signin', opts: { replace: true } });
  } finally {
    global.window = prevWin2;
  }

  // Case 3: Non-configurable getter-only navigate (`configurable: false`) must NOT throw TypeError and escapes /signin after auth:signIn
  const prevWin3 = global.window;
  const escaped = [];
  let token3 = '';
  global.window = {
    location: {
      pathname: '/signin',
      search: '?redirect=/signin',
      hash: '',
      assign: (url) => { escaped.push(url); global.window.location.pathname = '/admin'; },
    },
    history: { replaceState: () => {}, pushState: () => {} },
    localStorage: { getItem: () => '' },
  };
  try {
    const lockedRouter = {};
    const rawNav = (to, opts) => { escaped.push(['rawNav', to, opts]); };
    Object.defineProperty(lockedRouter, 'navigate', {
      configurable: false,
      enumerable: true,
      get() { return rawNav; },
    });
    const api3 = {
      auth: { getToken: () => token3 },
      async request(cfg) {
        if (cfg.url === 'auth:signIn') {
          token3 = 'valid.jwt.token';
          return { data: { data: { token: token3 } }, status: 200 };
        }
        return { data: { ok: true } };
      },
    };
    assert.doesNotThrow(() => installSignInApiGuards({ apiClient: api3, router: lockedRouter }));
    await api3.request({ url: 'auth:signIn', method: 'post' });
    await new Promise((resolve) => setTimeout(resolve, 90));
    assert.ok(escaped.some((entry) => Array.isArray(entry) && entry[0] === 'rawNav' && entry[1] === '/admin'));
  } finally {
    global.window = prevWin3;
  }
});

test('T1-AUTH-02/03 & T4-RW-01: guards delayed app.router.router created in getRouterComponent(), strips router.state.location ?redirect=/signin, and escapes /signin after auth:signIn', async () => {
  const { installSignInApiGuards, registerSignInLogo, createBrandLogo } = require('../src/client/native-branding');

  class DelayedRouterManager {
    constructor(onNav) {
      this._onNav = onNav;
      this.routes = new Map();
      this.router = undefined;
      this.navigateWithPortalPolicy = (to, opts) => {
        if (this.router) return this.router.navigate(to, opts);
        onNav('outerOnly', to, opts);
      };
    }
    get navigate() {
      return this.navigateWithPortalPolicy;
    }
    get(name) { return this.routes.get(name); }
    add(name, route) { this.routes.set(name, route); }
    getRouterComponent() {
      const subs = [];
      const inner = {
        state: {
          location: { pathname: '/signin', search: '?redirect=/signin', hash: '' },
        },
        navigate: (to, opts) => {
          this._onNav('innerRouter', to, opts);
          const parsed = new URL(typeof to === 'string' ? to : to.pathname, 'http://localhost');
          inner.state.location = {
            pathname: parsed.pathname,
            search: parsed.search,
            hash: parsed.hash,
          };
          for (const fn of subs) fn(inner.state);
          return Promise.resolve();
        },
        subscribe(fn) {
          subs.push(fn);
          return () => {};
        },
      };
      this.router = inner;
      return () => null;
    }
  }

  // Case A: Delayed creation via getRouterComponent()
  const prevWin = global.window;
  const navLog = [];
  let token = '';
  global.window = {
    location: {
      pathname: '/signin',
      search: '',
      hash: '',
      assign: (u) => {
        navLog.push(['assign', u]);
        global.window.location.pathname = u;
      },
    },
    history: {
      replaceState: (_s, _t, url) => {
        navLog.push(['historyReplace', url]);
        if (typeof url === 'string') {
          const parsed = new URL(url, 'http://localhost');
          global.window.location.pathname = parsed.pathname;
          global.window.location.search = parsed.search;
        }
      },
      pushState: () => {},
    },
    localStorage: { getItem: () => '' },
  };
  try {
    const rm = new DelayedRouterManager((kind, to, opts) => navLog.push([kind, to, opts]));
    const api = {
      auth: { getToken: () => token },
      async request(cfg) {
        if (cfg.url === 'auth:signIn') {
          token = 'valid.jwt.token';
          return { data: { data: { token } }, status: 200 };
        }
        return { data: { ok: true } };
      },
    };
    const app = { apiClient: api, router: rm };
    installSignInApiGuards(app);

    // At load() time, outer navigateWithPortalPolicy is wrapped, but inner router is not yet created
    assert.equal(app.__ldxSignInState.navWrapped, true);
    assert.equal(app.__ldxSignInState.innerNavWrapped, false);
    assert.equal(rm.router, undefined);

    // getRouterComponent() lazily instantiates app.router.router with ?redirect=/signin
    rm.getRouterComponent();
    assert.ok(rm.router);
    assert.equal(app.__ldxSignInState.innerNavWrapped, true);
    // Inner router state.location.search must already be cleared to '' so React Router useSearchParams() sees no redirect=/signin
    assert.equal(rm.router.state.location.pathname, '/signin');
    assert.equal(rm.router.state.location.search, '');
    assert.deepEqual(navLog.find((e) => e[0] === 'innerRouter'), ['innerRouter', '/signin', { replace: true }]);

    // Even if inner router state.location is later mutated to ?redirect=%2Fsignin, subscribe clears it cleanly
    rm.router.state.location = { pathname: '/signin', search: '?redirect=%2Fsignin', hash: '' };
    rm.router.navigate('/signin?redirect=%2Fsignin', { replace: true });
    assert.equal(rm.router.state.location.search, '');

    // On auth:signIn success, calling unwrapped-style inner router.navigate('/signin') (like plugin-auth useRedirect) is redirected to /admin
    await api.request({ url: 'auth:signIn', method: 'post' });
    await rm.router.navigate('/signin', { replace: true });
    assert.deepEqual(navLog.at(-1), ['innerRouter', '/admin', { replace: true }]);
    assert.equal(rm.router.state.location.pathname, '/admin');
  } finally {
    global.window = prevWin;
  }

  // Case B: BrandedSignIn useEffect + post-signIn safety escape even when navWrapped && innerNavWrapped are true
  const prevWinB = global.window;
  const navLogB = [];
  let tokenB = '';
  global.window = {
    location: {
      pathname: '/signin',
      search: '',
      hash: '',
      assign: (u) => {
        navLogB.push(['assign', u]);
        global.window.location.pathname = u;
      },
    },
    history: { replaceState: () => {}, pushState: () => {} },
    localStorage: { getItem: () => '' },
  };
  try {
    const rmB = {
      routes: new Map(),
      get(name) { return this.routes.get(name); },
      add(name, route) { this.routes.set(name, route); },
      navigateWithPortalPolicy: (to, opts) => {
        navLogB.push(['portalPolicy', to, opts]);
        if (typeof to === 'string') global.window.location.pathname = new URL(to, 'http://localhost').pathname;
      },
      get navigate() { return this.navigateWithPortalPolicy; },
      router: undefined,
    };
    rmB.add('auth.signin', { path: '/signin', Component: () => null });
    const apiB = {
      auth: { getToken: () => tokenB },
      async request(cfg) {
        if (cfg.url === 'auth:signIn') {
          tokenB = 'valid.jwt.token';
          return { data: { data: { token: tokenB } }, status: 200 };
        }
        return { data: { data: [] } };
      },
    };
    const effects = [];
    const fakeReact = {
      Fragment: 'Fragment',
      createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
      useState: (init) => [init, () => {}],
      useEffect: (fn) => { effects.push(fn); },
    };
    const appB = { apiClient: apiB, router: rmB };
    registerSignInLogo(appB, fakeReact, createBrandLogo({ useSystemSettings: () => null }, fakeReact));

    // Attach inner router AFTER load/registerSignInLogo without calling getRouterComponent
    rmB.router = {
      state: { location: { pathname: '/signin', search: '?redirect=/signin', hash: '' } },
      navigate: (to, opts) => {
        navLogB.push(['lateInner', to, opts]);
        const parsed = new URL(typeof to === 'string' ? to : to.pathname, 'http://localhost');
        rmB.router.state.location = { pathname: parsed.pathname, search: parsed.search, hash: parsed.hash };
        if (parsed.pathname !== '/signin') global.window.location.pathname = parsed.pathname;
        return Promise.resolve();
      },
      subscribe: () => () => {},
    };

    // Mounting BrandedSignIn runs useEffect -> wraps late inner router and clears ?redirect=/signin
    const SignInComp = rmB.get('auth.signin').Component;
    SignInComp({});
    for (const eff of effects) eff();
    assert.equal(appB.__ldxSignInState.innerNavWrapped, true);
    assert.equal(rmB.router.state.location.search, '');

    // Even if useRedirect never calls navigate after auth:signIn, fallback escape moves off /signin to /admin
    await apiB.request({ url: 'auth:signIn', method: 'post' });
    await new Promise((resolve) => setTimeout(resolve, 320));
    assert.equal(global.window.location.pathname, '/admin');
    assert.ok(navLogB.some((e) => e[0] === 'portalPolicy' && e[1] === '/admin'));
  } finally {
    global.window = prevWinB;
  }
});
