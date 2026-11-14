/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';
const {createNativeWorkspace, workspacePages, WORKSPACE_PATH}=require('./native-workspace');

// Input must be the host's accessible route tree, never the legacy app catalog.
function pageTree(routes, query = '') {
  const needle = String(query).trim().toLocaleLowerCase('vi');
  function visit(items, ancestorMatches = false, lab = false) {
    return (Array.isArray(items) ? items : [])
      .filter(route => route && !route.hidden && !route.hideInMenu)
      .map((route, index) => ({route, index}))
      .sort((a, b) => (Number(a.route.sort) || 0) - (Number(b.route.sort) || 0) || a.index - b.index)
      .flatMap(({route}) => {
        const title = typeof route.title === 'string' && route.title.trim() ? route.title : 'Chưa đặt tên';
        const matches = ancestorMatches || !needle || title.toLocaleLowerCase('vi').includes(needle);
        if (route.type === 'group') {
          const children = visit(route.children, matches, lab);
          return children.length ? [{key: 'group:' + String(route.id ?? route.schemaUid), title, children}] : [];
        }
        if (!['page', 'flowPage'].includes(route.type) || typeof route.schemaUid !== 'string' ||
            !/^[a-zA-Z0-9_-]+$/.test(route.schemaUid) || !matches ||
            (route.options?.workspace?.lab === true) !== lab) return [];
        return [{key: 'page:' + route.schemaUid, title, path: '/admin/' + route.schemaUid}];
      });
  }
  const tree = visit(routes);
  const lab = visit(routes, 'kiểm thử'.includes(needle), true);
  return lab.length ? [...tree, {key:'lab', title:'Kiểm thử', children:lab}] : tree;
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

function createNativeBuilderNavigation(client, React, antd, app, {clientV2, router, flow, BrandLogo} = {}) {
  // Only replace the registered shell when all required public SDKs exist.
  if (!clientV2 || !router || !flow || !app.flowEngine ||
      ![client.useAllAccessDesktopRoutes, client.useUIConfigurationPermissions,
        client.useDesignable, clientV2.getAdminLayoutModel, router.useLocation].every(value => typeof value === 'function') ||
      !client.AdminProvider || !flow.FlowModelRenderer || !router.Link || !router.Outlet) return null;
  const NativeModel = app.flowEngine.getModelClass('AdminLayoutModel');
  if (!NativeModel || typeof NativeModel.prototype.render !== 'function') return null;
  const h = React.createElement;
  const workspace = createNativeWorkspace(client, React, antd, app, router, BrandLogo);

  function QuickCreateSettings({route, refresh}) {
    const api = client.useAPIClient();
    const configuration = route.options?.workspace?.quickCreate;
    const [pageUid, setPageUid] = React.useState(configuration?.pageUid);
    const [label, setLabel] = React.useState(configuration?.label ?? '');
    const [collection, setCollection] = React.useState(configuration?.collection ?? '');
    const [saving, setSaving] = React.useState(false);
    const [message, setMessage] = React.useState(null);
    const pages = workspacePages([route]).filter(page => page.section !== 'reports')
      .map(page => ({label:page.title, value:page.path.slice('/admin/'.length)}));
    const valid = pages.some(page => page.value === pageUid) && label.trim() && /^[a-zA-Z0-9_]+$/.test(collection.trim());
    async function save(remove) {
      if (saving || (!remove && !valid)) return;
      setSaving(true); setMessage(null);
      try {
        const params = {filterByTk:route.id};
        const response = await api.request({url:'desktopRoutes:get', method:'get', params});
        const current = response.data?.data;
        if (!current || String(current.id) !== String(route.id)) throw new Error('Route unavailable');
        const options = {...current.options, workspace:{...current.options?.workspace}};
        if (remove) delete options.workspace.quickCreate;
        else options.workspace.quickCreate = {pageUid, label:label.trim(), collection:collection.trim()};
        await api.request({url:'desktopRoutes:update', method:'post', params, data:{options}});
        if (remove) {setPageUid(undefined); setLabel(''); setCollection('');}
        try {await refresh();}
        catch {setMessage({type:'warning', text:'Đã lưu. Hãy tải lại trang để cập nhật danh mục.'}); return;}
        setMessage({type:'success', text:remove ? 'Đã gỡ nút tạo nhanh.' : 'Đã lưu nút tạo nhanh.'});
      } catch {
        setMessage({type:'error', text:'Không lưu được cấu hình. Kiểm tra quyền sửa menu và thử lại.'});
      } finally {setSaving(false);}
    }
    const field = (name, control) => h('label', {style:{display:'grid', gap:4, marginBottom:12}}, name, control);
    return h('form', {onSubmit:event => {event.preventDefault(); save(false);}, style:{marginTop:16}},
      field('Trang chứa form tạo', h(antd.Select, {'aria-label':'Trang chứa form tạo', options:pages, value:pageUid, onChange:setPageUid, disabled:saving})),
      field('Tên nút', h(antd.Input, {value:label, maxLength:60, onChange:event=>setLabel(event.target.value), disabled:saving})),
      field('Tên kỹ thuật của collection', h(antd.Input, {value:collection, onChange:event=>setCollection(event.target.value), disabled:saving})),
      h(antd.Space, null,
        h(antd.Button, {type:'primary', htmlType:'submit', disabled:!valid, loading:saving}, 'Lưu nút tạo nhanh'),
        configuration ? h(antd.Button, {disabled:saving, onClick:()=>save(true)}, 'Gỡ nút') : null),
      message ? h(antd.Alert, {type:message.type, message:message.text, style:{marginTop:12}}) : null);
  }

  function BuilderLanding() {
    const {allowConfigUI} = client.useUIConfigurationPermissions();
    const {allAccessRoutes, refresh} = client.useAllAccessDesktopRoutes();
    const [selected, setSelected] = React.useState(undefined);
    const apps = (allAccessRoutes ?? []).filter(route => route?.id != null &&
      workspacePages([route]).some(page => page.section !== 'reports'));
    const route = apps.find(item => item.id === selected);
    return h('section', {style: {padding: 32}}, h('h1', null, allowConfigUI ? 'Build UI' : 'Không có quyền truy cập'),
      h('p', null, allowConfigUI ? 'Chọn một trang trong cây bên trái để thiết kế giao diện.' : 'Trang này dành cho builder có quyền thiết kế giao diện.'),
      allowConfigUI && workspace ? h(antd.Card, {title:'Nút tạo nhanh trên Workspace', style:{maxWidth:520, marginTop:20}},
        h(antd.Select, {'aria-label':'Ứng dụng cần cấu hình', placeholder:'Chọn ứng dụng', style:{width:'100%'},
          value:selected, onChange:setSelected, options:apps.map(item=>({value:item.id,label:item.title}))}),
        route ? h(QuickCreateSettings, {key:route.id, route, refresh}) : null) : null);
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
    const workspaceMode = pathname === WORKSPACE_PATH || pathname.startsWith(WORKSPACE_PATH + '/popups/');
    React.useEffect(() => {mounted.current = true; return () => {mounted.current = false;};}, []);
    React.useEffect(() => {
      if (allowConfigUI && !configMode && !workspaceMode) lastPage.current = pathname;
    }, [allowConfigUI, configMode, workspaceMode, pathname]);
    React.useEffect(() => {
      // Native page/popup models need these routes even when our employee
      // shell replaces the host menu. The input remains the accessible tree.
      model.syncMenuRoutes(allAccessRoutes);
    }, [allAccessRoutes, model]);
    React.useEffect(() => {
      const media = window.matchMedia('(max-width: 767px)');
      const apply = () => {
        model.setIsMobileLayout(media.matches);
        desiredSettings.current = !!allowConfigUI && !!designable && !configMode && !workspaceMode && !media.matches;
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
    }, [allowConfigUI, designable, configMode, workspaceMode, model]);

    // Runtime employees use Workspace while retaining native pages and permission checks.
    if (!allowConfigUI) return workspace ? h(workspace.Shell, {model}) : NativeModel.prototype.render.call(model);
    if (workspaceMode && workspace) return h(workspace.Shell, {model, studioPath:lastPage.current});
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
          ? h('details', {key:node.key + Boolean(query), open: node.key !== 'lab' || !!query || undefined},
            h('summary', {style: {cursor: 'pointer', padding: '8px 0', fontWeight:600}}, node.title), renderTree(node.children))
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
        h('div', {style: {display: 'flex', alignItems: 'center', gap: 10}},
          BrandLogo ? h(BrandLogo, {size: 32}) : null,
          h('strong', {style: {fontSize: 22}}, 'LatticeDX')),
        h('nav', {'aria-label': 'Chế độ Studio', style: {display: 'flex', alignItems: 'center', gap: 8}},
          modeLink('Config', settingsPath, configMode), modeLink('Build UI', lastPage.current, !configMode)),
        h('div', {style: {marginLeft: 'auto'}}, client.PinnedPluginList ? h(client.PinnedPluginList) : null)),
      h('div', {style: {display: 'flex', flex: 1, minHeight: 0}},
        !configMode ? h('aside', {style: {width: 260, minWidth: 200, maxWidth: '40vw', borderRight: '1px solid #dce3ed', background:'#f5f7fb', padding: 16, overflow: 'auto'}},
          h('h2', {style: {fontSize: 16, marginTop: 0}}, 'Ứng dụng và trang'),
          h(antd.Input, {value: query, placeholder: 'Tìm ứng dụng hoặc trang…', 'aria-label': 'Tìm nhóm hoặc trang', allowClear: true,
            onChange: event => setQuery(event.target.value)}),
          h(antd.Button, {onClick: refreshRoutes, loading: busy, style: {marginTop: 12}}, 'Cập nhật'),
          error ? h(antd.Alert, {type: 'error', message: error, showIcon: true, style: {marginTop: 12}})
            : tree.length ? h('nav', {'aria-label': 'Cây nhóm trang native'}, renderTree(tree))
              : h('p', {role: 'status'}, query ? 'Không có trang phù hợp.' : 'Chưa có trang hiển thị được cấp quyền.'),
          workspace ? h(router.Link, {to: BUILDER_PATH, style:{display:'block', marginTop:16}}, 'Cấu hình nút tạo nhanh') : null,
          settingsPages ? h(router.Link, {to: settingsPages.path, style: {display: 'block', marginTop: 12}}, 'Quản lý nhóm và trang') : null) : null,
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
