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
  { id: 'portal-work', label: 'Không gian Làm việc (Work Portal)', keywords: 'cong viec work portal', path: '/p/work', category: 'Cổng tác nghiệp' },
  { id: 'portal-procurement', label: 'Cổng Mua sắm (Procurement)', keywords: 'mua sam procurement yeu cau don hang', path: '/p/procurement', category: 'Cổng tác nghiệp' },
  { id: 'portal-logistics', label: 'Cổng Logistics & Kho vận', keywords: 'logistics van chuyen don hang', path: '/p/logistics', category: 'Cổng tác nghiệp' },
  { id: 'portal-incidents', label: 'Cổng Giám sát Sự cố IT/OT', keywords: 'su co canh bao kho lanh iot telemetry', path: '/p/incidents', category: 'Cổng tác nghiệp' },
  { id: 'portal-services', label: 'Cổng Dịch vụ Nội bộ & P.A.R.A.', keywords: 'dich vu noi bo para tai lieu knowledge', path: '/p/internal-service', category: 'Cổng tác nghiệp' },
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

function detectIsAdmin(client, app) {
  try {
    const role = app?.apiClient?.auth?.role || client?.useCurrentUserContext?.()?.data?.currentRole || '';
    return ['root', 'admin', 'ldx_admin'].includes(String(role));
  } catch {
    return false;
  }
}

function createCommandPaletteProvider(client, React, _antd, app) {
  const h = React.createElement;
  const useApi = typeof client?.useAPIClient === 'function' ? client.useAPIClient : () => app?.apiClient || null;

  return function LatticeCommandPaletteProvider(props) {
    const api = useApi();
    const [open, setOpen] = React.useState(false);
    const [query, setQuery] = React.useState('');
    const [searchHits, setSearchHits] = React.useState([]);
    const [activeIndex, setActiveIndex] = React.useState(0);

    const isAdmin = detectIsAdmin(client, app);
    const localMatches = React.useMemo(
      () => filterCommands(DEFAULT_COMMAND_ITEMS, query, { isAdmin }),
      [query, isAdmin],
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
      if (!open || !api?.request) {
        setSearchHits([]);
        return undefined;
      }
      const trimmed = String(query || '').trim();
      if (trimmed.length < 2) {
        setSearchHits([]);
        return undefined;
      }
      let cancelled = false;
      const timer = typeof setTimeout === 'function'
        ? setTimeout(async () => {
            try {
              const res = await api.request({
                url: 'latticePara:hybridSearch',
                method: 'get',
                params: { query: trimmed, limit: 5 },
                skipNotify: true,
              });
              const items = res?.data?.data?.items || res?.data?.items || [];
              if (!cancelled && Array.isArray(items)) {
                setSearchHits(items.map((doc) => ({
                  id: `para-${doc.id}`,
                  label: doc.title || doc.code || `P.A.R.A #${doc.id}`,
                  path: '/p/internal-service',
                  category: `P.A.R.A (${doc.paraSpace || 'docs'})`,
                })));
              }
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
                placeholder: 'Tìm nhanh trang, quy trình hoặc tài liệu P.A.R.A. (Esc để đóng)…',
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
                      background: idx === activeIndex ? '#eff6ff' : 'transparent',
                      color: idx === activeIndex ? '#1d4ed8' : '#0f172a',
                      fontSize: 13,
                    },
                  },
                    h('span', { style: { fontWeight: 600 } }, item.label),
                    h('span', { style: { fontSize: 11, color: '#64748b' } }, item.category || item.path),
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
  createCommandPaletteProvider,
};
