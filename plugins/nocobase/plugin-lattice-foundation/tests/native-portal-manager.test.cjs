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
const {
  toPortalSlug,
  ensureDynamicLayoutsRegistered,
  buildPortalAppList,
  createNativePortalManager,
  resolveLegacyMobileRedirect,
} = require('../src/client/native-portal-manager');

function createReactMock() {
  let cursor = 0;
  const state = [], effects = [];
  return {
    Fragment: 'Fragment',
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState(initial) {
      const i = cursor++;
      if (!(i in state)) state[i] = typeof initial === 'function' ? initial() : initial;
      return [state[i], v => { state[i] = typeof v === 'function' ? v(state[i]) : v; }];
    },
    useEffect(fn) { effects.push(fn); },
    reset() { cursor = 0; },
    flush() { while (effects.length) effects.shift()(); },
  };
}

function find(node, predicate) {
  if (!node || typeof node !== 'object') return null;
  if (predicate(node)) return node;
  if (typeof node.type === 'function') return find(node.type(node.props), predicate);
  return node.children?.flat(Infinity).map(c => find(c, predicate)).find(Boolean) || null;
}

test('toPortalSlug normalizes Vietnamese titles and ensures safe kebab slugs', () => {
  assert.equal(toPortalSlug('Cổng Điều phối & Kho vận'), 'cong-dieu-phoi-kho-van');
  assert.equal(toPortalSlug('  Nhân sự  '), 'nhan-su');
});

test('ensureDynamicLayoutsRegistered registers custom desktop and mobile layouts safely without duplicates', () => {
  const layouts = new Map([['admin', true]]);
  const app = {
    layoutManager: {
      hasLayout: name => layouts.has(name),
      registerLayout: cfg => { layouts.set(cfg.routeName, cfg); },
    },
  };
  const added = ensureDynamicLayoutsRegistered(app, [
    { uid: 'admin-layout-model', routeName: 'admin', routePath: '/admin', enabled: true },
    { uid: 'ldx-portal-hr', routeName: 'p_hr', routePath: '/p/hr', layoutType: 'desktop', enabled: true },
    { uid: 'ldx-portal-field', routeName: 'p_field', routePath: '/p/field', layoutType: 'mobile', enabled: true },
    { uid: 'ldx-portal-off', routeName: 'p_off', routePath: '/p/off', layoutType: 'desktop', enabled: false },
  ]);
  assert.deepEqual(added, ['p_hr', 'p_field']);
  assert.equal(layouts.get('p_hr').layoutModelClass, 'AdminLayoutModel');
  assert.equal(layouts.get('p_field').layoutModelClass, 'MobileLayoutModel');
  assert.equal(layouts.has('p_off'), false);
  assert.deepEqual(ensureDynamicLayoutsRegistered(app, [{ uid: 'ldx-portal-hr', routeName: 'p_hr', routePath: '/p/hr', enabled: true }]), []);
});

test('buildPortalAppList and app.apps.loadAppList include portals, workspace, and admin settings link', async () => {
  const portals = [{ uid: 'ldx-portal-hr', title: 'HR Portal', routeName: 'p_hr', routePath: '/p/hr', firstPagePath: '/p/hr/home', enabled: true }];
  const list = buildPortalAppList(portals, { allowConfigUI: true });
  assert.deepEqual(list.map(i => i.url), ['/p/hr/home', '/admin/lattice-workspace', '/admin/settings/multi-portal']);
  const React = createReactMock();
  const addedSettings = [];
  const app = {
    layoutManager: { hasLayout: () => false, registerLayout() {} },
    pluginSettingsManager: { add: (name, cfg) => addedSettings.push({ name, ...cfg }) },
    apiClient: { request: async () => ({ data: { data: portals } }) },
    apps: { loadAppList: async () => [{ title: 'External SubApp', url: '/apps/sub', target: '_self' }] },
  };
  const manager = createNativePortalManager({ useAPIClient: () => app.apiClient }, React, {}, app, { useNavigate: () => () => {} });
  assert.equal(addedSettings[0].name, 'multi-portal');
  assert.equal(addedSettings[0].aclSnippet, 'pm');
  manager.setPermissions(false);
  const appList = await app.apps.loadAppList();
  assert.deepEqual(appList.map(i => i.url), ['/p/hr/home', '/admin/lattice-workspace', '/apps/sub']);
});

