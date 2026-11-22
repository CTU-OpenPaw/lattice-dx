/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { createMultiPortalSettingsPage } = require('./native-portal-settings');

function toPortalSlug(title) {
  return String(title || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36);
}

function renderPortalTile(React, icons, color, iconName, size = 28, label = 'L') {
  const h = React.createElement;
  const IconComp = icons && iconName ? icons[iconName] : null;
  const fallbackText = String(label || iconName || 'P').trim().slice(0, 1).toUpperCase() || 'P';
  return h('span', {
    style: {
      width: size, height: size, borderRadius: Math.max(6, Math.round(size * 0.22)),
      background: color || '#1677ff', color: '#fff', display: 'inline-flex',
      alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      fontSize: Math.round(size * 0.48), fontWeight: 700,
    },
  }, IconComp ? h(IconComp, { style: { fontSize: Math.round(size * 0.54), color: '#fff' } }) : fallbackText);
}

function ensureDynamicLayoutsRegistered(app, portals) {
  const lm = app?.layoutManager;
  if (!lm || typeof lm.registerLayout !== 'function') return [];
  const registered = [];
  for (const portal of Array.isArray(portals) ? portals : []) {
    if (!portal || portal.enabled === false) continue;
    if (!portal.uid || portal.uid === 'admin-layout-model' || portal.uid === 'mobile-layout-model') continue;
    if (!portal.routeName || !portal.routePath) continue;
    if (typeof lm.hasLayout === 'function' && lm.hasLayout(portal.routeName)) continue;
    const isMobile = portal.layoutType === 'mobile';
    try {
      lm.registerLayout({
        routeName: portal.routeName,
        routePath: portal.routePath,
        uid: portal.uid,
        layoutModelClass: isMobile ? 'MobileLayoutModel' : 'AdminLayoutModel',
        rootPageModelClass: isMobile ? 'MobileRootPageModel' : 'RootPageModel',
        childPageModelClass: isMobile ? 'MobileChildPageModel' : 'ChildPageModel',
        authCheck: true,
      });
      registered.push(portal.routeName);
    } catch {}
  }
  return registered;
}

function buildPortalAppList(portals, { allowConfigUI = false, React, icons } = {}) {
  const tile = (color, icon, title) => (React ? renderPortalTile(React, icons, color, icon, 28, title) : icon);
  const items = (Array.isArray(portals) ? portals : [])
    .filter(p => p && p.enabled !== false && (allowConfigUI || p.uid !== 'admin-layout-model'))
    .map(p => ({
      title: p.title,
      url: p.firstPagePath || p.routePath,
      target: '_self',
      icon: tile(p.color || '#1677ff', p.icon || 'AppstoreOutlined', p.title),
    }));
  items.push({
    title: 'Công việc của tôi',
    url: '/admin/lattice-workspace',
    target: '_self',
    icon: tile('#0f766e', 'CheckSquareOutlined', 'W'),
  });
  if (allowConfigUI) {
    items.push({
      title: 'Quản lý Multi-Portal',
      url: '/admin/settings/multi-portal',
      target: '_self',
      icon: tile('#4f46e5', 'SettingOutlined', 'M'),
    });
  }
  return items;
}

function registerPortalSwitcherPlugin(client, React, antd, app, portalsRef, { icons } = {}) {
  const prevLoadAppList = app?.apps?.loadAppList;
  const loadAppList = async () => {
    const currentRole = app?.apiClient?.auth?.role ?? '';
    let portals = portalsRef.current;
    if ((!portals || !portals.length || portalsRef.role !== currentRole) && typeof app?.apiClient?.request === 'function') {
      try {
        const res = await app.apiClient.request({ url: 'latticePortals:listAccessible', method: 'get' });
        portals = Array.isArray(res?.data?.data) ? res.data.data : [];
        portalsRef.current = portals;
        portalsRef.role = currentRole;
        ensureDynamicLayoutsRegistered(app, portals);
      } catch { portals = []; }
    }
    const items = buildPortalAppList(portals, { allowConfigUI: Boolean(portalsRef.allowConfigUI), React, icons });
    let extra = [];
    if (typeof prevLoadAppList === 'function') {
      try {
        const res = await prevLoadAppList();
        if (Array.isArray(res)) extra = res;
      } catch {}
    }
    const seen = new Set(items.map(i => i.url));
    return [...items, ...extra.filter(i => i && !seen.has(i.url))];
  };
  if (app) app.apps = { ...app.apps, loadAppList };
  return loadAppList;
}

