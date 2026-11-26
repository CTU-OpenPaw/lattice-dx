/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const BRAND_FALLBACK_SRC = '/v/lattice-brand.svg';
const SEEDED_DEFAULT_LOGO_SRC = '/files/main/main/attachments/1.png';
const SIGNIN_GUARDS_INSTALLED = Symbol('ldxSignInApiGuardsInstalled');
const SIGNIN_NAV_GUARDED = Symbol('ldxSignInNavGuarded');
const SIGNIN_INNER_ROUTER_GUARDED = Symbol('ldxSignInInnerRouterGuarded');
const SIGNIN_ORIG_NAVIGATE = Symbol('ldxSignInOrigNavigate');
const SIGNIN_ADD_GUARDED = Symbol('ldxSignInAddGuarded');
const SIGNIN_HISTORY_GUARDED = Symbol('ldxSignInHistoryGuarded');
const SIGNIN_SUBSCRIBE_GUARDED = Symbol('ldxSignInSubscribeGuarded');

function decodeJwtPayload(token) {
  if (typeof token !== 'string') return null;
  const parts = token.trim().split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
    const normalized = b64 + pad;
    let jsonText = null;
    if (typeof atob === 'function') {
      const bin = atob(normalized);
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      jsonText = typeof TextDecoder === 'function' ? new TextDecoder().decode(bytes) : bin;
    } else if (typeof Buffer !== 'undefined') {
      jsonText = Buffer.from(normalized, 'base64').toString('utf8');
    }
    if (!jsonText) return null;
    const parsed = JSON.parse(jsonText);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isJwtTokenExpired(token, nowMs = Date.now()) {
  const payload = decodeJwtPayload(token);
  if (!payload) return false;
  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) return false;
  return payload.exp <= Math.floor(nowMs / 1000);
}

function hasClientToken(apiClient) {
  try {
    const t = typeof apiClient?.auth?.getToken === 'function'
      ? apiClient.auth.getToken()
      : apiClient?.auth?.token;
    if (typeof t === 'string' && t.trim() && !isJwtTokenExpired(t)) return true;
  } catch {}
  try {
    const t = typeof window !== 'undefined' && window.localStorage
      ? window.localStorage.getItem('NOCOBASE_TOKEN')
      : '';
    if (typeof t === 'string' && t.trim() && !isJwtTokenExpired(t)) return true;
  } catch {}
  return false;
}

function isOnSignInRoute() {
  try {
    const pathname = typeof window !== 'undefined' && window.location ? String(window.location.pathname || '') : '';
    return /^\/(?:v\/)?signin(?:\/|$)/.test(pathname);
  } catch {
    return false;
  }
}

function isNoAuthBackgroundRoute() {
  try {
    const pathname = typeof window !== 'undefined' && window.location ? String(window.location.pathname || '') : '';
    return /^\/(?:v\/)?(?:signin|mobile|track|form)(?:\/|$)/.test(pathname);
  } catch {
    return false;
  }
}

