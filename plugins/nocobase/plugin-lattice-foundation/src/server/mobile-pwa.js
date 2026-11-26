/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SAFE_VERSION_RE = /[^a-zA-Z0-9._-]/g;
const STATIC_ASSET_MATCH_RE = /^(?:\/(?:v\/)?assets\/[a-zA-Z0-9._/-]+\.(?:js|css|svg|png|woff2?)|\/v\/global\.css|\/v\/browser-checker\.js(?:\?v=[0-9a-zA-Z._-]+)?)$/;

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC32_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makePngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function buildPngIconBuffer(size) {
  const dim = Number(size) === 512 ? 512 : 192;
  const stride = 1 + dim * 4;
  const raw = Buffer.alloc(stride * dim);
  const scale = dim / 192;

  for (let y = 0; y < dim; y += 1) {
    const rowStart = y * stride;
    raw[rowStart] = 0;
    const sy = y / scale;
    for (let x = 0; x < dim; x += 1) {
      const sx = x / scale;
      let r = 15;
      let g = 23;
      let b = 42;
      let a = 255;

      // Green status circle: cx=132, cy=64, r=16
      const dx = sx - 132;
      const dy = sy - 64;
      if (dx * dx + dy * dy <= 16 * 16) {
        r = 34;
        g = 197;
        b = 94;
      } else if (
        (sx >= 56 && sx <= 84 && sy >= 52 && sy <= 140)
        || (sx >= 56 && sx <= 136 && sy >= 116 && sy <= 140)
      ) {
        // Sky-blue LatticeDX "L" glyph
        r = 56;
        g = 189;
        b = 248;
      }

      const px = rowStart + 1 + x * 4;
      raw[px] = r;
      raw[px + 1] = g;
      raw[px + 2] = b;
      raw[px + 3] = a;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(dim, 0);
  ihdr.writeUInt32BE(dim, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idat = zlib.deflateSync(raw, { level: 6 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    makePngChunk('IHDR', ihdr),
    makePngChunk('IDAT', idat),
    makePngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const PNG_ICON_192 = buildPngIconBuffer(192);
const PNG_ICON_512 = buildPngIconBuffer(512);

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
        src: '/api/dxos:icon-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any maskable',
      },
      {
        src: '/api/dxos:icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any maskable',
      },
    ],
  };
}

function sanitizePrecacheAssets(assets = []) {
  const seen = new Set();
  const safe = [];
  for (const raw of Array.isArray(assets) ? assets : []) {
    const val = String(raw || '').trim();
    if (!val || val.includes('..') || val.toLowerCase().includes('%2f')) continue;
    if (!STATIC_ASSET_MATCH_RE.test(val)) continue;
    if (!seen.has(val)) {
      seen.add(val);
      safe.push(val);
    }
  }
  return safe;
}

function extractClientV2AssetUrls(html = '') {
  const src = String(html || '');
  const found = [];
  const attrRe = /(?:src|href)=["'](\/(?:(?:v\/)?assets\/[a-zA-Z0-9._/-]+\.(?:js|css|svg|png|woff2?)|v\/global\.css|v\/browser-checker\.js(?:\?v=[0-9a-zA-Z._-]+)?))["']/g;
  let m = attrRe.exec(src);
  while (m) {
    found.push(m[1]);
    m = attrRe.exec(src);
  }
  return sanitizePrecacheAssets(found);
}

function resolveDefaultIndexHtml() {
  const candidates = [];
  if (process.env.APP_PACKAGE_ROOT) {
    candidates.push(path.resolve(process.env.APP_PACKAGE_ROOT, 'dist/client/v/index.html'));
  }
  candidates.push(
    path.resolve(process.cwd(), 'node_modules/@nocobase/app/dist/client/v/index.html'),
    '/app/nocobase/node_modules/@nocobase/app/dist/client/v/index.html',
  );
  const appPublicPath = String(process.env.APP_PUBLIC_PATH || '').trim();
  if (appPublicPath && appPublicPath !== '/') {
    try {
      if (fs.existsSync(appPublicPath) && fs.statSync(appPublicPath).isDirectory()) {
        candidates.push(
          path.resolve(appPublicPath, 'v/index.html'),
          path.resolve(appPublicPath, 'index.html'),
        );
      }
    } catch {
      // Ignore unreadable APP_PUBLIC_PATH
    }
  }
  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p) && fs.statSync(p).isFile()) {
        return fs.readFileSync(p, 'utf8');
      }
    } catch {
      // Ignore unreadable candidate path
    }
  }
  return null;
}

