/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const POLL_INTERVAL_MS = 60_000;

const CATEGORY_TABS = [
  { key: 'all', label: 'Tất cả' },
  { key: 'mention', label: 'Nhắc tên (@)' },
  { key: 'voucher', label: 'Chứng từ' },
  { key: 'sla', label: 'SLA' },
  { key: 'alarm', label: 'Cảnh báo' },
  { key: 'approval', label: 'Phê duyệt' },
  { key: 'system', label: 'Hệ thống' },
];

const SEVERITY_STYLES = {
  critical: { bg: '#fee2e2', color: '#991b1b', label: 'Khẩn cấp' },
  high: { bg: '#ffedd5', color: '#9a3412', label: 'Cao' },
  warning: { bg: '#fef3c7', color: '#92400e', label: 'Cảnh báo' },
  info: { bg: '#e0f2fe', color: '#075985', label: 'Thông tin' },
};

function readCurrentPathname() {
  if (typeof window === 'undefined' || !window.location) return '';
  return String(window.location.pathname || '');
}

function isVisibleBellPath(pathname) {
  const clean = String(pathname || '').split('?')[0].split('#')[0].trim();
  if (!clean || clean === '/signin' || clean.startsWith('/signin/') || clean === '/signup' || clean.startsWith('/signup/')) {
    return false;
  }
  return clean === '/p' || clean.startsWith('/p/') || clean === '/admin' || clean.startsWith('/admin/');
}

function isMobileViewport() {
  if (typeof window === 'undefined') return false;
  if (typeof window.matchMedia === 'function') {
    try {
      return Boolean(window.matchMedia('(max-width: 767px)').matches);
    } catch {}
  }
  return Number(window.innerWidth) > 0 && Number(window.innerWidth) < 768;
}

function isAuthenticatedClient(api) {
  if (!api || typeof api.request !== 'function') return false;
  try {
    if (typeof api.auth?.getToken === 'function' && api.auth.getToken()) return true;
  } catch {}
  if (api.auth?.role && api.auth.role !== 'anonymous') return true;
  try {
    if (typeof localStorage !== 'undefined' && typeof localStorage.getItem === 'function' && localStorage.getItem('NOCOBASE_TOKEN')) {
      return true;
    }
  } catch {}
  return false;
}

function isSafeInternalTargetPath(rawPath) {
  const p = String(rawPath || '').trim();
  return /^\/(?!\/)[^\s\\]{0,500}$/.test(p);
}

function createBellIcon(h) {
  return h('svg', {
    width: 16,
    height: 16,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
  },
    h('path', { d: 'M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9' }),
    h('path', { d: 'M13.73 21a2 2 0 0 1-3.46 0' }),
  );
}

