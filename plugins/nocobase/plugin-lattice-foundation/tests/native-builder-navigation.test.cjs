/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pageTree, hostPath, firstSettingsPath, createNativeBuilderNavigation } = require('../src/client/native-builder-navigation');
const { createNativePortalManager } = require('../src/client/native-portal-manager');
const { readFileSync } = require('node:fs');
const { runInNewContext } = require('node:vm');

test('projects host accessible groups/pages without catalog or external link destinations', () => {
  const routes = [{ type: 'group', id: 8, title: 'Nhân sự', children: [
    { type: 'page', schemaUid: 'employees-v1', title: 'Nhân viên', sort: 2 },
    { type: 'flowPage', schemaUid: 'departments_v2', title: 'Đơn vị', sort: 1 },
    { type: 'link', title: 'External', options: { href: 'https://example.com' } },
    { type: 'tabs', schemaUid: 'tab', title: 'Tab' },
  ] }];
  const snapshot = JSON.stringify(routes);
  assert.deepEqual(pageTree(routes), [{ key: 'group:8', title: 'Nhân sự', children: [
    { key: 'page:departments_v2', title: 'Đơn vị', path: '/admin/departments_v2' },
    { key: 'page:employees-v1', title: 'Nhân viên', path: '/admin/employees-v1' },
  ] }]);
  assert.equal(JSON.stringify(routes), snapshot);
});

test('hidden parents, hidden pages, empty groups and malformed UIDs are excluded', () => {
  const page = { type: 'flowPage', schemaUid: 'valid', title: 'Trang' };
  assert.deepEqual(pageTree([
    { ...page, hidden: true }, { ...page, hideInMenu: true },
    { type: 'group', id: 1, hidden: true, children: [page] },
    { type: 'group', id: 2, children: [] },
    ...['../settings', '', 'https://other', null, '..', 'a/b', 'x?y'].map(schemaUid => ({ ...page, schemaUid })),
  ]), []);
  assert.deepEqual(pageTree(null), []);
});

test('search retains ancestor hierarchy and matches a group without flattening its pages', () => {
  const routes = [{ type: 'group', id: 1, title: 'Nhân sự', children: [
    { type: 'page', schemaUid: 'a', title: 'Nhân viên' },
    { type: 'page', schemaUid: 'b', title: 'Đơn vị' },
  ] }];
  assert.deepEqual(pageTree(routes, 'ĐƠN VỊ')[0].children.map(x => x.key), ['page:b']);
  assert.equal(pageTree(routes, 'Nhân sự')[0].children.length, 2);
  assert.deepEqual(pageTree(routes, 'không tồn tại'), []);
});

test('native links respect host basename and reject non-native or unsafe destinations', () => {
  assert.equal(hostPath('/company/acme/', '/admin/a'), '/company/acme/admin/a');
  assert.equal(hostPath('/', '/admin/a'), '/admin/a');
  assert.equal(hostPath(undefined, '/admin/settings/users'), '/admin/settings/users');
  for (const path of ['//other', '/lattice/studio', '/admin/../signin', '/admin/x?q=y', '/administrator', '/admin/x\\y']) {
    assert.equal(hostPath('', path), null);
  }
  assert.equal(hostPath('//other', '/admin/a'), null);
});

test('Config selects only an allowed settings leaf, never a denied or external setting', () => {
  assert.equal(firstSettingsPath([
    { isAllow: false, path: '/admin/settings/secrets' },
    { children: [{ isAllow: false, path: '/admin/settings/no' }, { isAllow: true, path: '/admin/settings/users' }] },
  ]), '/admin/settings/users');
  assert.equal(firstSettingsPath([{ path: 'https://example.com' }, { isAllow: false, children: [{ path: '/admin/settings/no' }] }]), null);
});