function isSelfSignInTarget(rawTarget) {
  if (typeof rawTarget !== 'string' || !rawTarget.trim()) return false;
  let candidate = rawTarget.trim();
  for (let i = 0; i < 2; i += 1) {
    try {
      const decoded = decodeURIComponent(candidate);
      if (decoded === candidate) break;
      candidate = decoded;
    } catch {
      break;
    }
  }
  try {
    const parsed = new URL(candidate, 'http://localhost');
    return /^\/(?:v\/)?signin(?:\/|$)/.test(String(parsed.pathname || ''));
  } catch {
    return /^\/(?:v\/)?signin(?:[/?#]|$)/.test(candidate);
  }
}

function sanitizeSignInNavigationTarget(target) {
  if (typeof target === 'string') {
    if (!isSelfSignInTarget(target)) return target;
    try {
      const isAbsolute = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(target);
      const parsed = new URL(target, 'http://localhost');
      const redir = parsed.searchParams.get('redirect');
      if (redir !== null && isSelfSignInTarget(redir)) {
        parsed.searchParams.delete('redirect');
      }
      if (isAbsolute) return parsed.toString();
      return parsed.pathname + (parsed.search || '') + (parsed.hash || '');
    } catch {
      return target.replace(/([?&])redirect=[^&#]*/gi, '$1').replace(/\?&/, '?').replace(/[?&]$/, '');
    }
  }
  if (target && typeof target === 'object' && typeof target.pathname === 'string' && isSelfSignInTarget(target.pathname)) {
    const search = typeof target.search === 'string' ? target.search : '';
    if (search) {
      try {
        const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
        const redir = params.get('redirect');
        if (redir !== null && isSelfSignInTarget(redir)) {
          params.delete('redirect');
          const nextSearch = params.toString();
          return { ...target, search: nextSearch ? `?${nextSearch}` : '' };
        }
      } catch {}
    }
  }
  return target;
}

function localizeSignInError(msg) {
  const text = String(msg || '').trim();
  if (!text) return 'Đăng nhập thất bại. Vui lòng thử lại.';
  const lower = text.toLowerCase();
  if (lower.includes('username/email or password is incorrect') || lower.includes('username or password is incorrect')) {
    return 'Tên đăng nhập / email hoặc mật khẩu không đúng. Vui lòng kiểm tra lại.';
  }
  if (lower.includes('password is incorrect') || lower.includes('invalid password')) {
    return 'Mật khẩu không đúng. Vui lòng thử lại.';
  }
  if (lower.includes('user not found') || lower.includes('account does not exist')) {
    return 'Không tìm thấy tài khoản phù hợp.';
  }
  if (lower.includes('account is disabled') || lower.includes('user is disabled') || lower.includes('locked')) {
    return 'Tài khoản đang bị tạm khóa hoặc vô hiệu hóa. Liên hệ quản trị viên.';
  }
  if (lower.includes('too many requests') || lower.includes('rate limit')) {
    return 'Bạn đã thử đăng nhập quá nhiều lần. Vui lòng chờ ít phút rồi thử lại.';
  }
  if (lower.includes('verification_failed') || lower.includes('verification failed')) {
    return 'Không xác thực được tài khoản doanh nghiệp. Kiểm tra liên kết tài khoản hoặc thử lại.';
  }
  if (lower.includes('authenticator') && (lower.includes('not found') || lower.includes('invalid') || lower.includes('disabled'))) {
    return 'Phương thức đăng nhập chưa sẵn sàng hoặc đã bị tắt.';
  }
  if (lower.includes('unauthorized') || lower === 'http 401') {
    return 'Phiên đăng nhập không hợp lệ hoặc thông tin xác thực sai.';
  }
  return text;
}

function resolveShortCircuitResponse(url, apiClient) {
  const cleanUrl = String(url || '');
  if (!cleanUrl || hasClientToken(apiClient)) return null;
  if (/(?:^|\/)(?:aiEmployees:listByUser)(?:[/?]|$)/.test(cleanUrl)) {
    return { data: [] };
  }
  if (/(?:^|\/)(?:aiConversations:unreadCounts)(?:[/?]|$)/.test(cleanUrl)) {
    return { data: { unreadCount: 0, total: 0 } };
  }
  if (/(?:^|\/)(?:blockTemplates:list)(?:[/?]|$)/.test(cleanUrl)) {
    return { data: [] };
  }
  if (isNoAuthBackgroundRoute() && /(?:^|\/)auth:check(?:[/?]|$)/.test(cleanUrl)) {
    return { data: null };
  }
  return null;
}

function localizeAuthErrorPayload(err) {
  if (!err || typeof err !== 'object') return err;
  const reqUrl = String(err.config?.url || '');
  const isAuthCall = isOnSignInRoute() || /(?:^|\/)auth:(?:signIn|signUp|check)(?:[/?]|$)/.test(reqUrl);
  if (!isAuthCall) return err;
  if (err.response?.data && typeof err.response.data === 'object') {
    if (Array.isArray(err.response.data.errors)) {
      err.response.data.errors = err.response.data.errors.map((entry) => (
        entry && typeof entry === 'object' && typeof entry.message === 'string'
          ? { ...entry, message: localizeSignInError(entry.message) }
          : entry
      ));
    }
    if (typeof err.response.data.message === 'string') {
      err.response.data.message = localizeSignInError(err.response.data.message);
    }
  }
  if (typeof err.message === 'string') {
    err.message = localizeSignInError(err.message);
  }
  return err;
}

function wrapPropertySafely(target, prop, makeWrapper) {
  if (!target || (typeof target !== 'object' && typeof target !== 'function')) return false;
  let current;
  try {
    current = target[prop];
  } catch {
    return false;
  }
  if (typeof current !== 'function') return false;
  if (current[SIGNIN_NAV_GUARDED]) return true;
  const wrapped = makeWrapper(current);
  try {
    wrapped[SIGNIN_NAV_GUARDED] = true;
  } catch {}
  const ownDesc = Object.getOwnPropertyDescriptor(target, prop);
  if (ownDesc && ownDesc.configurable === false) {
    if ('value' in ownDesc && ownDesc.writable) {
      try {
        target[prop] = wrapped;
        return target[prop] === wrapped;
      } catch {
        return false;
      }
    }
    return false;
  }
  try {
    Object.defineProperty(target, prop, {
      configurable: true,
      writable: true,
      enumerable: ownDesc ? ownDesc.enumerable : true,
      value: wrapped,
    });
    if (target[prop] === wrapped) return true;
  } catch {}
  try {
    target[prop] = wrapped;
    return target[prop] === wrapped;
  } catch {
    return false;
  }
}

function hasRecentSignIn(state, apiClient) {
  return Boolean(
    state
    && state.lastSignInSuccessAt > 0
    && (Date.now() - state.lastSignInSuccessAt) < 10000
    && hasClientToken(apiClient)
  );
}

function stripCurrentSignInSelfRedirect(app) {
  if (isOnSignInRoute() && typeof window !== 'undefined' && window.location) {
    const curHref = `${window.location.pathname || ''}${window.location.search || ''}${window.location.hash || ''}`;
    const sanitized = sanitizeSignInNavigationTarget(curHref);
    if (sanitized !== curHref && typeof window.history?.replaceState === 'function') {
      try {
        window.history.replaceState(null, '', sanitized);
      } catch {}
    }
  }

  const innerRouter = app?.router?.router;
  const innerLoc = innerRouter?.state?.location;
  if (!innerRouter || !innerLoc || typeof innerLoc.pathname !== 'string') return;
  if (!isSelfSignInTarget(innerLoc.pathname)) return;
  const winHasPath = typeof window !== 'undefined' && Boolean(window.location?.pathname);
  if (winHasPath && !isOnSignInRoute()) return;

  const innerHref = `${innerLoc.pathname}${innerLoc.search || ''}${innerLoc.hash || ''}`;
  const sanitizedInner = sanitizeSignInNavigationTarget(innerHref);
  if (sanitizedInner === innerHref) return;

  const state = app && typeof app === 'object' ? app.__ldxSignInState : null;
  if (state?.strippingInnerRedirect || hasRecentSignIn(state, app?.apiClient)) return;

  const origNav = typeof innerRouter[SIGNIN_ORIG_NAVIGATE] === 'function'
    ? innerRouter[SIGNIN_ORIG_NAVIGATE]
    : (typeof innerRouter.navigate === 'function' ? innerRouter.navigate.bind(innerRouter) : null);
  if (!origNav) return;

  if (state) state.strippingInnerRedirect = true;
  try {
    const res = origNav(sanitizedInner, { replace: true });
    if (res && typeof res.catch === 'function') res.catch(() => {});
  } catch {} finally {
    if (state) state.strippingInnerRedirect = false;
  }
}

function installSignInApiGuards(app) {
  const state = (app && typeof app === 'object')
    ? (app.__ldxSignInState || (app.__ldxSignInState = {
      lastSignInSuccessAt: 0,
      navWrapped: false,
      innerNavWrapped: false,
      strippingInnerRedirect: false,
      escapeTimer: null,
    }))
    : {
      lastSignInSuccessAt: 0,
      navWrapped: false,
      innerNavWrapped: false,
      strippingInnerRedirect: false,
      escapeTimer: null,
    };

  if (typeof window !== 'undefined' && window.history && !window.history[SIGNIN_HISTORY_GUARDED]) {
    try {
      window.history[SIGNIN_HISTORY_GUARDED] = true;
      for (const methodName of ['replaceState', 'pushState']) {
        wrapPropertySafely(window.history, methodName, (orig) => function guardedHistoryState(data, unused, url) {
          let nextUrl = url;
          if (typeof url === 'string') {
            nextUrl = sanitizeSignInNavigationTarget(url);
          } else if (url && typeof url === 'object' && typeof url.href === 'string') {
            nextUrl = sanitizeSignInNavigationTarget(url.href);
          }
          return orig.call(this, data, unused, nextUrl);
        });
      }
    } catch {}
  }

  const apiClient = app?.apiClient;
  const makeGuardedNavigate = (orig, owner) => {
    const boundOrig = orig.bind(owner);
    return function guardedNavigate(to, opts) {
      const justSignedIn = hasRecentSignIn(state, app?.apiClient);
      if (justSignedIn) {
        const targetPath = typeof to === 'string' ? to : (to && typeof to === 'object' ? to.pathname : '');
        if (isSelfSignInTarget(targetPath)) {
          return boundOrig('/admin', opts);
        }
      }
      return boundOrig(sanitizeSignInNavigationTarget(to), opts);
    };
  };

  const ensureInnerRouterGuards = () => {
    const innerRouter = app?.router?.router;
    if (!innerRouter || typeof innerRouter !== 'object') {
      stripCurrentSignInSelfRedirect(app);
      return false;
    }
    let innerWrapped = Boolean(innerRouter[SIGNIN_INNER_ROUTER_GUARDED]);
    if (!innerWrapped) {
      if (typeof innerRouter.navigate === 'function') {
        const rawInnerNav = innerRouter.navigate;
        if (!rawInnerNav[SIGNIN_NAV_GUARDED]) {
          try {
            innerRouter[SIGNIN_ORIG_NAVIGATE] = rawInnerNav.bind(innerRouter);
          } catch {}
        }
        if (wrapPropertySafely(innerRouter, 'navigate', (orig) => makeGuardedNavigate(orig, innerRouter))) {
          innerWrapped = true;
        }
      }
      if (typeof innerRouter.subscribe === 'function' && !innerRouter[SIGNIN_SUBSCRIBE_GUARDED]) {
        try {
          innerRouter[SIGNIN_SUBSCRIBE_GUARDED] = true;
          innerRouter.subscribe(() => {
            stripCurrentSignInSelfRedirect(app);
          });
        } catch {}
      }
      if (innerWrapped) {
        try {
          innerRouter[SIGNIN_INNER_ROUTER_GUARDED] = true;
        } catch {}
      }
    }
    state.innerNavWrapped = Boolean(state.innerNavWrapped || innerWrapped);
    state.navWrapped = Boolean(state.navWrapped || innerWrapped);
    stripCurrentSignInSelfRedirect(app);
    return innerWrapped;
  };

  if (app?.router && !app.router[SIGNIN_NAV_GUARDED]) {
    let wrapped = false;
    if (typeof app.router.navigateWithPortalPolicy === 'function') {
      if (wrapPropertySafely(app.router, 'navigateWithPortalPolicy', (orig) => makeGuardedNavigate(orig, app.router))) {
        wrapped = true;
      }
    } else if (typeof app.router.navigate === 'function') {
      if (wrapPropertySafely(app.router, 'navigate', (orig) => makeGuardedNavigate(orig, app.router))) {
        wrapped = true;
      }
    }
    state.navWrapped = Boolean(state.navWrapped || wrapped);
    try {
      app.router[SIGNIN_NAV_GUARDED] = true;
    } catch {}
  }

  if (app?.router && typeof app.router.getRouterComponent === 'function') {
    wrapPropertySafely(app.router, 'getRouterComponent', (orig) => function guardedGetRouterComponent(...args) {
      const result = orig.apply(this ?? app.router, args);
      ensureInnerRouterGuards();
      return result;
    });
  }

  ensureInnerRouterGuards();

  const schedulePostSignInEscapeIfNeeded = () => {
    const scheduledWin = typeof window !== 'undefined' ? window : null;
    if (!scheduledWin || !isOnSignInRoute() || !hasClientToken(apiClient)) return;
    if (typeof setTimeout !== 'function') return;
    if (state.escapeTimer && typeof clearTimeout === 'function') {
      try { clearTimeout(state.escapeTimer); } catch {}
      state.escapeTimer = null;
    }
    const delayMs = (state.navWrapped && state.innerNavWrapped) ? 250 : 50;
    const timer = setTimeout(() => {
      state.escapeTimer = null;
      if (typeof window === 'undefined' || window !== scheduledWin) return;
      if (!isOnSignInRoute() || !hasClientToken(apiClient)) return;
      try {
        if (typeof app?.router?.navigate === 'function') {
          const navRes = app.router.navigate('/admin', { replace: true });
          if (navRes && typeof navRes.catch === 'function') navRes.catch(() => {});
          if (!isOnSignInRoute()) return;
        }
      } catch {}
      try {
        if (typeof app?.router?.router?.navigate === 'function') {
          const innerRes = app.router.router.navigate('/admin', { replace: true });
          if (innerRes && typeof innerRes.catch === 'function') innerRes.catch(() => {});
          if (!isOnSignInRoute()) return;
        }
      } catch {}
      try {
        if (typeof window !== 'undefined' && typeof window.location?.assign === 'function') {
          window.location.assign('/admin');
        }
      } catch {}
    }, delayMs);
    state.escapeTimer = timer;
    if (timer && typeof timer.unref === 'function') timer.unref();
  };

  if (!apiClient || apiClient[SIGNIN_GUARDS_INSTALLED]) return;
  apiClient[SIGNIN_GUARDS_INSTALLED] = true;

  if (apiClient.axios?.interceptors?.request?.use) {
    apiClient.axios.interceptors.request.use((config) => {
      const payload = resolveShortCircuitResponse(config?.url, apiClient);
      if (payload) {
        return {
          ...config,
          adapter: async () => ({
            data: payload,
            status: 200,
            statusText: 'OK',
            headers: {},
            config,
          }),
        };
      }
      return config;
    });
  }

  const respInterceptors = apiClient.axios?.interceptors?.response;
  if (respInterceptors && typeof respInterceptors.use === 'function') {
    respInterceptors.use(
      (res) => {
        const reqUrl = String(res?.config?.url || '');
        if (/(?:^|\/)auth:signOut(?:[/?]|$)/.test(reqUrl)) {
          state.lastSignInSuccessAt = 0;
        } else if (/(?:^|\/)auth:signIn(?:[/?]|$)/.test(reqUrl)) {
          ensureInnerRouterGuards();
          state.lastSignInSuccessAt = Date.now();
          schedulePostSignInEscapeIfNeeded();
        }
        return res;
      },
      (err) => Promise.reject(localizeAuthErrorPayload(err)),
    );
    if (Array.isArray(respInterceptors.handlers) && respInterceptors.handlers.length > 1) {
      respInterceptors.handlers.unshift(respInterceptors.handlers.pop());
    }
  }

  if (typeof apiClient.request === 'function') {
    const origRequest = apiClient.request.bind(apiClient);
    apiClient.request = async function guardedRequest(cfg = {}, ...rest) {
      const payload = resolveShortCircuitResponse(cfg?.url, apiClient);
      if (payload) {
        return { data: payload, status: 200, statusText: 'OK', headers: {}, config: cfg };
      }
      try {
        const result = await origRequest(cfg, ...rest);
        const reqUrl = String(cfg?.url || '');
        if (/(?:^|\/)auth:signOut(?:[/?]|$)/.test(reqUrl)) {
          state.lastSignInSuccessAt = 0;
        } else if (/(?:^|\/)auth:signIn(?:[/?]|$)/.test(reqUrl)) {
          ensureInnerRouterGuards();
          state.lastSignInSuccessAt = Date.now();
          schedulePostSignInEscapeIfNeeded();
        }
        return result;
      } catch (err) {
        throw localizeAuthErrorPayload(err);
      }
    };
  }
}

function createBrandLogo(client, React) {
  if (typeof client.useSystemSettings !== 'function') return () => null;
  return function BrandLogo({size}) {
    const {data} = client.useSystemSettings() || {};
    const rawSrc = typeof data?.data?.logo?.url === 'string' ? data.data.logo.url.trim() : '';
    const normalizedSrc = (!rawSrc || rawSrc === SEEDED_DEFAULT_LOGO_SRC) ? BRAND_FALLBACK_SRC : rawSrc;
    const [failedSrc, setFailedSrc] = React.useState(null);
    const [fallbackFailed, setFallbackFailed] = React.useState(false);

    const effectiveSrc = failedSrc === normalizedSrc ? BRAND_FALLBACK_SRC : normalizedSrc;
    if (
      typeof effectiveSrc !== 'string'
      || !/^\/(?!\/)[^\\\s]+$/.test(effectiveSrc)
      || (effectiveSrc === BRAND_FALLBACK_SRC && (fallbackFailed || failedSrc === BRAND_FALLBACK_SRC))
    ) {
      return null;
    }

    return React.createElement('img', {
      src: effectiveSrc,
      alt: '',
      width: size,
      height: size,
      onError: () => {
        if (effectiveSrc === BRAND_FALLBACK_SRC) {
          setFallbackFailed(true);
        } else {
          setFailedSrc(normalizedSrc);
        }
      },
      style: {objectFit: 'contain', borderRadius: 6, display: 'block', margin: '0 auto', flexShrink: 0},
    });
  };
}

const SIGNIN_WRAPPED = Symbol('ldxSignInWrapped');

function registerSignInLogo(app, React, BrandLogo) {
  installSignInApiGuards(app);
  if (typeof app.router?.get !== 'function') return;
  const wrapRoute = (route) => {
    if (!route || route[SIGNIN_WRAPPED]) return false;
    if (route.skipAuthCheck === undefined) {
      route.skipAuthCheck = true;
    }
    const withLogo = NativeSignIn => function BrandedSignIn(props) {
      const [hideSignup, setHideSignup] = React.useState(false);
      React.useEffect?.(() => {
        installSignInApiGuards(app);
        if (isOnSignInRoute() && typeof window !== 'undefined' && window.location) {
          const curHref = `${window.location.pathname || ''}${window.location.search || ''}${window.location.hash || ''}`;
          const sanitized = sanitizeSignInNavigationTarget(curHref);
          if (sanitized !== curHref) {
            let navigated = false;
            if (typeof app?.router?.navigate === 'function') {
              try {
                app.router.navigate(sanitized, { replace: true });
                navigated = true;
              } catch {}
            }
            if (!navigated && typeof window.history?.replaceState === 'function') {
              try {
                window.history.replaceState(null, '', sanitized);
              } catch {}
            }
          }
        }
        let active = true;
        if (typeof app?.apiClient?.request !== 'function') return undefined;
        app.apiClient.request({ url: 'authenticators:publicList', skipAuth: true, skipNotify: true }).then((r) => {
          if (!active) return;
          const list = Array.isArray(r?.data?.data) ? r.data.data : [];
          const hasEnterprise = list.some((a) => a?.authType === 'lattice-keycloak');
          const allDisallowSignup = list.length > 0 && list.every((a) => a?.options?.allowSignUp !== true);
          if (hasEnterprise || allDisallowSignup) setHideSignup(true);
        }).catch(() => {});
        return () => { active = false; };
      }, []);
      const form = typeof NativeSignIn === 'string'
        ? app.renderComponent(NativeSignIn, props)
        : React.createElement(NativeSignIn, props);
      return React.createElement(React.Fragment, null,
        hideSignup ? React.createElement('style', null, 'a[href^="/signup"]{display:none !important;}') : null,
        React.createElement(BrandLogo, {size: 72}),
        form);
    };
    if (typeof route.componentLoader === 'function') {
      const loadNativeSignIn = route.componentLoader;
      route[SIGNIN_WRAPPED] = true;
      route.componentLoader = async () => {
        const loaded = await loadNativeSignIn();
        return withLogo(loaded.default ?? loaded.Component ?? loaded);
      };
      return true;
    }
    if (route.Component) {
      route[SIGNIN_WRAPPED] = true;
      route.Component = withLogo(route.Component);
      return true;
    }
    return false;
  };
  const wrapSignIn = () => wrapRoute(app.router.get('auth.signin'));
  if (typeof app.router.add === 'function' && !app.router[SIGNIN_ADD_GUARDED]) {
    app.router[SIGNIN_ADD_GUARDED] = true;
    const origAdd = app.router.add.bind(app.router);
    app.router.add = function guardedAdd(name, route, ...rest) {
      if (name === 'auth.signin' && route && typeof route === 'object') {
        wrapRoute(route);
      }
      return origAdd(name, route, ...rest);
    };
  }
  if (wrapSignIn() || !app.eventBus) return;
  const events = ['plugin:auth:loaded', 'plugin:@nocobase/plugin-auth:loaded'];
  const onAuthLoaded = () => {
    if (wrapSignIn()) for (const name of events) app.eventBus.removeEventListener(name, onAuthLoaded);
  };
  for (const name of events) app.eventBus.addEventListener(name, onAuthLoaded);
}

module.exports = {
  createBrandLogo,
  registerSignInLogo,
  installSignInApiGuards,
  localizeSignInError,
  resolveShortCircuitResponse,
  sanitizeSignInNavigationTarget,
  isSelfSignInTarget,
  isJwtTokenExpired,
};
