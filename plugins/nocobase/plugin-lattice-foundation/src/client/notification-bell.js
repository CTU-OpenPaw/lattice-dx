/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { subscribeSurfaceEvents } = require('./sse-hub');

const POLL_INTERVAL_MS = 60_000;
const SSE_RECONNECT_BASE_MS = 3_000;
const PORTAL_SLUG_RE = /^[a-z0-9_-]{1,64}$/i;
let bellInstanceSeq = 0;

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

function isMobileBellPath(pathname) {
  const clean = String(pathname || '').split('?')[0].split('#')[0].trim();
  return clean === '/v/mobile'
    || clean.startsWith('/v/mobile/')
    || clean === '/mobile'
    || clean.startsWith('/mobile/');
}

function isVisibleBellPath(pathname) {
  const clean = String(pathname || '').split('?')[0].split('#')[0].trim();
  if (!clean || clean === '/signin' || clean.startsWith('/signin/') || clean === '/signup' || clean.startsWith('/signup/')) {
    return false;
  }
  return clean === '/p'
    || clean.startsWith('/p/')
    || clean === '/admin'
    || clean.startsWith('/admin/')
    || isMobileBellPath(clean);
}

function resolveBellPortalSlug(pathname) {
  const clean = String(pathname || '').split('?')[0].split('#')[0].trim();
  const pMatch = /^\/p\/([a-z0-9_-]{1,64})(?:\/|$)/i.exec(clean);
  if (pMatch && PORTAL_SLUG_RE.test(pMatch[1])) return pMatch[1].toLowerCase();
  if (isMobileBellPath(clean)) return 'mobile';
  if (clean === '/admin' || clean.startsWith('/admin/')) return 'admin';
  return 'workspace';
}

function resolveClientAuthToken(api, storage) {
  if (!api) return '';
  try {
    const t = typeof api.auth?.getToken === 'function' ? api.auth.getToken() : '';
    if (typeof t === 'string' && t.trim()) return t.trim();
  } catch {}
  try {
    const t = api.auth?.token;
    if (typeof t === 'string' && t.trim()) return t.trim();
  } catch {}
  try {
    if (storage && typeof storage.getItem === 'function') {
      const t = storage.getItem('NOCOBASE_TOKEN');
      if (typeof t === 'string' && t.trim()) return t.trim();
    }
    if (typeof localStorage !== 'undefined' && typeof localStorage.getItem === 'function') {
      const t = localStorage.getItem('NOCOBASE_TOKEN');
      if (typeof t === 'string' && t.trim()) return t.trim();
    }
  } catch {}
  return '';
}

function parseSseChunk(chunk) {
  const normalized = String(chunk || '').replace(/\r\n/g, '\n');
  const blocks = normalized.split('\n\n');
  const rest = blocks.pop() ?? '';
  const frames = [];
  for (const block of blocks) {
    if (!block.trim() || block.startsWith(':')) continue;
    let eventName = 'message';
    const dataLines = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim() || 'message';
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (!dataLines.length) continue;
    let data = {};
    try { data = JSON.parse(dataLines.join('\n')); } catch { data = { raw: dataLines.join('\n') }; }
    frames.push({ event: eventName, data });
  }
  return { frames, rest };
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
  return Boolean(resolveClientAuthToken(api));
}