test('MultiPortalSettingsPage renders portal grid, Clause 5.2 footer, and PortalBar switches routes', async () => {
  const React = createReactMock();
  const portals = [
    { uid: 'admin-layout-model', slug: 'admin', title: 'Studio', routeName: 'admin', routePath: '/admin', enabled: true, builtin: true, routeCount: 3, roles: [] },
    { uid: 'ldx-portal-hr', slug: 'hr', title: 'HR', routeName: 'p_hr', routePath: '/p/hr', firstPagePath: '/p/hr/home', enabled: true, isDefault: true, routeCount: 1, roles: ['ldx_employee'] },
  ];
  const requests = [], navigated = [];
  const antd = Object.fromEntries(['Modal', 'Input', 'Select', 'Switch', 'Alert', 'Button', 'Space', 'Tag', 'Dropdown', 'Popconfirm'].map(n => [n, n]));
  const client = {
    useAPIClient: () => ({
      request: async req => {
        requests.push(req);
        if (req.url === 'latticePortals:list') return { data: { data: portals } };
        if (req.url === 'roles:list') return { data: { data: [{ name: 'ldx_employee', title: 'Nhân viên' }] } };
        return { data: { data: {} } };
      },
    }),
  };
  const settings = [];
  const app = {
    layoutManager: { hasLayout: () => false, registerLayout() {} },
    pluginSettingsManager: { add: (name, cfg) => settings.push({ name, ...cfg }) },
  };
  const router = { Link: 'Link', useNavigate: () => to => navigated.push(to) };
  const manager = createNativePortalManager(client, React, antd, app, router);
  const Page = settings[0].Component;
  React.reset();
  Page();
  React.flush();
  await new Promise(r => setImmediate(r));
  React.reset();
  const ui = Page();
  assert.ok(find(ui, n => n.type === 'h1' && n.children[0] === 'Multi-Portal Manager'));
  assert.ok(find(ui, n => n.type === 'strong' && n.children[0] === 'HR'));
  assert.ok(find(ui, n => n.type === 'a' && n.props.href === 'https://www.nocobase.com' && n.children[0] === 'NocoBase'));
  assert.ok(requests.some(r => r.url === 'latticePortals:list'));

  const bar = manager.PortalBar({ portals, currentLayoutUid: 'ldx-portal-hr', pathname: '/p/hr/home', allowConfigUI: true, onSwitch: to => navigated.push(to) });
  const dropdown = find(bar, n => n.type === 'Dropdown');
  dropdown.props.menu.items[0].onClick();
  assert.equal(navigated.at(-1), '/admin');
});