function createNotificationBellProvider(client, React, _antd, app) {
  if (!React || typeof React.createElement !== 'function') return null;
  const h = React.createElement;
  const useApi = typeof client?.useAPIClient === 'function' ? client.useAPIClient : () => app?.apiClient || null;

  return function LatticeNotificationBellProvider({ children } = {}) {
    const api = useApi();
    const [pathname, setPathname] = React.useState(() => readCurrentPathname());
    const [mobile, setMobile] = React.useState(() => isMobileViewport());
    const [open, setOpen] = React.useState(false);
    const [unreadCount, setUnreadCount] = React.useState(0);
    const [items, setItems] = React.useState([]);
    const [category, setCategory] = React.useState('all');
    const [loading, setLoading] = React.useState(false);
    const [authRejected, setAuthRejected] = React.useState(false);

    React.useEffect(() => {
      if (typeof window === 'undefined') return undefined;
      const syncPath = () => {
        const next = readCurrentPathname();
        setPathname((prev) => (prev === next ? prev : next));
      };
      const media = typeof window.matchMedia === 'function' ? window.matchMedia('(max-width: 767px)') : null;
      const syncMobile = () => setMobile(isMobileViewport());
      const unsubRouter = typeof app?.router?.subscribe === 'function' ? app.router.subscribe(syncPath) : null;
      window.addEventListener?.('popstate', syncPath);
      media?.addEventListener?.('change', syncMobile);
      return () => {
        if (typeof unsubRouter === 'function') unsubRouter();
        window.removeEventListener?.('popstate', syncPath);
        media?.removeEventListener?.('change', syncMobile);
      };
    }, []);

    const visible = Boolean(!authRejected && isVisibleBellPath(pathname) && isAuthenticatedClient(api));

    const fetchUnreadCount = React.useCallback(async () => {
      if (!visible || typeof api?.request !== 'function') return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      try {
        const res = await api.request({
          url: 'latticeNotifications:unreadCount',
          method: 'get',
          skipNotify: true,
        });
        const count = Number(res?.data?.data?.unreadCount ?? res?.data?.unreadCount ?? 0);
        if (Number.isFinite(count) && count >= 0) setUnreadCount(count);
      } catch (err) {
        if (Number(err?.response?.status ?? err?.status) === 401) {
          setAuthRejected(true);
        }
      }
    }, [api, visible]);

    const fetchInbox = React.useCallback(async (selectedCategory = category) => {
      if (!visible || typeof api?.request !== 'function') return;
      setLoading(true);
      try {
        const res = await api.request({
          url: 'latticeNotifications:listMine',
          method: 'get',
          params: {
            limit: 30,
            ...(selectedCategory && selectedCategory !== 'all' ? { category: selectedCategory } : {}),
          },
          skipNotify: true,
        });
        const data = res?.data?.data || res?.data || {};
        setItems(Array.isArray(data.items) ? data.items : []);
        if (data.unreadCount != null) {
          setUnreadCount(Math.max(0, Number(data.unreadCount) || 0));
        }
      } catch {
        // Keep existing list on transient fetch errors
      } finally {
        setLoading(false);
      }
    }, [api, visible, category]);

    React.useEffect(() => {
      setAuthRejected(false);
    }, [api?.auth?.role, pathname]);

    React.useEffect(() => {
      if (!visible) {
        setOpen(false);
        return undefined;
      }
      fetchUnreadCount();
      if (typeof window === 'undefined') return undefined;
      const timer = setInterval(() => {
        if (typeof document === 'undefined' || document.visibilityState !== 'hidden') {
          fetchUnreadCount();
        }
      }, POLL_INTERVAL_MS);
      if (typeof timer?.unref === 'function') timer.unref();
      const onVisibility = () => {
        if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
          fetchUnreadCount();
        }
      };
      if (typeof document !== 'undefined') {
        document.addEventListener?.('visibilitychange', onVisibility);
      }
      return () => {
        clearInterval(timer);
        if (typeof document !== 'undefined') {
          document.removeEventListener?.('visibilitychange', onVisibility);
        }
      };
    }, [visible, fetchUnreadCount]);

    const setPopoverOpen = React.useCallback((next) => {
      setOpen(next);
      if (next) fetchInbox(category);
    }, [category, fetchInbox]);

    React.useEffect(() => {
      if (!visible || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined;
      const onKeyDown = (e) => {
        if (e?.altKey && !e.ctrlKey && !e.metaKey && String(e.key || '').toLowerCase() === 'n') {
          e.preventDefault?.();
          setPopoverOpen(!open);
        } else if (e?.key === 'Escape' && open) {
          setOpen(false);
        }
      };
      window.addEventListener('keydown', onKeyDown);
      return () => {
        window.removeEventListener?.('keydown', onKeyDown);
      };
    }, [visible, open, setPopoverOpen]);

    const togglePopover = () => setPopoverOpen(!open);

    const handleCategorySelect = (nextCat) => {
      setCategory(nextCat);
      fetchInbox(nextCat);
    };

    const handleItemClick = async (item) => {
      if (!item) return;
      if (!item.readAt && typeof api?.request === 'function') {
        const nowIso = new Date().toISOString();
        setItems((prev) => prev.map((it) => (it.id === item.id ? { ...it, readAt: nowIso } : it)));
        setUnreadCount((c) => Math.max(0, c - 1));
        try {
          await api.request({
            url: 'latticeNotifications:markRead',
            method: 'post',
            data: { id: item.id },
            skipNotify: true,
          });
        } catch {}
      }
      setOpen(false);
      if (isSafeInternalTargetPath(item.targetPath)) {
        if (typeof app?.router?.navigate === 'function') {
          app.router.navigate(item.targetPath);
        } else if (typeof window !== 'undefined' && typeof window.location?.assign === 'function') {
          window.location.assign(item.targetPath);
        }
      }
    };

    const handleMarkAllRead = async () => {
      if (!unreadCount || typeof api?.request !== 'function') return;
      const nowIso = new Date().toISOString();
      const unreadInList = items.filter((it) => !it.readAt).length;
      setItems((prev) => prev.map((it) => (it.readAt ? it : { ...it, readAt: nowIso })));
      if (category === 'all') {
        setUnreadCount(0);
      } else if (unreadInList > 0) {
        setUnreadCount((c) => Math.max(0, c - unreadInList));
      }
      try {
        const res = await api.request({
          url: 'latticeNotifications:markAllRead',
          method: 'post',
          data: category !== 'all' ? { category } : {},
          skipNotify: true,
        });
        if (category !== 'all') {
          const updatedCount = Number(res?.data?.data?.updatedCount ?? res?.data?.updatedCount);
          if (Number.isFinite(updatedCount) && updatedCount >= 0 && unreadInList === 0) {
            setUnreadCount((c) => Math.max(0, c - updatedCount));
          }
          await fetchUnreadCount();
        }
      } catch {
        await fetchUnreadCount();
      }
    };

    if (!visible) {
      return h(React.Fragment, null, children);
    }

    const wrapStyle = mobile
      ? { position: 'fixed', top: 6, right: 54, zIndex: 1050, pointerEvents: 'auto' }
      : { position: 'fixed', top: 8, right: 210, zIndex: 1050, pointerEvents: 'auto' };

    const popoverStyle = {
      position: 'fixed',
      top: mobile ? 44 : 46,
      right: mobile ? 10 : 16,
      width: mobile ? 'calc(100vw - 20px)' : 380,
      maxWidth: 400,
      maxHeight: '72vh',
      display: 'flex',
      flexDirection: 'column',
      background: '#ffffff',
      border: '1px solid #cbd5e1',
      borderRadius: 12,
      boxShadow: '0 14px 36px rgba(15, 23, 42, 0.18)',
      zIndex: 1055,
      overflow: 'hidden',
      color: '#0f172a',
    };

    return h(React.Fragment, null,
      children,
      h('div', { 'data-testid': 'ldx-notification-bell-wrap', style: wrapStyle },
        h('button', {
          type: 'button',
          'data-testid': 'ldx-notification-bell-btn',
          'aria-label': 'Thông báo',
          'aria-expanded': open,
          title: 'Thông báo (Alt+N)',
          onClick: togglePopover,
          style: {
            position: 'relative',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            height: 30,
            padding: '0 10px',
            borderRadius: 999,
            border: '1px solid rgba(148, 163, 184, 0.45)',
            background: open ? '#1d4ed8' : 'rgba(255, 255, 255, 0.94)',
            color: open ? '#ffffff' : '#1e293b',
            fontSize: 12,
            fontWeight: 600,
            cursor: 'pointer',
            boxShadow: '0 2px 8px rgba(15, 23, 42, 0.12)',
          },
        },
          createBellIcon(h),
          !mobile ? h('span', null, 'Thông báo') : null,
          unreadCount > 0 ? h('span', {
            'data-testid': 'ldx-notification-badge',
            style: {
              minWidth: 18,
              height: 18,
              padding: '0 5px',
              borderRadius: 999,
              background: '#ef4444',
              color: '#ffffff',
              fontSize: 11,
              fontWeight: 700,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              lineHeight: 1,
            },
          }, unreadCount > 99 ? '99+' : String(unreadCount)) : null,
        ),
        open ? h('div', {
          role: 'dialog',
          'aria-label': 'Hộp thư thông báo',
          'data-testid': 'ldx-notification-popover',
          style: popoverStyle,
        },
          h('div', {
            style: {
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '10px 14px',
              borderBottom: '1px solid #e2e8f0',
              background: '#f8fafc',
            },
          },
            h('strong', { style: { fontSize: 13 } }, `Thông báo (${unreadCount} chưa đọc)`),
            h('button', {
              type: 'button',
              'data-testid': 'ldx-notification-mark-all',
              disabled: unreadCount === 0,
              onClick: handleMarkAllRead,
              style: {
                border: 'none',
                background: 'transparent',
                color: unreadCount > 0 ? '#2563eb' : '#94a3b8',
                fontSize: 12,
                fontWeight: 600,
                cursor: unreadCount > 0 ? 'pointer' : 'default',
                padding: 0,
              },
            }, 'Đánh dấu tất cả đã đọc'),
          ),
          h('div', {
            style: {
              display: 'flex',
              gap: 6,
              padding: '8px 12px',
              overflowX: 'auto',
              borderBottom: '1px solid #f1f5f9',
            },
          }, CATEGORY_TABS.map((tab) => {
            const active = category === tab.key;
            return h('button', {
              key: tab.key,
              type: 'button',
              'data-testid': `ldx-notification-cat-${tab.key}`,
              onClick: () => handleCategorySelect(tab.key),
              style: {
                padding: '3px 9px',
                borderRadius: 999,
                border: `1px solid ${active ? '#2563eb' : '#cbd5e1'}`,
                background: active ? '#eff6ff' : '#ffffff',
                color: active ? '#1d4ed8' : '#475569',
                fontSize: 11,
                fontWeight: 600,
                whiteSpace: 'nowrap',
                cursor: 'pointer',
              },
            }, tab.label);
          })),
          h('div', { style: { overflowY: 'auto', flex: 1, padding: 8, display: 'grid', gap: 6 } },
            loading && !items.length
              ? h('div', { style: { padding: 18, textAlign: 'center', fontSize: 12, color: '#64748b' } }, 'Đang tải thông báo…')
              : !items.length
                ? h('div', { style: { padding: 20, textAlign: 'center', fontSize: 12, color: '#64748b' } }, 'Chưa có thông báo nào.')
                : items.map((item) => {
                  const sev = SEVERITY_STYLES[item.severity] || SEVERITY_STYLES.info;
                  const unread = !item.readAt;
                  return h('button', {
                    key: item.id,
                    type: 'button',
                    'data-testid': `ldx-notification-item-${item.id}`,
                    onClick: () => handleItemClick(item),
                    style: {
                      width: '100%',
                      textAlign: 'left',
                      padding: '9px 10px',
                      borderRadius: 8,
                      border: `1px solid ${unread ? '#bfdbfe' : '#e2e8f0'}`,
                      background: unread ? '#f0f7ff' : '#ffffff',
                      cursor: 'pointer',
                      display: 'grid',
                      gap: 4,
                    },
                  },
                    h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 } },
                      h('span', {
                        style: {
                          fontSize: 10,
                          fontWeight: 700,
                          padding: '1px 6px',
                          borderRadius: 4,
                          background: sev.bg,
                          color: sev.color,
                        },
                      }, `${sev.label} · ${item.category || 'system'}`),
                      unread ? h('span', { style: { width: 7, height: 7, borderRadius: 999, background: '#2563eb' } }) : null,
                    ),
                    h('div', { style: { fontSize: 12, fontWeight: unread ? 700 : 600, color: '#0f172a' } }, item.title),
                    item.body ? h('div', { style: { fontSize: 11, color: '#475569' } }, String(item.body).slice(0, 140)) : null,
                  );
                }),
          ),
        ) : null,
      ),
    );
  };
}

module.exports = {
  POLL_INTERVAL_MS,
  CATEGORY_TABS,
  readCurrentPathname,
  isVisibleBellPath,
  isMobileViewport,
  isAuthenticatedClient,
  isSafeInternalTargetPath,
  createNotificationBellProvider,
};
