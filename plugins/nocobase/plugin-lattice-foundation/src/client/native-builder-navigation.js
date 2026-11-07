// SPDX-License-Identifier: Apache-2.0
'use strict';
const {createNativeWorkspace}=require('./native-workspace');

// Input must be the host's accessible route tree, never the legacy app catalog.
function pageTree(routes, query = '') {
  const needle = String(query).trim().toLocaleLowerCase('vi');
  function visit(items, ancestorMatches = false) {
    return (Array.isArray(items) ? items : [])
      .filter(route => route && !route.hidden && !route.hideInMenu)
      .map((route, index) => ({route, index}))
      .sort((a, b) => (Number(a.route.sort) || 0) - (Number(b.route.sort) || 0) || a.index - b.index)
      .flatMap(({route}) => {
        const title = typeof route.title === 'string' && route.title.trim() ? route.title : 'Chưa đặt tên';
        const matches = ancestorMatches || !needle || title.toLocaleLowerCase('vi').includes(needle);
        if (route.type === 'group') {
          const children = visit(route.children, matches);
          return children.length ? [{key: 'group:' + String(route.id ?? route.schemaUid), title, children}] : [];
        }
        if (!['page', 'flowPage'].includes(route.type) || typeof route.schemaUid !== 'string' ||
            !/^[a-zA-Z0-9_-]+$/.test(route.schemaUid) || !matches) return [];
        return [{key: 'page:' + route.schemaUid, title, path: '/admin/' + route.schemaUid}];
      });
  }
  return visit(routes);
}

function hostPath(basename, path) {
  // Only generate internal native destinations; no route-supplied URLs/links.
  if (typeof path !== 'string' || !/^\/admin(?:\/|$)/.test(path) || /[?#\\]/.test(path) || path.includes('..')) return null;
  const base = typeof basename === 'string' ? basename.replace(/\/$/, '') : '';
  if (base && (!/^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+$/.test(base))) return null;
  return (base === '/' ? '' : base) + path;
}

function firstSettingsPath(items) {
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || item.isAllow === false) continue;
    if (item.children?.length) {
      const child = firstSettingsPath(item.children);
      if (child) return child;
    } else if (hostPath('', item.path)) return item.path;
  }
  return null;
}

const BUILDER_PATH = '/admin/lattice-builder';