function harness({ allow = true, pathname = '/admin/demo', designable = false, runEffects = false, portals = [], layoutUid } = {}) {
  let cursor = 0, nativeRenders = 0, v2Renders = 0, lastGate = null;
  const state = [], registered = [], navigations = [], layouts = new Map(), registeredModels = {};
  let effects = [], cleanups = [];
  const React = {
    Fragment: 'Fragment',
    createElement: (type, props, ...children) => ({
      type,
      props: children.length ? { ...(props || {}), children: children.length === 1 ? children[0] : children } : (props || {}),
      children,
    }),
    useState(initial) { const i = cursor++; if (!(i in state)) state[i] = initial; return [state[i], v => { state[i] = v; }]; },
    useRef(initial) { const i = cursor++; return state[i] || (state[i] = { current: initial }); },
    useEffect(effect) { if (runEffects) effects.push(effect); },
  };
  class NativeModel {
    constructor() { if (layoutUid) this.layout = { uid: layoutUid }; }
    render() { nativeRenders++; return 'native runtime shell'; }
    addSubModel(subKey, opts) { return { subKey, ...opts }; }
    syncMenuRoutes(routes) { this.syncedRoutes = routes; }
    setIsMobileLayout(value) { this.isMobileLayout = value; }
  }
  class V2AdminModel {
    render() { v2Renders++; return 'v2 portal shell'; }
    syncMenuRoutes(routes) { this.v2SyncedRoutes = routes; }
    toProLayoutRoute() { return { path: '/', children: ['v2-item'] }; }
  }
  class V2MenuItem {
    addSubModel(subKey, opts) { return { subKey, ...opts }; }
  }
  const client = {
    AdminProvider: 'AdminProvider', PinnedPluginList: 'NativeTools', SchemaComponent: 'Schema', PagePopups: 'Popups',
    useAllAccessDesktopRoutes: () => ({ allAccessRoutes: [{ type: 'flowPage', schemaUid: 'demo', title: 'Trang demo' }], refresh: async () => {} }),
    useUIConfigurationPermissions: () => ({ allowConfigUI: allow }),
    useDesignable: () => ({ designable }),
    useAPIClient: () => ({ auth: { role: allow ? 'root' : 'ldx_employee' }, request: async () => ({ data: { data: portals } }) }),
  };
  const app = {
    flowEngine: {
      getModelClass: () => NativeModel,
      registerModels: map => Object.assign(registeredModels, map),
      flowSettings: { enabled: false, async enable() { this.enabled = true; }, async disable() { this.enabled = false; } },
    },
    layoutManager: { hasLayout: name => layouts.has(name), registerLayout: cfg => layouts.set(cfg.routeName, cfg) },
    pluginSettingsManager: { add() {} },
    router: { add: (name, route) => registered.push({ name, ...route }) },
  };
  const router = { Link: 'Link', Outlet: 'Outlet', useLocation: () => ({ pathname, search: '' }), useNavigate: () => (to, opts) => navigations.push({ to, opts }) };
  const antd = Object.fromEntries(['Input', 'Button', 'Alert', 'Select', 'Space', 'Card', 'Dropdown'].map(k => [k, k]));
  const portalManager = createNativePortalManager(client, React, antd, app, router);
  let model;
  const clientV2 = { AdminLayoutModel: V2AdminModel, AdminLayoutMenuItemModel: V2MenuItem, getAdminLayoutModel(engine, options) { model = new options.use(); return model; } };
  const Layout = createNativeBuilderNavigation(client, React, antd, app, { clientV2, router, flow: { FlowModelRenderer: 'FlowModelRenderer' }, portalManager });
  const root = Layout({});
  const gate = model.render();
  return {
    root, gate, registered, model, registeredModels, layouts, navigations,
    flowSettings: app.flowEngine.flowSettings,
    setAllow(v) { allow = v; },
    get lastGate() { return lastGate; },
    get nativeRenders() { return nativeRenders; },
    get v2Renders() { return v2Renders; },
    render() {
      cursor = 0;
      lastGate = gate.type(gate.props);
      const shell = lastGate?.type === 'AdminProvider' ? lastGate.children[0] : null;
      const ui = shell ? shell.type(shell.props) : lastGate;
      cleanups.forEach(c => c());
      cleanups = effects.map(e => e()).filter(v => typeof v === 'function');
      effects = [];
      return ui;
    },
  };
}

function find(node, predicate) {
  if (!node || typeof node !== 'object') return null;
  if (predicate(node)) return node;
  if (typeof node.type === 'function') return find(node.type(node.props), predicate);
  return node.children?.flat(Infinity).map(child => find(child, predicate)).find(Boolean) || null;
}

