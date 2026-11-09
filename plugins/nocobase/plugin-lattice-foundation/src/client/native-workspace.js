// SPDX-License-Identifier: Apache-2.0
'use strict';

const WORKSPACE_PATH = '/admin/lattice-workspace';

function workspaceFailure(error) {
  const status = Number(error?.response?.status ?? error?.status);
  if (status === 401) return {signIn: true, message: 'Phiên đăng nhập đã hết hạn. Anh/chị vui lòng đăng nhập lại.'};
  if (status === 403) return {message: 'Tài khoản hiện không có quyền tải nội dung này. Vui lòng kiểm tra quyền với quản trị viên.'};
  return {message: 'Chưa tải được nội dung. Vui lòng kiểm tra kết nối và thử lại.'};
}

function workspacePages(routes, inheritedSection) {
  return (Array.isArray(routes) ? routes : []).slice()
    .sort((a, b) => (Number(a?.sort) || 0) - (Number(b?.sort) || 0)).flatMap(route => {
    if (!route || route.hidden || route.hideInMenu) return [];
    const section = route.options?.workspace?.section ?? inheritedSection;
    if (route.type === 'group') return workspacePages(route.children, section);
    if (!['page', 'flowPage'].includes(route.type) || typeof route.schemaUid !== 'string' ||
        !/^[a-zA-Z0-9_-]+$/.test(route.schemaUid)) return [];
    return [{ id: route.id, title: typeof route.title === 'string' && route.title.trim() ? route.title : 'Chưa đặt tên', path: '/admin/' + route.schemaUid, section }];
  });
}