async function resolveDefaultV2IndexHtml({ Gateway } = {}) {
  let gatewayClass = Gateway;
  if (gatewayClass === undefined) {
    try {
      gatewayClass = require('@nocobase/server')?.Gateway;
    } catch {
      gatewayClass = null;
    }
  }
  try {
    const gwInstance = typeof gatewayClass?.getInstance === 'function' ? gatewayClass.getInstance() : null;
    if (gwInstance && typeof gwInstance.renderV2IndexHtml === 'function') {
      const rendered = await gwInstance.renderV2IndexHtml();
      if (typeof rendered === 'string' && rendered.trim()) {
        return rendered;
      }
    }
  } catch {
    // Fall through to filesystem template lookup
  }
  return resolveDefaultIndexHtml();
}

function injectMobilePwaHead(html = '', { precacheAssets } = {}) {
  let out = typeof html === 'string' ? html : String(html || '');
  if (!out.trim()) out = resolveDefaultIndexHtml() || '';
  if (!out.trim()) return '';
  const discovered = Array.isArray(precacheAssets) ? sanitizePrecacheAssets(precacheAssets) : extractClientV2AssetUrls(out);
  const headSnippets = [];
  if (!/name=["']theme-color["']/i.test(out)) {
    headSnippets.push('<meta name="theme-color" content="#0f172a">');
  }
  if (!/name=["']apple-mobile-web-app-capable["']/i.test(out)) {
    headSnippets.push('<meta name="apple-mobile-web-app-capable" content="yes">');
  }
  if (!/rel=["']manifest["']/i.test(out)) {
    headSnippets.push('<link rel="manifest" href="/api/dxos:manifest">');
  }
  if (!/rel=["']apple-touch-icon["']/i.test(out)) {
    headSnippets.push('<link rel="apple-touch-icon" href="/api/dxos:icon-192.png">');
  }
  if (!out.includes('/api/dxos:sw.js')) {
    const safeAssetsJson = JSON.stringify(discovered);
    headSnippets.push(
      `<script>(function(){if(typeof navigator==='undefined'||!('serviceWorker' in navigator))return;var a=${safeAssetsJson};navigator.serviceWorker.register('/api/dxos:sw.js',{scope:'/'}).then(function(r){var sw=r&&(r.active||r.installing||r.waiting)||navigator.serviceWorker.controller;if(sw&&a.length&&typeof sw.postMessage==='function'){sw.postMessage({type:'PRECACHE_ASSETS',assets:a});}}).catch(function(){});})();</script>`,
    );
  }
  if (!headSnippets.length) return out;
  const injected = `${headSnippets.join('\n  ')}\n`;
  if (/<\/head>/i.test(out)) {
    return out.replace(/<\/head>/i, `  ${injected}</head>`);
  }
  return `${injected}${out}`;
}

function createMobilePwaGatewayHandler({ readIndexHtml, precacheAssets, Gateway } = {}) {
  return async function mobilePwaGatewayHandler(req, res) {
    const method = String(req?.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      return false;
    }
    let urlObj;
    try {
      urlObj = new URL(req?.url || '/', 'http://127.0.0.1');
    } catch {
      return false;
    }
    const pathname = urlObj.pathname.replace(/\/+$/, '') || '/';
    if (pathname !== '/v/mobile') {
      return false;
    }
    const hasExplicitReader = typeof readIndexHtml === 'function';
    const rawHtml = hasExplicitReader
      ? await readIndexHtml(req)
      : await resolveDefaultV2IndexHtml({ Gateway });
    if (typeof rawHtml !== 'string' || !rawHtml.trim()) {
      return false;
    }
    if (!hasExplicitReader && !/<script\b/i.test(rawHtml)) {
      return false;
    }
    const html = injectMobilePwaHead(rawHtml, { precacheAssets });
    if (!html || !html.trim()) {
      return false;
    }
    const headers = {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    };
    if (typeof res?.writeHead === 'function') {
      res.writeHead(200, headers);
    } else if (typeof res?.setHeader === 'function') {
      res.statusCode = 200;
      for (const [k, v] of Object.entries(headers)) {
        res.setHeader(k, v);
      }
    }
    if (method === 'HEAD') {
      res.end();
    } else {
      res.end(html);
    }
    return true;
  };
}

function buildServiceWorkerScript({ version = '0.4.2', precacheAssets = [] } = {}) {
  const safeVersion = String(version || '0.4.2').replace(SAFE_VERSION_RE, '').slice(0, 32) || '0.4.2';
  const cacheName = `latticedx-field-pwa-v${safeVersion}`;
  const shellUrls = [
    '/v/mobile',
    '/api/dxos:manifest',
    '/api/dxos:icon-192.png',
    '/api/dxos:icon-512.png',
    ...sanitizePrecacheAssets(precacheAssets),
  ];

  return [
    `const CACHE_NAME = ${JSON.stringify(cacheName)};`,
    `const SHELL_URLS = ${JSON.stringify(shellUrls)};`,
    `const STATIC_ASSET_RE = /^\\/(?:(?:v\\/)?assets\\/[a-zA-Z0-9._\\/-]+\\.(?:js|css|svg|png|woff2?)|v\\/global\\.css|v\\/browser-checker\\.js(?:\\?v=[0-9a-zA-Z._-]+)?)$/;`,
    '',
    'function isSafeShellPath(pathname) {',
    '  if (!pathname || pathname.includes("..") || pathname.toLowerCase().includes("%2f")) return false;',
    '  if (pathname === "/v/mobile" || pathname === "/api/dxos:manifest" || pathname === "/api/dxos:icon-192.png" || pathname === "/api/dxos:icon-512.png") return true;',
    '  return STATIC_ASSET_RE.test(pathname);',
    '}',
    '',
    'function isCacheableResponse(response) {',
    '  if (!response || !response.ok) return false;',
    '  if (response.redirected) return false;',
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
    '  // CRITICAL SECURITY INVARIANT: NetworkOnly for all /api/* endpoints except /api/dxos:manifest and static PWA PNG icons.',
    '  if (url.pathname.startsWith("/api/") && url.pathname !== "/api/dxos:manifest" && url.pathname !== "/api/dxos:icon-192.png" && url.pathname !== "/api/dxos:icon-512.png") return;',
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
    'self.addEventListener("message", (event) => {',
    '  const data = event && event.data;',
    '  if (!data || data.type !== "PRECACHE_ASSETS" || !Array.isArray(data.assets)) return;',
    '  const safe = data.assets.filter((u) => {',
    '    if (typeof u !== "string" || !u.startsWith("/")) return false;',
    '    if (u.startsWith("/api/")) return false;',
    '    return isSafeShellPath(u);',
    '  });',
    '  if (!safe.length) return;',
    '  const work = caches.open(CACHE_NAME).then((cache) => cache.addAll(safe)).catch(() => undefined);',
    '  if (typeof event.waitUntil === "function") event.waitUntil(work);',
    '});',
    '',
  ].join('\n');
}

function registerMobilePwaActions(targetOrOpts = {}, maybeOpts = {}) {
  const isAppTarget = Boolean(targetOrOpts && typeof targetOrOpts === 'object' && targetOrOpts.resourceManager);
  const opts = isAppTarget ? maybeOpts : targetOrOpts;
  const version = typeof opts?.version === 'string' && opts.version.trim() ? opts.version.trim() : '0.4.2';

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
    let precacheAssets = [];
    if (Array.isArray(opts?.precacheAssets)) {
      precacheAssets = opts.precacheAssets;
    } else {
      const htmlTemplate = typeof opts?.readIndexHtml === 'function'
        ? await opts.readIndexHtml()
        : await resolveDefaultV2IndexHtml({ Gateway: opts?.Gateway });
      precacheAssets = htmlTemplate ? extractClientV2AssetUrls(htmlTemplate) : [];
    }
    ctx.body = buildServiceWorkerScript({ version, precacheAssets });
    if (next) await next();
  };

  const makeIconHandler = (buf) => async (ctx, next) => {
    if (ctx?.method && String(ctx.method).trim().toUpperCase() !== 'GET') {
      failPwa(ctx, 405, 'Method not allowed.', 'METHOD_NOT_ALLOWED');
    }
    ctx.withoutDataWrapping = true;
    setHeader(ctx, 'Content-Type', 'image/png');
    setHeader(ctx, 'Cache-Control', 'public, max-age=86400');
    ctx.status = 200;
    ctx.body = buf;
    if (next) await next();
  };

  const actions = {
    manifest: manifestHandler,
    'sw.js': swHandler,
    sw: swHandler,
    'icon-192.png': makeIconHandler(PNG_ICON_192),
    'icon-512.png': makeIconHandler(PNG_ICON_512),
  };

  if (isAppTarget && typeof targetOrOpts.resourceManager?.define === 'function') {
    targetOrOpts.resourceManager.define({ name: 'dxos', actions });
    if (typeof targetOrOpts.acl?.allow === 'function') {
      targetOrOpts.acl.allow('dxos', ['manifest', 'sw.js', 'sw', 'icon-192.png', 'icon-512.png'], 'public');
    }
  }

  return actions;
}

module.exports = {
  buildPngIconBuffer,
  buildPwaManifest,
  buildServiceWorkerScript,
  extractClientV2AssetUrls,
  resolveDefaultIndexHtml,
  resolveDefaultV2IndexHtml,
  injectMobilePwaHead,
  createMobilePwaGatewayHandler,
  registerMobilePwaActions,
};
