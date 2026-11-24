/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { isSafeAppPath } = require('./blocks-helpers');

const DEFAULT_COMMAND_ITEMS = [
  { id: 'portal-workspace', label: 'Không gian Làm việc', keywords: 'cong viec work workspace khong gian lam viec', path: '/admin/lattice-workspace', category: 'Cổng tác nghiệp' },
  { id: 'portal-procurement', label: 'Cổng Mua sắm (Procurement)', keywords: 'mua sam procurement yeu cau don hang', path: '/p/procurement', category: 'Cổng tác nghiệp' },
  { id: 'portal-services', label: 'Cổng Dịch vụ Nội bộ & P.A.R.A.', keywords: 'dich vu noi bo para tai lieu knowledge services', path: '/p/services', category: 'Cổng tác nghiệp' },
  { id: 'admin-studio', label: 'DX-OS Control Studio (Workflows · Outbox · GitOps)', keywords: 'studio workflow outbox dlq gitops bundle', path: '/admin/settings/dxos-studio', category: 'Quản trị', adminOnly: true },
  { id: 'admin-ai', label: 'AI Workforce & Quota Center', keywords: 'ai agent mcp quota audit', path: '/admin/settings/dxos-ai', category: 'Quản trị', adminOnly: true },
];

function foldVi(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .trim();
}

function filterCommands(items, query, { isAdmin = false } = {}) {
  const q = foldVi(query);
  const out = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== 'object') continue;
    if (item.adminOnly && !isAdmin) continue;
    if (!isSafeAppPath(item.path)) continue;
    if (q) {
      const hay = foldVi(`${item.label || ''} ${item.keywords || ''} ${item.path || ''} ${item.category || ''}`);
      if (!hay.includes(q)) continue;
    }
    out.push(item);
  }
  return out;
}

function detectIsAdmin(client, app, userCtx) {
  try {
    const hasExplicitUserCtx = arguments.length >= 3;
    const ctxRole = hasExplicitUserCtx
      ? userCtx?.data?.currentRole
      : (typeof client?.useCurrentUserContext === 'function' ? client.useCurrentUserContext()?.data?.currentRole : undefined);
    const role = app?.apiClient?.auth?.role || ctxRole || '';
    return ['root', 'admin', 'ldx_admin'].includes(String(role));
  } catch {
    return false;
  }
}

function buildDynamicCommandItems(portals, { isAdmin = false } = {}) {
  const out = [];
  const seenPaths = new Set();
  const pushUnique = (item) => {
    if (!item || !isSafeAppPath(item.path) || seenPaths.has(item.path)) return;
    if (item.adminOnly && !isAdmin) return;
    seenPaths.add(item.path);
    out.push(item);
  };

  for (const p of Array.isArray(portals) ? portals : []) {
    if (!p || typeof p !== 'object' || p.enabled === false) continue;
    if (p.uid === 'mobile-layout-model' || p.layoutType === 'mobile') continue;
    if (p.uid === 'admin-layout-model' && !isAdmin) continue;
    const targetPath = isSafeAppPath(p.firstPagePath)
      ? p.firstPagePath
      : (isSafeAppPath(p.routePath) ? p.routePath : '');
    if (!targetPath) continue;
    pushUnique({
      id: `portal-${p.slug || p.uid || targetPath}`,
      label: p.title || p.slug || targetPath,
      keywords: [p.slug, p.routePath, p.description, p.uid].filter(Boolean).join(' '),
      path: targetPath,
      category: 'Cổng tác nghiệp',
    });
  }

  pushUnique(DEFAULT_COMMAND_ITEMS[0]);
  if (isAdmin) {
    for (const item of DEFAULT_COMMAND_ITEMS) {
      if (item.adminOnly) pushUnique(item);
    }
  }
  return out;
}

