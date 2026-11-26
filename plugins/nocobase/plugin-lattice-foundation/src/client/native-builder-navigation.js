/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { createNativeWorkspace, workspacePages, WORKSPACE_PATH } = require('./native-workspace');

const BUILDER_PATH = '/admin/lattice-builder';

function pageTree(routes, query = '') {
  const needle = String(query).trim().toLocaleLowerCase('vi');
  function visit(items, ancestorMatches = false, lab = false) {
    return (Array.isArray(items) ? items : [])
      .filter(route => route && !route.hidden && !route.hideInMenu)
      .map((route, index) => ({ route, index }))
      .sort((a, b) => (Number(a.route.sort) || 0) - (Number(b.route.sort) || 0) || a.index - b.index)
      .flatMap(({ route }) => {
        const title = typeof route.title === 'string' && route.title.trim() ? route.title : 'Chưa đặt tên';
        const matches = ancestorMatches || !needle || title.toLocaleLowerCase('vi').includes(needle);
        if (route.type === 'group') {
          const children = visit(route.children, matches, lab);
          return children.length ? [{ key: 'group:' + String(route.id ?? route.schemaUid), title, children }] : [];
        }
        if (!['page', 'flowPage'].includes(route.type) || typeof route.schemaUid !== 'string' ||
            !/^[a-zA-Z0-9_-]+$/.test(route.schemaUid) || !matches ||
            (route.options?.workspace?.lab === true) !== lab) return [];
        return [{ key: 'page:' + route.schemaUid, title, path: '/admin/' + route.schemaUid }];
      });
  }
  const tree = visit(routes);
  const lab = visit(routes, 'kiểm thử'.includes(needle), true);
  return lab.length ? [...tree, { key: 'lab', title: 'Kiểm thử', children: lab }] : tree;
}