function createNativeBuilderNavigation(client, React, antd, app, {clientV2, router, flow} = {}) {
  // Only replace the registered shell when all required public SDKs exist.
  if (!clientV2 || !router || !flow || !app.flowEngine ||
      ![client.useAllAccessDesktopRoutes, client.useUIConfigurationPermissions,
        client.useDesignable, clientV2.getAdminLayoutModel, router.useLocation].every(value => typeof value === 'function') ||
      !client.AdminProvider || !flow.FlowModelRenderer || !router.Link || !router.Outlet) return null;
  const NativeModel = app.flowEngine.getModelClass('AdminLayoutModel');
  if (!NativeModel || typeof NativeModel.prototype.render !== 'function') return null;
  const h = React.createElement;
  const workspace = createNativeWorkspace(client, React, antd, app, router);

  function BuilderLanding() {
    const {allowConfigUI} = client.useUIConfigurationPermissions();
    return h('section', {style: {padding: 32}}, h('h1', null, allowConfigUI ? 'Build UI' : 'Không có quyền truy cập'),
      h('p', null, allowConfigUI ? 'Chọn một trang trong cây bên trái để thiết kế giao diện.' : 'Trang này dành cho builder có quyền thiết kế giao diện.'));
  }
  app.router.add('admin.lattice-builder', {path: BUILDER_PATH, Component: BuilderLanding});

  function BuilderShell({model}) {
    const {allowConfigUI} = client.useUIConfigurationPermissions();
    const {allAccessRoutes, refresh} = client.useAllAccessDesktopRoutes();
    const {designable} = client.useDesignable();
    const {pathname} = router.useLocation();
    const [query, setQuery] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState('');
    const [flowError, setFlowError] = React.useState('');
    const mounted = React.useRef(true);
    const lastPage = React.useRef(BUILDER_PATH);
    const desiredSettings = React.useRef(false);
    const syncing = React.useRef(Promise.resolve());
    const configMode = /^\/admin\/settings(?:\/|$)/.test(pathname);
    React.useEffect(() => {mounted.current = true; return () => {mounted.current = false;};}, []);
    React.useEffect(() => {
      if (allowConfigUI && !configMode) lastPage.current = pathname;
    }, [allowConfigUI, configMode, pathname]);
    React.useEffect(() => {
      if (!allowConfigUI) return;
      model.syncMenuRoutes(allAccessRoutes);
    }, [allowConfigUI, allAccessRoutes, model]);
    React.useEffect(() => {
      if (!allowConfigUI) {desiredSettings.current = false; return;}
      const media = window.matchMedia('(max-width: 767px)');
      const apply = () => {
        model.setIsMobileLayout(media.matches);
        desiredSettings.current = !!designable && !configMode && !media.matches;
        // Serialize async host enable/disable so an older route cannot win a race.
        syncing.current = syncing.current.catch(() => {}).then(async () => {
          const enabled = desiredSettings.current;
          if (enabled) await app.flowEngine.flowSettings.enable();
          else await app.flowEngine.flowSettings.disable();
          if (enabled !== desiredSettings.current) {
            if (desiredSettings.current) await app.flowEngine.flowSettings.enable();
            else await app.flowEngine.flowSettings.disable();
          }
          if (mounted.current) setFlowError('');
        }).catch(() => {if (mounted.current) setFlowError('Không bật được công cụ thiết kế. Vui lòng tải lại trang.');});
      };
      apply(); media.addEventListener('change', apply);
      return () => {desiredSettings.current = false; media.removeEventListener('change', apply);};
    }, [allowConfigUI, designable, configMode, model]);

    // Runtime employees use Workspace while retaining native pages and permission checks.
    if (!allowConfigUI) return workspace ? h(workspace.Shell, {model}) : NativeModel.prototype.render.call(model);
    const settingsPath = firstSettingsPath(app.pluginSettingsManager?.getList(true));
    const settingsPages = app.pluginSettingsManager?.get('routes.desktop', true);
    const tree = pageTree(allAccessRoutes, query);
    async function refreshRoutes() {
      if (busy) return;
      setBusy(true); setError('');
      try {await refresh();}
      catch {if (mounted.current) setError('Không cập nhật được danh sách trang. Vui lòng thử lại.');}
      finally {if (mounted.current) setBusy(false);}
    }
    function renderTree(nodes) {
      return h('ul', {style: {listStyle: 'none', paddingLeft: 12}}, nodes.map(node => h('li', {key: node.key},
        node.children
          ? h('details', {open: true}, h('summary', {style: {cursor: 'pointer', padding: '8px 0'}}, node.title), renderTree(node.children))
          : h(router.Link, {to: node.path, 'aria-current': pathname === node.path ? 'page' : undefined,
            style: {display: 'block', padding: '8px 10px', borderRadius: 6,
              background: pathname === node.path ? '#e6f4ff' : undefined}}, node.title))));
    }
    const modeLink = (title, to, active) => to ? h(router.Link, {to, 'aria-current': active ? 'page' : undefined,
      style: {color: active ? '#fff' : '#cbd5e1', padding: '8px 16px', borderRadius: 6,
        background: active ? '#1d4ed8' : 'transparent', textDecoration: 'none', fontWeight: 600}}, title)
      : h('span', {'aria-disabled': true, style: {opacity: 0.5}}, title);
    return h('div', {style: {height: '100dvh', display: 'flex', flexDirection: 'column', '--nb-header-height': '56px'}},
      h('header', {style: {height: 56, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 24, padding: '0 20px', background: '#001529', color: '#fff'}},
        h('strong', {style: {fontSize: 22}}, 'LatticeDX'),
        h('nav', {'aria-label': 'Chế độ Studio', style: {display: 'flex', alignItems: 'center', gap: 8}},
          modeLink('Config', settingsPath, configMode), modeLink('Build UI', lastPage.current, !configMode)),
        h('div', {style: {marginLeft: 'auto'}}, client.PinnedPluginList ? h(client.PinnedPluginList) : null)),
      h('div', {style: {display: 'flex', flex: 1, minHeight: 0}},
        !configMode ? h('aside', {style: {width: 260, minWidth: 200, maxWidth: '40vw', borderRight: '1px solid #e5e7eb', padding: 16, overflow: 'auto'}},
          h('h2', {style: {fontSize: 16, marginTop: 0}}, 'Nhóm trang'),
          h(antd.Input, {value: query, placeholder: 'Tìm nhóm hoặc trang…', 'aria-label': 'Tìm nhóm hoặc trang', allowClear: true,
            onChange: event => setQuery(event.target.value)}),
          h(antd.Button, {onClick: refreshRoutes, loading: busy, style: {marginTop: 12}}, 'Cập nhật'),
          error ? h(antd.Alert, {type: 'error', message: error, showIcon: true, style: {marginTop: 12}})
            : tree.length ? h('nav', {'aria-label': 'Cây nhóm trang native'}, renderTree(tree))
              : h('p', {role: 'status'}, query ? 'Không có trang phù hợp.' : 'Chưa có trang hiển thị được cấp quyền.'),
          settingsPages ? h(router.Link, {to: settingsPages.path, style: {display: 'block', marginTop: 16}}, 'Quản lý nhóm và trang') : null) : null,
        h('main', {className: 'nb-subpages-slot-without-header-and-side',
          ref: element => model.setLayoutContentElement(element), style: {flex: 1, minWidth: 0, overflow: 'auto', position: 'relative'}},
          flowError ? h(antd.Alert, {type: 'error', message: flowError, showIcon: true}) : null,
          h(router.Outlet))));
  }
  class BuilderLayoutModel extends NativeModel {
    render() {return h(client.AdminProvider, null, h(BuilderShell, {model: this}));}
  }
  function BuilderAdminLayout(props) {
    const model = clientV2.getAdminLayoutModel(app.flowEngine, {create: true, props, use: BuilderLayoutModel});
    return h(flow.FlowModelRenderer, {model});
  }
  return BuilderAdminLayout;
}

module.exports = {pageTree, hostPath, firstSettingsPath, createNativeBuilderNavigation, BUILDER_PATH};