function mergeSearchHits(paraDocs = [], globalItems = []) {
  const out = [];
  const seenKeys = new Set();

  for (const doc of Array.isArray(paraDocs) ? paraDocs : []) {
    if (!doc || typeof doc !== 'object') continue;
    const key = doc.id != null ? `latticeParaDocuments:${doc.id}` : `para-label:${doc.title || doc.code}`;
    if (seenKeys.has(key)) continue;
    const targetPath = doc.id != null ? `/p/services?paraDocId=${encodeURIComponent(String(doc.id))}` : '/p/services';
    if (!isSafeAppPath(targetPath)) continue;
    seenKeys.add(key);
    out.push({
      id: `para-${doc.id ?? out.length}`,
      label: doc.title || doc.code || `P.A.R.A #${doc.id}`,
      path: targetPath,
      category: `P.A.R.A (${doc.paraSpace || 'docs'})`,
    });
  }

  for (const item of Array.isArray(globalItems) ? globalItems : []) {
    if (!item || typeof item !== 'object' || !isSafeAppPath(item.path)) continue;
    const key = item.collection && item.id != null ? `${item.collection}:${item.id}` : `${item.path}:${item.title || item.code}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    const title = String(item.title || '').trim();
    const code = String(item.code || '').trim();
    const label = code && title && !title.includes(code)
      ? `${code} — ${title}`
      : (title || code || `${item.collection || 'record'} #${item.id ?? ''}`);
    out.push({
      id: `rec-${key}`,
      label,
      path: item.path,
      category: item.category || item.collection || 'Bản ghi',
    });
  }

  return out;
}