function createNativeWorkspace(client, React, antd, app, router) {
  if (![client.useAPIClient, client.useAllAccessDesktopRoutes, router?.useLocation, router?.useNavigate]
    .every(value => typeof value === 'function') || !client.SchemaComponent || !client.PagePopups) return null;
  const h = React.createElement;
  const roleNames = {
    ldx_employee: 'Nhân viên', ldx_manager: 'Quản lý', ldx_warehouse: 'Kho',
    ldx_dispatcher: 'Điều phối', ldx_driver: 'Tài xế', ldx_director: 'Giám đốc',
    ldx_admin: 'Admin nghiệp vụ', root: 'Quản trị nền tảng',
  };
  const todoSchema = {
    type: 'void',
    properties: {
      nativeTasks: {
        type: 'void', 'x-decorator': 'WorkflowTodo.Decorator',
        'x-component': 'CardItem', 'x-component-props': { title: 'Công việc được giao' },
        properties: { todos: { type: 'void', 'x-component': 'WorkspaceNativeTasks' } },
      },
    },
  };
  const css = `
    .ldx-native-workspace {height:100dvh;display:flex;flex-direction:column;background:#f6f8fc;color:#152238}
    .ldx-native-header {height:60px;flex-shrink:0;display:flex;align-items:center;gap:16px;padding:0 20px;background:white;border-bottom:1px solid #dfe5ed}
    .ldx-native-header a {text-decoration:none}
    .ldx-native-header .anticon {color:#34465e}
    .ldx-native-brand {font-size:21px;font-weight:750;color:#142844;white-space:nowrap}
    .ldx-native-body {display:flex;flex:1;min-height:0}
    .ldx-native-sidebar {width:224px;flex-shrink:0;border-right:1px solid #dfe5ed;padding:18px 12px;overflow:auto;background:#f0f4fa}
    .ldx-native-sidebar a {display:block;padding:11px 14px;border-radius:7px;color:#283a52;text-decoration:none;margin-bottom:5px}
    .ldx-native-sidebar a[aria-current=page] {background:#dce9ff;color:#155ac0;font-weight:600}
    .ldx-native-content {flex:1;min-width:0;overflow:auto;position:relative}
    .ldx-native-page {padding:24px;max-width:1440px;margin:0 auto}
    .ldx-native-cards {display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px;margin:16px 0 24px}
    .ldx-native-card {display:block;border:1px solid #dce3ed;border-radius:9px;padding:16px;background:white;color:#20314b;text-decoration:none}
    .ldx-native-card:hover {border-color:#1677ff}
    .ldx-native-search {width:min(360px,35vw)}
    .ldx-native-search .ant-input {color:#152238}
    .ldx-native-search .ant-input::placeholder {color:#66758a}
    .ldx-native-toolbar {display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:16px 0}
    .ldx-native-catalog-search {display:flex;gap:8px;flex:1;max-width:520px;min-width:0}
    .ldx-native-catalog-search .ant-input-affix-wrapper {min-width:0}
    .ldx-native-catalog-search .ant-input::placeholder {color:#66758a}
    .ldx-native-shortcut-heading {display:flex;gap:12px;flex-wrap:wrap;justify-content:space-between;align-items:center}
    .ldx-native-card strong {overflow-wrap:anywhere}
    .ldx-native-header a:focus-visible,.ldx-native-sidebar a:focus-visible,.ldx-native-card:focus-visible {outline:2px solid #155ac0;outline-offset:3px}
    .ldx-native-update {color:#52657d;font-size:13px}
    .ldx-native-tools {flex-shrink:0}
    .ldx-native-backdrop {display:none}
    .ldx-native-toggle {display:none}
    @media(max-width:767px) {
      .ldx-native-toggle {display:inline-block}
      .ldx-native-header {padding:0 10px;gap:6px}
      .ldx-native-brand {font-size:17px}
      .ldx-native-tools {margin-left:auto}
      .ldx-native-search {display:none}
      .ldx-native-role {display:none}
      .ldx-native-sidebar {display:none}
      .ldx-native-body {position:relative}
      .ldx-native-backdrop {display:block;position:absolute;inset:0;z-index:99;background:#15223855;border:0}
      .ldx-native-sidebar.is-open {display:block;position:absolute;top:0;bottom:0;z-index:100;background:#f0f4fa;box-shadow:3px 0 12px #0002}
      .ldx-native-page {padding:16px}
      .ldx-native-catalog-search {flex-basis:100%}
    }
    @media(max-width:479px) {
      .ldx-native-label {display:none}
      .ldx-native-header {padding:0 8px;gap:4px}
      .ldx-native-brand {font-size:15px}
      .ldx-native-toggle {width:32px;min-width:32px;padding:0;flex-shrink:0}
    }
  `;

  function Failure({error, retry, busy}) {
    const failure = workspaceFailure(error);
    return h(antd.Alert, {type:'error', message: failure.message, showIcon:true,
      action: failure.signIn
        ? h(router.Link, {to:'/signin?redirect=' + encodeURIComponent(WORKSPACE_PATH)}, 'Đăng nhập lại')
        : h(antd.Button, {onClick:retry, loading:busy, disabled:busy}, 'Thử lại')});
  }

  // Keep the host list provider, request, filter, popup and submit actions.
  // Only its presentation of a failed/empty read is adapted here.
  function NativeTasks({view}) {
    const {service} = typeof client.useListBlockContext === 'function' ? client.useListBlockContext() || {} : {};
    const retry = async () => {
      try { await (service.refreshAsync ? service.refreshAsync() : service.refresh()); }
      catch { /* The native request service exposes its error on the next render. */ }
    };
    if (service?.error && !service.loading) return h(Failure, {error:service.error, retry, busy:false});
    const nativeList = h(client.SchemaComponent, {schema: {type:'void', properties: {
      nativeTodo: {type:'void', 'x-component':'WorkflowTodo'},
    }}});
    return h('div', {'aria-busy':Boolean(service?.loading)},
      service?.loading ? h('p', {role:'status'}, 'Đang tải công việc…') : null,
      antd.ConfigProvider ? h(antd.ConfigProvider, {renderEmpty:() => service?.loading ? null : h(antd.Empty, {
        description:view === 'completed' ? 'Chưa có công việc đã xử lý.' : 'Hiện không có công việc cần xử lý.',
      })}, nativeList) : nativeList);
  }

  function pageCards(pages) {
    return h('div', { className: 'ldx-native-cards' }, pages.map(page =>
      h(router.Link, { key: page.path, to: page.path, className: 'ldx-native-card' },
        h('strong', null, page.title), h('div', { style: { marginTop: 10 } }, 'Mở trang →'))));
  }

  function Landing() {
    const { allAccessRoutes, refresh } = client.useAllAccessDesktopRoutes();
    const { search } = router.useLocation();
    const navigate = router.useNavigate();
    const params = new URLSearchParams(search);
    const view = params.get('view');
    const query = (params.get('q') || '').trim().toLocaleLowerCase('vi');
    const [taskView, setTaskView] = React.useState('pending');
    const [busy, setBusy] = React.useState(true);
    const [error, setError] = React.useState(null);
    const [updated, setUpdated] = React.useState('');
    const [term, setTerm] = React.useState(params.get('q') || '');
    const request = React.useRef({busy:false, mounted:true});
    React.useEffect(() => {request.current.mounted = true; return () => {request.current.mounted = false;};}, []);
    React.useEffect(() => {setTerm(params.get('q') || '');}, [search]);
    const pages = workspacePages(allAccessRoutes).filter(page =>
      page.title.toLocaleLowerCase('vi').includes(query) && (view !== 'reports' || page.section === 'reports'));
    const catalog = view === 'apps' || view === 'reports';
    async function reload() {
      if (request.current.busy) return;
      request.current.busy = true;
      setBusy(true); setError(null); setUpdated('');
      try {
        await refresh();
        if (request.current.mounted) setUpdated(new Date().toLocaleTimeString('vi-VN'));
      }
      catch (failure) {if (request.current.mounted) setError(failure);}
      finally {request.current.busy = false; if (request.current.mounted) setBusy(false);}
    }
    // The host provider swallows its initial read failure. Verify this read
    // explicitly so an unavailable route service is not labelled as no access.
    React.useEffect(() => {reload();}, [refresh]);
    const catalogPath = WORKSPACE_PATH + '?view=' + (view === 'reports' ? 'reports' : 'apps');
    const clearSearch = () => {setTerm(''); navigate(catalogPath);};
    const cards = busy ? h('p', {role:'status'}, 'Đang cập nhật danh sách trang…')
      : error ? null : pages.length ? pageCards(catalog ? pages : pages.slice(0, 3))
      : h(antd.Empty, {description:query ? 'Không tìm thấy trang phù hợp.'
        : view === 'reports' ? 'Chưa có trang báo cáo được cấp quyền.' : 'Chưa có trang nghiệp vụ được cấp quyền.'},
        query ? h(antd.Button, {onClick:clearSearch}, 'Xóa tìm kiếm') : null);
    return h('section', { className: 'ldx-native-page' },
      h('h1', null, view === 'reports' ? 'Báo cáo' : catalog ? 'Ứng dụng' : 'Công việc của tôi'),
      error ? h(Failure, {error, retry:reload, busy}) : null,
      catalog ? h(React.Fragment, null,
        h('div', {className:'ldx-native-toolbar'},
          h('form', {className:'ldx-native-catalog-search', role:'search', 'aria-label':'Tìm trong danh sách trang', onSubmit:event => {
            event.preventDefault(); navigate(catalogPath + (term.trim() ? '&q=' + encodeURIComponent(term.trim()) : ''));
          }},
            h(antd.Input, {'aria-label':'Tên trang cần tìm', placeholder:'Nhập tên trang…', value:term,
              onChange:event => setTerm(event.target.value)}),
            h(antd.Button, {htmlType:'submit'}, 'Tìm')),
          h(antd.Button, {onClick:reload, loading:busy, disabled:busy}, 'Cập nhật danh sách')),
        cards)
        : h(React.Fragment, null,
          h('div', {className:'ldx-native-shortcut-heading'},
            h('h2', { style: { fontSize: 17 } }, 'Lối tắt trang'),
            h(router.Link, { to: WORKSPACE_PATH + '?view=apps' }, 'Xem tất cả ứng dụng'),
            h(antd.Button, {onClick:reload, loading:busy, disabled:busy}, 'Cập nhật lối tắt')),
          cards,
          h(antd.Tabs, { activeKey: taskView, onChange: setTaskView, items: [
            { key: 'pending', label: 'Cần xử lý' },
            { key: 'completed', label: 'Đã xử lý' },
          ] }),
          h(client.SchemaComponent, { key: taskView, components:{WorkspaceNativeTasks:NativeTasks}, schema: { ...todoSchema, name: 'workspaceTasks_' + taskView, properties: { [taskView]: {
            ...todoSchema.properties.nativeTasks,
            properties:{todos:{...todoSchema.properties.nativeTasks.properties.todos, 'x-component-props':{view:taskView}}},
            'x-decorator-props': { params: { filter: taskView === 'pending'
              ? { status: 0, 'execution.status': 0 } : { status: [1, -3, -5] } } },
          } } } })),
      h('p', {role:'status', className:'ldx-native-update'}, !busy && !error
        ? (catalog ? 'Có ' + pages.length + ' trang phù hợp. ' : '') + (updated ? 'Đã cập nhật danh sách trang lúc ' + updated : '') : ''),
      h(router.Outlet));
  }
  app.router.add('admin.lattice-workspace', { path: WORKSPACE_PATH, Component: Landing });
  app.router.add('admin.lattice-workspace.popups', { path: WORKSPACE_PATH + '/popups/*', Component: client.PagePopups });

  function Shell({ model }) {
    const api = client.useAPIClient();
    const { allAccessRoutes } = client.useAllAccessDesktopRoutes();
    const { pathname, search } = router.useLocation();
    const navigate = router.useNavigate();
    const [query, setQuery] = React.useState('');
    const [open, setOpen] = React.useState(false);
    const toggle = React.useRef(null);
    const pages = workspacePages(allAccessRoutes);
    const hasReports = pages.some(page => page.section === 'reports');
    const params = new URLSearchParams(search);
    const mode = pathname === WORKSPACE_PATH || pathname.startsWith(WORKSPACE_PATH + '/popups/') ? params.get('view') || 'tasks' : 'page';
    const current = pages.find(page => page.path === pathname || pathname.startsWith(page.path + '/'));
    React.useEffect(() => {
      setOpen(false);
      if (pathname === '/admin' || pathname === '/admin/') navigate(WORKSPACE_PATH, { replace: true });
    }, [pathname, search, navigate]);
    React.useEffect(() => { setQuery(new URLSearchParams(search).get('q') || ''); }, [search]);
    const link = (label, view, to) => h(router.Link, {
      to, 'aria-current': mode === view ? 'page' : undefined, onClick: () => setOpen(false),
    }, label);
    const closeNavigation = () => {setOpen(false); toggle.current?.focus();};
    return h('div', { className: 'ldx-native-workspace', onKeyDown:event => {
      if (open && event.key === 'Escape') {event.preventDefault(); closeNavigation();}
    } },
      h('style', null, css),
      h('header', { className: 'ldx-native-header' },
        h(antd.Button, {ref:toggle, className: 'ldx-native-toggle', 'aria-label': (open ? 'Đóng' : 'Mở') + ' điều hướng Workspace',
          'aria-expanded': open, 'aria-controls':'ldx-workspace-navigation', onClick: () => setOpen(value => !value) }, '☰'),
        h(router.Link, { to: WORKSPACE_PATH, className: 'ldx-native-brand' }, 'LatticeDX'),
        h('span', {className:'ldx-native-label'}, 'Workspace'),
        h('form', { className: 'ldx-native-search', onSubmit: event => {
          event.preventDefault();
          navigate(WORKSPACE_PATH + '?view=apps&q=' + encodeURIComponent(query));
        } }, h(antd.Input, { 'aria-label': 'Tìm trang được cấp quyền', placeholder: 'Tìm trang được cấp quyền…', value: query, onChange: event => setQuery(event.target.value) })),
        h('span', { className: 'ldx-native-role', style: { marginLeft: 'auto', color: '#52657d' } }, roleNames[api.auth.role] || 'Tài khoản'),
        client.PinnedPluginList ? h('div', {className:'ldx-native-tools'}, h(client.PinnedPluginList)) : null),
      h('div', { className: 'ldx-native-body' },
        open ? h('button', {type:'button', className:'ldx-native-backdrop', 'aria-label':'Đóng bảng điều hướng', onClick:closeNavigation}) : null,
        h('aside', {id:'ldx-workspace-navigation', className: 'ldx-native-sidebar' + (open ? ' is-open' : '') },
          h('nav', { 'aria-label': 'Điều hướng Workspace' },
            link('Công việc của tôi', 'tasks', WORKSPACE_PATH),
            link('Ứng dụng', 'apps', WORKSPACE_PATH + '?view=apps'),
            hasReports ? link('Báo cáo', 'reports', WORKSPACE_PATH + '?view=reports') : null,
            current ? h('div', { style: { padding: '12px 14px', color: '#52657d' } }, current.title) : null)),
        h('main', { className: 'ldx-native-content nb-subpages-slot-without-header-and-side',
          ref: element => model.setLayoutContentElement(element) }, h(router.Outlet))));
  }
  return { Shell };
}

module.exports = { WORKSPACE_PATH, workspacePages, workspaceFailure, createNativeWorkspace };
