/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {pageTree, hostPath, firstSettingsPath, createNativeBuilderNavigation} = require('../src/client/native-builder-navigation');
const {readFileSync} = require('node:fs');
const {runInNewContext} = require('node:vm');

test('projects host accessible groups/pages without catalog or external link destinations', () => {
  const routes = [{type: 'group', id: 8, title: 'Nhân sự', children: [
    {type: 'page', schemaUid: 'employees-v1', title: 'Nhân viên', sort: 2},
    {type: 'flowPage', schemaUid: 'departments_v2', title: 'Đơn vị', sort: 1},
    {type: 'link', title: 'External', options: {href: 'https://example.com'}},
    {type: 'tabs', schemaUid: 'tab', title: 'Tab'},
  ]}];
  const snapshot = JSON.stringify(routes);
  assert.deepEqual(pageTree(routes), [{key: 'group:8', title: 'Nhân sự', children: [
    {key: 'page:departments_v2', title: 'Đơn vị', path: '/admin/departments_v2'},
    {key: 'page:employees-v1', title: 'Nhân viên', path: '/admin/employees-v1'},
  ]}]);
  assert.equal(JSON.stringify(routes), snapshot);
});

test('hidden parents, hidden pages, empty groups and malformed UIDs are excluded', () => {
  const page = {type: 'flowPage', schemaUid: 'valid', title: 'Trang'};
  assert.deepEqual(pageTree([
    {...page, hidden: true}, {...page, hideInMenu: true},
    {type: 'group', id: 1, hidden: true, children: [page]},
    {type: 'group', id: 2, children: []},
    ...['../settings', '', 'https://other', null, '..', 'a/b', 'x?y'].map(schemaUid => ({...page, schemaUid})),
  ]), []);
  assert.deepEqual(pageTree(null), []);
});

test('search retains ancestor hierarchy and matches a group without flattening its pages', () => {
  const routes = [{type: 'group', id: 1, title: 'Nhân sự', children: [
    {type: 'page', schemaUid: 'a', title: 'Nhân viên'},
    {type: 'page', schemaUid: 'b', title: 'Đơn vị'},
  ]}];
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
    {isAllow: false, path: '/admin/settings/secrets'},
    {children: [{isAllow: false, path: '/admin/settings/no'}, {isAllow: true, path: '/admin/settings/users'}]},
  ]), '/admin/settings/users');
  assert.equal(firstSettingsPath([{path: 'https://example.com'}, {isAllow: false, children: [{path: '/admin/settings/no'}]}]), null);
});

function harness({allow = true, pathname = '/admin/demo', refresh = async () => {}, designable = false, runEffects = false} = {}) {
  let cursor = 0;
  const state = [], registered = [];
  let effects = [], cleanups = [];
  let nativeRenders = 0;
  const React = {
    createElement: (type, props, ...children) => ({type, props: props || {}, children}),
    useState(initial) {const index = cursor++; if (!(index in state)) state[index] = initial; return [state[index], value => {state[index] = value;}];},
    useRef(initial) {const index=cursor++; return state[index] || (state[index]={current:initial});},
    useEffect(effect) {if (runEffects) effects.push(effect);},
  };
  class NativeModel {
    render() {nativeRenders++; return 'native runtime shell';}
    syncMenuRoutes(routes) {this.syncedRoutes=routes;}
    setIsMobileLayout(value) {this.isMobileLayout=value;}
  }
  const client = {
    AdminProvider: 'AdminProvider', PinnedPluginList: 'NativeTools',
    useAllAccessDesktopRoutes: () => ({allAccessRoutes: [{type: 'flowPage', schemaUid: 'demo', title: 'Trang demo'}], refresh}),
    useUIConfigurationPermissions: () => ({allowConfigUI: allow}), useDesignable: () => ({designable}),
  };
  const app = {
    flowEngine: {getModelClass: () => NativeModel,
      flowSettings: {enabled:false, async enable() {this.enabled=true;}, async disable() {this.enabled=false;}}},
    router: {add: (name, route) => registered.push({name, ...route})},
    pluginSettingsManager: {getList: () => [{path: '/admin/settings/users'}], get: () => null},
  };
  let model;
  const clientV2 = {getAdminLayoutModel(engine, options) {model = new options.use(); return model;}};
  const router = {Link: 'Link', Outlet: 'Outlet', useLocation: () => ({pathname})};
  const Layout = createNativeBuilderNavigation(client, React, {Input: 'Input', Button: 'Button', Alert: 'Alert'}, app,
    {clientV2, router, flow: {FlowModelRenderer: 'FlowModelRenderer'}});
  const root = Layout({});
  const provider = model.render();
  const shell = provider.children[0];
  return {root, provider, registered, model, flowSettings:app.flowEngine.flowSettings,
    setAllow(value) {allow=value;}, get nativeRenders() {return nativeRenders;}, render() {
      cursor = 0;const ui=shell.type(shell.props);
      cleanups.forEach(cleanup=>cleanup());
      cleanups=effects.map(effect=>effect()).filter(value=>typeof value==='function');effects=[];
      return ui;
    }};
}

function find(node, predicate) {
  if (!node || typeof node !== 'object') return null;
  if (predicate(node)) return node;
  return node.children?.flat(Infinity).map(child => find(child, predicate)).find(Boolean) || null;
}

