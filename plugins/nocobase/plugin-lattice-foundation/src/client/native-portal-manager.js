/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
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
    .filter(p => p && p.enabled !== false)
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
    let portals = portalsRef.current;
    if ((!portals || !portals.length) && typeof app?.apiClient?.request === 'function') {
      try {
        const res = await app.apiClient.request({ url: 'latticePortals:listAccessible', method: 'get' });
        portals = Array.isArray(res?.data?.data) ? res.data.data : [];
        portalsRef.current = portals;
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

function createNativePortalManager(client, React, antd, app, router, icons) {
  if (!React?.createElement || !app) return null;
  const h = React.createElement;
  const portalsRef = { current: [], allowConfigUI: false };
  const renderTile = (color, iconName, size, label) => renderPortalTile(React, icons, color, iconName, size, label);
  const syncPortals = items => {
    if (!Array.isArray(items)) return;
    portalsRef.current = items;
    ensureDynamicLayoutsRegistered(app, items);
  };

  registerPortalSwitcherPlugin(client, React, antd, app, portalsRef, { icons });

  const MultiPortalSettingsPage = createMultiPortalSettingsPage(client, React, antd, app, router, {
    renderTile, toPortalSlug, syncPortals,
  });

  if (app.pluginSettingsManager && typeof app.pluginSettingsManager.add === 'function') {
    app.pluginSettingsManager.add('multi-portal', {
      title: 'Multi-Portal',
      icon: 'AppstoreOutlined',
      Component: MultiPortalSettingsPage,
      aclSnippet: 'pm',
    });
  }

  function PortalBar({ portals, currentLayoutUid, pathname, allowConfigUI, onSwitch }) {
    const rawList = Array.isArray(portals) && portals.length ? portals : portalsRef.current;
    const list = (Array.isArray(rawList) ? rawList : []).filter(p => p && p.enabled !== false);
    const active = list.find(p => p.uid === currentLayoutUid)
      || list.find(p => p.routePath && (pathname === p.routePath || pathname.startsWith(p.routePath + '/')))
      || list[0];
    const items = buildPortalAppList(list, { allowConfigUI, React, icons });
    if (!items.length) return null;

    const pillStyle = {
      position: 'fixed', left: 12, bottom: 10, zIndex: 900, pointerEvents: 'auto',
      display: 'inline-flex', alignItems: 'center', gap: 8, padding: '4px 10px',
      borderRadius: 8, background: '#ffffff', border: '1px solid #cbd5e1',
      boxShadow: '0 2px 8px rgba(15, 23, 42, 0.1)', color: '#0f172a',
      fontSize: 12, fontWeight: 600, cursor: 'pointer', maxWidth: 184,
    };

    const label = active ? active.title : 'Chuyển Portal';
    const menuItems = items.map((item, idx) => ({
      key: `${idx}:${item.url}`,
      label: h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 8 } },
        item.icon, h('span', null, item.title)),
      onClick: () => onSwitch?.(item.url),
    }));

    if (antd?.Dropdown) {
      return h('div', { className: 'nb-portal-switcher', 'aria-label': 'Chuyển Portal' },
        h(antd.Dropdown, { menu: { items: menuItems }, placement: 'topLeft', trigger: ['click'] },
          h('button', { type: 'button', style: pillStyle, title: label },
            renderTile(active?.color || '#1677ff', active?.icon || 'AppstoreOutlined', 20, label),
            h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, label),
            h('span', { style: { opacity: 0.6, fontSize: 10 } }, '▲'))));
    }
    return h('div', { className: 'nb-portal-switcher', 'aria-label': 'Chuyển Portal' },
      h('button', { type: 'button', style: pillStyle, onClick: () => onSwitch?.(items[0].url) }, label));
  }

  return {
    MultiPortalSettingsPage,
    PortalBar,
    setPortals: syncPortals,
    setPermissions: allow => { portalsRef.allowConfigUI = Boolean(allow); },
    ensureDynamicLayoutsRegistered: items => ensureDynamicLayoutsRegistered(app, items),
    getPortals: () => portalsRef.current,
  };
}

module.exports = {
  toPortalSlug,
  renderPortalTile,
  ensureDynamicLayoutsRegistered,
  buildPortalAppList,
  registerPortalSwitcherPlugin,
  createNativePortalManager,
};
