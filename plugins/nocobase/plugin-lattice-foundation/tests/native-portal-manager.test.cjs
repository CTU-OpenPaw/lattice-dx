/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
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
