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
      if (Array.isArray(c)) flatChildren.push(...c.flat(Infinity));
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
      const el = Component(props);
      return el;
    },
    _flushEffects() {
      for (const eff of pendingEffects.splice(0)) {
        const prev = effectSlots[eff.idx];
        if (prev && typeof prev.cleanup === 'function') prev.cleanup();
        const nextCleanup = eff.fn();
        effectSlots[eff.idx] = { deps: eff.deps, cleanup: typeof nextCleanup === 'function' ? nextCleanup : null };
      }
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
  if (typeof node.type === 'function') {
    const rendered = node.type({ ...(node.props || {}), children: node.children || [] });
    const hit = findNode(rendered, predicate);
    if (hit) return hit;
  }
  for (const child of node.children || []) {
    const hit = findNode(child, predicate);
    if (hit) return hit;
  }
  return null;
}

function findAllNodes(node, predicate, acc = []) {
  if (!node || typeof node !== 'object') return acc;
  if (predicate(node)) acc.push(node);
  if (typeof node.type === 'function') {
    const rendered = node.type({ ...(node.props || {}), children: node.children || [] });
    findAllNodes(rendered, predicate, acc);
  }
  for (const child of node.children || []) {
    findAllNodes(child, predicate, acc);
  }
  return acc;
}

function collectText(node) {
  if (node === null || node === undefined || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(collectText).join(' ');
  if (typeof node === 'object') {
    if (typeof node.type === 'function') {
      return collectText(node.type({ ...(node.props || {}), children: node.children || [] }));
    }
    return (node.children || []).map(collectText).join(' ');
  }
  return '';
}

function makeMemoryStorage() {
  const map = new Map();
  return {
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); },
  };
}

function withMobileGlobals(fn, { storage, onLine = true, fetchImpl } = {}) {
  const prev = {
    navigator: global.navigator,
    window: global.window,
    document: global.document,
    fetch: globalThis.fetch,
  };
  Object.defineProperty(global, 'navigator', { configurable: true, value: { onLine } });
  Object.defineProperty(global, 'window', {
    configurable: true,
    value: { localStorage: storage, addEventListener() {}, removeEventListener() {}, location: { pathname: '/v/mobile', search: '', hash: '' } },
  });
  Object.defineProperty(global, 'document', {
    configurable: true,
    value: { head: { appendChild() {} }, querySelector() { return null; }, createElement() { return {}; } },
  });
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: fetchImpl || (async () => ({ ok: true, status: 200, body: null })),
  });
  return Promise.resolve().then(fn).finally(() => {
    Object.defineProperty(global, 'navigator', { configurable: true, writable: true, value: prev.navigator });
    Object.defineProperty(global, 'window', { configurable: true, writable: true, value: prev.window });
    Object.defineProperty(global, 'document', { configurable: true, writable: true, value: prev.document });
    Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: prev.fetch });
  });
}

test('M2-4a: dist/client-v2 overrides pre-existing and late-registered mobile layout route while keeping dxos-mobile-field routes', async () => {
  const distV2Src = readFileSync(join(PLUGIN_ROOT, 'dist/client-v2/index.js'), 'utf8');
  let modV2;
  const defineV2 = (name, deps, factory) => {
    assert.equal(name, '@latticedx/plugin-lattice-foundation/client-v2');
    modV2 = factory({ Plugin: class {} }, {});
  };
  defineV2.amd = {};
  vm.runInNewContext(distV2Src, {
    define: defineV2,
    sessionStorage: { getItem: () => null },
    window: { location: { pathname: '/v/mobile' } },
  });
  const PluginClass = modV2.default;

  // Case 1: mobile route registered BEFORE plugin.load()
  const routesBefore = new Map([
    ['mobile', { path: '/mobile', element: { type: 'MobileLayoutModel' } }],
  ]);
  const routerBefore = {
    has: (name) => routesBefore.has(name),
    add: (name, route) => routesBefore.set(name, route),
  };
  const p1 = new PluginClass();
  p1.app = { router: routerBefore };
  await p1.load();
  assert.equal(typeof routesBefore.get('mobile').Component, 'function', 'Pre-existing mobile route must be overridden with MobileFieldPwaPage');
  assert.equal(routesBefore.get('mobile').element, undefined, 'Overridden mobile route must clear LayoutRoute element');
  assert.equal(routesBefore.get('dxos-mobile-field').path, '/mobile');
  assert.equal(routesBefore.get('dxos-mobile-field-sub').path, '/mobile/*');

  // Case 2: mobile route registered AFTER plugin.load() by plugin-ui-layout
  const routesAfter = new Map();
  const routerAfter = {
    has: (name) => routesAfter.has(name),
    add: (name, route) => routesAfter.set(name, route),
  };
  const p2 = new PluginClass();
  p2.app = { router: routerAfter };
  await p2.load();
  routerAfter.add('mobile', { path: '/mobile', element: { type: 'LateMobileLayoutModel' } });
  const lateRoute = routesAfter.get('mobile');
  assert.equal(typeof lateRoute.Component, 'function', 'Late-registered mobile route must be intercepted');
  assert.equal(lateRoute.element, undefined, 'Late-registered mobile route must drop LayoutRoute element');
  assert.equal(lateRoute.Component, routesAfter.get('dxos-mobile-field').Component);
});