function createNativePortalManager(client, React, antd, app, router, icons, { clientV2 } = {}) {
  if (!React?.createElement || !app) return null;
  const h = React.createElement;
  const portalsRef = { current: [], allowConfigUI: false, role: null };
  const startupRouteNames = new Set();
  const listeners = new Set();
  const builderIntentRef = { current: false };
  let preloaded = false;
  const renderTile = (color, iconName, size, label) => renderPortalTile(React, icons, color, iconName, size, label);
  const syncPortals = items => {
    if (!Array.isArray(items)) return;
    portalsRef.current = items;
    portalsRef.role = app?.apiClient?.auth?.role ?? '';
    ensureDynamicLayoutsRegistered(app, items);
    ensureLayoutModelsReady();
    listeners.forEach(fn => { try { fn(); } catch {} });
  };
  const upsertPortal = saved => {
    if (!saved || !saved.uid) return;
    const prev = portalsRef.current.map(p => (saved.isDefault && p.uid !== saved.uid ? { ...p, isDefault: false } : p));
    const idx = prev.findIndex(p => p.uid === saved.uid);
    const merged = idx >= 0
      ? prev.map((p, i) => (i === idx ? { ...p, ...saved, firstPagePath: saved.firstPagePath ?? p.firstPagePath } : p))
      : [...prev, saved];
    syncPortals(merged);
  };
  function ensureLayoutModelsReady() {
    if (typeof app?.flowEngine?.createModel !== 'function' || typeof app?.flowEngine?.getModel !== 'function') return;
    for (const layout of app?.layoutManager?.listLayouts?.() || []) {
      if (layout?.uid && layout.uid !== 'admin-layout-model' && layout.layoutModelClass === 'AdminLayoutModel' && !app.flowEngine.getModel(layout.uid)) {
        try { app.flowEngine.createModel({ uid: layout.uid, use: 'AdminLayoutModel', props: { layout } }); } catch {}
      }
    }
  }
  async function preloadPortals() {
    if (typeof app?.apiClient?.request !== 'function') return [];
    try {
      const res = await app.apiClient.request({ url: 'uiLayouts:listEnabled', method: 'get', skipNotify: true });
      const rows = Array.isArray(res?.data?.data) ? res.data.data : [];
      ensureDynamicLayoutsRegistered(app, rows);
      preloaded = true;
      for (const r of rows) {
        if (r && r.enabled !== false && r.routeName && r.uid !== 'admin-layout-model' && r.uid !== 'mobile-layout-model') {
          startupRouteNames.add(r.routeName);
        }
      }
      return rows;
    } catch { return []; }
  }
  function navigateToPortal(dest, navigate, opts) {
    const m = /^\/p\/([^/?#]+)/.exec(String(dest || ''));
    const fullUrl = app?.getRouteUrl?.(dest) || dest;
    const hotPortal = Boolean(m && (preloaded || startupRouteNames.size > 0) && (() => {
      const portal = portalsRef.current.find(p => p.routePath === '/p/' + m[1]);
      const routeName = portal?.routeName || ('p_' + m[1].replace(/-/g, '_'));
      return !startupRouteNames.has(routeName);
    })());
    if ((hotPortal || typeof navigate !== 'function') && typeof window !== 'undefined' && window.location) {
      if (opts?.replace && typeof window.location.replace === 'function') window.location.replace(fullUrl);
      else window.location.assign?.(fullUrl);
      return;
    }
    navigate?.(dest, opts);
  }
  function requestBuilderMode(flag) {
    const enabled = Boolean(flag);
    builderIntentRef.current = enabled;
    try {
      window?.localStorage?.setItem('NOCOBASE_V2_FLOW_SETTINGS_ENABLED', enabled ? '1' : '0');
      if (typeof CustomEvent === 'function' && typeof window?.dispatchEvent === 'function') {
        window.dispatchEvent(new CustomEvent('nocobase:v2:flow-settings-preference-change', { detail: { enabled } }));
      }
    } catch {}
  }
  function consumeBuilderIntent() {
    const val = builderIntentRef.current;
    builderIntentRef.current = false;
    return val;
  }

  registerPortalSwitcherPlugin(client, React, antd, app, portalsRef, { icons });
  const MultiPortalSettingsPage = createMultiPortalSettingsPage(client, React, antd, app, router, {
    renderTile, toPortalSlug, syncPortals, upsertPortal, navigateToPortal, requestBuilderMode,
  });
  if (app.pluginSettingsManager && typeof app.pluginSettingsManager.add === 'function') {
    app.pluginSettingsManager.add('multi-portal', {
      title: 'Multi-Portal', icon: 'AppstoreOutlined', Component: MultiPortalSettingsPage, aclSnippet: 'pm',
    });
  }

  function PortalBar({ portals, currentLayoutUid, pathname = '', allowConfigUI, onSwitch, variant = 'topbar' }) {
    const rawList = Array.isArray(portals) && portals.length ? portals : portalsRef.current;
    const list = (Array.isArray(rawList) ? rawList : [])
      .filter(p => p && p.enabled !== false && (allowConfigUI || p.uid !== 'admin-layout-model'));
    let activeBadge = list.find(p => p.uid === currentLayoutUid)
      || list.find(p => p.routePath && (pathname === p.routePath || pathname.startsWith(p.routePath + '/')))
      || list[0];
    if (pathname === '/admin/lattice-workspace' || pathname.startsWith('/admin/lattice-workspace/')) {
      activeBadge = { title: 'Công việc của tôi', color: '#0f766e', icon: 'CheckSquareOutlined' };
    } else if (/^\/admin\/settings\/multi-portal(?:\/|$)/.test(pathname)) {
      activeBadge = { title: 'Multi-Portal', color: '#4f46e5', icon: 'SettingOutlined' };
    } else if (/^\/admin\/settings\/dxos-studio(?:\/|$)/.test(pathname)) {
      activeBadge = { title: 'DX-OS Studio', color: '#0f766e', icon: 'ControlOutlined' };
    } else if (/^\/admin\/settings(?:\/|$)/.test(pathname)) {
      activeBadge = { title: 'Cài đặt hệ thống', color: '#475569', icon: 'SettingOutlined' };
    }
    const items = buildPortalAppList(list, { allowConfigUI, React, icons });
    if (!items.length) return null;
    const isTopbar = variant === 'topbar';
    const pillStyle = isTopbar
      ? { display: 'inline-flex', alignItems: 'center', gap: 8, height: 30, lineHeight: 1.2, verticalAlign: 'middle', padding: '0 10px', borderRadius: 6, background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.24)', color: '#ffffff', fontSize: 12, fontWeight: 600, cursor: 'pointer', maxWidth: 220 }
      : { position: 'fixed', left: 12, bottom: 10, zIndex: 900, pointerEvents: 'auto', display: 'inline-flex', alignItems: 'center', gap: 8, padding: '4px 10px', borderRadius: 8, background: '#ffffff', border: '1px solid #cbd5e1', boxShadow: '0 2px 8px rgba(15, 23, 42, 0.1)', color: '#0f172a', fontSize: 12, fontWeight: 600, cursor: 'pointer', maxWidth: 200 };
    const wrapStyle = isTopbar
      ? { display: 'inline-flex', alignItems: 'center', height: 46, verticalAlign: 'middle', lineHeight: 1.2, marginRight: 6 }
      : undefined;
    const label = activeBadge ? activeBadge.title : 'Chuyển Portal';
    const menuItems = items.map((item, idx) => ({
      key: `${idx}:${item.url}`,
      label: h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 8 } }, item.icon, h('span', null, item.title)),
      onClick: () => (onSwitch ? onSwitch(item.url) : navigateToPortal(item.url, null)),
    }));
    const triggerBtn = h('button', {
      type: 'button', 'data-testid': 'portal-switcher-button', style: pillStyle, title: label, onClick: e => e?.stopPropagation?.(),
    }, renderTile(activeBadge?.color || '#1677ff', activeBadge?.icon || 'AppstoreOutlined', 20, label),
      h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, label),
      h('span', { style: { opacity: 0.7, fontSize: 10 } }, isTopbar ? '▾' : '▲'));
    return h('span', { className: 'nb-portal-switcher', 'aria-label': 'Chuyển Portal', style: wrapStyle },
      antd?.Dropdown ? h(antd.Dropdown, { menu: { items: menuItems }, placement: isTopbar ? 'bottomRight' : 'topLeft', trigger: ['click'] }, triggerBtn) : triggerBtn);
  }

  function TopbarPortalSwitcher({ model }) {
    const loc = typeof router?.useLocation === 'function' ? router.useLocation() : null;
    const navigate = typeof router?.useNavigate === 'function' ? router.useNavigate() : null;
    const perms = typeof client?.useUIConfigurationPermissions === 'function' ? client.useUIConfigurationPermissions() : null;
    const api = typeof client?.useAPIClient === 'function' ? client.useAPIClient() : null;
    const allow = Boolean(perms?.allowConfigUI);
    const currentRole = api?.auth?.role ?? '';
    const [, bump] = React.useState(0);
    React.useEffect(() => {
      const fn = () => bump(n => n + 1);
      listeners.add(fn);
      if ((!portalsRef.current.length || portalsRef.role !== currentRole) && typeof api?.request === 'function') {
        api.request({ url: 'latticePortals:listAccessible', method: 'get' }).then(res => syncPortals(res?.data?.data || [])).catch(() => {});
      }
      return () => { listeners.delete(fn); };
    }, [api, currentRole]);
    return h(PortalBar, {
      portals: portalsRef.current, currentLayoutUid: model?.parent?.layout?.uid, pathname: loc?.pathname || '',
      allowConfigUI: allow, variant: 'topbar', onSwitch: dest => navigateToPortal(dest, navigate),
    });
  }

  let hasTopbarSwitcher = false;
  const TopbarBase = clientV2?.TopbarActionModel || app?.flowEngine?.getModelClass?.('TopbarActionModel');
  const AdminBase = clientV2?.AdminLayoutModel || app?.flowEngine?.getModelClass?.('AdminLayoutModel');
  if (typeof TopbarBase === 'function' && TopbarBase !== AdminBase && typeof app?.flowEngine?.registerModels === 'function') {
    class PortalSwitcherTopbarActionModel extends TopbarBase {
      constructor(...args) { super(...args); this.sort = -50; this.actionId = 'portal-switcher'; this.testId = 'portal-switcher-button'; }
      render() { return h(TopbarPortalSwitcher, { model: this }); }
    }
    app.flowEngine.registerModels({ PortalSwitcherTopbarActionModel });
    hasTopbarSwitcher = true;
  }
  const existingSwitcherPanel = app?.flowEngine?.getModelClass?.('AppSwitcherActionPanelModel');
  if (typeof clientV2?.AppSwitcherActionPanelModel === 'function' && typeof app?.flowEngine?.registerModels === 'function' && (!existingSwitcherPanel || existingSwitcherPanel === AdminBase)) {
    app.flowEngine.registerModels({ AppSwitcherActionPanelModel: clientV2.AppSwitcherActionPanelModel });
  }
  if (client?.PinnedPluginListProvider && typeof app?.use === 'function') {
    app.use(client.PinnedPluginListProvider, {
      items: {
        ldxPortalSwitcher: { order: -50, component: TopbarPortalSwitcher, pin: true, snippet: '*' },
      },
    });
    hasTopbarSwitcher = true;
  }

  return {
    MultiPortalSettingsPage, PortalBar, TopbarPortalSwitcher, hasTopbarSwitcher, preloadPortals,
    navigateToPortal, requestBuilderMode, consumeBuilderIntent, setPortals: syncPortals, upsertPortal,
    ensureLayoutModelsReady, setPermissions: allow => { portalsRef.allowConfigUI = Boolean(allow); },
    ensureDynamicLayoutsRegistered: items => ensureDynamicLayoutsRegistered(app, items),
    getPortals: () => portalsRef.current,
  };
}

function resolveLegacyMobileRedirect(win, app) {
  if (!win || win.__nocobase_app_client_entry_mode__ !== 'legacy-default') return null;
  if (app?.layoutManager?.hasLayout?.('mobile')) return null;
  const pathname = String(win.location?.pathname || '');
  if (pathname !== '/mobile' && !pathname.startsWith('/mobile/')) return null;
  if (pathname.includes('..') || pathname.includes('\\')) return null;
  const rawPrefix = String(win.__nocobase_modern_client_prefix__ || 'v').replace(/^\/+|\/+$/g, '');
  const prefix = /^[a-zA-Z0-9_-]{1,32}$/.test(rawPrefix) ? rawPrefix : 'v';
  const search = typeof win.location?.search === 'string' ? win.location.search : '';
  const hash = typeof win.location?.hash === 'string' ? win.location.hash : '';
  return `/${prefix}${pathname}${search}${hash}`;
}

module.exports = {
  toPortalSlug,
  renderPortalTile,
  ensureDynamicLayoutsRegistered,
  buildPortalAppList,
  registerPortalSwitcherPlugin,
  createNativePortalManager,
  resolveLegacyMobileRedirect,
};
