/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const SVG_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192"><rect width="192" height="192" rx="36" fill="#0f172a"/><path d="M56 52h28v64h52v24H56V52z" fill="#38bdf8"/><circle cx="132" cy="64" r="16" fill="#22c55e"/></svg>';
const ICON_DATA_URI = `data:image/svg+xml;base64,${Buffer.from(SVG_ICON, 'utf8').toString('base64')}`;
const SAFE_VERSION_RE = /[^a-zA-Z0-9._-]/g;

function failPwa(ctx, status, message, code) {
  if (typeof ctx?.throw === 'function') {
    ctx.throw(status, message, code ? { code } : undefined);
  }
  throw Object.assign(new Error(message || `HTTP ${status}`), { status, code });
}

function setHeader(ctx, name, value) {
  if (typeof ctx?.set === 'function') {
    ctx.set(name, value);
    return;
  }
  if (typeof ctx?.response?.set === 'function') {
    ctx.response.set(name, value);
    return;
  }
  ctx.response = ctx.response || {};
  ctx.response.headers = ctx.response.headers || {};
  ctx.response.headers[name] = value;
}

function buildPwaManifest() {
  // Zero user/org/tenant PII or secrets — purely static public shell metadata.
  return {
    name: 'LatticeDX Field PWA',
    short_name: 'LatticeField',
    description: 'LatticeDX Mobile Field Operations & Offline ePOD Capture',
    start_url: '/v/mobile',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait-primary',
    background_color: '#0f172a',
    theme_color: '#0f172a',
    icons: [
      {
        src: ICON_DATA_URI,
        sizes: '192x192',
        type: 'image/svg+xml',
        purpose: 'any maskable',
      },
      {
        src: ICON_DATA_URI,
        sizes: '512x512',
        type: 'image/svg+xml',
        purpose: 'any maskable',
      },
    ],
  };
}

function buildServiceWorkerScript({ version = '1.0.0' } = {}) {
  const safeVersion = String(version || '1.0.0').replace(SAFE_VERSION_RE, '').slice(0, 32) || '1.0.0';
  const cacheName = `latticedx-field-pwa-v${safeVersion}`;

  return [
    `const CACHE_NAME = ${JSON.stringify(cacheName)};`,
    `const SHELL_URLS = ['/v/mobile', '/api/dxos:manifest'];`,
    `const STATIC_ASSET_RE = /^\\/(?:v\\/)?assets\\/[a-zA-Z0-9._\\/-]+\\.(?:js|css|svg|png|woff2?)$/;`,
    '',
    'function isSafeShellPath(pathname) {',
    '  if (!pathname || pathname.includes("..") || pathname.toLowerCase().includes("%2f")) return false;',
    '  if (pathname === "/v/mobile" || pathname === "/api/dxos:manifest") return true;',
    '  return STATIC_ASSET_RE.test(pathname);',
    '}',
    '',
    'function isCacheableResponse(response) {',
    '  if (!response || !response.ok) return false;',
    '  if (response.type && response.type !== "basic") return false;',
    '  const cc = String(response.headers && response.headers.get ? response.headers.get("Cache-Control") || "" : "").toLowerCase();',
    '  if (cc.includes("no-store") || cc.includes("private")) return false;',
    '  const setCookie = response.headers && response.headers.get ? response.headers.get("Set-Cookie") : null;',
    '  if (setCookie) return false;',
    '  return true;',
    '}',
    '',
    'self.addEventListener("install", (event) => {',
    '  event.waitUntil(',
    '    caches.open(CACHE_NAME)',
    '      .then((cache) => cache.addAll(SHELL_URLS))',
    '      .catch(() => undefined)',
    '      .then(() => self.skipWaiting())',
    '  );',
    '});',
    '',
    'self.addEventListener("activate", (event) => {',
    '  event.waitUntil(',
    '    caches.keys()',
    '      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))',
    '      .then(() => self.clients.claim())',
    '  );',
    '});',
    '',
    'self.addEventListener("fetch", (event) => {',
    '  const req = event.request;',
    '  if (!req || req.method !== "GET") return;',
    '  let url;',
    '  try {',
    '    url = new URL(req.url, self.location.origin);',
    '  } catch {',
    '    return;',
    '  }',
    '  if (url.origin !== self.location.origin) return;',
    '  // CRITICAL SECURITY INVARIANT: NetworkOnly for all /api/* endpoints except /api/dxos:manifest.',
    '  if (url.pathname.startsWith("/api/") && url.pathname !== "/api/dxos:manifest") return;',
    '  if (!isSafeShellPath(url.pathname)) return;',
    '',
    '  event.respondWith(',
    '    fetch(req)',
    '      .then((res) => {',
    '        if (isCacheableResponse(res)) {',
    '          const copy = res.clone();',
    '          caches.open(CACHE_NAME).then((cache) => cache.put(url.pathname, copy)).catch(() => undefined);',
    '        }',
    '        return res;',
    '      })',
    '      .catch(() => caches.open(CACHE_NAME).then((cache) => cache.match(url.pathname).then((hit) => hit || cache.match(req))))',
    '  );',
    '});',
    '',
  ].join('\n');
}

function registerMobilePwaActions(targetOrOpts = {}, maybeOpts = {}) {
  const isAppTarget = Boolean(targetOrOpts && typeof targetOrOpts === 'object' && targetOrOpts.resourceManager);
  const opts = isAppTarget ? maybeOpts : targetOrOpts;
  const version = typeof opts?.version === 'string' && opts.version.trim() ? opts.version.trim() : '1.0.0';

  const manifestHandler = async (ctx, next) => {
    if (ctx?.method && String(ctx.method).trim().toUpperCase() !== 'GET') {
      failPwa(ctx, 405, 'Method not allowed.', 'METHOD_NOT_ALLOWED');
    }
    ctx.withoutDataWrapping = true;
    setHeader(ctx, 'Content-Type', 'application/manifest+json; charset=utf-8');
    setHeader(ctx, 'Cache-Control', 'public, max-age=300');
    ctx.status = 200;
    ctx.body = buildPwaManifest();
    if (next) await next();
  };

  const swHandler = async (ctx, next) => {
    if (ctx?.method && String(ctx.method).trim().toUpperCase() !== 'GET') {
      failPwa(ctx, 405, 'Method not allowed.', 'METHOD_NOT_ALLOWED');
    }
    ctx.withoutDataWrapping = true;
    setHeader(ctx, 'Content-Type', 'application/javascript; charset=utf-8');
    setHeader(ctx, 'Service-Worker-Allowed', '/');
    setHeader(ctx, 'Cache-Control', 'no-cache, no-store, must-revalidate');
    ctx.status = 200;
    ctx.body = buildServiceWorkerScript({ version });
    if (next) await next();
  };

  const actions = {
    manifest: manifestHandler,
    'sw.js': swHandler,
    sw: swHandler,
  };

  if (isAppTarget && typeof targetOrOpts.resourceManager?.define === 'function') {
    targetOrOpts.resourceManager.define({ name: 'dxos', actions });
    if (typeof targetOrOpts.acl?.allow === 'function') {
      targetOrOpts.acl.allow('dxos', ['manifest', 'sw.js', 'sw'], 'public');
    }
  }

  return actions;
}

module.exports = {
  buildPwaManifest,
  buildServiceWorkerScript,
  registerMobilePwaActions,
};