test('preloadPortals awaits uiLayouts:listEnabled, navigateToPortal handles hot-created portals, and TopbarActionModel excludes admin portal for employees', async t => {
  const previousWindow = global.window;
  const assigned = [];
  const store = new Map();
  global.window = {
    location: { assign: url => assigned.push(url), replace: url => assigned.push('replace:' + url) },
    localStorage: { setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k) },
  };
  t.after(() => { global.window = previousWindow; });

  const React = createReactMock();
  const layouts = new Map([['admin', true]]);
  const registeredModels = {};
  const usedProviders = [];
  const requests = [], navigated = [], settings = [];
  const antd = Object.fromEntries(['Modal', 'Input', 'Select', 'Switch', 'Alert', 'Button', 'Space', 'Tag', 'Dropdown', 'Popconfirm'].map(n => [n, n]));
  const portalRows = [
    { uid: 'admin-layout-model', title: 'Desktop layout', routeName: 'admin', routePath: '/admin', enabled: true },
    { uid: 'ldx-portal-hr', title: 'HR Portal', routeName: 'p_hr', routePath: '/p/hr', firstPagePath: '/p/hr/home', enabled: true },
  ];
  class AdminBase {}
  class TopbarBase {}
  const app = {
    layoutManager: { hasLayout: name => layouts.has(name), registerLayout: cfg => layouts.set(cfg.routeName, cfg) },
    pluginSettingsManager: { add: (name, cfg) => settings.push({ name, ...cfg }) },
    use: (prov, cfg) => usedProviders.push({ prov, cfg }),
    flowEngine: {
      getModelClass: name => (name === 'TopbarActionModel' ? TopbarBase : AdminBase),
      registerModels: map => Object.assign(registeredModels, map),
      flowSettings: { enabled: false, async enable() { this.enabled = true; }, async disable() { this.enabled = false; } },
    },
    apiClient: {
      request: async req => {
        requests.push(req);
        if (req.url === 'uiLayouts:listEnabled') return { data: { data: portalRows } };
        if (req.url === 'latticePortals:list') return { data: { data: portalRows } };
        if (req.url === 'roles:list') return { data: { data: [] } };
        return { data: { data: [] } };
      },
    },
  };
  const client = {
    PinnedPluginListProvider: 'PinnedPluginListProvider',
    useAPIClient: () => app.apiClient,
    useUIConfigurationPermissions: () => ({ allowConfigUI: false }),
  };
  const router = { Link: 'Link', useNavigate: () => to => navigated.push(to), useLocation: () => ({ pathname: '/p/hr/home' }) };
  class AppSwitcherPanel {}
  const manager = createNativePortalManager(client, React, antd, app, router, null, {
    clientV2: { TopbarActionModel: TopbarBase, AdminLayoutModel: AdminBase, AppSwitcherActionPanelModel: AppSwitcherPanel },
  });
  assert.equal(registeredModels.AppSwitcherActionPanelModel, AppSwitcherPanel);

  const loaded = await manager.preloadPortals();
  assert.equal(loaded.length, 2);
  assert.ok(requests.some(r => r.url === 'uiLayouts:listEnabled' && r.skipNotify === true));
  assert.equal(layouts.get('p_hr').routePath, '/p/hr');
  assert.deepEqual(manager.getPortals(), []);

  manager.navigateToPortal('/p/hr/home', to => navigated.push(to));
  assert.equal(navigated.at(-1), '/p/hr/home');
  manager.navigateToPortal('/p/new-portal/home', to => navigated.push(to));
  assert.equal(assigned.at(-1), '/p/new-portal/home');

  assert.equal(manager.hasTopbarSwitcher, true);
  assert.equal(manager.hasTopbarNotificationBell, true);
  const topbarModel = new registeredModels.PortalSwitcherTopbarActionModel();
  assert.equal(topbarModel.sort, -50);
  assert.equal(topbarModel.actionId, 'portal-switcher');
  const bellModel = new registeredModels.NotificationBellTopbarActionModel();
  assert.equal(bellModel.sort, -40);
  assert.equal(bellModel.actionId, 'notification-bell');
  const employeeBar = manager.PortalBar({ portals: portalRows, pathname: '/p/hr/home', allowConfigUI: false, onSwitch: to => navigated.push(to) });
  assert.equal(employeeBar.type, 'span');
  assert.equal(employeeBar.props.style.height, 46);
  assert.equal(employeeBar.props.style.display, 'inline-flex');
  const employeeDrop = find(employeeBar, n => n.type === 'Dropdown');
  assert.equal(employeeDrop.props.menu.items.some(i => i.key.endsWith(':/admin')), false);

  const Page = settings[0].Component;
  React.reset();
  Page();
  React.flush();
  await new Promise(r => setImmediate(r));
  React.reset();
  const ui = Page();
  const hrCard = find(ui, n => n.type === 'article' && find(n, c => c.type === 'strong' && c.children[0] === 'HR Portal'));
  const builderBtn = find(hrCard, n => n.type === 'Button' && n.children[0] === 'Mở Builder');
  builderBtn.props.onClick();
  assert.equal(app.flowEngine.flowSettings.enabled, true);
  assert.equal(store.get('NOCOBASE_V2_FLOW_SETTINGS_ENABLED'), '1');
  assert.equal(navigated.at(-1), '/p/hr/home');
  assert.ok(usedProviders.some(u => (
    u.prov === 'PinnedPluginListProvider'
    && u.cfg?.items?.ldxPortalSwitcher?.order === -50
    && u.cfg?.items?.ldxPortalSwitcher?.snippet === '*'
    && u.cfg?.items?.ldxNotificationBell?.order === -40
    && u.cfg?.items?.ldxNotificationBell?.snippet === '*'
  )));
  manager.requestBuilderMode(false);
  assert.equal(store.get('NOCOBASE_V2_FLOW_SETTINGS_ENABLED'), '0');
});