test('delegates AdminLayoutModel to NativeModel.prototype.render, registers AdminLayoutModel, and centers Clause 5.2 link outside settings', () => {
  const setup = harness();
  assert.equal(setup.root.type, 'FlowModelRenderer');
  assert.equal(typeof setup.registeredModels.AdminLayoutModel, 'function');
  const ui = setup.render();
  assert.equal(setup.lastGate.type, 'AdminProvider');
  assert.equal(ui.type, 'Fragment');
  assert.equal(ui.children[0], 'native runtime shell');
  assert.equal(setup.nativeRenders, 1);
  const link = find(ui, n => n.type === 'a' && n.props.href === 'https://www.nocobase.com');
  assert.equal(link.children[0], 'NocoBase');
  const footer = find(ui, n => n.props?.className === 'ldx-clause52-attribution');
  assert.equal(footer.props.style.left, '50%');
  assert.ok(find(ui, n => n.props?.className === 'nb-portal-switcher'));

  const settingsSetup = harness({ pathname: '/admin/settings/multi-portal' });
  const settingsUi = settingsSetup.render();
  assert.equal(find(settingsUi, n => n.props?.className === 'ldx-clause52-attribution'), null);
});

test('employees wait on /admin redirect without mounting AdminProvider, then use V2AdminModel inside portal', async () => {
  const portals = [{ uid: 'ldx-portal-hr', title: 'HR', routeName: 'p_hr', routePath: '/p/hr', firstPagePath: '/p/hr/leave', isDefault: true, enabled: true }];
  const setup = harness({ allow: false, pathname: '/admin', runEffects: true, portals });
  const waitingUi = setup.render();
  assert.equal(waitingUi.props.className, 'ldx-portal-redirecting');
  assert.notEqual(setup.lastGate.type, 'AdminProvider');
  assert.equal(setup.nativeRenders, 0);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(setup.layouts.get('p_hr').layoutModelClass, 'AdminLayoutModel');
  assert.deepEqual(setup.navigations.at(-1), { to: '/p/hr/leave', opts: { replace: true } });

  const portalSetup = harness({ allow: false, pathname: '/p/hr/leave', layoutUid: 'ldx-portal-hr' });
  const portalUi = portalSetup.render();
  assert.equal(portalSetup.lastGate.type, 'AdminProvider');
  assert.equal(portalUi.children[0], 'v2 portal shell');
  assert.equal(portalSetup.v2Renders, 1);
  assert.equal(portalSetup.nativeRenders, 0);
  portalSetup.model.syncMenuRoutes(['r1']);
  assert.deepEqual(portalSetup.model.v2SyncedRoutes, ['r1']);
  assert.deepEqual(portalSetup.model.toProLayoutRoute(), { path: '/', children: ['v2-item'] });
  assert.equal(typeof portalSetup.registeredModels.LatticePortalMenuItemModel, 'function');
  assert.equal(portalSetup.model.addSubModel('menuItems', { use: 'AdminLayoutMenuItemModel', uid: 'm1' }).use, 'LatticePortalMenuItemModel');
  const adminSetup = harness({ allow: true, pathname: '/admin/demo' });
  assert.equal(adminSetup.model.addSubModel('menuItems', { use: 'AdminLayoutMenuItemModel', uid: 'm0' }).use, 'AdminLayoutMenuItemModel');

  const builderRoute = setup.registered.find(r => r.name === 'admin.lattice-builder');
  const landing = builderRoute.Component();
  assert.ok(find(landing, n => n.type === 'h1' && n.children[0] === 'Không có quyền truy cập'));
});

test('unsupported SDK does not register routes or replace the native layout', () => {
  assert.equal(createNativeBuilderNavigation({}, {}, {}, {}), null);
});

