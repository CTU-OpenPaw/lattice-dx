/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const WORKSPACE_PATH = '/admin/lattice-workspace';

function workspaceFailure(error) {
  const status = Number(error?.response?.status ?? error?.status);
  if (status === 401) return { signIn: true, message: 'Phiên đăng nhập đã hết hạn. Anh/chị vui lòng đăng nhập lại.' };
  if (status === 403) return { message: 'Tài khoản hiện không có quyền tải nội dung này. Vui lòng kiểm tra quyền với quản trị viên.' };
  return { message: 'Chưa tải được nội dung. Vui lòng kiểm tra kết nối và thử lại.' };
}

function workspacePages(routes, inheritedSection) {
  return (Array.isArray(routes) ? routes : []).slice()
    .sort((a, b) => (Number(a?.sort) || 0) - (Number(b?.sort) || 0)).flatMap(route => {
      if (!route || route.hidden || route.hideInMenu || route.options?.workspace?.lab === true) return [];
      const section = route.options?.workspace?.section ?? inheritedSection;
      if (route.type === 'group') return workspacePages(route.children, section);
      if (!['page', 'flowPage'].includes(route.type) || typeof route.schemaUid !== 'string' ||
          !/^[a-zA-Z0-9_-]+$/.test(route.schemaUid)) return [];
      const title = typeof route.title === 'string' && route.title.trim() ? route.title : 'Chưa đặt tên';
      return [{ id: route.id, title, path: '/admin/' + route.schemaUid, section }];
    });
}

function workspaceApplications(routes) {
  return (Array.isArray(routes) ? routes : []).slice()
    .sort((a, b) => (Number(a?.sort) || 0) - (Number(b?.sort) || 0))
    .flatMap(route => {
      const pages = workspacePages([route]).filter(page => page.section !== 'reports');
      if (!pages.length) return [];
      const app = String(route.id ?? route.schemaUid ?? '');
      if (!app) return [];
      const title = route.title?.trim() || pages[0].title;
      const quickCreate = route.options?.workspace?.quickCreate;
      const destination = pages.find(page => page.path === '/admin/' + quickCreate?.pageUid);
      const action = destination && typeof quickCreate.label === 'string' && quickCreate.label.trim() &&
        typeof quickCreate.collection === 'string' && /^[a-zA-Z0-9_]+$/.test(quickCreate.collection)
        ? { label: quickCreate.label.trim(), collection: quickCreate.collection, path: destination.path } : null;
      const path = route.type === 'group' ? WORKSPACE_PATH + '?view=apps&app=' + encodeURIComponent(app) : pages[0].path;
      return [{ id: app, title, pages, path, action }];
    });
}

function canQuickCreate(permissions, collection) {
  return permissions?.allowAll === true || Boolean(permissions?.actions?.[collection + ':create']);
}

