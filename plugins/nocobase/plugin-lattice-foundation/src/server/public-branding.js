/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const BRAND_LOGO_PATH = '/v/lattice-brand.svg';
const FAVICON_FALLBACK_PATH = '/v/favicon_no_exist.ico';
const DEFAULT_SEEDED_LOGO_URL = '/files/main/main/attachments/1.png';

const LATTICE_BRAND_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">',
  '<rect width="32" height="32" rx="8" fill="#0284c7"/>',
  '<path d="M9 16l5 5 9-9" stroke="#ffffff" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  '</svg>',
].join('');

const LATTICE_BRAND_SVG_BUFFER = Buffer.from(LATTICE_BRAND_SVG, 'utf8');

function createPublicBrandingGatewayHandler() {
  return async function publicBrandingGatewayHandler(req, res) {
    const method = String(req?.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      return false;
    }

    let pathname = '/';
    try {
      pathname = new URL(req?.url || '/', 'http://127.0.0.1').pathname;
    } catch {
      return false;
    }

    if (pathname !== BRAND_LOGO_PATH && pathname !== FAVICON_FALLBACK_PATH) {
      return false;
    }

    const headers = {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
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
      res.end(LATTICE_BRAND_SVG_BUFFER);
    }
    return true;
  };
}

function normalizeLogoObject(rawLogo, isAuthenticated) {
  const logoObj = rawLogo && typeof rawLogo.toJSON === 'function'
    ? rawLogo.toJSON()
    : (rawLogo && typeof rawLogo === 'object' ? { ...rawLogo } : null);

  const logoUrl = typeof logoObj?.url === 'string' ? logoObj.url.trim() : '';
  const isSeededDefault = logoUrl === DEFAULT_SEEDED_LOGO_URL || logoObj?.title === 'nocobase-logo';
  const isUnauthProtectedFile = !isAuthenticated && logoUrl.startsWith('/files/');
  const isMissingLogo = !logoUrl;

  if (!isSeededDefault && !isUnauthProtectedFile && !isMissingLogo) {
    return null;
  }

  return {
    ...(logoObj || {}),
    title: !logoObj?.title || logoObj.title === 'nocobase-logo' ? 'LatticeDX' : logoObj.title,
    url: BRAND_LOGO_PATH,
    preview: BRAND_LOGO_PATH,
  };
}

function createSystemSettingsBrandingMiddleware() {
  return async function latticePublicBrandingLogoMiddleware(ctx, next) {
    await next();
    if (
      ctx?.action?.resourceName !== 'systemSettings'
      || ctx?.action?.actionName !== 'get'
      || !ctx?.body
      || typeof ctx.body !== 'object'
    ) {
      return;
    }

    let bodyTarget = ctx.body;
    if (typeof bodyTarget.toJSON === 'function') {
      bodyTarget = bodyTarget.toJSON();
      ctx.body = bodyTarget;
    }

    const container = bodyTarget.data && typeof bodyTarget.data === 'object'
      ? bodyTarget.data
      : bodyTarget;
    if (!container || typeof container !== 'object') {
      return;
    }

    const isAuthenticated = Boolean(ctx.state?.currentUser);
    const normalizedLogo = normalizeLogoObject(container.logo, isAuthenticated);
    if (normalizedLogo) {
      container.logo = normalizedLogo;
    }
  };
}

module.exports = {
  BRAND_LOGO_PATH,
  FAVICON_FALLBACK_PATH,
  DEFAULT_SEEDED_LOGO_URL,
  LATTICE_BRAND_SVG,
  createPublicBrandingGatewayHandler,
  createSystemSettingsBrandingMiddleware,
};
