/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const net = require('node:net');
const { ORG_ID_RE, defaultFoundation, fail, runWithOptionalRls } = require('../wms-dmn-shared');

const MAX_HTTP_RESPONSE_BYTES = 16384;
const BLOCKED_PROTO = new Set(['__proto__', 'constructor', 'prototype']);
const SENSITIVE_KEY_RE = /token|secret|password|apikey|api_key|authorization|cookie|credential|jwt|bearer|privatekey|private_key|sessionid|session_id|passphrase|access_key|client_secret/i;
const JSON_QUOTED_SECRET_RE = /((?:["'])[a-zA-Z0-9_.-]*(?:token|secret|password|apikey|api_key|jwt|privatekey|private_key|client_secret|access_key|credential|passphrase|sessionid|session_id|authorization|cookie)(?:["'])\s*:\s*)(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^\s,;}"']+))/gi;
const META_HOSTS = new Set(['metadata.google.internal', 'metadata.azure.com', 'metadata.aws.internal', 'instance-data', 'fd00:ec2::254']);
const ormDepthStore = new AsyncLocalStorage();

/** Reads effective ORM trigger recursion depth across hookOpts and AsyncLocalStorage. */
function getOrmTriggerDepth(hookOpts) {
  const [rawHook, rawAls] = [Number(hookOpts?.depth), Number(ormDepthStore.getStore()?.depth)];
  return Math.max(Number.isFinite(rawHook) && rawHook >= 0 ? rawHook : 0, Number.isFinite(rawAls) && rawAls >= 0 ? rawAls : 0);
}

/** Runs an ORM write or DAG traversal with propagated recursion depth in AsyncLocalStorage. */
function runWithOrmDepth(depth, fn) {
  const n = Number(depth);
  return ormDepthStore.run({ depth: Number.isFinite(n) && n >= 0 ? n : 0 }, fn);
}

/** Wraps automation DB work in transaction-local app.current_org RLS when DX_PG_RLS_SESSION=true. */
async function runAutomationWithRls(db, organizationId, fn) {
  const orgId = typeof organizationId === 'string' ? organizationId.trim() : '';
  if (process.env.DX_PG_RLS_SESSION === 'true' && ORG_ID_RE.test(orgId)) {
    const pgRls = defaultFoundation?.pgRls;
    if (typeof pgRls?.installRlsTransactionBridge === 'function') pgRls.installRlsTransactionBridge(db);
    return runWithOptionalRls(db, orgId, fn);
  }
  return fn(null);
}

/** Enforces caller organizationId precedence and rejects cross-tenant mismatches with 403. */
function resolveTrustedOrgId(trustedOrg, untrustedOrg, message = 'Organization mismatch') {
  const [t, u] = [String(trustedOrg || '').trim(), String(untrustedOrg || '').trim()];
  if (t && u && t !== u) throw fail('NATIVE_ORGANIZATION_MISMATCH', 403, message);
  return t || u || '';
}

