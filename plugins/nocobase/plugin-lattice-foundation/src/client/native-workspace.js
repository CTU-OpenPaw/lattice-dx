// SPDX-License-Identifier: Apache-2.0
'use strict';

const WORKSPACE_PATH = '/admin/lattice-workspace';

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
        properties: { todos: { type: 'void', 'x-component': 'WorkflowTodo' } },
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
    .ldx-native-toggle {display:none}
    @media(max-width:767px) {
      .ldx-native-toggle {display:inline-block}
      .ldx-native-header {padding:0 10px;gap:8px}
      .ldx-native-brand {font-size:17px}
      .ldx-native-search {display:none}
      .ldx-native-role {display:none}
      .ldx-native-sidebar {display:none}
      .ldx-native-sidebar.is-open {display:block;position:absolute;top:60px;bottom:0;z-index:100;background:#f0f4fa;box-shadow:3px 0 12px #0002}
      .ldx-native-page {padding:16px}
    }
  `;

  function pageCards(pages) {
    return h('div', { className: 'ldx-native-cards' }, pages.map(page =>
      h(router.Link, { key: page.path, to: page.path, className: 'ldx-native-card' },
        h('strong', null, page.title), h('div', { style: { marginTop: 10 } }, 'Mở trang →'))));
  }

  function Landing() {
    const { allAccessRoutes, refresh } = client.useAllAccessDesktopRoutes();
    const { search } = router.useLocation();
    const params = new URLSearchParams(search);
    const view = params.get('view');
    const query = (params.get('q') || '').trim().toLocaleLowerCase('vi');
    const [taskView, setTaskView] = React.useState('pending');
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState('');
    const pages = workspacePages(allAccessRoutes).filter(page =>
      page.title.toLocaleLowerCase('vi').includes(query) && (view !== 'reports' || page.section === 'reports'));
    const catalog = view === 'apps' || view === 'reports';
    async function reload() {
      if (busy) return;
      setBusy(true); setError('');
      try { await refresh(); }
      catch { setError('Không cập nhật được danh sách trang. Vui lòng thử lại.'); }
      finally { setBusy(false); }
    }
    return h('section', { className: 'ldx-native-page' },
      h('h1', null, view === 'reports' ? 'Báo cáo' : catalog ? 'Ứng dụng' : 'Công việc của tôi'),
      error ? h(antd.Alert, { type: 'error', message: error, showIcon: true }) : null,
      catalog ? h(React.Fragment, null,
        h(antd.Button, { onClick: reload, loading: busy }, 'Cập nhật danh sách'),
        pages.length ? pageCards(pages) : h(antd.Empty, { description: query ? 'Không tìm thấy trang phù hợp.' : 'Chưa có trang được cấp quyền.' }))
        : h(React.Fragment, null,
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
            h('h2', { style: { fontSize: 17 } }, 'Lối tắt trang'),
            h(router.Link, { to: WORKSPACE_PATH + '?view=apps' }, 'Xem tất cả ứng dụng')),
          pages.length ? pageCards(pages.slice(0, 3)) : h('p', null, 'Chưa có trang nghiệp vụ được cấp quyền.'),
          h(antd.Tabs, { activeKey: taskView, onChange: setTaskView, items: [
            { key: 'pending', label: 'Cần xử lý' },
            { key: 'completed', label: 'Đã xử lý' },
          ] }),
          h(client.SchemaComponent, { key: taskView, schema: { ...todoSchema, name: 'workspaceTasks_' + taskView, properties: { [taskView]: {
            ...todoSchema.properties.nativeTasks,
            'x-decorator-props': { params: { filter: taskView === 'pending'
              ? { status: 0, 'execution.status': 0 } : { status: [1, -3, -5] } } },
          } } } })),
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
    const pages = workspacePages(allAccessRoutes);
    const hasReports = pages.some(page => page.section === 'reports');
    const params = new URLSearchParams(search);
    const mode = pathname === WORKSPACE_PATH || pathname.startsWith(WORKSPACE_PATH + '/popups/') ? params.get('view') || 'tasks' : 'page';
    const current = pages.find(page => page.path === pathname);
    React.useEffect(() => {
      setOpen(false);
      if (pathname === '/admin' || pathname === '/admin/') navigate(WORKSPACE_PATH, { replace: true });
    }, [pathname, navigate]);
    React.useEffect(() => { setQuery(new URLSearchParams(search).get('q') || ''); }, [search]);
    const link = (label, view, to) => h(router.Link, {
      to, 'aria-current': mode === view ? 'page' : undefined, onClick: () => setOpen(false),
    }, label);
    return h('div', { className: 'ldx-native-workspace' },
      h('style', null, css),
      h('header', { className: 'ldx-native-header' },
        h(antd.Button, { className: 'ldx-native-toggle', 'aria-label': 'Mở điều hướng Workspace', 'aria-expanded': open, onClick: () => setOpen(value => !value) }, '☰'),
        h(router.Link, { to: WORKSPACE_PATH, className: 'ldx-native-brand' }, 'LatticeDX'),
        h('span', null, 'Workspace'),
        h('form', { className: 'ldx-native-search', onSubmit: event => {
          event.preventDefault();
          navigate(WORKSPACE_PATH + '?view=apps&q=' + encodeURIComponent(query));
        } }, h(antd.Input, { 'aria-label': 'Tìm trang được cấp quyền', placeholder: 'Tìm trang được cấp quyền…', value: query, onChange: event => setQuery(event.target.value) })),
        h('span', { className: 'ldx-native-role', style: { marginLeft: 'auto', color: '#52657d' } }, roleNames[api.auth.role] || 'Tài khoản'),
        client.PinnedPluginList ? h(client.PinnedPluginList) : null),
      h('div', { className: 'ldx-native-body' },
        h('aside', { className: 'ldx-native-sidebar' + (open ? ' is-open' : '') },
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

module.exports = { WORKSPACE_PATH, workspacePages, createNativeWorkspace };