test('savePortal preserves existing portals via upsertPortal, navigateToPortal applies basename, and PortalBar separates settings labels', async t => {
  const previousWindow = global.window;
  const assigned = [];
  global.window = {
    location: { assign: url => assigned.push(url), replace: url => assigned.push('replace:' + url) },
  };
  t.after(() => { global.window = previousWindow; });

  const React = createReactMock();
  let role = 'ldx_employee';
  const portalRows = [
    { uid: 'admin-layout-model', title: 'Studio', routeName: 'admin', routePath: '/admin', enabled: true },
    { uid: 'ldx-portal-hr', title: 'HR', routeName: 'p_hr', routePath: '/p/hr', firstPagePath: '/p/hr/home', enabled: true },
    { uid: 'ldx-portal-ops', title: 'Ops', routeName: 'p_ops', routePath: '/p/ops', firstPagePath: '/p/ops/home', enabled: true },
  ];
  const settings = [];
  const antd = Object.fromEntries(['Modal', 'Input', 'Select', 'Switch', 'Alert', 'Button', 'Space', 'Tag', 'Dropdown', 'Popconfirm'].map(n => [n, n]));
  const app = {
    getRouteUrl: path => '/sub' + path,
    layoutManager: { hasLayout: () => false, registerLayout() {}, listLayouts: () => [] },
    pluginSettingsManager: { add: (name, cfg) => settings.push({ name, ...cfg }) },
    apiClient: {
      auth: { get role() { return role; } },
      request: async req => {
        if (req.url === 'latticePortals:save') {
          return { data: { data: { uid: 'ldx-portal-new', slug: 'new', title: 'New', routeName: 'p_new', routePath: '/p/new', enabled: true } } };
        }
        return { data: { data: req.url === 'roles:list' ? [] : portalRows } };
      },
    },
  };
  const manager = createNativePortalManager({ useAPIClient: () => app.apiClient }, React, antd, app, { Link: 'Link', useNavigate: () => null });
  manager.setPortals(portalRows);
  manager.upsertPortal({ uid: 'ldx-portal-hr', title: 'HR Updated', isDefault: true, enabled: true });
  assert.equal(manager.getPortals().length, 3);
  assert.equal(manager.getPortals().find(p => p.uid === 'ldx-portal-hr').firstPagePath, '/p/hr/home');

  manager.navigateToPortal('/p/new/home', null);
  assert.equal(assigned.at(-1), '/sub/p/new/home');

  const multiBar = manager.PortalBar({ portals: portalRows, pathname: '/admin/settings/multi-portal', allowConfigUI: true });
  const usersBar = manager.PortalBar({ portals: portalRows, pathname: '/admin/settings/users', allowConfigUI: true });
  assert.ok(find(multiBar, n => n.children?.[0] === 'Multi-Portal'));
  assert.ok(find(usersBar, n => n.children?.[0] === 'Cài đặt hệ thống'));
});

test('resolveLegacyMobileRedirect bridges /mobile* to /{prefix}/mobile* only in legacy-default mode without native mobile layout', () => {
  assert.equal(
    resolveLegacyMobileRedirect({
      __nocobase_app_client_entry_mode__: 'legacy-default',
      location: { pathname: '/mobile', search: '', hash: '' },
    }, { layoutManager: { hasLayout: () => false } }),
    '/v/mobile',
  );
  assert.equal(
    resolveLegacyMobileRedirect({
      __nocobase_app_client_entry_mode__: 'legacy-default',
      location: { pathname: '/mobile/w6golht1d9g', search: '?tab=1', hash: '#top' },
    }, { layoutManager: { hasLayout: () => false } }),
    '/v/mobile/w6golht1d9g?tab=1#top',
  );
  assert.equal(
    resolveLegacyMobileRedirect({
      __nocobase_app_client_entry_mode__: 'legacy-default',
      __nocobase_modern_client_prefix__: 'modern',
      location: { pathname: '/mobile', search: '', hash: '' },
    }, {}),
    '/modern/mobile',
  );
  assert.equal(
    resolveLegacyMobileRedirect({
      __nocobase_app_client_entry_mode__: 'legacy-default',
      __nocobase_modern_client_prefix__: '//evil.com',
      location: { pathname: '/mobile', search: '', hash: '' },
    }, {}),
    '/v/mobile',
  );
  assert.equal(
    resolveLegacyMobileRedirect({
      __nocobase_app_client_entry_mode__: 'legacy-default',
      location: { pathname: '/mobile', search: '', hash: '' },
    }, { layoutManager: { hasLayout: name => name === 'mobile' } }),
    null,
  );
  for (const mode of ['modern', undefined]) {
    assert.equal(
      resolveLegacyMobileRedirect({
        __nocobase_app_client_entry_mode__: mode,
        location: { pathname: '/mobile', search: '', hash: '' },
      }, {}),
      null,
    );
  }
  for (const p of ['/admin', '/p/services', '/mobile-web', '/mobile/../evil', '/v/mobile']) {
    assert.equal(
      resolveLegacyMobileRedirect({
        __nocobase_app_client_entry_mode__: 'legacy-default',
        location: { pathname: p, search: '', hash: '' },
      }, {}),
      null,
    );
  }
});