test('replaces the shell through native model lifecycle and has two header mode links, no drawer', () => {
  const setup = harness();
  assert.equal(setup.root.type, 'FlowModelRenderer');
  assert.equal(setup.provider.type, 'AdminProvider');
  const ui = setup.render();
  const header = find(ui, n => n.type === 'header');
  assert.equal(find(header, n => n.type === 'Link' && n.children[0] === 'Config').props.to, '/admin/settings/users');
  assert.equal(find(header, n => n.type === 'Link' && n.children[0] === 'Build UI').props.to, '/admin/lattice-builder');
  assert.equal(find(ui, n => n.type === 'Drawer'), null);
  assert.ok(find(ui, n => n.type === 'NativeTools'));
});

test('Build UI is a registered page; sidebar links use the host SPA router and main keeps its Outlet', () => {
  const setup = harness();
  assert.equal(setup.registered[0].name, 'admin.lattice-builder');
  assert.equal(setup.registered[0].path, '/admin/lattice-builder');
  const ui = setup.render();
  const sidebar = find(ui, n => n.type === 'aside');
  assert.equal(find(sidebar, n => n.type === 'Link' && n.children[0] === 'Trang demo').props.to, '/admin/demo');
  assert.ok(find(ui, n => n.type === 'Outlet'));
  assert.equal(find(ui, n => n.type === 'a'), null);
});

test('Config keeps native settings content without a duplicate page-tree sidebar', () => {
  const ui = harness({pathname: '/admin/settings/users'}).render();
  assert.equal(find(ui, n => n.type === 'aside'), null);
  assert.ok(find(ui, n => n.type === 'Outlet'));
  assert.equal(find(ui, n => n.type === 'Link' && n.children[0] === 'Config').props['aria-current'], 'page');
});

test('employees keep the native runtime shell and cannot use the builder landing page', () => {
  const setup = harness({allow: false});
  assert.equal(setup.render(), 'native runtime shell');
  assert.equal(setup.nativeRenders, 1);
  const landing = setup.registered[0].Component();
  assert.ok(find(landing, n => n.type === 'h1' && n.children[0] === 'Không có quyền truy cập'));
});

test('unsupported SDK does not register routes or replace the native layout', () => {
  assert.equal(createNativeBuilderNavigation({}, {}, {}, {}), null);
});

test('switching from builder to employee disables design mode even after enable has settled', async t => {
  const previous=global.window;
  global.window={matchMedia:()=>({matches:false,addEventListener() {},removeEventListener() {}})};
  t.after(()=>{global.window=previous;});
  const setup=harness({allow:true,designable:true,runEffects:true});
  setup.render();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(setup.flowSettings.enabled,true);
  setup.setAllow(false);setup.render();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(setup.flowSettings.enabled,false);
});

test('employee native model keeps accessible menu routes and reacts to mobile layout changes', async t => {
  const previous=global.window, listeners=new Set();
  const media={matches:false,addEventListener(event,listener) {listeners.add(listener);},removeEventListener(event,listener) {listeners.delete(listener);}};
  global.window={matchMedia:()=>media};
  t.after(()=>{global.window=previous;});
  const setup=harness({allow:false,runEffects:true});
  setup.render();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(setup.model.syncedRoutes?.[0]?.schemaUid,'demo');
  assert.equal(setup.model.isMobileLayout,false);
  media.matches=true;listeners.forEach(listener=>listener());
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(setup.model.isMobileLayout,true);
  assert.equal(setup.flowSettings.enabled,false);
});

test('failed refresh hides stale page links and recovers on retry', async () => {
  let attempts = 0;
  const setup = harness({refresh: async () => {if (++attempts === 1) throw new Error('403');}});
  await find(setup.render(), n => n.type === 'Button').props.onClick();
  const failed = setup.render();
  assert.ok(find(failed, n => n.type === 'Alert'));
  assert.equal(find(failed, n => n.type === 'Link' && n.children[0] === 'Trang demo'), null);
  await find(failed, n => n.type === 'Button').props.onClick();
  assert.ok(find(setup.render(), n => n.type === 'Link' && n.children[0] === 'Trang demo'));
});

test('built AMD entry registers the replacement layout and builder route when host SDK is available', async () => {
  let factory;
  const define = (name, deps, value) => {factory = value;};
  define.amd = {};
  runInNewContext(readFileSync(require.resolve('../dist/client/index.js'), 'utf8'), {
    define, window: {location: {hostname: 'localhost', pathname: '/admin'}}, sessionStorage: {getItem: () => null},
  });
  class NativeModel {render() {return null;}}
  class BlockModel {static define() {} static registerFlow() {}}
  const client = {Plugin: class {}, AdminProvider() {}, useAllAccessDesktopRoutes() {}, useUIConfigurationPermissions() {}, useDesignable() {}};
  const routes = [], components = {};
  const app = {
    flowEngine: {getModelClass: name => name === 'AdminLayoutModel' ? NativeModel : undefined},
    router: {add: (name, route) => routes.push({name, ...route})},
    addComponents: value => Object.assign(components, value), addScopes() {}, use() {},
    schemaInitializerManager: {get: () => ({add() {}})},
  };
  const v2 = {BlockModel, getAdminLayoutModel() {}};
  const mod = factory(client, {}, {}, v2, {Link() {}, Outlet() {}, useLocation() {}}, {FlowModelRenderer: {$$typeof: Symbol.for('react.memo')}});
  const plugin = new mod.default();
  plugin.app = app; plugin.flowEngine = {registerModels() {}};
  await plugin.load();
  assert.equal(typeof components.AdminLayout, 'function');
  assert.ok(routes.some(route => route.name === 'admin.lattice-builder' && route.path === '/admin/lattice-builder'));
});