function createNativeWorkspace(client, React, antd, app, router) {
  if (![client.useAPIClient, client.useAllAccessDesktopRoutes, router?.useLocation, router?.useNavigate]
    .every(value => typeof value === 'function') || !client.SchemaComponent || !client.PagePopups) return null;
  const h = React.createElement;
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
    .ldx-native-page {box-sizing:border-box;padding:28px;max-width:1440px;margin:0 auto}
    .ldx-native-page h1 {margin:0 0 24px;font-size:30px;font-weight:750;line-height:1.25;color:#142238}
    .ldx-native-page h2 {margin:0;font-size:18px;font-weight:650}
    .ldx-native-cards {display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,240px),1fr));gap:14px;margin:12px 0 24px}
    .ldx-native-card {display:flex;flex-direction:column;gap:12px;border:1px solid #dce3ed;border-radius:10px;padding:16px;background:white;color:#20314b;text-decoration:none;box-shadow:0 1px 2px #1522380c}
    .ldx-native-card span {color:#155ac0;font-size:13px}
    .ldx-native-card:hover {border-color:#1677ff}
    .ldx-native-card-actions {display:flex;flex-wrap:wrap;gap:8px;margin-top:auto}
    .ldx-native-card-actions a {padding:5px 12px;border:1px solid #cbd5e1;border-radius:6px;color:#243850;text-decoration:none}
    .ldx-native-card-actions a:hover {border-color:#155ac0;color:#155ac0}
    .ldx-native-card-actions .ldx-native-create {background:#155ac0;border-color:#155ac0;color:white}
    .ldx-native-card-actions .ldx-native-create:hover {background:#114b9e;color:white}
    .ldx-native-toolbar {display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:16px 0}
    .ldx-native-catalog-search {display:flex;gap:8px;flex:1;max-width:520px;min-width:0}
    .ldx-native-shortcut-heading {display:flex;gap:12px;flex-wrap:wrap;justify-content:space-between;align-items:center}
    .ldx-native-shortcut-heading a {color:#155ac0;font-weight:600}
    .ldx-native-page .ant-card-body {overflow-x:auto}
    .ldx-task-list .ant-list-item {display:block;padding:0}
    .ldx-task-columns,.ldx-task-row {display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1.4fr) minmax(100px,1fr) minmax(100px,1fr) minmax(100px,auto);gap:12px;align-items:center;padding:10px 12px}
    .ldx-task-columns {background:#eef3fa;border-radius:6px;color:#34465e;font-size:13px;font-weight:600}
    .ldx-task-row {min-height:58px;overflow-wrap:anywhere}
    .ldx-task-label {display:none}
    .ldx-task-status {display:inline-block;padding:2px 8px;border-radius:12px;background:#e8edf4;color:#34465e;font-size:12px}
    .ldx-task-status.pending {background:#fff1ce;color:#754900}
    .ldx-task-status.resolved {background:#e1f3e8;color:#24623d}
    .ldx-task-status.rejected {background:#fae6e6;color:#8b3131}
    .ldx-native-card strong {overflow-wrap:anywhere}
    .ldx-native-update {color:#52657d;font-size:13px}
    @media(max-width:767px) {
      .ldx-task-columns {display:none}
      .ldx-task-row {grid-template-columns:minmax(0,1fr) minmax(0,1fr)}
      .ldx-task-title {grid-column:1/-1}
      .ldx-task-label {display:block;margin-bottom:2px;color:#52657d;font-size:12px}
      .ldx-native-page {padding:16px}
      .ldx-native-catalog-search {flex-basis:100%}
    }
  `;

  function Failure({ error, retry, busy }) {
    const failure = workspaceFailure(error);
    return h(antd.Alert, {
      type: 'error', message: failure.message, showIcon: true,
      action: failure.signIn
        ? h(router.Link, { to: '/signin?redirect=' + encodeURIComponent(WORKSPACE_PATH) }, 'Đăng nhập lại')
        : h(antd.Button, { onClick: retry, loading: busy, disabled: busy }, 'Thử lại'),
    });
  }

  const taskColumns = ['Công việc', 'Quy trình', 'Trạng thái', 'Giao lúc', 'Thao tác'];
  const taskStates = { 0: ['Cần xử lý', 'pending'], 1: ['Đã xử lý', 'resolved'], '-3': ['Đã dừng', ''], '-5': ['Đã từ chối', 'rejected'] };
  const taskDate = new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short', timeStyle: 'short' });

  function TaskColumnHead() {
    const { service } = client.useListBlockContext() ?? {};
    if (service?.loading || !service?.data?.data?.length) return null;
    return h('div', { className: 'ldx-task-columns', 'aria-hidden': true }, taskColumns.map(label => h('span', { key: label }, label)));
  }

  function TaskRow({ children }) {
    const record = client.useCollectionRecordData() ?? {};
    const [status, tone] = taskStates[record.status] ?? ['—', ''];
    const date = record.createdAt ? new Date(record.createdAt) : null;
    const cell = (column, content) => h('div', null, h('span', { className: 'ldx-task-label' }, taskColumns[column]), content);
    return h('div', { className: 'ldx-task-row' },
      h('strong', { className: 'ldx-task-title' }, record.title || record.node?.title || 'Công việc'),
      cell(1, record.workflow?.title || '—'),
      cell(2, h('span', { className: 'ldx-task-status ' + tone }, status)),
      cell(3, date && Number.isFinite(date.getTime()) ? h('time', { dateTime: date.toISOString() }, taskDate.format(date)) : '—'),
      cell(4, children));
  }

  function taskListSchema(view) {
    return { type: 'void', properties: {
      toolbar: { type: 'void', 'x-component': 'ActionBar', 'x-component-props': { style: { marginBottom: 12 } }, properties: {
        filter: { type: 'void', title: 'Lọc công việc', 'x-action': 'filter', 'x-component': 'Filter.Action', 'x-use-component-props': 'useFilterActionProps', 'x-align': 'left',
          'x-component-props': { icon: 'FilterOutlined', nonfilterable: ['workflow.type', 'workflow.mode', 'workflow.description', 'workflow.categories'], default: { $and: [{ title: { $includes: '' } }, { 'workflow.title': { $includes: '' } }] } } },
        refresh: { type: 'void', title: 'Làm mới', 'x-component': 'Action', 'x-action': 'refresh', 'x-use-component-props': 'useRefreshActionProps', 'x-align': 'right', 'x-component-props': { icon: 'ReloadOutlined' } },
      } },
      columns: { type: 'void', 'x-component': 'WorkspaceTaskColumnHead' },
      list: { type: 'array', 'x-component': 'List', properties: {
        item: { type: 'object', 'x-component': 'List.Item', properties: {
          row: { type: 'void', 'x-component': 'WorkspaceTaskRow', properties: {
            actions: { type: 'void', 'x-component': 'ActionBar', 'x-use-component-props': 'useListActionBarProps', 'x-component-props': { layout: 'one-column' }, properties: {
              view: { name: 'view', type: 'void', title: view === 'pending' ? 'Mở công việc' : 'Xem chi tiết', 'x-component': 'Action.Link', 'x-component-props': { openMode: 'modal' }, 'x-action': 'view', 'x-uid': 'workspace-native-task-view', 'x-action-context': { dataSource: 'main', collection: 'workflowManualTasks', doNotUpdateContext: true }, properties: { drawer: { type: 'void', 'x-component': 'WorkflowTodo.Drawer' } } },
            } },
          } },
        } },
      } },
    } };
  }

  function NativeTasks({ view, suppressEmpty }) {
    const { service } = typeof client.useListBlockContext === 'function' ? client.useListBlockContext() || {} : {};
    const retry = async () => { try { await (service.refreshAsync ? service.refreshAsync() : service.refresh()); } catch {} };
    if (service?.error && !service.loading) return h(Failure, { error: service.error, retry, busy: false });
    const useTaskRows = typeof client.useCollectionRecordData === 'function' && typeof client.useListBlockContext === 'function';
    const schema = useTaskRows ? taskListSchema(view) : { type: 'void', properties: { nativeTodo: { type: 'void', 'x-component': 'WorkflowTodo' } } };
    const nativeList = h(client.SchemaComponent, { schema, components: { WorkspaceTaskRow: TaskRow, WorkspaceTaskColumnHead: TaskColumnHead } });
    return h('div', { className: 'ldx-task-list', 'aria-busy': Boolean(service?.loading) },
      service?.loading ? h('p', { role: 'status' }, 'Đang tải công việc…') : null,
      antd.ConfigProvider ? h(antd.ConfigProvider, { renderEmpty: () => ((service?.loading || suppressEmpty) ? null : h(antd.Empty, { description: view === 'completed' ? 'Chưa có công việc đã xử lý.' : 'Hiện không có công việc cần xử lý.' })) }, nativeList) : nativeList);
  }

  const pageCards = pages => h('div', { className: 'ldx-native-cards' }, pages.map(page =>
    h(router.Link, { key: page.path, to: page.path, className: 'ldx-native-card' }, h('strong', null, page.title), h('span', null, 'Mở trang →'))));

  const applicationCards = (applications, permissions) => h('div', { className: 'ldx-native-cards' }, applications.map(({ id, title, path, action }) =>
    h('article', { key: id, className: 'ldx-native-card' }, h('strong', null, title),
      h('div', { className: 'ldx-native-card-actions' },
        action && canQuickCreate(permissions, action.collection) ? h(router.Link, { to: action.path, className: 'ldx-native-create' }, '+ ' + action.label) : null,
        h(router.Link, { to: path, 'aria-label': 'Mở ' + title }, 'Mở')))));

  const INBOX_SOURCE_LABELS = { business: 'Nghiệp vụ', ai_hitl: 'AI HITL', flow: 'Flow tự động', proposals: 'Đề xuất AI' };
  const INBOX_STATUS_LABELS = { pending: ['Chờ duyệt', 'pending'], approved: ['Đã duyệt', 'resolved'], rejected: ['Từ chối', 'rejected'], reviewed: ['Đã xem xét', 'resolved'], executed: ['Đã thực thi', 'resolved'] };

  function Landing() {
    const { allAccessRoutes, refresh } = client.useAllAccessDesktopRoutes();
    const api = client.useAPIClient();
    const role = api.auth.role;
    const { search } = router.useLocation();
    const navigate = router.useNavigate();
    const params = new URLSearchParams(search);
    const view = params.get('view'), appId = view === 'apps' ? params.get('app') : null;
    const query = (params.get('q') || '').trim().toLocaleLowerCase('vi');
    const [taskView, setTaskView] = React.useState('pending');
    const [busy, setBusy] = React.useState(true);
    const [error, setError] = React.useState(null);
    const [updated, setUpdated] = React.useState('');
    const [term, setTerm] = React.useState(params.get('q') || '');
    const [permissionResult, setPermissionResult] = React.useState(null);
    const [portalApps, setPortalApps] = React.useState([]);
    const [inboxState, setInboxState] = React.useState({ loading: false, items: [], error: null, busyKey: null });
    const [inboxVersion, setInboxVersion] = React.useState(0);
    const request = React.useRef({ busy: false, mounted: true });
    React.useEffect(() => { request.current.mounted = true; return () => { request.current.mounted = false; }; }, []);
    React.useEffect(() => {
      if (typeof document !== 'undefined') document.title = 'Không gian Làm việc — LatticeDX';
    }, []);
    React.useEffect(() => { setTerm(params.get('q') || ''); }, [search]);
    React.useEffect(() => {
      if (typeof api?.request !== 'function') return undefined;
      let active = true;
      api.request({ url: 'latticePortals:listAccessible', method: 'get', skipNotify: true }).then(res => {
        if (!active) return;
        const raw = res?.data?.data;
        if (!Array.isArray(raw)) return;
        const mapped = raw
          .filter(p => p && p.enabled !== false && p.uid !== 'admin-layout-model' && typeof p.firstPagePath === 'string' && p.firstPagePath.startsWith('/p/'))
          .map(p => {
            const title = typeof p.title === 'string' && p.title.trim() ? p.title.trim() : p.routePath;
            const id = String(p.uid || p.routePath);
            return { id, title, pages: [{ id, title, path: p.firstPagePath }], path: p.firstPagePath, action: null };
          });
        setPortalApps(mapped);
      }).catch(() => {});
      return () => { active = false; };
    }, [api, role, updated]);
    const baseApps = workspaceApplications(allAccessRoutes);
    const seenIds = new Set(baseApps.map(item => item.id));
    const seenPaths = new Set(baseApps.map(item => item.path));
    const mergedPortalApps = portalApps.filter(item => !seenIds.has(item.id) && !seenPaths.has(item.path));
    const applications = [...baseApps, ...mergedPortalApps];
    const selectedApp = applications.find(item => item.id === appId);
    const matchingApps = applications.filter(item => item.title.toLocaleLowerCase('vi').includes(query) || item.pages.some(page => page.title.toLocaleLowerCase('vi').includes(query)));
    const pages = (appId ? selectedApp?.pages ?? [] : workspacePages(allAccessRoutes).filter(page => page.section === 'reports')).filter(page => page.title.toLocaleLowerCase('vi').includes(query));
    const hasQuickCreate = applications.some(item => item.action);
    React.useEffect(() => {
      if (!hasQuickCreate || typeof api.request !== 'function') return;
      let active = true;
      setPermissionResult(null);
      api.request({ url: 'roles:check', method: 'get' }).then(result => {
        if (active) setPermissionResult({ role, permissions: result.data?.data });
      }).catch(() => {});
      return () => { active = false; };
    }, [api, role, hasQuickCreate, updated]);
    const catalog = view === 'apps' || view === 'reports';
    React.useEffect(() => {
      if (catalog || typeof api?.request !== 'function') return undefined;
      let active = true;
      setInboxState(prev => ({ ...prev, loading: true, error: null }));
      api.request({
        url: 'dxosApprovals:listInbox',
        method: 'get',
        params: { status: taskView === 'pending' ? 'pending' : 'all', limit: 20 },
        skipNotify: true,
      }).then(res => {
        if (!active) return;
        const payload = res?.data?.data ?? res?.data;
        if (!Array.isArray(payload?.items)) {
          setInboxState(prev => ({ ...prev, loading: false, items: [] }));
          return;
        }
        setInboxState(prev => ({ ...prev, loading: false, items: payload.items, error: null }));
      }).catch(err => {
        if (!active) return;
        const msg = err?.response?.data?.errors?.[0]?.message || err?.message || 'Không tải được hộp thư phê duyệt DX-OS.';
        setInboxState(prev => ({ ...prev, loading: false, error: msg }));
      });
      return () => { active = false; };
    }, [api, role, taskView, updated, inboxVersion, catalog]);

    async function decideInboxItem(item, decision) {
      const key = String(item?.itemKey || `${item?.source || 'business'}:${item?.id || ''}`);
      if (!key || inboxState.busyKey || typeof api?.request !== 'function') return;
      setInboxState(prev => ({ ...prev, busyKey: key, error: null }));
      const note = decision === 'reject' ? 'Từ chối từ Không gian việc của tôi' : 'Phê duyệt từ Không gian việc của tôi';
      try {
        await api.request({
          url: 'dxosApprovals:decide',
          method: 'post',
          data: { itemKey: item.itemKey, source: item.source, id: item.id, decision, note },
          skipNotify: true,
        });
        setInboxState(prev => ({ ...prev, busyKey: null }));
        setInboxVersion(v => v + 1);
      } catch (err) {
        const msg = err?.response?.data?.errors?.[0]?.message || err?.message || 'Không xử lý được quyết định phê duyệt.';
        setInboxState(prev => ({ ...prev, busyKey: null, error: msg }));
      }
    }

    async function reload() {
      if (request.current.busy) return;
      request.current.busy = true; setBusy(true); setError(null); setUpdated('');
      try { await refresh(); if (request.current.mounted) setUpdated(new Date().toLocaleTimeString('vi-VN')); }
      catch (failure) { if (request.current.mounted) setError(failure); }
      finally { request.current.busy = false; if (request.current.mounted) setBusy(false); }
    }
    React.useEffect(() => { reload(); }, [refresh]);
    const allAppsPath = WORKSPACE_PATH + '?view=apps';
    const catalogPath = view === 'reports' ? WORKSPACE_PATH + '?view=reports' : allAppsPath + (appId ? '&app=' + encodeURIComponent(appId) : '');
    const clearSearch = () => { setTerm(''); navigate(catalogPath); };
    const showPages = view === 'reports' || Boolean(appId), count = showPages ? pages.length : matchingApps.length;
    const cards = busy ? h('p', { role: 'status' }, 'Đang cập nhật danh sách trang…')
      : error ? null : count ? (showPages ? pageCards(pages) : applicationCards(catalog ? matchingApps : matchingApps.slice(0, 6), permissionResult?.role === role ? permissionResult?.permissions : null))
        : h(antd.Empty, { description: query ? 'Không tìm thấy trang phù hợp.' : view === 'reports' ? 'Chưa có trang báo cáo được cấp quyền.' : appId ? 'Ứng dụng này chưa có trang được cấp quyền.' : 'Chưa có ứng dụng được cấp quyền.' },
          query ? h(antd.Button, { onClick: clearSearch }, 'Xóa tìm kiếm') : null);
    const inboxSection = (inboxState.items.length > 0 || inboxState.loading || inboxState.error) ? h('section', {
      'data-testid': 'ldx-workspace-dxos-inbox',
      style: { margin: '12px 0 20px', padding: 16, borderRadius: 10, border: '1px solid #dce3ed', background: '#ffffff' },
    },
      h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' } },
        h('h2', { style: { margin: 0, fontSize: 16, fontWeight: 650, color: '#142238' } }, 'Phê duyệt & Đề xuất cần xử lý (DX-OS Inbox)'),
        inboxState.loading ? h('span', { role: 'status', style: { fontSize: 12, color: '#52657d' } }, 'Đang đồng bộ hộp thư…') : null),
      inboxState.error ? h(antd.Alert, { type: 'error', message: inboxState.error, showIcon: true, style: { marginBottom: 12 } }) : null,
      inboxState.items.length > 0 ? h('div', { style: { display: 'grid', gap: 10 } },
        inboxState.items.map(item => {
          const itemKey = String(item.itemKey || `${item.source || 'business'}:${item.id || ''}`);
          const [statusLabel, statusTone] = INBOX_STATUS_LABELS[item.status] || [String(item.status || '—'), ''];
          const sourceLabel = INBOX_SOURCE_LABELS[item.source] || String(item.source || 'DX-OS');
          const itemBusy = inboxState.busyKey === itemKey;
          return h('article', {
            key: itemKey,
            'data-testid': 'ldx-inbox-item-' + itemKey,
            style: {
              display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap',
              padding: '12px 14px', borderRadius: 8, border: '1px solid #e2e8f0', background: '#f8fafc',
            },
          },
            h('div', { style: { display: 'grid', gap: 4, minWidth: 0, flex: 1 } },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                h('strong', { style: { fontSize: 14, color: '#0f172a' } }, item.title || itemKey),
                h('span', { className: 'ldx-task-status' }, sourceLabel),
                h('span', { className: 'ldx-task-status ' + statusTone }, statusLabel)),
              item.summary ? h('span', { style: { fontSize: 13, color: '#475569' } }, item.summary) : null),
            item.canAct ? h('div', { style: { display: 'flex', gap: 8, flexShrink: 0 } },
              h(antd.Button, {
                type: 'primary',
                size: 'small',
                'data-testid': 'ldx-inbox-approve-' + itemKey,
                loading: itemBusy,
                disabled: Boolean(inboxState.busyKey),
                onClick: () => decideInboxItem(item, 'approve'),
              }, 'Phê duyệt'),
              h(antd.Button, {
                danger: true,
                size: 'small',
                'data-testid': 'ldx-inbox-reject-' + itemKey,
                loading: itemBusy,
                disabled: Boolean(inboxState.busyKey),
                onClick: () => decideInboxItem(item, 'reject'),
              }, 'Từ chối')) : null);
        })) : null) : null;
    return h('section', { className: 'ldx-native-page' },
      h('style', null, css),
      h('h1', null, view === 'reports' ? 'Báo cáo' : catalog ? selectedApp?.title ?? 'Ứng dụng' : 'Công việc của tôi'),
      error ? h(Failure, { error, retry: reload, busy }) : null,
      catalog ? h(React.Fragment, null,
        appId ? h(router.Link, { to: allAppsPath }, '← Tất cả ứng dụng') : null,
        h('div', { className: 'ldx-native-toolbar' },
          h('form', { className: 'ldx-native-catalog-search', role: 'search', 'aria-label': 'Tìm trong danh sách trang', onSubmit: e => { e.preventDefault(); navigate(catalogPath + (term.trim() ? '&q=' + encodeURIComponent(term.trim()) : '')); } },
            h(antd.Input, { 'aria-label': 'Tên trang cần tìm', placeholder: 'Nhập tên trang…', value: term, onChange: e => setTerm(e.target.value) }),
            h(antd.Button, { htmlType: 'submit' }, 'Tìm')),
          h(antd.Button, { onClick: reload, loading: busy, disabled: busy }, 'Cập nhật danh sách')),
        cards)
        : h(React.Fragment, null,
          h('div', { className: 'ldx-native-shortcut-heading' },
            h('h2', null, 'Lối tắt ứng dụng'),
            h(router.Link, { to: allAppsPath }, 'Xem tất cả ứng dụng →')),
          cards,
          h(antd.Tabs, { activeKey: taskView, onChange: setTaskView, items: [{ key: 'pending', label: 'Cần xử lý' }, { key: 'completed', label: 'Đã xử lý' }] }),
          inboxSection,
          h(client.SchemaComponent, { key: taskView, components: { WorkspaceNativeTasks: NativeTasks }, schema: { ...todoSchema, name: 'workspaceTasks_' + taskView, properties: { [taskView]: {
            ...todoSchema.properties.nativeTasks,
            properties: { todos: { ...todoSchema.properties.nativeTasks.properties.todos, 'x-component-props': { view: taskView, suppressEmpty: inboxState.items.length > 0 } } },
            'x-decorator-props': { params: { filter: taskView === 'pending' ? { status: 0, 'execution.status': 0 } : { status: [1, -3, -5] } } },
          } } } })),
      h('p', { role: 'status', className: 'ldx-native-update' }, !busy && !error ? (catalog ? 'Có ' + count + (showPages ? ' trang' : ' ứng dụng') + ' phù hợp. ' : '') + (updated ? 'Đã cập nhật danh sách trang lúc ' + updated : '') : ''),
      h(router.Outlet));
  }

  app.router.add('admin.lattice-workspace', { path: WORKSPACE_PATH, Component: Landing });
  app.router.add('admin.lattice-workspace.popups', { path: WORKSPACE_PATH + '/popups/*', Component: client.PagePopups });

  function Shell({ model }) {
    return h('main', {
      className: 'nb-subpages-slot-without-header-and-side',
      ref: el => model?.setLayoutContentElement?.(el),
    }, router.Outlet ? h(router.Outlet) : null);
  }
  return { Shell };
}

module.exports = { WORKSPACE_PATH, workspacePages, workspaceFailure, createNativeWorkspace };