function createCommandPaletteProvider(client, React, _antd, app) {
  const h = React.createElement;
  const useApi = typeof client?.useAPIClient === 'function' ? client.useAPIClient : () => app?.apiClient || null;
  const useCurrentUser = typeof client?.useCurrentUserContext === 'function'
    ? client.useCurrentUserContext
    : () => null;

  return function LatticeCommandPaletteProvider(props) {
    const api = useApi();
    let userCtx = null;
    try {
      userCtx = useCurrentUser();
    } catch {
      userCtx = null;
    }
    const [open, setOpen] = React.useState(false);
    const [query, setQuery] = React.useState('');
    const [portalItems, setPortalItems] = React.useState(null);
    const [searchHits, setSearchHits] = React.useState([]);
    const [activeIndex, setActiveIndex] = React.useState(0);

    const isAdmin = detectIsAdmin(client, app, userCtx);
    const localMatches = React.useMemo(
      () => filterCommands(portalItems || DEFAULT_COMMAND_ITEMS, query, { isAdmin }),
      [portalItems, query, isAdmin],
    );

    const navigateTo = React.useCallback((targetPath) => {
      if (!isSafeAppPath(targetPath)) return;
      setOpen(false);
      setQuery('');
      if (app?.router?.navigate) app.router.navigate(targetPath);
      else if (typeof window !== 'undefined' && window.location) window.location.assign(app?.getRouteUrl?.(targetPath) || targetPath);
    }, []);

    React.useEffect(() => {
      if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined;
      const onKeyDown = (e) => {
        if ((e.metaKey || e.ctrlKey) && String(e.key || '').toLowerCase() === 'k') {
          if (typeof e.preventDefault === 'function') e.preventDefault();
          setOpen((prev) => !prev);
          setActiveIndex(0);
          return;
        }
        if (e.key === 'Escape' && open) {
          setOpen(false);
        }
      };
      window.addEventListener('keydown', onKeyDown);
      return () => {
        if (typeof window.removeEventListener === 'function') window.removeEventListener('keydown', onKeyDown);
      };
    }, [open]);

    React.useEffect(() => {
      if (!open || !api?.request) return undefined;
      let cancelled = false;
      api.request({
        url: 'latticePortals:listAccessible',
        method: 'get',
        skipNotify: true,
      }).then((res) => {
        if (cancelled) return;
        const raw = res?.data?.data ?? res?.data;
        if (Array.isArray(raw)) {
          setPortalItems(buildDynamicCommandItems(raw, { isAdmin }));
        } else {
          setPortalItems(null);
        }
      }).catch(() => {
        if (!cancelled) setPortalItems(null);
      });
      return () => { cancelled = true; };
    }, [open, api, isAdmin]);

    React.useEffect(() => {
      if (!open || !api?.request) {
        setSearchHits([]);
        return undefined;
      }
      const trimmed = String(query || '').trim().slice(0, 120);
      if (trimmed.length < 2) {
        setSearchHits([]);
        return undefined;
      }
      let cancelled = false;
      const timer = typeof setTimeout === 'function'
        ? setTimeout(async () => {
            try {
              const [paraRes, globalRes] = await Promise.allSettled([
                api.request({
                  url: 'latticePara:hybridSearch',
                  method: 'get',
                  params: { query: trimmed, limit: 5 },
                  skipNotify: true,
                }),
                api.request({
                  url: 'dxosBlocks:globalSearch',
                  method: 'get',
                  params: { query: trimmed, limit: 6 },
                  skipNotify: true,
                }),
              ]);
              if (cancelled) return;
              const paraItems = paraRes.status === 'fulfilled'
                ? (paraRes.value?.data?.data?.items || paraRes.value?.data?.items || [])
                : [];
              const globalItems = globalRes.status === 'fulfilled'
                ? (globalRes.value?.data?.data?.items || globalRes.value?.data?.items || [])
                : [];
              setSearchHits(mergeSearchHits(paraItems, globalItems));
            } catch {
              if (!cancelled) setSearchHits([]);
            }
          }, 180)
        : null;
      return () => {
        cancelled = true;
        if (timer && typeof clearTimeout === 'function') clearTimeout(timer);
      };
    }, [open, query, api]);

    const combined = [...localMatches, ...searchHits];

    const onInputKeyDown = (e) => {
      if (e.key === 'ArrowDown') {
        if (typeof e.preventDefault === 'function') e.preventDefault();
        setActiveIndex((prev) => (combined.length ? (prev + 1) % combined.length : 0));
      } else if (e.key === 'ArrowUp') {
        if (typeof e.preventDefault === 'function') e.preventDefault();
        setActiveIndex((prev) => (combined.length ? (prev - 1 + combined.length) % combined.length : 0));
      } else if (e.key === 'Enter' && combined[activeIndex]) {
        if (typeof e.preventDefault === 'function') e.preventDefault();
        navigateTo(combined[activeIndex].path);
      } else if (e.key === 'Escape') {
        setOpen(false);
      }
    };

    const modalNode = open
      ? h('div', {
          'data-testid': 'dxos-command-palette',
          role: 'dialog',
          'aria-modal': true,
          'aria-label': 'LatticeDX Command Palette',
          style: {
            position: 'fixed',
            inset: 0,
            background: 'rgba(15, 23, 42, 0.45)',
            zIndex: 9999,
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'center',
            paddingTop: '12vh',
          },
          onClick: (e) => { if (e.target === e.currentTarget) setOpen(false); },
        },
          h('div', {
            style: {
              width: 'min(580px, 92vw)',
              borderRadius: 12,
              background: '#ffffff',
              border: '1px solid #cbd5e1',
              boxShadow: '0 24px 48px rgba(15, 23, 42, 0.28)',
              overflow: 'hidden',
            },
          },
            h('div', { style: { padding: '12px 14px', borderBottom: '1px solid #e2e8f0', display: 'flex', alignItems: 'center', gap: 10 } },
              h('input', {
                type: 'search',
                autoFocus: true,
                value: query,
                onChange: (e) => { setQuery(e.target.value); setActiveIndex(0); },
                onKeyDown: onInputKeyDown,
                placeholder: 'Tìm nhanh trang, chứng từ, tài sản hoặc P.A.R.A. (Esc để đóng)…',
                style: { width: '100%', border: 'none', outline: 'none', fontSize: 14, color: '#0f172a' },
              }),
            ),
            h('div', { style: { maxHeight: 340, overflowY: 'auto', padding: 8, display: 'grid', gap: 4 } },
              !combined.length
                ? h('div', { style: { padding: 14, textAlign: 'center', fontSize: 13, color: '#64748b' } }, 'Không có kết quả phù hợp.')
                : combined.map((item, idx) => h('div', {
                    key: `${item.id}-${idx}`,
                    role: 'option',
                    'aria-selected': idx === activeIndex,
                    onClick: () => navigateTo(item.path),
                    style: {
                      padding: '8px 12px',
                      borderRadius: 8,
                      cursor: 'pointer',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: 8,
                      background: idx === activeIndex ? '#eff6ff' : 'transparent',
                      color: idx === activeIndex ? '#1d4ed8' : '#0f172a',
                      fontSize: 13,
                    },
                  },
                    h('span', { style: { fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' } }, item.label),
                    h('span', { style: { fontSize: 11, color: '#64748b', whiteSpace: 'nowrap', flexShrink: 0 } }, item.category || item.path),
                  )),
            ),
          ),
        )
      : null;

    if (!modalNode) return props?.children ?? null;
    return h(React.Fragment, null, props?.children ?? null, modalNode);
  };
}

module.exports = {
  DEFAULT_COMMAND_ITEMS,
  foldVi,
  filterCommands,
  buildDynamicCommandItems,
  mergeSearchHits,
  createCommandPaletteProvider,
};