test('MultiPortalSettingsPage includes custom non-ldx enterprise roles while excluding system/builder roles', async () => {
  const React = createReactMock();
  const antd = Object.fromEntries(['Modal', 'Input', 'Select', 'Switch', 'Alert', 'Button', 'Space', 'Tag', 'Dropdown', 'Popconfirm'].map(n => [n, n]));
  const rolesFromServer = [
    { name: 'root', title: 'Root', allowConfigure: true, snippets: ['*'] },
    { name: 'admin', title: 'Admin', allowConfigure: true, snippets: ['pm'] },
    { name: 'anonymous', title: 'Anonymous', allowConfigure: false, snippets: [] },
    { name: 'member', title: 'Member', allowConfigure: false, snippets: [] },
    { name: 'ui_builder', title: 'UI Builder', allowConfigure: true, snippets: ['pm.*'] },
    { name: 'ldx_employee', title: 'Nhân viên', allowConfigure: false, snippets: [] },
    { name: 'custom_auditor', title: 'Kiểm toán viên', allowConfigure: false, snippets: [] },
  ];
  const client = {
    useAPIClient: () => ({
      request: async req => {
        if (req.url === 'latticePortals:list') return { data: { data: [] } };
        if (req.url === 'roles:list') return { data: { data: rolesFromServer } };
        return { data: { data: {} } };
      },
    }),
  };
  const settings = [];
  const app = {
    layoutManager: { hasLayout: () => false, registerLayout() {} },
    pluginSettingsManager: { add: (name, cfg) => settings.push({ name, ...cfg }) },
  };
  createNativePortalManager(client, React, antd, app, { Link: 'Link', useNavigate: () => () => {} });
  const Page = settings[0].Component;
  React.reset();
  Page();
  React.flush();
  await new Promise(r => setImmediate(r));
  React.reset();
  const ui = Page();
  const modal = find(ui, n => Array.isArray(n.props?.roles));
  assert.ok(modal);
  assert.deepEqual(modal.props.roles.map(r => r.name), ['ldx_employee', 'custom_auditor']);
});

test('TopbarPortalSwitcher requires auth token, uses skipNotify, and syncPortals avoids redundant churn on identical metadata', async () => {
  const React = createReactMock();
  const requests = [];
  let token = '';
  let registerCount = 0;
  let modelGetCount = 0;
  const portals = [
    { uid: 'ldx-portal-services', title: 'Cổng Dịch vụ', routeName: 'p_services', routePath: '/p/services', firstPagePath: '/p/services/home', enabled: true },
  ];
  const app = {
    layoutManager: {
      hasLayout: () => false,
      registerLayout: () => { registerCount += 1; },
      listLayouts: () => [{ uid: 'ldx-portal-services', layoutModelClass: 'AdminLayoutModel' }],
    },
    flowEngine: {
      getModel: () => { modelGetCount += 1; return { uid: 'ldx-portal-services' }; },
      createModel: () => {},
    },
    pluginSettingsManager: { add() {} },
    apiClient: {
      auth: { role: 'ldx_employee', getToken: () => token },
      request: async req => {
        requests.push(req);
        return { data: { data: portals } };
      },
    },
  };
  const manager = createNativePortalManager(
    { useAPIClient: () => app.apiClient, useUIConfigurationPermissions: () => ({ allowConfigUI: false }) },
    React,
    { Dropdown: 'Dropdown' },
    app,
    { Link: 'Link', useLocation: () => ({ pathname: '/p/services/home' }), useNavigate: () => () => {} },
  );

  // Without auth token: TopbarPortalSwitcher must NOT call latticePortals:listAccessible
  React.reset();
  manager.TopbarPortalSwitcher({});
  React.flush();
  await new Promise(r => setImmediate(r));
  assert.equal(requests.filter(r => r.url === 'latticePortals:listAccessible').length, 0);

  // With auth token: calls with skipNotify: true
  token = 'jwt-emp';
  React.reset();
  manager.TopbarPortalSwitcher({});
  React.flush();
  await new Promise(r => setImmediate(r));
  const req = requests.find(r => r.url === 'latticePortals:listAccessible');
  assert.ok(req);
  assert.equal(req.skipNotify, true);

  // Identical syncPortals call does NOT trigger redundant ensureDynamicLayoutsRegistered/ensureLayoutModelsReady churn
  const regsAfterFirst = registerCount;
  const getsAfterFirst = modelGetCount;
  manager.setPortals([{ ...portals[0] }]);
  assert.equal(registerCount, regsAfterFirst);
  assert.equal(modelGetCount, getsAfterFirst);

  // Changed metadata DOES sync
  manager.setPortals([{ ...portals[0], title: 'Cổng Dịch vụ v2' }]);
  assert.ok(modelGetCount > getsAfterFirst);
});