test('M2-4b: MobileFieldPwaPage shows auth banner + /signin CTA when unauthenticated and on 401, and avoids misleading empty copy', async () => {
  const { createMobileFieldPwaPage } = require('../src/client-v2/mobile-field-pwa');
  const fakeReact = createFakeReact();
  const storage = makeMemoryStorage();

  await withMobileGlobals(async () => {
    const unauthApi = { auth: { getToken: () => '' }, request: async () => ({ data: {} }) };
    const MobilePage = createMobileFieldPwaPage({ Plugin: class {} }, fakeReact, {});
    const tree = fakeReact._render(MobilePage, { storage, apiClient: unauthApi });
    fakeReact._flushEffects();

    const banner = findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-auth-banner');
    assert.ok(banner, 'Unauthenticated mobile PWA must render mobile-pwa-auth-banner');
    const signinLink = findNode(banner, (n) => n.props?.['data-testid'] === 'mobile-pwa-signin-link');
    assert.ok(signinLink, 'Auth banner must include sign-in CTA link');
    assert.equal(signinLink.props.href, '/signin?redirect=%2Fv%2Fmobile');

    const aboveFoldText = collectText(findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-above-fold-cards'));
    assert.ok(!aboveFoldText.includes('Không có yêu cầu phê duyệt tồn đọng.'), 'Must not show misleading empty message when unauthenticated');
    assert.ok(aboveFoldText.includes('Đăng nhập để xem tác vụ hiện trường.'), 'Must prompt sign-in in empty ops sections');
    fakeReact._unmount();
  }, { storage });

  // 401 expiration during authenticated refresh triggers authExpired banner
  const fakeReact401 = createFakeReact();
  const storage401 = makeMemoryStorage();
  await withMobileGlobals(async () => {
    const expiredApi = {
      auth: { getToken: () => 'expired-jwt' },
      request: async () => {
        throw Object.assign(new Error('Unauthorized'), { response: { status: 401 } });
      },
    };
    const MobilePage = createMobileFieldPwaPage({ Plugin: class {} }, fakeReact401, {});
    let tree = fakeReact401._render(MobilePage, { storage: storage401, apiClient: expiredApi });
    fakeReact401._flushEffects();
    await new Promise((r) => setTimeout(r, 25));
    tree = fakeReact401._render(MobilePage, { storage: storage401, apiClient: expiredApi });
    assert.ok(findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-auth-banner'), '401 must surface mobile-pwa-auth-banner');
    fakeReact401._unmount();
  }, { storage: storage401 });
});

test('M2-4c: MobileFieldPwaPage checks roles:check to skip latticeIncidentCases:list for ldx_employee (0 403s) and surfaces rejected Promise.allSettled ops errors', async () => {
  const { createMobileFieldPwaPage } = require('../src/client-v2/mobile-field-pwa');
  const fakeReact = createFakeReact();
  const storage = makeMemoryStorage();

  await withMobileGlobals(async () => {
    const calls = [];
    const employeeApi = {
      auth: { role: 'ldx_employee', getToken: () => 'jwt-emp' },
      async request(req) {
        calls.push(req.url);
        if (req.url === 'roles:check') {
          return {
            data: {
              data: {
                role: 'ldx_employee',
                allowAll: false,
                resources: ['latticeRequests', 'latticeOrders', 'latticeServiceTickets'],
              },
            },
          };
        }
        if (req.url === 'dxosApprovals:listInbox') return { data: { data: { items: [] } } };
        if (req.url === 'latticeOrders:list') return { data: { data: [] } };
        if (req.url === 'latticeServiceTickets:list') {
          throw Object.assign(new Error('Service timeout 503'), { response: { status: 503 } });
        }
        if (req.url === 'latticeIncidentCases:list') {
          throw Object.assign(new Error('Forbidden 403'), { response: { status: 403 } });
        }
        return { data: {} };
      },
    };
    const MobilePage = createMobileFieldPwaPage({ Plugin: class {} }, fakeReact, {});
    let tree = fakeReact._render(MobilePage, { storage, apiClient: employeeApi });
    fakeReact._flushEffects();
    await new Promise((r) => setTimeout(r, 30));
    tree = fakeReact._render(MobilePage, { storage, apiClient: employeeApi });

    assert.equal(calls.includes('latticeIncidentCases:list'), false, 'Must skip latticeIncidentCases:list when roles:check excludes latticeIncidentCases');
    const incSection = findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-incidents-section');
    assert.ok(collectText(incSection).includes('Vai trò hiện tại không có quyền xem sự cố IoT.'), 'Must display role permission notice in incidents section');

    const opsErr = findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-ops-error');
    assert.ok(opsErr, 'Rejected Promise.allSettled call must surface mobile-pwa-ops-error banner');
    assert.ok(collectText(opsErr).includes('Phiếu dịch vụ'));
    assert.ok(findNode(opsErr, (n) => n.type === 'button' && collectText(n).includes('Thử lại')));
    fakeReact._unmount();
  }, { storage });
});

test('M2-4d: MobileFieldPwaPage notification drawer supports markAllRead, per-item markRead, and listMine error banner with retry', async () => {
  const { createMobileFieldPwaPage } = require('../src/client-v2/mobile-field-pwa');
  const fakeReact = createFakeReact();
  const storage = makeMemoryStorage();

  await withMobileGlobals(async () => {
    const calls = [];
    let failList = true;
    const notifApi = {
      auth: { getToken: () => 'jwt-notif' },
      async request(req) {
        calls.push(req);
        if (req.url === 'latticeNotifications:unreadCount') return { data: { data: { unreadCount: 2 } } };
        if (req.url === 'latticeNotifications:listMine') {
          if (failList) throw Object.assign(new Error('500 Notif Failed'), { response: { status: 500 } });
          return {
            data: {
              data: {
                unreadCount: 2,
                items: [
                  { id: 10, title: 'Cảnh báo nhiệt #1', body: 'Nhiệt độ tăng', readAt: null },
                  { id: 11, title: 'Đơn mới #2', body: 'Cần giao', readAt: null },
                ],
              },
            },
          };
        }
        return { data: { data: { ok: true } } };
      },
    };
    const MobilePage = createMobileFieldPwaPage({ Plugin: class {} }, fakeReact, {});
    let tree = fakeReact._render(MobilePage, { storage, apiClient: notifApi });
    fakeReact._flushEffects();
    await new Promise((r) => setTimeout(r, 20));
    tree = fakeReact._render(MobilePage, { storage, apiClient: notifApi });

    // Open notifications -> fails first -> shows mobile-pwa-notif-error
    await findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-notif-badge').props.onClick();
    tree = fakeReact._render(MobilePage, { storage, apiClient: notifApi });
    const errBox = findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-notif-error');
    assert.ok(errBox, 'Notification load error must render mobile-pwa-notif-error');

    // Retry succeeds
    failList = false;
    await findNode(errBox, (n) => n.props?.['data-testid'] === 'mobile-pwa-notif-retry').props.onClick();
    tree = fakeReact._render(MobilePage, { storage, apiClient: notifApi });
    assert.equal(findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-notif-error'), null);

    // Mark single item read
    await findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-notif-mark-10').props.onClick();
    tree = fakeReact._render(MobilePage, { storage, apiClient: notifApi });
    assert.ok(calls.some((c) => c.url === 'latticeNotifications:markRead' && c.data?.id === 10));
    assert.ok(collectText(findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-notif-badge')).includes('1'));

    // Mark all read
    await findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-notif-mark-all').props.onClick();
    tree = fakeReact._render(MobilePage, { storage, apiClient: notifApi });
    assert.ok(calls.some((c) => c.url === 'latticeNotifications:markAllRead'));
    assert.ok(collectText(findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-notif-badge')).includes('0'));
    fakeReact._unmount();
  }, { storage });
});

test('M2-4e: MobileFieldPwaPage interactive Incidents & Service Tickets cards open detail sheets, submit voucher, post chatter, create ticket, and fill Twin', async () => {
  const { createMobileFieldPwaPage } = require('../src/client-v2/mobile-field-pwa');
  const fakeReact = createFakeReact();
  const storage = makeMemoryStorage();

  await withMobileGlobals(async () => {
    const calls = [];
    const opsApi = {
      auth: { role: 'ldx_manager', getToken: () => 'jwt-mgr' },
      async request(req) {
        calls.push(req);
        if (req.url === 'roles:check') return { data: { data: { allowAll: true } } };
        if (req.url === 'latticeIncidentCases:list') {
          return { data: { data: [{ id: 77, code: 'INC-077', name: 'Cảnh báo kho lạnh', severity: 'critical', status: 'open', assetId: 12, proposal: 'Kiểm tra máy nén' }] } };
        }
        if (req.url === 'latticeServiceTickets:list') {
          return { data: { data: [{ id: 88, code: 'TKT-088', name: 'Sửa van kho', serviceType: 'maintenance', priority: 'high', status: 'draft', version: 1, description: 'Van rò khí' }] } };
        }
        if (req.url === 'latticeChatter:list') return { data: { data: { items: [{ id: 1, authorName: 'mgr', body: 'Đã kiểm tra sơ bộ' }] } } };
        if (req.url === 'latticeServiceTickets:create') return { data: { data: { id: 89, code: 'TKT-089', name: req.data.name, status: 'draft', priority: req.data.priority } } };
        if (req.url === 'latticeVoucher:submit') return { data: { data: { id: 88, status: 'submitted', version: 2 } } };
        return { data: { data: { ok: true } } };
      },
    };
    const MobilePage = createMobileFieldPwaPage({ Plugin: class {} }, fakeReact, {});
    let tree = fakeReact._render(MobilePage, { storage, apiClient: opsApi });
    fakeReact._flushEffects();
    await new Promise((r) => setTimeout(r, 30));
    tree = fakeReact._render(MobilePage, { storage, apiClient: opsApi });

    // Open Incident detail -> Fill Digital Twin + Ack + Chatter
    await findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-incident-open-77').props.onClick();
    tree = fakeReact._render(MobilePage, { storage, apiClient: opsApi });
    const incDetail = findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-incident-detail');
    assert.ok(incDetail, 'Clicking incident must open detail sheet');
    assert.ok(collectText(incDetail).includes('Kiểm tra máy nén'));

    findNode(incDetail, (n) => n.props?.['data-testid'] === 'mobile-pwa-incident-fill-twin').props.onClick();
    await findNode(incDetail, (n) => n.props?.['data-testid'] === 'mobile-pwa-incident-ack').props.onClick();
    findNode(incDetail, (n) => n.props?.['data-testid'] === 'mobile-pwa-incident-note-input').props.onChange({ target: { value: 'Đang xử lý máy nén' } });
    tree = fakeReact._render(MobilePage, { storage, apiClient: opsApi });
    await findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-incident-note-submit').props.onClick();
    tree = fakeReact._render(MobilePage, { storage, apiClient: opsApi });

    assert.equal(findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-twin-asset-input').props.value, '12');
    assert.ok(calls.some((c) => c.url === 'dxosBlocks:alarmAck' && c.data?.id === 77));
    assert.ok(calls.some((c) => c.url === 'latticeChatter:post' && c.data?.targetCollection === 'latticeIncidentCases'));

    // Open Ticket detail -> Submit draft voucher
    await findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-ticket-open-88').props.onClick();
    tree = fakeReact._render(MobilePage, { storage, apiClient: opsApi });
    const tktDetail = findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-ticket-detail');
    assert.ok(tktDetail, 'Clicking ticket must open detail sheet');
    await findNode(tktDetail, (n) => n.props?.['data-testid'] === 'mobile-pwa-ticket-submit-voucher').props.onClick();
    assert.ok(calls.some((c) => c.url === 'latticeVoucher:submit' && c.data?.collection === 'latticeServiceTickets' && c.data?.id === 88));

    // Quick create service ticket
    findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-ticket-create-toggle').props.onClick();
    tree = fakeReact._render(MobilePage, { storage, apiClient: opsApi });
    findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-ticket-new-name').props.onChange({ target: { value: 'Thay gioăng cửa kho' } });
    tree = fakeReact._render(MobilePage, { storage, apiClient: opsApi });
    await findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-ticket-new-submit').props.onClick({ preventDefault() {} });
    assert.ok(calls.some((c) => c.url === 'latticeServiceTickets:create' && c.data?.name === 'Thay gioăng cửa kho'));
    fakeReact._unmount();
  }, { storage });
});

test('M2-4f: Mobile AI chat uses <form onSubmit>, preserves multi-turn history, calls aiConversations with X-Timezone without hitting dxosAi:agentChat 404, and falls back to dxosAi:agentChat when mocked', async () => {
  const { createMobileFieldPwaPage } = require('../src/client-v2/mobile-field-pwa');

  // Case 1: Live aiConversations endpoint
  const fakeReactLive = createFakeReact();
  const storage1 = makeMemoryStorage();
  await withMobileGlobals(async () => {
    const calls = [];
    const liveAiApi = {
      auth: { getToken: () => 'jwt-ai' },
      async request(req) {
        calls.push(req);
        if (req.url === 'dxosAi:portalAgents') return { data: { data: { employees: [{ username: 'dxos-logistics' }] } } };
        if (req.url === 'aiConversations:create') return { data: { data: { sessionId: 'sess-mobile-1' } } };
        if (req.url === 'aiConversations:sendMessages') {
          return { data: { data: { content: 'Đơn hàng đang ở kho Cần Thơ.' } } };
        }
        return { data: {} };
      },
    };
    const MobilePage = createMobileFieldPwaPage({ Plugin: class {} }, fakeReactLive, {});
    let tree = fakeReactLive._render(MobilePage, { storage: storage1, apiClient: liveAiApi });
    fakeReactLive._flushEffects();
    findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-ai-pill').props.onClick();
    tree = fakeReactLive._render(MobilePage, { storage: storage1, apiClient: liveAiApi });

    const form = findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-ai-form');
    assert.ok(form && form.type === 'form', 'AI input/button must be wrapped in <form data-testid="mobile-pwa-ai-form">');
    assert.equal(findNode(form, (n) => n.props?.['data-testid'] === 'mobile-pwa-ai-send').props.type, 'submit');

    findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-ai-input').props.onChange({ target: { value: 'Kiểm tra đơn ORD-1' } });
    tree = fakeReactLive._render(MobilePage, { storage: storage1, apiClient: liveAiApi });
    await findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-ai-form').props.onSubmit({ preventDefault() {} });
    tree = fakeReactLive._render(MobilePage, { storage: storage1, apiClient: liveAiApi });

    assert.equal(calls.some((c) => c.url === 'dxosAi:agentChat'), false, 'Live path must not trigger 404 on dxosAi:agentChat');
    const sendCall = calls.find((c) => c.url === 'aiConversations:sendMessages');
    assert.ok(sendCall, 'Must invoke aiConversations:sendMessages');
    assert.equal(sendCall.headers?.['X-Timezone'], '+07:00');
    assert.equal(sendCall.data?.stream, false);
    assert.ok(collectText(findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-ai-reply')).includes('Đơn hàng đang ở kho Cần Thơ.'));

    // Second turn keeps first turn in thread
    findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-ai-input').props.onChange({ target: { value: 'Còn nhiệt độ?' } });
    tree = fakeReactLive._render(MobilePage, { storage: storage1, apiClient: liveAiApi });
    await findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-ai-form').props.onSubmit({ preventDefault() {} });
    tree = fakeReactLive._render(MobilePage, { storage: storage1, apiClient: liveAiApi });
    const threadText = collectText(findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-ai-drawer'));
    assert.ok(threadText.includes('Kiểm tra đơn ORD-1') && threadText.includes('Còn nhiệt độ?'), 'Must preserve multi-turn history');
    fakeReactLive._unmount();
  }, { storage: storage1 });

  // Case 2: Mock fallback to dxosAi:agentChat when aiConversations/a2a are unmocked
  const fakeReactMock = createFakeReact();
  const storage2 = makeMemoryStorage();
  await withMobileGlobals(async () => {
    const mockAiApi = {
      auth: { getToken: () => 'jwt-ai-mock' },
      async request(req) {
        if (req.url === 'dxosAi:agentChat') return { data: { data: { reply: 'Fallback mock reply' } } };
        return { data: {} };
      },
    };
    const MobilePage = createMobileFieldPwaPage({ Plugin: class {} }, fakeReactMock, {});
    let tree = fakeReactMock._render(MobilePage, { storage: storage2, apiClient: mockAiApi });
    fakeReactMock._flushEffects();
    findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-ai-pill').props.onClick();
    tree = fakeReactMock._render(MobilePage, { storage: storage2, apiClient: mockAiApi });
    findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-ai-input').props.onChange({ target: { value: 'Hello' } });
    tree = fakeReactMock._render(MobilePage, { storage: storage2, apiClient: mockAiApi });
    await findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-ai-form').props.onSubmit({ preventDefault() {} });
    tree = fakeReactMock._render(MobilePage, { storage: storage2, apiClient: mockAiApi });
    assert.ok(collectText(findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-ai-reply')).includes('Fallback mock reply'));
    fakeReactMock._unmount();
  }, { storage: storage2 });
});

test('M2-4g: submitTwinDesired enforces twinBusy guard against double submit and disables button', async () => {
  const { createMobileFieldPwaPage } = require('../src/client-v2/mobile-field-pwa');
  const fakeReact = createFakeReact();
  const storage = makeMemoryStorage();

  await withMobileGlobals(async () => {
    let resolveTwin;
    let twinCalls = 0;
    const twinApi = {
      auth: { role: 'ldx_manager', getToken: () => 'jwt-twin' },
      async request(req) {
        if (req.url === 'roles:check') {
          return {
            data: {
              data: {
                allowAll: false,
                resources: ['latticeAssets'],
                actions: { 'latticeAssets:update': true },
              },
            },
          };
        }
        if (req.url === 'dxosBlocks:twinSetDesired') {
          twinCalls += 1;
          return new Promise((resolve) => { resolveTwin = resolve; });
        }
        return { data: {} };
      },
    };
    const MobilePage = createMobileFieldPwaPage({ Plugin: class {} }, fakeReact, {});
    let tree = fakeReact._render(MobilePage, { storage, apiClient: twinApi });
    assert.equal(findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-twin-submit'), null, 'Twin control must remain hidden fail-closed before roles:check resolves');
    fakeReact._flushEffects();
    await new Promise((r) => setTimeout(r, 20));
    tree = fakeReact._render(MobilePage, { storage, apiClient: twinApi });
    findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-twin-asset-input').props.onChange({ target: { value: '12' } });
    findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-twin-temp-input').props.onChange({ target: { value: '-18' } });
    tree = fakeReact._render(MobilePage, { storage, apiClient: twinApi });

    const p1 = findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-twin-submit').props.onClick();
    tree = fakeReact._render(MobilePage, { storage, apiClient: twinApi });
    const btnDuring = findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-twin-submit');
    assert.equal(btnDuring.props.disabled, true, 'Twin submit button must be disabled while in-flight');
    assert.ok(collectText(btnDuring).includes('Đang gửi lệnh...'));

    // Second concurrent call is ignored
    await btnDuring.props.onClick();
    assert.equal(twinCalls, 1, 'Concurrent double click must not fire second twinSetDesired request');

    resolveTwin({ data: { data: { ok: true } } });
    await p1;
    tree = fakeReact._render(MobilePage, { storage, apiClient: twinApi });
    assert.equal(findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-twin-submit').props.disabled, false);
    fakeReact._unmount();
  }, { storage });
});

test('M2-5: TaskInboxBlock & Workspace have ZERO "sắp có"/"Dự kiến" stubs and Workspace Notification bell loads & marks notifications', async () => {
  const { createInboxComponents } = require('../src/client/inbox-blocks');
  const { createWorkspaceComponent } = require('../src/client/workspace');

  // 1. TaskInboxBlock has zero disabled "sắp có" buttons
  const fakeReact1 = createFakeReact();
  const { TaskInboxBlock } = createInboxComponents(fakeReact1);
  const manifest = require('../src/shared/manifests/work.json');
  const inboxTree = fakeReact1._render(TaskInboxBlock, {
    manifest,
    block: manifest.blocks[0],
    api: { workflow: async () => ({ items: [], page: { offset: 0, limit: 10, hasMore: false, nextOffset: null } }) },
    connected: true,
    actorId: 'emp-1',
  });
  const inboxText = collectText(inboxTree);
  assert.ok(!inboxText.includes('Đang thực hiện') && !inboxText.includes('Đã hoàn thành') && !inboxText.includes('Tôi đã tạo'), 'Stub scope buttons must be removed');
  const stubButtons = findAllNodes(inboxTree, (n) => n.type === 'button' && String(n.props?.title || '').includes('sắp có'));
  assert.equal(stubButtons.length, 0);

  // 2. Workspace has zero "sắp có" / "Dự kiến" stubs and wired Notification bell
  const fakeReact2 = createFakeReact();
  const calls = [];
  const wsApiClient = {
    auth: { signOut: async () => {} },
    async request(req) {
      calls.push(req);
      if (req.url === 'auth:check') return { data: { data: { username: 'emp1', nickname: 'Nhân viên' } } };
      if (req.url === 'latticeApps:list') return { data: { data: { items: [] } } };
      if (req.url === 'dxActions:status') return { data: { connected: false } };
      if (req.url === 'latticeNotifications:unreadCount') return { data: { data: { unreadCount: 2 } } };
      if (req.url === 'latticeNotifications:listMine') {
        return {
          data: {
            data: {
              unreadCount: 2,
              items: [{ id: 51, title: 'Thông báo nghiệm thu', body: 'Đã duyệt', readAt: null }],
            },
          },
        };
      }
      return { data: { data: { ok: true } } };
    },
  };
  const Workspace = createWorkspaceComponent({ useAPIClient: () => wsApiClient }, fakeReact2, { Application: () => null });

  await withMobileGlobals(async () => {
    global.window.location = { pathname: '/lattice', search: '', hash: '' };
    let tree = fakeReact2._render(Workspace, {});
    fakeReact2._flushEffects();
    await new Promise((r) => setTimeout(r, 25));
    tree = fakeReact2._render(Workspace, {});

    const allText = collectText(tree);
    assert.ok(!allText.includes('Báo cáo'), 'Dead Báo cáo stub must be removed');
    assert.ok(!allText.includes('AI Assistant'), 'Dead AI Assistant stub must be removed');
    assert.ok(!allText.includes('Cài đặt cá nhân'), 'Dead Cài đặt cá nhân stub must be removed');
    assert.ok(!allText.includes('Dự kiến'), 'No Dự kiến badge in Workspace');
    const sapCoButtons = findAllNodes(tree, (n) => n.type === 'button' && String(n.props?.title || n.props?.['aria-label'] || '').includes('sắp có'));
    assert.equal(sapCoButtons.length, 0);

    const bellBtn = findNode(tree, (n) => n.props?.['data-testid'] === 'lx-notification-bell');
    assert.ok(bellBtn && !bellBtn.props.disabled, 'Workspace notification bell must be enabled');
    assert.ok(collectText(bellBtn).includes('2'), 'Bell badge must show unreadCount = 2');

    await bellBtn.props.onClick();
    tree = fakeReact2._render(Workspace, {});
    const popover = findNode(tree, (n) => n.props?.['data-testid'] === 'lx-notification-popover');
    assert.ok(popover && collectText(popover).includes('Thông báo nghiệm thu'));

    await findNode(popover, (n) => n.props?.['data-testid'] === 'lx-notification-mark-51').props.onClick();
    assert.ok(calls.some((c) => c.url === 'latticeNotifications:markRead' && c.data?.id === 51));
    await findNode(popover, (n) => n.props?.['data-testid'] === 'lx-notification-mark-all').props.onClick();
    assert.ok(calls.some((c) => c.url === 'latticeNotifications:markAllRead'));
    fakeReact2._unmount();
  }, { storage: makeMemoryStorage() });
});

test('M2-4h: Outbox delete requires inline two-step confirmation (Xóa -> Xác nhận xóa? / Hủy)', async () => {
  const { createMobileFieldPwaPage } = require('../src/client-v2/mobile-field-pwa');
  const { enqueueOutboxItem, listOutboxItems } = require('../src/client-v2/mobile-offline-db');
  const fakeReact = createFakeReact();
  const storage = makeMemoryStorage();
  const item = await enqueueOutboxItem({
    actionType: 'iot.twinSetDesired',
    payload: { assetId: 55, desiredPatch: { targetTempC: -18 } },
  }, { useIndexedDB: false, storage });

  await withMobileGlobals(async () => {
    const MobilePage = createMobileFieldPwaPage({ Plugin: class {} }, fakeReact, {});
    let tree = fakeReact._render(MobilePage, { storage, useIndexedDB: false, apiClient: { auth: { getToken: () => '' }, request: async () => ({ data: {} }) } });
    fakeReact._flushEffects();
    await new Promise((r) => setTimeout(r, 15));
    tree = fakeReact._render(MobilePage, { storage, useIndexedDB: false, apiClient: { auth: { getToken: () => '' }, request: async () => ({ data: {} }) } });

    findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-queue-badge').props.onClick();
    tree = fakeReact._render(MobilePage, { storage, useIndexedDB: false, apiClient: { auth: { getToken: () => '' }, request: async () => ({ data: {} }) } });

    // First click on Xóa does NOT delete yet; reveals confirm + cancel
    findNode(tree, (n) => n.props?.['data-testid'] === `mobile-pwa-outbox-delete-${item.id}`).props.onClick();
    tree = fakeReact._render(MobilePage, { storage, useIndexedDB: false, apiClient: { auth: { getToken: () => '' }, request: async () => ({ data: {} }) } });
    assert.equal((await listOutboxItems({ useIndexedDB: false, storage })).length, 1, 'First click must not delete immediately');

    const cancelBtn = findNode(tree, (n) => n.props?.['data-testid'] === `mobile-pwa-outbox-delete-cancel-${item.id}`);
    assert.ok(cancelBtn, 'Must show Hủy button');
    cancelBtn.props.onClick();
    tree = fakeReact._render(MobilePage, { storage, useIndexedDB: false, apiClient: { auth: { getToken: () => '' }, request: async () => ({ data: {} }) } });
    assert.equal((await listOutboxItems({ useIndexedDB: false, storage })).length, 1);

    // Confirm deletes item
    findNode(tree, (n) => n.props?.['data-testid'] === `mobile-pwa-outbox-delete-${item.id}`).props.onClick();
    tree = fakeReact._render(MobilePage, { storage, useIndexedDB: false, apiClient: { auth: { getToken: () => '' }, request: async () => ({ data: {} }) } });
    const confirmBtn = findNode(tree, (n) => n.props?.['data-testid'] === `mobile-pwa-outbox-delete-confirm-${item.id}`);
    assert.ok(confirmBtn, 'Must show Xác nhận xóa? button');
    await confirmBtn.props.onClick();
    assert.equal((await listOutboxItems({ useIndexedDB: false, storage })).length, 0);
    fakeReact._unmount();
  }, { storage });
});

test('M2-4i: MobileFieldPwaPage service ticket create & note submit strictly comply with service-schema.js and service-scope.js for non-root users', async () => {
  const { createMobileFieldPwaPage } = require('../src/client-v2/mobile-field-pwa');
  const { SERVICE_TYPES, SERVICE_PRIORITIES, validateServiceTicket } = require('../../plugin-dxos-studio/src/server/service-schema');
  const { createServiceScopeMiddleware } = require('../../plugin-dxos-studio/src/server/service-scope');
  const fakeReact = createFakeReact();
  const storage = makeMemoryStorage();

  const mockDb = {
    getRepository(name) {
      if (name === 'latticeEmployees') {
        return {
          async find() {
            return [{ id: 101, userId: 42, organizationId: 'org-test', departmentId: null, active: true }];
          },
        };
      }
      if (name === 'latticeServiceTickets') {
        return {
          async findOne() {
            return { id: 88, organizationId: 'org-test', status: 'draft', version: 1 };
          },
        };
      }
      return null;
    },
  };
  const scopeMw = createServiceScopeMiddleware(mockDb);

  await withMobileGlobals(async () => {
    const calls = [];
    const empApi = {
      auth: { role: 'ldx_employee', getToken: () => 'jwt-emp' },
      async request(req) {
        calls.push(req);
        if (req.url === 'roles:check') {
          return { data: { data: { role: 'ldx_employee', allowAll: false, resources: ['latticeOrders', 'latticeServiceTickets'] } } };
        }
        if (req.url === 'latticeServiceTickets:list') {
          return { data: { data: [{ id: 88, code: 'TKT-088', name: 'Hỗ trợ VPN', serviceType: 'it_support', priority: 'medium', status: 'draft', version: 1 }] } };
        }
        if (req.url === 'latticeChatter:list') return { data: { data: { items: [] } } };
        if (req.url === 'latticeServiceTickets:create' || req.url === 'latticeServiceTickets:update') {
          const [, actionName] = req.url.split(':');
          const ctx = {
            state: { currentRole: 'ldx_employee', currentUser: { id: 42 } },
            action: {
              resourceName: 'latticeServiceTickets',
              actionName,
              params: {
                ...(req.params || {}),
                values: { ...(req.data || {}) },
              },
            },
          };
          await scopeMw(ctx, async () => {
            if (actionName === 'create') {
              const model = { isNewRecord: true, ...ctx.action.params.values };
              validateServiceTicket(model, { context: ctx, fields: Object.keys(model) });
            }
          });
          return { data: { data: { id: 89, ...ctx.action.params.values } } };
        }
        return { data: { data: { ok: true } } };
      },
    };

    const MobilePage = createMobileFieldPwaPage({ Plugin: class {} }, fakeReact, {});
    let tree = fakeReact._render(MobilePage, { storage, apiClient: empApi });
    fakeReact._flushEffects();
    await new Promise((r) => setTimeout(r, 25));
    tree = fakeReact._render(MobilePage, { storage, apiClient: empApi });

    // 1. Open quick-create ticket form and inspect <select> enum options against SERVICE_TYPES & SERVICE_PRIORITIES
    findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-ticket-create-toggle').props.onClick();
    tree = fakeReact._render(MobilePage, { storage, apiClient: empApi });

    const typeSelect = findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-ticket-new-type');
    const typeValues = findAllNodes(typeSelect, (n) => n.type === 'option').map((o) => o.props.value);
    assert.deepEqual([...typeValues].sort(), [...SERVICE_TYPES].sort(), 'Ticket type <select> options must match SERVICE_TYPES');

    const prioSelect = findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-ticket-new-priority');
    const prioValues = findAllNodes(prioSelect, (n) => n.type === 'option').map((o) => o.props.value);
    assert.deepEqual([...prioValues].sort(), [...SERVICE_PRIORITIES].sort(), 'Ticket priority <select> options must match SERVICE_PRIORITIES');

    // 2. Submit new ticket with default selections and validate against server middleware + validateServiceTicket
    findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-ticket-new-name').props.onChange({ target: { value: 'Yêu cầu cấp lại thẻ kho' } });
    tree = fakeReact._render(MobilePage, { storage, apiClient: empApi });
    const createdTicket = await findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-ticket-new-submit').props.onClick({ preventDefault() {} });
    assert.ok(createdTicket && createdTicket.id === 89, 'latticeServiceTickets:create must succeed through real service-scope & service-schema validation');

    const createCall = calls.find((c) => c.url === 'latticeServiceTickets:create');
    assert.ok(createCall, 'Must call latticeServiceTickets:create');
    assert.equal(typeof createCall.data.code, 'string');
    assert.ok(createCall.data.code.trim().length > 0, 'Create payload must include non-empty code');
    assert.equal(createCall.data.status, undefined, 'Create payload must omit protected status field');
    assert.equal(createCall.data.resolutionNote, undefined, 'Create payload must omit protected resolutionNote field');
    assert.ok(SERVICE_TYPES.includes(createCall.data.serviceType), `Invalid serviceType: ${createCall.data.serviceType}`);
    assert.ok(SERVICE_PRIORITIES.includes(createCall.data.priority), `Invalid priority: ${createCall.data.priority}`);

    // 3. Open draft ticket #88 and submit detail note -> must use latticeChatter:post, never protected resolutionNote update
    tree = fakeReact._render(MobilePage, { storage, apiClient: empApi });
    await findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-ticket-open-88').props.onClick();
    tree = fakeReact._render(MobilePage, { storage, apiClient: empApi });
    findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-ticket-note-input').props.onChange({ target: { value: 'Đã kiểm tra log VPN' } });
    tree = fakeReact._render(MobilePage, { storage, apiClient: empApi });
    const noteOk = await findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-ticket-note-submit').props.onClick({ preventDefault() {} });
    assert.equal(noteOk, true, 'Submitting ticket note must succeed for non-root user without 403');
    assert.equal(calls.some((c) => c.url === 'latticeServiceTickets:update'), false, 'Must not send protected resolutionNote update');
    assert.ok(calls.some((c) => c.url === 'latticeChatter:post' && c.data?.targetCollection === 'latticeServiceTickets' && c.data?.targetRecordId === 88 && c.data?.body === 'Đã kiểm tra log VPN'));

    fakeReact._unmount();
  }, { storage });
});

test('M2-4j: submitMobileAiPrompt skips dxosAi:agentChat when live aiConversations/dxos-a2a endpoints fail with HTTP 500', async () => {
  const { createMobileFieldPwaPage } = require('../src/client-v2/mobile-field-pwa');
  const fakeReact = createFakeReact();
  const storage = makeMemoryStorage();

  await withMobileGlobals(async () => {
    const calls = [];
    const liveErrorApi = {
      auth: { getToken: () => 'jwt-live-err' },
      async request(req) {
        calls.push(req.url);
        if (req.url === 'dxosAi:portalAgents') return { data: { data: { employees: [{ username: 'dxos-logistics' }] } } };
        if (req.url === 'aiConversations:create') {
          throw Object.assign(new Error('Internal Server Error'), { response: { status: 500, data: { errors: [{ message: 'LLM provider unavailable' }] } } });
        }
        if (req.url === 'dxos-a2a') {
          throw Object.assign(new Error('Bad Gateway'), { response: { status: 502, data: { errors: [{ message: 'A2A gateway down' }] } } });
        }
        if (req.url === 'dxosAi:agentChat') {
          throw Object.assign(new Error('Not Found'), { response: { status: 404 } });
        }
        return { data: {} };
      },
    };

    const MobilePage = createMobileFieldPwaPage({ Plugin: class {} }, fakeReact, {});
    let tree = fakeReact._render(MobilePage, { storage, apiClient: liveErrorApi });
    fakeReact._flushEffects();
    findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-ai-pill').props.onClick();
    tree = fakeReact._render(MobilePage, { storage, apiClient: liveErrorApi });
    findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-ai-input').props.onChange({ target: { value: 'Kiểm tra kho' } });
    tree = fakeReact._render(MobilePage, { storage, apiClient: liveErrorApi });
    await findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-ai-form').props.onSubmit({ preventDefault() {} });
    tree = fakeReact._render(MobilePage, { storage, apiClient: liveErrorApi });

    assert.equal(calls.includes('dxosAi:agentChat'), false, 'Must NOT call dxosAi:agentChat 404 when live endpoints already failed with server error');
    const drawerText = collectText(findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-ai-drawer'));
    assert.ok(drawerText.includes('A2A gateway down') || drawerText.includes('LLM provider unavailable'), 'Must surface live AI server error instead of fake success');
    fakeReact._unmount();
  }, { storage });
});

test('P1-12: Mobile AI chat enforces AbortController timeout, skips cascading dxos-a2a on 503/timeout, renders loading & inline error card with Thử lại button', async () => {
  const { createMobileFieldPwaPage } = require('../src/client-v2/mobile-field-pwa');
  const fakeReact = createFakeReact();
  const storage = makeMemoryStorage();

  await withMobileGlobals(async () => {
    const calls = [];
    let failMode = 'timeout';
    const aiApi = {
      auth: { getToken: () => 'jwt-ai-timeout' },
      async request(req) {
        calls.push(req.url);
        if (req.url === 'dxosAi:portalAgents') return { data: { data: { employees: [{ username: 'dxos-logistics' }] } } };
        if (req.url === 'aiConversations:create') {
          if (failMode === 'timeout') {
            return new Promise(() => {}); // Never resolves -> triggers aiTimeoutMs
          }
          if (failMode === '503') {
            throw Object.assign(new Error('Service Unavailable'), { response: { status: 503, data: { errors: [{ message: '9router offline' }] } } });
          }
          return { data: { data: { id: 'sess-1' } } };
        }
        if (req.url === 'aiConversations:sendMessages') {
          return { data: { data: { reply: 'Đã khôi phục trợ lý AI.' } } };
        }
        return { data: {} };
      },
    };

    const MobilePage = createMobileFieldPwaPage({ Plugin: class {} }, fakeReact, {});
    let tree = fakeReact._render(MobilePage, { storage, apiClient: aiApi, aiTimeoutMs: 30 });
    fakeReact._flushEffects();
    findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-ai-pill').props.onClick();
    tree = fakeReact._render(MobilePage, { storage, apiClient: aiApi, aiTimeoutMs: 30 });
    findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-ai-input').props.onChange({ target: { value: 'Tình trạng đơn?' } });
    tree = fakeReact._render(MobilePage, { storage, apiClient: aiApi, aiTimeoutMs: 30 });

    const submitPromise = findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-ai-form').props.onSubmit({ preventDefault() {} });
    tree = fakeReact._render(MobilePage, { storage, apiClient: aiApi, aiTimeoutMs: 30 });
    assert.ok(findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-ai-loading'), 'Loading indicator must appear while aiBusy');
    await submitPromise;
    tree = fakeReact._render(MobilePage, { storage, apiClient: aiApi, aiTimeoutMs: 30 });

    assert.equal(calls.includes('dxos-a2a'), false, 'Must skip cascading dxos-a2a on timeout');
    const errCard = findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-ai-error-card');
    assert.ok(errCard, 'Expected inline error card on timeout');
    const retryBtn = findNode(errCard, (n) => n.props?.['data-testid'] === 'mobile-pwa-ai-retry-btn');
    assert.ok(retryBtn, 'Expected Thử lại button in error card');

    // Retry succeeds cleanly when server recovers
    failMode = 'ok';
    await retryBtn.props.onClick();
    tree = fakeReact._render(MobilePage, { storage, apiClient: aiApi, aiTimeoutMs: 30 });
    assert.ok(collectText(findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-ai-reply')).includes('Đã khôi phục trợ lý AI.'));

    // 503 also skips cascading dxos-a2a
    calls.length = 0;
    failMode = '503';
    findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-ai-input').props.onChange({ target: { value: 'Thử 503' } });
    tree = fakeReact._render(MobilePage, { storage, apiClient: aiApi, aiTimeoutMs: 30 });
    await findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-ai-form').props.onSubmit({ preventDefault() {} });
    tree = fakeReact._render(MobilePage, { storage, apiClient: aiApi, aiTimeoutMs: 30 });
    assert.equal(calls.includes('dxos-a2a'), false, 'Must skip cascading dxos-a2a on 503');
    fakeReact._unmount();
  }, { storage });
});

test('T2-MOBILE-01: dist/client-v2 marks mobile routes skipAuthCheck: true and guards expired-JWT background calls without blocking epodCapture', async () => {
  const distV2Src = readFileSync(join(PLUGIN_ROOT, 'dist/client-v2/index.js'), 'utf8');
  let modV2;
  const defineV2 = (name, _deps, factory) => {
    modV2 = factory({ Plugin: class {} }, {});
  };
  defineV2.amd = {};
  const expiredPayload = Buffer.from(JSON.stringify({ userId: 5, exp: Math.floor(Date.now() / 1000) - 3600 })).toString('base64url');
  const expiredJwt = `eyJhbGciOiJIUzI1NiJ9.${expiredPayload}.sig`;

  const reqInterceptors = [];
  const networkCalls = [];
  const routes = new Map([['mobile', { path: '/mobile', element: { type: 'MobileLayout' } }]]);
  const storage = makeMemoryStorage();
  storage.setItem('NOCOBASE_TOKEN', expiredJwt);

  const mockWindow = {
    location: { pathname: '/v/mobile', search: '', hash: '' },
    localStorage: storage,
    addEventListener() {},
    removeEventListener() {},
  };
  vm.runInNewContext(distV2Src, {
    define: defineV2,
    URL,
    URLSearchParams,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    TextDecoder,
    sessionStorage: { getItem: () => null },
    window: mockWindow,
  });

  const prevWin = global.window;
  global.window = mockWindow;
  try {
    const apiClient = {
      auth: { getToken: () => expiredJwt },
      axios: {
        interceptors: {
          request: { use: (fn) => reqInterceptors.push(fn) },
          response: { handlers: [], use: () => {} },
        },
      },
      async request(cfg) {
        networkCalls.push(cfg.url);
        throw Object.assign(new Error('Unauthorized'), { status: 401 });
      },
    };
    const PluginClass = modV2.default;
    const p = new PluginClass();
    p.app = {
      apiClient,
      router: {
        has: (name) => routes.has(name),
        routes: Object.fromEntries(routes),
        add: (name, route) => routes.set(name, route),
      },
    };
    await p.load();

    assert.equal(routes.get('mobile').skipAuthCheck, true);
    assert.equal(routes.get('dxos-mobile-field').skipAuthCheck, true);
    assert.equal(routes.get('dxos-mobile-field-sub').skipAuthCheck, true);

    for (const bgUrl of ['auth:check', 'aiEmployees:listByUser', 'aiConversations:unreadCounts', 'blockTemplates:list']) {
      const res = await apiClient.request({ url: bgUrl });
      assert.equal(res.status, 200, `Expected expired-JWT guard for ${bgUrl}`);
    }
    assert.equal(networkCalls.length, 0);

    // Mutating ePOD sync must still hit the server (triggering 401 stop in flushOfflineQueue)
    await assert.rejects(
      () => apiClient.request({ url: 'dxosWms:epodCapture', method: 'post' }),
      (err) => err.status === 401,
    );
    assert.deepEqual(networkCalls, ['dxosWms:epodCapture']);
  } finally {
    global.window = prevWin;
  }
});

test('T1-MOBILE-06: MobileFieldPwaPage offline incident create queues valid assetEntityId + organizationId + summary and syncs cleanly through dxosBlocks:alarmIngest', async () => {
  const { createMobileFieldPwaPage, flushOfflineQueue } = require('../src/client-v2/mobile-field-pwa');
  const { createDxosBlocksActions } = require('../../plugin-dxos-blocks/src/server/blocks-api');
  const fakeReact = createFakeReact();
  const storage = makeMemoryStorage();

  const createdIncidents = [];
  const mockDb = {
    getRepository(name) {
      if (name === 'latticeEmployees') {
        return {
          find: async () => [{ id: 201, userId: 35, organizationId: 'native-ui-lab', active: true }],
        };
      }
      if (name === 'roles') {
        return {
          findOne: async () => ({ name: 'ldx_manager', allowAll: false, strategy: { actions: ['*:*'] } }),
        };
      }
      if (name === 'dataSourcesRolesResources') {
        return {
          findOne: async () => ({ roleName: 'ldx_manager', name: 'latticeIncidentCases', usingActionsConfig: false }),
        };
      }
      if (name === 'latticeIncidentCases') {
        return {
          find: async () => [],
          create: async ({ values }) => {
            const row = { id: createdIncidents.length + 1, ...values };
            createdIncidents.push(row);
            return row;
          },
        };
      }
      if (name === 'latticeNotifications') {
        return { find: async () => [], create: async ({ values }) => values };
      }
      return null;
    },
  };
  const blocksActions = createDxosBlocksActions(mockDb, {});
  const alarmCalls = [];

  await withMobileGlobals(async () => {
    const winListeners = {};
    global.window.addEventListener = (ev, fn) => {
      (winListeners[ev] ||= []).push(fn);
    };
    global.window.removeEventListener = (ev, fn) => {
      if (winListeners[ev]) winListeners[ev] = winListeners[ev].filter((f) => f !== fn);
    };
    const managerApi = {
      auth: { role: 'ldx_manager', getToken: () => 'jwt-mgr' },
      async request(req) {
        if (req.url === 'roles:check') {
          return {
            data: {
              data: {
                role: 'ldx_manager',
                allowAll: false,
                resources: ['latticeOrders', 'latticeIncidentCases', 'latticeServiceTickets'],
                actions: { 'latticeIncidentCases:create': true, 'dxosBlocks:alarmIngest': true },
              },
            },
          };
        }
        if (req.url === 'latticeOrders:list') {
          return { data: { data: [{ id: 10, code: 'ORD-10', organizationId: 'native-ui-lab', status: 'submitted' }] } };
        }
        if (req.url === 'latticeIncidentCases:list') return { data: { data: [] } };
        if (req.url === 'latticeServiceTickets:list') return { data: { data: [] } };
        if (req.url === 'dxosApprovals:listInbox') return { data: { data: { items: [] } } };
        if (req.url === 'dxosBlocks:alarmIngest') {
          alarmCalls.push(req.data);
          const ctx = {
            method: 'POST',
            state: { currentRole: 'ldx_manager', currentUser: { id: 35, username: 'native.lab.manager' } },
            action: { params: { values: { ...(req.data || {}) } } },
          };
          await blocksActions.alarmIngest(ctx, async () => {});
          return { data: { data: ctx.body } };
        }
        return { data: { data: { ok: true } } };
      },
    };

    const MobilePage = createMobileFieldPwaPage({ Plugin: class {} }, fakeReact, {});
    let tree = fakeReact._render(MobilePage, { storage, useIndexedDB: false, apiClient: managerApi });
    fakeReact._flushEffects();
    await new Promise((r) => setTimeout(r, 30));
    tree = fakeReact._render(MobilePage, { storage, useIndexedDB: false, apiClient: managerApi });

    // Switch offline via window 'offline' event, open incident form, submit without entering optional entity URN
    Object.defineProperty(global, 'navigator', { configurable: true, value: { onLine: false } });
    for (const fn of winListeners.offline || []) fn();
    tree = fakeReact._render(MobilePage, { storage, useIndexedDB: false, apiClient: managerApi });
    findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-incident-create-toggle').props.onClick();
    tree = fakeReact._render(MobilePage, { storage, useIndexedDB: false, apiClient: managerApi });
    findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-incident-new-title').props.onChange({ target: { value: 'Sự cố offline E2E test' } });
    tree = fakeReact._render(MobilePage, { storage, useIndexedDB: false, apiClient: managerApi });

    const queued = await findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-incident-new-submit').props.onClick({ preventDefault() {} });
    assert.ok(queued && queued.queued === true, 'Offline incident submit must enqueue item');
    assert.equal(queued.item.actionType, 'iot.incidentCreate');
    assert.equal(queued.item.payload.organizationId, 'native-ui-lab');
    assert.ok(queued.item.payload.assetEntityId, 'Payload must include non-empty assetEntityId');
    assert.equal(queued.item.payload.summary, 'Sự cố offline E2E test');

    // Outbox drawer displays the incident title
    tree = fakeReact._render(MobilePage, { storage, useIndexedDB: false, apiClient: managerApi });
    findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-queue-badge').props.onClick();
    tree = fakeReact._render(MobilePage, { storage, useIndexedDB: false, apiClient: managerApi });
    const drawerText = collectText(findNode(tree, (n) => n.props?.['data-testid'] === 'mobile-pwa-outbox-drawer'));
    assert.ok(drawerText.includes('Sự cố offline E2E test'));

    // Reconnect and flush queue -> must pass real blocksActions.alarmIngest with 0 quarantined items
    const syncRes = await flushOfflineQueue({ apiClient: managerApi, storage, useIndexedDB: false, isOnline: true });
    assert.equal(syncRes.synced, 1);
    assert.equal(syncRes.quarantined, 0);
    assert.equal(syncRes.remaining.length, 0);
    assert.equal(alarmCalls.length, 1);
    assert.equal(alarmCalls[0].organizationId, 'native-ui-lab');
    assert.ok(alarmCalls[0].assetEntityId);
    assert.equal(createdIncidents.length, 1);
    assert.equal(createdIncidents[0].name, 'Sự cố offline E2E test');
    assert.equal(createdIncidents[0].organizationId, 'native-ui-lab');

    fakeReact._unmount();
  }, { storage });
});