function extractRawAuthorityHost(rawUrl) {
  const m = String(rawUrl || '').match(/^(?:[a-z][a-z0-9+.-]*:)?\/\/([^/?#]*)/i);
  if (!m?.[1] || m[1].includes('@') || m[1].includes('\\')) return '';
  const auth = m[1];
  if (auth.startsWith('[')) return auth.includes(']') ? auth.slice(1, auth.indexOf(']')).toLowerCase().replace(/\.+$/, '') : '';
  const colon = auth.indexOf(':');
  return (colon >= 0 ? auth.slice(0, colon) : auth).toLowerCase().replace(/\.+$/, '');
}
const parseIpv4Part = (p) => (!p ? null : /^0x[0-9a-f]+$/i.test(p) ? Number.parseInt(p.slice(2), 16) : (/^0[0-7]+$/.test(p) && p.length > 1) ? Number.parseInt(p.slice(1), 8) : /^\d+$/.test(p) ? Number.parseInt(p, 10) : null);
function parseIpv4Octets(host) {
  const clean = String(host || '').trim().toLowerCase().replace(/\.+$/, '');
  if (!clean) return null;
  if (/^(?:0x[0-9a-f]+|0[0-7]+|\d+)$/i.test(clean)) {
    const num = parseIpv4Part(clean);
    return Number.isInteger(num) && num >= 0 && num <= 0xffffffff ? [(num >>> 24) & 255, (num >>> 16) & 255, (num >>> 8) & 255, num & 255] : null;
  }
  const parts = clean.split('.');
  const nums = (parts.length >= 2 && parts.length <= 4) ? parts.map(parseIpv4Part) : null;
  if (!nums || nums.some((n) => n === null || n < 0)) return null;
  if (parts.length === 4) return nums.every((n) => n <= 255) ? nums : null;
  const tail = nums[nums.length - 1];
  if (nums.slice(0, -1).some((n) => n > 255) || tail > (parts.length === 2 ? 0xffffff : 0xffff)) return null;
  return parts.length === 2 ? [nums[0], (tail >>> 16) & 255, (tail >>> 8) & 255, tail & 255] : [nums[0], nums[1], (tail >>> 8) & 255, tail & 255];
}
function isNonCanonicalHost(host) {
  const clean = String(host || '').toLowerCase().replace(/\.+$/, '');
  if (!clean) return false;
  if (/^\d+$/.test(clean) || /^0x[0-9a-f]+$/i.test(clean)) return true;
  const parts = clean.split('.');
  return parts.length >= 1 && parts.length <= 4 && parts.every((p) => /^(?:0x[0-9a-f]+|0[0-7]*|[1-9]\d*)$/i.test(p))
    && (parts.length !== 4 || parts.some((p) => /^0x/i.test(p) || (p.length > 1 && p.startsWith('0'))));
}
function isPrivateOrMetaIpv4(ipOrOctets) {
  const octets = Array.isArray(ipOrOctets) ? ipOrOctets : (() => { const p = String(ipOrOctets || '').split('.'); return p.length === 4 && p.every((x) => /^(?:0|[1-9]\d{0,2})$/.test(x)) ? p.map(Number) : null; })();
  if (!octets || octets.some((n) => n < 0 || n > 255)) return false;
  const [a, b] = octets;
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}
function parseIpv6Hextets(rawAddr) {
  const addr = String(rawAddr || '').toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  const halves = addr.includes(':') ? addr.split('::') : null;
  if (!halves || halves.length > 2) return null;
  const expand = (side, isRight) => {
    const out = [];
    for (let i = 0, tok = side ? side.split(':') : []; i < tok.length; i += 1) {
      if (tok[i].includes('.')) {
        const o = (i === tok.length - 1 && (halves.length < 2 || isRight)) ? tok[i].split('.') : null;
        if (!o || o.length !== 4 || !o.every((x) => /^(?:0|[1-9]\d{0,2})$/.test(x) && Number(x) <= 255)) return null;
        const [a, b, c, d] = o.map(Number);
        out.push(((a << 8) | b) & 0xffff, ((c << 8) | d) & 0xffff);
      } else if (/^[0-9a-f]{1,4}$/.test(tok[i])) out.push(Number.parseInt(tok[i], 16));
      else return null;
    }
    return out;
  };
  if (halves.length === 1) { const g = expand(halves[0], true); return g && g.length === 8 ? g : null; }
  const [left, right] = [expand(halves[0], false), expand(halves[1], true)];
  return (!left || !right || 8 - left.length - right.length < 1) ? null : [...left, ...Array(8 - left.length - right.length).fill(0), ...right];
}
const hextetsToIpv4 = (hi, lo) => `${(hi >>> 8) & 255}.${hi & 255}.${(lo >>> 8) & 255}.${lo & 255}`;
function isBlockedIpv6(rawHost) {
  const bare = String(rawHost || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (!bare.includes(':')) return false;
  const h = bare.includes('%') ? null : parseIpv6Hextets(bare);
  if (!h) return true;
  const [h0, h1, h2, h3, h4, h5, h6, h7] = h;
  const zero5 = h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0;
  if ((zero5 && (h5 === 0xffff || (h5 === 0 && ((h6 === 0 && h7 <= 1) || isPrivateOrMetaIpv4(hextetsToIpv4(h6, h7)))))) || (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0xffff && h5 === 0)) return true;
  if ((h0 === 0x0064 && h1 === 0xff9b && (h2 === 1 || (h2 === 0 && isPrivateOrMetaIpv4(hextetsToIpv4(h6, h7))))) || (h0 === 0x2002 && isPrivateOrMetaIpv4(hextetsToIpv4(h1, h2)))) return true;
  return (h0 & 0xffc0) === 0xfe80 || (h0 & 0xfe00) === 0xfc00 || (h0 & 0xff00) === 0xff00 || (h0 === 0x0100 && h1 === 0 && h2 === 0 && h3 === 0) || (h0 === 0x2001 && h1 === 0x0db8);
}

function isMetadataTarget(host) {
  const clean = String(host || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (!clean) return false;
  if (META_HOSTS.has(clean) || clean.endsWith('.metadata.google.internal') || clean.endsWith('.metadata.azure.com')) return true;
  if (net.isIPv4(clean) && clean.startsWith('169.254.')) return true;
  if (!clean.includes(':')) return false;
  const h = parseIpv6Hextets(clean);
  if (!h) return clean.includes('169.254.') || clean.startsWith('::ffff:') || /(?:^|:)a9fe:[0-9a-f]{1,4}$/i.test(clean);
  const [h0, h1, h2, h3, h4, h5, h6] = h;
  const zero5 = h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0;
  return (zero5 && (h5 === 0xffff || (h5 === 0 && (h6 & 0xffff) === 0xa9fe))) || (h0 & 0xffc0) === 0xfe80 || (h0 & 0xfe00) === 0xfc00;
}

function isUnsafeStaticHost(host) {
  const clean = String(host || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (!clean) return false;
  if (isMetadataTarget(clean) || clean === 'localhost' || clean.endsWith('.localhost') || clean.endsWith('.local') || clean.endsWith('.internal')) return true;
  if (isNonCanonicalHost(clean) || (clean.includes(':') && isBlockedIpv6(clean))) return true;
  const octets = parseIpv4Octets(clean);
  return Boolean(octets && isPrivateOrMetaIpv4(octets));
}

function isUnsafeStaticUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return false;
  const [trimmed, lower] = [rawUrl.trim(), rawUrl.trim().toLowerCase()];
  if ((lower.startsWith('/') && !lower.startsWith('//')) || (lower.startsWith('{{') && lower.endsWith('}}'))) return false;
  if (['169.254.', 'metadata.google.internal', 'metadata.azure.com', 'metadata.aws.internal', 'instance-data', 'fd00:ec2::254', '0xa9fea9fe', '2852039166'].some((p) => lower.includes(p))) return true;
  const hasScheme = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(trimmed);
  if (!hasScheme && !trimmed.startsWith('[') && !trimmed.includes(':') && !/^(?:\d+|0x[0-9a-f]+|[\d.]+|localhost)$/i.test(trimmed)) return false;
  const cand = lower.startsWith('//') ? `http:${trimmed}` : (hasScheme ? trimmed : (lower.includes(':') && !lower.includes('.') ? `http://[${trimmed}]` : `http://${trimmed}`));
  const rawAuth = extractRawAuthorityHost(cand);
  if (rawAuth && isUnsafeStaticHost(rawAuth)) return true;
  try { return isUnsafeStaticHost(new URL(cand).hostname); } catch { return isUnsafeStaticHost(lower.split(/[/?#]/)[0]); }
}

function redactJsonQuotedSecrets(rawText) {
  let count = 0;
  const text = String(rawText ?? '').replace(JSON_QUOTED_SECRET_RE, (full, prefix, dq, sq, bare) => {
    const val = dq ?? sq ?? bare ?? '';
    if (!val || /^\[REDACTED(?:_[A-Z]+)?\]$/.test(val)) return full;
    count += 1;
    return dq !== undefined ? `${prefix}"[REDACTED]"` : sq !== undefined ? `${prefix}'[REDACTED]'` : `${prefix}[REDACTED]`;
  });
  return { text, count };
}

function sanitizeOutgoingHeaders(customHeaders, authHeaders = {}, hmacHeaders = {}) {
  const locked = new Set(['authorization', 'proxy-authorization', 'host', 'content-length', ...Object.keys(authHeaders).map((k) => k.toLowerCase()), ...Object.keys(hmacHeaders).map((k) => k.toLowerCase())]);
  const out = {};
  for (const [k, v] of Object.entries(customHeaders && typeof customHeaders === 'object' ? customHeaders : {})) {
    if (!BLOCKED_PROTO.has(k) && !locked.has(String(k).toLowerCase())) out[k] = v;
  }
  return out;
}

function scrubAndCapHttpBody(rawBody, secrets, maxBytes = MAX_HTTP_RESPONSE_BYTES) {
  const scrubStr = (s) => {
    let out = String(s);
    if (secrets && typeof secrets === 'object') for (const sv of Object.values(secrets)) if (typeof sv === 'string' && sv.length >= 4) out = out.split(sv).join('[REDACTED]');
    return redactJsonQuotedSecrets(out).text.replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, '[REDACTED_KEY]').replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi, '$1[REDACTED]');
  };
  const walk = (v, depth = 0) => {
    if (depth > 10) return '[TRUNCATED]';
    if (v == null || typeof v === 'number' || typeof v === 'boolean') return v;
    if (typeof v === 'string') return scrubStr(v);
    if (Array.isArray(v)) return v.slice(0, 200).map((x) => walk(x, depth + 1));
    if (typeof v === 'object') {
      const o = {};
      for (const [k, val] of Object.entries(v)) if (!BLOCKED_PROTO.has(k)) o[k] = SENSITIVE_KEY_RE.test(k) ? '[REDACTED]' : walk(val, depth + 1);
      return o;
    }
    return scrubStr(v);
  };
  const cleaned = walk(rawBody);
  const serialized = JSON.stringify(cleaned);
  return serialized && serialized.length > maxBytes ? { _truncated: true, preview: serialized.slice(0, Math.min(4096, maxBytes - 128)), originalBytes: serialized.length } : cleaned;
}

module.exports = {
  MAX_HTTP_RESPONSE_BYTES, SENSITIVE_KEY_RE, getOrmTriggerDepth, runWithOrmDepth, runAutomationWithRls, resolveTrustedOrgId,
  extractRawAuthorityHost, isNonCanonicalHost, isPrivateOrMetaIpv4, isBlockedIpv6, isMetadataTarget, isUnsafeStaticUrl,
  redactJsonQuotedSecrets, sanitizeOutgoingHeaders, scrubAndCapHttpBody,
};