function hostPath(basename, path) {
  if (typeof path !== 'string' || !/^\/admin(?:\/|$)/.test(path) || /[?#\\]/.test(path) || path.includes('..')) return null;
  const base = typeof basename === 'string' ? basename.replace(/\/$/, '') : '';
  if (base && !/^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+$/.test(base)) return null;
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

function resolvePortalRedirect(portalList, pathname, allowConfigUI) {
  const portalMatch = /^\/p\/([^/?#]+)/.exec(String(pathname || ''));
  if (!portalMatch) return null;
  const list = Array.isArray(portalList)
    ? portalList.filter(p => p && p.enabled !== false && p.uid !== 'admin-layout-model')
    : [];
  const slugPath = '/p/' + portalMatch[1];
  const activeAccessiblePortal = list.find(p => p.routePath === slugPath && p.firstPagePath) || null;
  if (!allowConfigUI && !activeAccessiblePortal) {
    const sibling = list.find(
      p => typeof p?.routePath === 'string' && p.routePath.startsWith(slugPath + '-') && p.firstPagePath,
    );
    if (sibling && sibling.firstPagePath !== pathname) return sibling.firstPagePath;
    return null;
  }
  if (
    activeAccessiblePortal
    && (pathname === activeAccessiblePortal.routePath || pathname === activeAccessiblePortal.routePath + '/')
    && activeAccessiblePortal.firstPagePath !== pathname
  ) {
    return activeAccessiblePortal.firstPagePath;
  }
  return null;
}

function createNativeBuilderNavigation(client, React, antd, app, { clientV2, router, flow, portalManager } = {}) {
  if (!clientV2 || !router || !flow || !app?.flowEngine ||
      ![client.useAllAccessDesktopRoutes, client.useUIConfigurationPermissions,
        client.useDesignable, clientV2.getAdminLayoutModel, router.useLocation].every(v => typeof v === 'function') ||
      !client.AdminProvider || !flow.FlowModelRenderer || !router.Link || !router.Outlet) return null;
  const NativeModel = app.flowEngine.getModelClass('AdminLayoutModel');
  if (!NativeModel || typeof NativeModel.prototype?.render !== 'function') return null;
  const V2Model = clientV2?.AdminLayoutModel;
  const V2MenuItem = clientV2?.AdminLayoutMenuItemModel;
  const hasPortalMenuItem = typeof V2MenuItem === 'function';
  const rewriteMenuSubModel = (subKey, opts) => (hasPortalMenuItem && subKey === 'menuItems' && opts?.use === 'AdminLayoutMenuItemModel'
    ? { ...opts, use: 'LatticePortalMenuItemModel' } : opts);
  const isPortalModel = inst => Boolean(typeof V2Model?.prototype?.render === 'function' && inst?.layout?.uid && inst.layout.uid !== 'admin-layout-model');

  const h = React.createElement;
  const Fragment = React.Fragment || 'div';
  const workspace = createNativeWorkspace(client, React, antd, app, router);
  const useApi = typeof client.useAPIClient === 'function' ? client.useAPIClient : () => null;
  const useNav = typeof router.useNavigate === 'function' ? router.useNavigate : () => null;
  const landingPath = items => {
    const custom = (Array.isArray(items) ? items : []).filter(p => p && p.enabled !== false && p.uid !== 'admin-layout-model');
    const target = custom.find(p => p.isDefault) || custom[0];
    return target?.firstPagePath || target?.routePath || WORKSPACE_PATH;
  };
  const goPortal = (dest, navigate, opts) => (portalManager?.navigateToPortal
    ? portalManager.navigateToPortal(dest, navigate, opts) : navigate?.(dest, opts));
  const redirectNotice = () => h('div', {
    className: 'ldx-portal-redirecting', role: 'status',
    style: { padding: 48, textAlign: 'center', color: '#64748b', fontSize: 14 },
  }, 'Đang chuyển đến Cổng làm việc...');

  function QuickCreateSettings({ route, refresh }) {
    const api = useApi();
    const configuration = route.options?.workspace?.quickCreate;
    const [pageUid, setPageUid] = React.useState(configuration?.pageUid);
    const [label, setLabel] = React.useState(configuration?.label ?? '');
    const [collection, setCollection] = React.useState(configuration?.collection ?? '');
    const [saving, setSaving] = React.useState(false);
    const [message, setMessage] = React.useState(null);
    const pages = workspacePages([route]).filter(p => p.section !== 'reports').map(p => ({ label: p.title, value: p.path.slice('/admin/'.length) }));
    const valid = pages.some(p => p.value === pageUid) && label.trim() && /^[a-zA-Z0-9_]+$/.test(collection.trim());

    async function save(remove) {
      if (saving || (!remove && !valid) || !api?.request) return;
      setSaving(true); setMessage(null);
      try {
        const params = { filterByTk: route.id };
        const response = await api.request({ url: 'desktopRoutes:get', method: 'get', params });
        const current = response.data?.data;
        if (!current || String(current.id) !== String(route.id)) throw new Error('Route unavailable');
        const options = { ...current.options, workspace: { ...current.options?.workspace } };
        if (remove) delete options.workspace.quickCreate;
        else options.workspace.quickCreate = { pageUid, label: label.trim(), collection: collection.trim() };
        await api.request({ url: 'desktopRoutes:update', method: 'post', params, data: { options } });
        if (remove) { setPageUid(undefined); setLabel(''); setCollection(''); }
        try { await refresh(); } catch { setMessage({ type: 'warning', text: 'Đã lưu. Hãy tải lại trang để cập nhật danh mục.' }); return; }
        setMessage({ type: 'success', text: remove ? 'Đã gỡ nút tạo nhanh.' : 'Đã lưu nút tạo nhanh.' });
      } catch { setMessage({ type: 'error', text: 'Không lưu được cấu hình. Kiểm tra quyền sửa menu và thử lại.' }); }
      finally { setSaving(false); }
    }
    const field = (name, control) => h('label', { style: { display: 'grid', gap: 4, marginBottom: 12 } }, name, control);
    return h('form', { onSubmit: e => { e.preventDefault(); save(false); }, style: { marginTop: 16 } },
      field('Trang chứa form tạo', h(antd.Select, { 'aria-label': 'Trang chứa form tạo', options: pages, value: pageUid, onChange: setPageUid, disabled: saving })),
      field('Tên nút', h(antd.Input, { value: label, maxLength: 60, onChange: e => setLabel(e.target.value), disabled: saving })),
      field('Tên kỹ thuật của collection', h(antd.Input, { value: collection, onChange: e => setCollection(e.target.value), disabled: saving })),
      h(antd.Space, null,
        h(antd.Button, { type: 'primary', htmlType: 'submit', disabled: !valid, loading: saving }, 'Lưu nút tạo nhanh'),
        configuration ? h(antd.Button, { disabled: saving, onClick: () => save(true) }, 'Gỡ nút') : null),
      message ? h(antd.Alert, { type: message.type, message: message.text, style: { marginTop: 12 } }) : null);
  }

  function BuilderLanding() {
    const { allowConfigUI } = client.useUIConfigurationPermissions();
    const { allAccessRoutes, refresh } = client.useAllAccessDesktopRoutes();
    const [selected, setSelected] = React.useState(undefined);
    const apps = (allAccessRoutes ?? []).filter(r => r?.id != null && workspacePages([r]).some(p => p.section !== 'reports'));
    const route = apps.find(item => item.id === selected);
    return h('section', { style: { padding: 32 } },
      h('h1', null, allowConfigUI ? 'Build UI' : 'Không có quyền truy cập'),
      h('p', null, allowConfigUI ? 'Chọn một trang trong cây bên trái để thiết kế giao diện.' : 'Trang này dành cho builder có quyền thiết kế giao diện.'),
      allowConfigUI ? h('p', null, h(router.Link, { to: '/admin/settings/multi-portal' }, 'Mở quản lý Multi-Portal →')) : null,
      allowConfigUI && workspace ? h(antd.Card, { title: 'Nút tạo nhanh trên Workspace', style: { maxWidth: 520, marginTop: 20 } },
        h(antd.Select, { 'aria-label': 'Ứng dụng cần cấu hình', placeholder: 'Chọn ứng dụng', style: { width: '100%' },
          value: selected, onChange: setSelected, options: apps.map(item => ({ value: item.id, label: item.title })) }),
        route ? h(QuickCreateSettings, { key: route.id, route, refresh }) : null) : null);
  }
  app.router.add('admin.lattice-builder', { path: BUILDER_PATH, Component: BuilderLanding });

  function BuilderShell({ model }) {
    const { allowConfigUI } = client.useUIConfigurationPermissions();
    const { allAccessRoutes } = client.useAllAccessDesktopRoutes();
    const { designable, setDesignable } = (typeof client.useDesignable === 'function' ? client.useDesignable() : null) || {};
    const { pathname } = router.useLocation();
    const api = useApi();
    const navigate = useNav();
    const [portals, setPortals] = React.useState(null);
    const [loadFallback, setLoadFallback] = React.useState(false);
    const portalsRef = React.useRef(null);
    const fetchedKeyRef = React.useRef(null);
    const inFlightKeyRef = React.useRef(null);
    const requestSeqRef = React.useRef(0);
    const recoveryAttemptedRef = React.useRef('');
    const lastCheckedPathRef = React.useRef('');
    const portalList = Array.isArray(portals) ? portals : [];
    const desiredSettings = React.useRef('keep');
    const syncing = React.useRef(Promise.resolve());
    const configMode = /^\/admin\/settings(?:\/|$)/.test(pathname);
    const workspaceMode = pathname === WORKSPACE_PATH || pathname.startsWith(WORKSPACE_PATH + '/popups/');
    const isAdminRoot = pathname === '/admin' || pathname === '/admin/';

    React.useEffect(() => {
      if (!model.layout?.uid && Array.isArray(allAccessRoutes)) model.syncMenuRoutes?.(allAccessRoutes);
    }, [allAccessRoutes, model]);

    React.useEffect(() => {
      let active = true;
      const media = typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia('(max-width: 767px)') : null;
      const apply = () => {
        if (!active) return;
        const isMobile = Boolean(media?.matches);
        if (model && model.isMobileLayout !== isMobile) {
          model.setIsMobileLayout?.(isMobile);
        }
        if (!allowConfigUI) portalManager?.requestBuilderMode?.(false);
        const forceDisable = !allowConfigUI || configMode || workspaceMode || isMobile;
        const wantBuilder = !forceDisable && Boolean(portalManager?.consumeBuilderIntent?.());
        if (wantBuilder) setDesignable?.(true);
        desiredSettings.current = forceDisable ? 'disable' : (designable || wantBuilder ? 'enable' : 'keep');
        syncing.current = syncing.current.catch(() => {}).then(async () => {
          if (!active) return;
          const mode = desiredSettings.current;
          const applyFlow = m => (m === 'enable' ? app.flowEngine.flowSettings?.enable?.()
            : m === 'disable' ? app.flowEngine.flowSettings?.disable?.() : null);
          await applyFlow(mode);
          if (active && desiredSettings.current !== mode) await applyFlow(desiredSettings.current);
        }).catch(() => {});
      };
      apply();
      media?.addEventListener?.('change', apply);
      return () => { active = false; media?.removeEventListener?.('change', apply); };
    }, [allowConfigUI, designable, configMode, workspaceMode, model]);

    React.useEffect(() => {
      portalManager?.setPermissions?.(Boolean(allowConfigUI));
      const fetchKey = `${api?.auth?.role ?? ''}:${Boolean(allowConfigUI)}`;
      if (!api || typeof api.request !== 'function') {
        if (portalsRef.current === null) {
          portalsRef.current = [];
          setPortals([]);
        }
        return undefined;
      }
      if (fetchedKeyRef.current === fetchKey && Array.isArray(portalsRef.current)) {
        return undefined;
      }
      if (inFlightKeyRef.current === fetchKey) {
        return undefined;
      }
      inFlightKeyRef.current = fetchKey;
      const seq = ++requestSeqRef.current;
      let active = true;
      api.request({ url: 'latticePortals:listAccessible', method: 'get', skipNotify: true }).then(res => {
        if (!active || seq !== requestSeqRef.current) return;
        inFlightKeyRef.current = null;
        const items = Array.isArray(res?.data?.data) ? res.data.data : [];
        fetchedKeyRef.current = fetchKey;
        portalsRef.current = items;
        setPortals(items);
        portalManager?.setPortals?.(items);
        portalManager?.ensureDynamicLayoutsRegistered?.(items);
      }).catch(() => {
        if (inFlightKeyRef.current === fetchKey) inFlightKeyRef.current = null;
        if (!active || seq !== requestSeqRef.current) return;
        if (portalsRef.current === null) {
          portalsRef.current = [];
          setPortals([]);
        }
      });
      return () => { active = false; };
    }, [api, api?.auth?.role, allowConfigUI]);

    React.useEffect(() => {
      if (allowConfigUI || !isAdminRoot || !navigate) return;
      if (!api || typeof api.request !== 'function') {
        navigate(WORKSPACE_PATH, { replace: true });
        return;
      }
      if (portals === null) return;
      const dest = landingPath(portalList);
      if (dest !== pathname) goPortal(dest, navigate, { replace: true });
    }, [isAdminRoot, allowConfigUI, portals, pathname, navigate, api]);

    const portalMatch = /^\/p\/([^/?#]+)/.exec(pathname);
    const activeAccessiblePortal = portalMatch ? portalList.find(p => p.routePath === '/p/' + portalMatch[1] && p.firstPagePath) : null;
    const redirectTarget = portals !== null ? resolvePortalRedirect(portalList, pathname, allowConfigUI) : null;

    React.useEffect(() => {
      if (!redirectTarget || !navigate) return;
      goPortal(redirectTarget, navigate, { replace: true });
    }, [redirectTarget, navigate]);

    React.useEffect(() => {
      if (lastCheckedPathRef.current !== pathname) {
        lastCheckedPathRef.current = pathname;
        if (loadFallback) setLoadFallback(false);
      }
      if (typeof document === 'undefined' || !activeAccessiblePortal || redirectTarget || configMode || workspaceMode) {
        return undefined;
      }
      let active = true;
      let retryTimer = null;
      const isContentBlank = () => {
        const container = document.querySelector?.('main')
          || document.querySelector?.('.ant-layout-content')
          || document.querySelector?.('#nocobase-app-container');
        if (!container) return false;
        const text = String(container.innerText ?? container.textContent ?? '').trim();
        if (text.length > 0) return false;
        const hasBlocks = Boolean(container.querySelector?.('table, form, canvas, input, button, [role="grid"], .ant-card, .ant-empty, .ant-result, .ant-alert'));
        return !hasBlocks;
      };
      const settleTimer = setTimeout(() => {
        if (!active || !isContentBlank()) return;
        if (recoveryAttemptedRef.current !== pathname) {
          recoveryAttemptedRef.current = pathname;
          try {
            const layoutUid = model?.layout?.uid || activeAccessiblePortal?.uid;
            if (layoutUid && typeof app?.flowEngine?.loadModel === 'function') {
              Promise.resolve(app.flowEngine.loadModel(layoutUid)).catch(() => {});
            }
            model?.flowEngine?.loadModel?.(layoutUid)?.catch?.(() => {});
          } catch {}
          retryTimer = setTimeout(() => {
            if (!active) return;
            if (isContentBlank()) setLoadFallback(true);
          }, 800);
          return;
        }
        setLoadFallback(true);
      }, 2500);
      return () => {
        active = false;
        clearTimeout(settleTimer);
        if (retryTimer) clearTimeout(retryTimer);
      };
    }, [pathname, activeAccessiblePortal, redirectTarget, configMode, workspaceMode, model, loadFallback]);

    if ((!allowConfigUI && isAdminRoot) || redirectTarget) return redirectNotice();

    const ShellModel = isPortalModel(model) ? V2Model : NativeModel;
    const isEmptyEmployeePortal = Boolean(portals !== null && !allowConfigUI && portalMatch && !activeAccessiblePortal);
    const emptyPortalCard = isEmptyEmployeePortal ? h('div', {
      'data-testid': 'ldx-empty-portal-fallback',
      style: {
        maxWidth: 680, margin: '48px auto', padding: 28, borderRadius: 12,
        background: '#ffffff', border: '1px solid #e2e8f0', boxShadow: '0 4px 16px rgba(15,23,42,0.06)',
        display: 'grid', gap: 12,
      },
    },
      h('h2', { style: { margin: 0, fontSize: 18, color: '#0f172a' } }, 'Không gian này hiện chưa có trang làm việc cho vai trò của bạn'),
      h('p', { style: { margin: 0, fontSize: 13, color: '#475569' } },
        'Các phân hệ nghiệp vụ được hiển thị theo quyền hạn của tài khoản hiện tại. Vui lòng chọn cổng làm việc được cấp quyền bên dưới.'),
      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 4 } },
        portalList.filter(p => p?.firstPagePath).map(p => h('button', {
          key: p.uid || p.routePath,
          type: 'button',
          onClick: () => goPortal(p.firstPagePath, navigate),
          style: {
            padding: '7px 14px', borderRadius: 8, border: '1px solid #1677ff',
            background: '#eff6ff', color: '#1d4ed8', fontWeight: 600, fontSize: 13, cursor: 'pointer',
          },
        }, p.title || p.routePath)),
        h('button', {
          type: 'button',
          onClick: () => goPortal(WORKSPACE_PATH, navigate),
          style: {
            padding: '7px 14px', borderRadius: 8, border: '1px solid #cbd5e1',
            background: '#ffffff', color: '#334155', fontWeight: 600, fontSize: 13, cursor: 'pointer',
          },
        }, 'Về Không gian việc của tôi'),
      ),
    ) : null;
    const loadFallbackBanner = loadFallback && !isEmptyEmployeePortal ? h('div', {
      'data-testid': 'ldx-portal-load-fallback',
      role: 'alert',
      style: {
        position: 'fixed', top: 64, left: '50%', transform: 'translateX(-50%)', zIndex: 950,
        maxWidth: 560, width: 'calc(100% - 32px)', padding: '16px 20px', borderRadius: 12,
        background: '#ffffff', border: '1px solid #f59e0b', boxShadow: '0 8px 24px rgba(15,23,42,0.12)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap',
      },
    },
      h('div', { style: { display: 'grid', gap: 4 } },
        h('strong', { style: { fontSize: 14, color: '#0f172a' } }, 'Không thể tải đầy đủ giao diện cổng làm việc'),
        h('span', { style: { fontSize: 12, color: '#475569' } }, 'Kết nối tải trang bị gián đoạn. Nhấn tải lại để khôi phục ngay.')),
      h('button', {
        type: 'button',
        onClick: () => {
          setLoadFallback(false);
          if (typeof window !== 'undefined' && typeof window.location?.reload === 'function') {
            window.location.reload();
          } else if (navigate) {
            navigate(pathname, { replace: true });
          }
        },
        style: {
          padding: '7px 14px', borderRadius: 8, border: '1px solid #1677ff',
          background: '#1677ff', color: '#ffffff', fontWeight: 600, fontSize: 13, cursor: 'pointer',
        },
      }, 'Tải lại trang'),
    ) : null;
    const nativeShell = emptyPortalCard || ShellModel.prototype.render.call(model);
    const switcher = !portalManager?.hasTopbarSwitcher && !configMode && portalManager?.PortalBar
      ? h(portalManager.PortalBar, { portals: portalList, currentLayoutUid: model?.layout?.uid, pathname, allowConfigUI, onSwitch: dest => goPortal(dest, navigate) })
      : null;
    const attribution = configMode ? null : h('footer', {
      className: 'ldx-clause52-attribution', 'aria-label': 'NocoBase attribution',
      style: {
        position: 'fixed', left: '50%', transform: 'translateX(-50%)', bottom: 6, zIndex: 900, pointerEvents: 'auto',
        fontSize: 11, color: '#64748b', background: 'rgba(255,255,255,0.92)',
        border: '1px solid #e2e8f0', borderRadius: 6, padding: '2px 10px',
      },
    }, 'Powered by ', h('a', {
      href: 'https://www.nocobase.com', target: '_blank', rel: 'noreferrer',
      style: { color: '#1677ff', textDecoration: 'none', fontWeight: 500 },
    }, 'NocoBase'));
    return h(Fragment, null, nativeShell, loadFallbackBanner, switcher, attribution);
  }

  function PortalAdminProvider({ children }) {
    const { pathname } = router.useLocation();
    const isAdminRoot = pathname === '/admin' || pathname === '/admin/';
    const syncAllow = Boolean(client.useUIConfigurationPermissions()?.allowConfigUI);
    const api = useApi();
    const navigate = useNav();
    const [verified, setVerified] = React.useState(false);

    React.useEffect(() => {
      if (!isAdminRoot) { setVerified(false); return; }
      if (!api || typeof api.request !== 'function') {
        if (!syncAllow && navigate) navigate(WORKSPACE_PATH, { replace: true });
        else setVerified(true);
        return;
      }
      let active = true;
      let unauthorized = false;
      Promise.all([
        api.request({ url: 'roles:check', method: 'get' }).catch(err => {
          if (err?.response?.status === 401 || err?.status === 401) unauthorized = true;
          return null;
        }),
        api.request({ url: 'latticePortals:listAccessible', method: 'get', skipNotify: true }).catch(() => null),
      ]).then(([roleRes, portalRes]) => {
        if (!active) return;
        if (unauthorized) { setVerified(true); return; }
        const rData = roleRes?.data?.data;
        const snippets = Array.isArray(rData?.snippets) ? rData.snippets : [];
        const hasRoleCheck = rData && !Array.isArray(rData) &&
          (typeof rData.allowAll === 'boolean' || typeof rData.allowConfigure === 'boolean' || Array.isArray(rData.snippets));
        const hasBuilderSnippet = (!snippets.includes('!ui.*') && snippets.includes('ui.*')) || snippets.includes('pm') || snippets.includes('pm.*');
        const isBuilder = hasRoleCheck ? Boolean(rData.allowAll || rData.allowConfigure || hasBuilderSnippet) : syncAllow;
        const items = Array.isArray(portalRes?.data?.data) ? portalRes.data.data : [];
        portalManager?.setPermissions?.(isBuilder); portalManager?.setPortals?.(items); portalManager?.ensureDynamicLayoutsRegistered?.(items);
        if (!isBuilder && navigate) { goPortal(landingPath(items), navigate, { replace: true }); return; }
        setVerified(true);
      });
      return () => { active = false; };
    }, [isAdminRoot, syncAllow, api, navigate]);
    return isAdminRoot && !verified ? redirectNotice() : h(client.AdminProvider, null, children);
  }

  class BuilderLayoutModel extends NativeModel {
    addSubModel(subKey, opts) {
      const nextOpts = isPortalModel(this) ? rewriteMenuSubModel(subKey, opts) : opts;
      return typeof super.addSubModel === 'function' ? super.addSubModel(subKey, nextOpts) : nextOpts;
    }
    syncMenuRoutes(routes) {
      return isPortalModel(this) && typeof V2Model.prototype.syncMenuRoutes === 'function'
        ? V2Model.prototype.syncMenuRoutes.call(this, routes) : (typeof super.syncMenuRoutes === 'function' ? super.syncMenuRoutes(routes) : undefined);
    }
    toProLayoutRoute(opts) {
      return isPortalModel(this) && typeof V2Model.prototype.toProLayoutRoute === 'function'
        ? V2Model.prototype.toProLayoutRoute.call(this, opts) : (typeof super.toProLayoutRoute === 'function' ? super.toProLayoutRoute(opts) : { path: '/', children: [] });
    }
    render() { return h(PortalAdminProvider, null, h(BuilderShell, { model: this })); }
  }
  if (typeof app.flowEngine.registerModels === 'function') {
    const models = { AdminLayoutModel: BuilderLayoutModel };
    if (hasPortalMenuItem) {
      models.LatticePortalMenuItemModel = class LatticePortalMenuItemModel extends V2MenuItem {
        addSubModel(subKey, opts) { return super.addSubModel(subKey, rewriteMenuSubModel(subKey, opts)); }
      };
    }
    app.flowEngine.registerModels(models);
  }
  return function BuilderAdminLayout(props) {
    const model = clientV2.getAdminLayoutModel(app.flowEngine, { create: true, props, use: BuilderLayoutModel });
    return h(flow.FlowModelRenderer, { model });
  };
}

module.exports = { pageTree, hostPath, firstSettingsPath, resolvePortalRedirect, createNativeBuilderNavigation, BUILDER_PATH };