function hasExistingBellInDom(ownInstanceId) {
  if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return false;
  try {
    const nodes = document.querySelectorAll('[data-latticedx-notification-bell]');
    const list = Array.from(nodes || []);
    return list.some((node) => {
      const inst = node?.getAttribute?.('data-ldx-bell-instance');
      return !ownInstanceId || inst !== ownInstanceId;
    });
  } catch {
    return false;
  }
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

function createNotificationBellCore(client, React, _antd, app, { defaultVariant = 'floating', hasTopbar = false } = {}) {
  if (!React || typeof React.createElement !== 'function') return null;
  const h = React.createElement;
  const useApi = typeof client?.useAPIClient === 'function' ? client.useAPIClient : () => app?.apiClient || null;
  const useCb = typeof React.useCallback === 'function' ? React.useCallback : (fn) => fn;
  const useRefSafe = typeof React.useRef === 'function' ? React.useRef : (init) => ({ current: init });

  return function LatticeNotificationBell({ children, variant = defaultVariant, pathname: pathnameProp } = {}) {
    const api = useApi();
    const isTopbar = variant === 'topbar';
    const [pathname, setPathname] = React.useState(() => pathnameProp || readCurrentPathname());
    const [mobile, setMobile] = React.useState(() => isMobileViewport());
    const [open, setOpen] = React.useState(false);
    const [unreadCount, setUnreadCount] = React.useState(0);
    const [items, setItems] = React.useState([]);
    const [category, setCategory] = React.useState('all');
    const [loading, setLoading] = React.useState(false);
    const [authRejected, setAuthRejected] = React.useState(false);
    const bellInstanceIdRef = useRefSafe(null);
    if (!bellInstanceIdRef.current) {
      bellInstanceIdRef.current = `ldx-bell-${++bellInstanceSeq}`;
    }
    const [duplicateBell, setDuplicateBell] = React.useState(() => hasExistingBellInDom(bellInstanceIdRef.current));
    const openRef = useRefSafe(open);
    openRef.current = open;

    React.useEffect(() => {
      if (pathnameProp && pathnameProp !== pathname) {
        setPathname(pathnameProp);
      }
    }, [pathnameProp]);

    React.useEffect(() => {
      if (typeof window === 'undefined') return undefined;
      const syncPath = () => {
        const next = pathnameProp || readCurrentPathname();
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
    }, [pathnameProp]);

    const effectivePath = pathnameProp || pathname;
    const suppressedByTopbar = !isTopbar && Boolean(hasTopbar) && !isMobileBellPath(effectivePath);
    const pathAllowed = isTopbar
      ? (!effectivePath || isVisibleBellPath(effectivePath))
      : isVisibleBellPath(effectivePath);
    const visible = Boolean(!suppressedByTopbar && !duplicateBell && !authRejected && pathAllowed && isAuthenticatedClient(api));

    const fetchUnreadCount = useCb(async () => {
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

    const fetchInbox = useCb(async (selectedCategory = category) => {
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

    const fetchInboxRef = useRefSafe(fetchInbox);
    fetchInboxRef.current = fetchInbox;
    const fetchUnreadCountRef = useRefSafe(fetchUnreadCount);
    fetchUnreadCountRef.current = fetchUnreadCount;

    React.useEffect(() => {
      setAuthRejected(false);
      setDuplicateBell(hasExistingBellInDom(bellInstanceIdRef.current));
    }, [api?.auth?.role, effectivePath, isTopbar]);

    const portalSlug = resolveBellPortalSlug(effectivePath);

    React.useEffect(() => {
      if (!visible) {
        setOpen(false);
        return undefined;
      }
      fetchUnreadCountRef.current?.();
      if (typeof window === 'undefined') return undefined;

      let disposed = false;

      const timer = setInterval(() => {
        if (typeof document === 'undefined' || document.visibilityState !== 'hidden') {
          fetchUnreadCountRef.current?.();
        }
      }, POLL_INTERVAL_MS);
      if (typeof timer?.unref === 'function') timer.unref();

      const handleSsePayload = (eventName, parsed) => {
        if (disposed || !parsed || typeof parsed !== 'object') return;
        if (Number.isFinite(Number(parsed.unreadCount)) && Number(parsed.unreadCount) >= 0) {
          setUnreadCount(Number(parsed.unreadCount));
          if (openRef.current) fetchInboxRef.current?.();
          return;
        }
        const kind = String(parsed.kind || parsed.type || '').trim().toLowerCase();
        if (kind === 'notification' || kind === 'unread_count' || eventName === 'notification' || eventName === 'unread_count') {
          fetchUnreadCountRef.current?.();
          if (openRef.current) fetchInboxRef.current?.();
        }
      };

      const token = resolveClientAuthToken(api);
      const fetchFn = typeof globalThis !== 'undefined' && typeof globalThis.fetch === 'function'
        ? globalThis.fetch
        : (typeof fetch === 'function' ? fetch : null);
      const baseApi = typeof api?.getBaseURL === 'function' ? api.getBaseURL() : '/api/';
      const prefix = String(baseApi || '/api/').replace(/\/?$/, '/');
      const sseUrl = `${prefix}dxosAi:surfaceEvents?portalSlug=${encodeURIComponent(portalSlug)}`;

      const unsubscribeSse = (token && typeof fetchFn === 'function')
        ? subscribeSurfaceEvents({
          portalSlug,
          sseUrl,
          token,
          fetchFn,
          minBackoffMs: SSE_RECONNECT_BASE_MS,
          maxBackoffMs: POLL_INTERVAL_MS,
          win: typeof window !== 'undefined' ? window : null,
          onEvent: (eventName, data) => {
            if (['notification', 'unread_count', 'update', 'message'].includes(eventName)) {
              handleSsePayload(eventName, data);
            }
          },
          onAuthError: () => {
            if (!disposed) setAuthRejected(true);
          },
        })
        : () => {};

      const onVisibility = () => {
        if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
          fetchUnreadCountRef.current?.();
        }
      };
      if (typeof document !== 'undefined') {
        document.addEventListener?.('visibilitychange', onVisibility);
      }
      return () => {
        disposed = true;
        clearInterval(timer);
        unsubscribeSse();
        if (typeof document !== 'undefined') {
          document.removeEventListener?.('visibilitychange', onVisibility);
        }
      };
    }, [visible, portalSlug, api]);

    const setPopoverOpen = useCb((next) => {
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
      return isTopbar ? null : h(React.Fragment, null, children);
    }

    const wrapStyle = isTopbar
      ? { position: 'relative', display: 'inline-flex', alignItems: 'center', height: 46, verticalAlign: 'middle', lineHeight: 1.2, marginRight: 6 }
      : (mobile
        ? { position: 'fixed', top: 6, right: 54, zIndex: 1050, pointerEvents: 'auto' }
        : { position: 'fixed', top: 8, right: 210, zIndex: 1050, pointerEvents: 'auto' });

    const buttonStyle = isTopbar
      ? {
          position: 'relative',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          height: 30,
          padding: '0 10px',
          borderRadius: 6,
          border: '1px solid rgba(255, 255, 255, 0.24)',
          background: open ? '#1d4ed8' : 'rgba(255, 255, 255, 0.12)',
          color: '#ffffff',
          fontSize: 12,
          fontWeight: 600,
          cursor: 'pointer',
        }
      : {
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
        };

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

    const bellWrap = h('div', {
      'data-testid': 'ldx-notification-bell-wrap',
      'data-variant': isTopbar ? 'topbar' : 'floating',
      'data-latticedx-notification-bell': isTopbar ? 'topbar' : 'floating',
      'data-ldx-bell-instance': bellInstanceIdRef.current,
      style: wrapStyle,
    },
      h('button', {
        type: 'button',
        'data-testid': 'ldx-notification-bell-btn',
        'aria-label': 'Thông báo',
        'aria-expanded': open,
        title: 'Thông báo (Alt+N)',
        onClick: togglePopover,
        style: buttonStyle,
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
      );

    return isTopbar ? bellWrap : h(React.Fragment, null, children, bellWrap);
  };
}

function createNotificationBellProvider(client, React, antd, app, options = {}) {
  return createNotificationBellCore(client, React, antd, app, {
    defaultVariant: options.variant || 'floating',
    hasTopbar: Boolean(options.hasTopbar),
  });
}

function createTopbarNotificationBell(client, React, antd, app) {
  return createNotificationBellCore(client, React, antd, app, {
    defaultVariant: 'topbar',
    hasTopbar: false,
  });
}

module.exports = {
  POLL_INTERVAL_MS,
  CATEGORY_TABS,
  readCurrentPathname,
  isMobileBellPath,
  isVisibleBellPath,
  resolveBellPortalSlug,
  isMobileViewport,
  resolveClientAuthToken,
  isAuthenticatedClient,
  isSafeInternalTargetPath,
  createNotificationBellProvider,
  createTopbarNotificationBell,
};