test('switching from builder to employee disables design mode even after enable has settled', async t => {
  const previous = global.window;
  global.window = { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) };
  t.after(() => { global.window = previous; });
  const setup = harness({ allow: true, designable: true, runEffects: true });
  setup.render(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(setup.flowSettings.enabled, true);
  setup.setAllow(false); setup.render(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(setup.flowSettings.enabled, false);
});

test('native model syncs menu routes when layout uid is absent, preserves portal routes when uid exists, and reacts to mobile changes', async t => {
  const previous = global.window, listeners = new Set();
  const media = { matches: false, addEventListener(e, l) { listeners.add(l); }, removeEventListener(e, l) { listeners.delete(l); } };
  global.window = { matchMedia: () => media };
  t.after(() => { global.window = previous; });

  const setup = harness({ allow: false, runEffects: true });
  setup.render(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(setup.model.syncedRoutes?.[0]?.schemaUid, 'demo');
  assert.equal(setup.model.isMobileLayout, false);
  media.matches = true; listeners.forEach(l => l());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(setup.model.isMobileLayout, true);
  assert.equal(setup.flowSettings.enabled, false);

  const portalSetup = harness({ allow: false, runEffects: true, layoutUid: 'ldx-portal-hr' });
  portalSetup.render(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(portalSetup.model.syncedRoutes, undefined);
});

test('built AMD entry registers the replacement layout, portal manager, and builder route when host SDK is available', async () => {
  let factory;
  const define = (name, deps, value) => { factory = value; };
  define.amd = {};
  runInNewContext(readFileSync(require.resolve('../dist/client/index.js'), 'utf8'), {
    define, window: { location: { hostname: 'localhost', pathname: '/admin' } }, sessionStorage: { getItem: () => null },
  });
  class NativeModel { render() { return null; } }
  class BlockModel { static define() {} static registerFlow() {} }
  class SettingsTopbarModel {}
  class UserCenterAction {}
  const client = { Plugin: class {}, AdminProvider() {}, useAllAccessDesktopRoutes() {}, useUIConfigurationPermissions() {}, useDesignable() {} };
  const routes = [], components = {}, settings = [], usedProviders = [], createdModels = [], registeredModels = {};
  const secObj = { title: 'Security' };
  const app = {
    flowEngine: {
      getModelClass: name => (name === 'AdminLayoutModel' ? NativeModel : name === 'PluginSettingsTopbarActionModel' ? SettingsTopbarModel : undefined),
      getModel: uid => (createdModels.includes(uid) ? { uid } : undefined),
      createModel: cfg => { createdModels.push(cfg.uid); return cfg; },
      registerModels: map => Object.assign(registeredModels, map),
    },
    layoutManager: { listLayouts: () => [{ uid: 'ldx-portal-hr', routeName: 'p_hr', routePath: '/p/hr', layoutModelClass: 'AdminLayoutModel' }] },
    pluginSettingsManager: { add: (name, cfg) => settings.push(name), get: name => (name === 'security' ? secObj : null) },
    router: { add: (name, route) => routes.push({ name, ...route }) },
    addComponents: value => Object.assign(components, value), addScopes() {},
    use: prov => usedProviders.push(prov),
    schemaInitializerManager: { get: () => ({ add() {} }) },
  };
  const V2ACLProvider = () => null;
  const v2 = { BlockModel, getAdminLayoutModel() {}, ACLRolesCheckProvider: V2ACLProvider, UserCenterActionItemModel: UserCenterAction };
  const mod = factory(client, { createElement() {} }, {}, v2, { Link() {}, Outlet() {}, useLocation() {} }, { FlowModelRenderer: { $$typeof: Symbol.for('react.memo') } });
  const plugin = new mod.default();
  plugin.app = app; plugin.flowEngine = app.flowEngine;
  await plugin.load();
  assert.equal(typeof components.AdminLayout, 'function');
  assert.equal(typeof app.apps.loadAppList, 'function');
  assert.ok(settings.includes('multi-portal'));
  assert.ok(routes.some(route => route.name === 'admin.lattice-builder' && route.path === '/admin/lattice-builder'));
  assert.ok(usedProviders.includes(V2ACLProvider));
  assert.equal(SettingsTopbarModel.prototype.aclSnippet, 'pm');
  assert.equal(secObj.aclSnippet, 'pm.security');
  assert.equal(registeredModels.LatticeSignOutUserCenterItemModel?.itemId, 'lattice-sign-out');
  assert.ok(createdModels.includes('ldx-portal-hr'));
});
