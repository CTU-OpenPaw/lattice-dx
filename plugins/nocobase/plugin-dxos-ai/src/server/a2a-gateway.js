/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { randomUUID } = require('node:crypto');
const dns = require('node:dns');
const net = require('node:net');
const path = require('node:path');

const {
  STARTER_AI_BLUEPRINTS,
  recordAiAuditLog,
  resolveDefaultOrganizationId,
} = require('./ai-schemas');
const { enforceProfileRoleLock } = require('./ai-sync');
const {
  ADMIN_BUILDER_TOOL_NAMES,
  val,
  resolveCallerRoleNames,
  isStudioAdmin,
} = require('./ai-tools-core');
const { redactPiiText, redactPiiDeep } = require('./ai-governance');
const { runWithTenantRls, runWithSystemRlsBypass } = require('./ai-rls');

const A2A_AGENT_CARD_PATHS = Object.freeze([
  '/.well-known/agent-card.json',
  '/api/dxos-a2a/agent-card.json',
]);
const A2A_RPC_PATH = '/api/dxos-a2a';
const A2A_VALID_STATUSES = Object.freeze([
  'submitted',
  'working',
  'input-required',
  'completed',
  'failed',
  'canceled',
]);
const A2A_TERMINAL_STATES = Object.freeze(['completed', 'failed', 'canceled']);
const A2A_TERMINAL_SET = new Set(A2A_TERMINAL_STATES);

const ORG_ID_RE = /^[a-zA-Z0-9_-]{1,80}$/;
const TASK_ID_RE = /^[a-zA-Z0-9._:-]{1,128}$/;
const AGENT_ID_RE = /^[a-z0-9][a-z0-9_-]{1,62}$/;
const PROTO_POLLUTION_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isValidOrganizationId(raw) {
  if (typeof raw !== 'string') return false;
  const clean = raw.trim();
  if (!clean) return false;
  const lower = clean.toLowerCase();
  if (lower === 'all' || PROTO_POLLUTION_KEYS.has(lower)) return false;
  return ORG_ID_RE.test(clean);
}
const SENSITIVE_HEADER_KEYS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'proxy-authorization',
]);

function a2aError(code, status, message, rpcCode = -32000, data = undefined) {
  return Object.assign(new Error(message || code), { code, status, rpcCode, data });
}

function loadSiblingModule(pluginDir, serverSubpath) {
  const inDist = __dirname.includes(`${path.sep}dist${path.sep}`);
  const pkgName = `@latticedx/${pluginDir}`;
  const candidates = inDist
    ? [
        `${pkgName}/dist/server/${serverSubpath}`,
        `${pkgName}/src/server/${serverSubpath}`,
        `../../../${pluginDir}/dist/server/${serverSubpath}`,
        `../../../${pluginDir}/src/server/${serverSubpath}`,
      ]
    : [
        `${pkgName}/src/server/${serverSubpath}`,
        `../../../${pluginDir}/src/server/${serverSubpath}`,
        `../../../${pluginDir}/dist/server/${serverSubpath}`,
      ];
  for (const modPath of candidates) {
    try {
      return require(modPath);
    } catch (err) {
      const isDirectMissing = err?.code === 'MODULE_NOT_FOUND'
        && (!Array.isArray(err.requireStack) || err.requireStack.length === 0 || err.requireStack[0] === __filename);
      if (!isDirectMissing) throw err;
    }
  }
  return null;
}

function resolveGatewayVersion() {
  try {
    return String(require('../../package.json')?.version || '0.4.1');
  } catch {
    return '0.4.1';
  }
}

function normalizePath(rawPath) {
  const p = String(rawPath || '').replace(/\/+$/, '');
  return p || '/';
}

function isAgentCardPath(rawPath) {
  const p = normalizePath(rawPath);
  return A2A_AGENT_CARD_PATHS.some((cardPath) => p === cardPath || p.endsWith(cardPath));
}

function isA2aRpcPath(rawPath) {
  const p = normalizePath(rawPath);
  return p === A2A_RPC_PATH || p.endsWith(A2A_RPC_PATH);
}

function buildStaticAgentCatalog() {
  const starterByName = new Map(
    (Array.isArray(STARTER_AI_BLUEPRINTS) ? STARTER_AI_BLUEPRINTS : []).map((bp) => [bp.username, bp]),
  );

  const catalog = {
    'dxos-architect': {
      id: 'dxos-architect',
      name: 'DX-OS System & App Architect',
      description: 'Enterprise domain schema planner, Multi-Entity App Builder 2.0, Portal composer, and workflow architect.',
      tags: ['architecture', 'app-builder', 'schema', 'portal', 'workflow'],
      isAdminBuilder: true,
      allowedRoles: ['root', 'admin'],
      systemPrompt: starterByName.get('dxos-architect')?.systemPrompt || 'Enterprise System Architect.',
    },
    'dxos-operator': {
      id: 'dxos-operator',
      name: 'DX-OS Operations Executor',
      description: 'Operational task execution, telemetry monitoring, incident triage, and governed workflow actions.',
      tags: ['operations', 'it-ot', 'triage', 'execution'],
      isAdminBuilder: false,
      allowedRoles: ['root', 'admin', 'ldx_admin', 'ldx_director', 'ldx_manager', 'ldx_operator', 'ldx_dispatcher', 'ldx_warehouse'],
      systemPrompt: 'You are DX-OS Operations Executor. Execute governed operational tasks within caller organization and RBAC bounds.',
    },
    'dxos-analyst': {
      id: 'dxos-analyst',
      name: 'DX-OS Enterprise Analyst',
      description: 'Cross-department analytics, impact graph tracing, KPI insights, and SLA compliance diagnostics.',
      tags: ['analytics', 'bi', 'impact-graph', 'diagnostics'],
      isAdminBuilder: false,
      allowedRoles: ['root', 'admin', 'ldx_admin', 'ldx_director', 'ldx_manager', 'ldx_employee'],
      systemPrompt: 'You are DX-OS Enterprise Analyst. Analyze organizational metrics, impact lineage, and operational bottlenecks.',
    },
    'dxos-coordinator': {
      id: 'dxos-coordinator',
      name: 'DX-OS Multi-Agent Coordinator',
      description: starterByName.get('dxos-coordinator')?.bio || 'Central multi-agent orchestration and cross-department delegation coordinator.',
      tags: ['coordination', 'orchestration', 'radar', 'routing'],
      isAdminBuilder: false,
      allowedRoles: starterByName.get('dxos-coordinator')?.allowedRoles || ['root', 'admin', 'ldx_admin', 'ldx_director', 'ldx_manager', 'ldx_employee'],
      systemPrompt: starterByName.get('dxos-coordinator')?.systemPrompt || 'Central coordinator.',
    },
    'dxos-ops': {
      id: 'dxos-ops',
      name: 'DX-OS Cold-Chain & IoT Ops',
      description: starterByName.get('dxos-ops')?.bio || 'FIWARE Orion-LD telemetry monitoring, P.A.R.A. SOP lookup, and incident remediation.',
      tags: ['cold-chain', 'iot', 'orion-ld', 'incidents'],
      isAdminBuilder: false,
      allowedRoles: starterByName.get('dxos-ops')?.allowedRoles || ['root', 'admin', 'ldx_admin', 'ldx_director', 'ldx_manager', 'ldx_employee', 'ldx_warehouse'],
      systemPrompt: starterByName.get('dxos-ops')?.systemPrompt || 'Cold-chain & IoT specialist.',
    },
    'dxos-logistics': {
      id: 'dxos-logistics',
      name: 'DX-OS Cold-Chain Logistics Dispatcher',
      description: starterByName.get('dxos-logistics')?.bio || '5-step cold-chain shipment tracking, bottleneck radar, and ePOD handoff support.',
      tags: ['logistics', 'fefo', 'dispatch', 'epod'],
      isAdminBuilder: false,
      allowedRoles: starterByName.get('dxos-logistics')?.allowedRoles || ['root', 'admin', 'ldx_admin', 'ldx_director', 'ldx_manager', 'ldx_employee', 'ldx_warehouse', 'ldx_dispatcher', 'ldx_driver'],
      systemPrompt: starterByName.get('dxos-logistics')?.systemPrompt || 'Logistics specialist.',
    },
    'dxos-workspace': {
      id: 'dxos-workspace',
      name: 'DX-OS Services, Procurement & P.A.R.A. Assistant',
      description: starterByName.get('dxos-workspace')?.bio || 'P.A.R.A. knowledge search, service ticket drafting, and procurement workflow support.',
      tags: ['services', 'procurement', 'para', 'knowledge'],
      isAdminBuilder: false,
      allowedRoles: starterByName.get('dxos-workspace')?.allowedRoles || ['root', 'admin', 'ldx_admin', 'ldx_director', 'ldx_manager', 'ldx_employee'],
      systemPrompt: starterByName.get('dxos-workspace')?.systemPrompt || 'Workspace & P.A.R.A. assistant.',
    },
  };
  return Object.freeze(catalog);
}

const A2A_AGENT_CATALOG = buildStaticAgentCatalog();

function readHeaderValue(reqOrCtx, headerName) {
  if (!reqOrCtx || typeof reqOrCtx !== 'object') return '';
  const target = String(headerName || '').toLowerCase();
  const sources = [reqOrCtx.headers, reqOrCtx.request?.headers];
  for (const bag of sources) {
    if (!bag || typeof bag !== 'object') continue;
    for (const [k, v] of Object.entries(bag)) {
      if (String(k).toLowerCase() !== target) continue;
      const raw = Array.isArray(v) ? v[0] : v;
      if (raw !== undefined && raw !== null) {
        const str = String(raw).trim();
        if (str) return str;
      }
    }
  }
  if (typeof reqOrCtx.get === 'function') {
    try {
      const got = reqOrCtx.get(headerName);
      if (got !== undefined && got !== null) {
        const str = String(got).trim();
        if (str) return str;
      }
    } catch {
      // ignore header getter errors
    }
  }
  return '';
}

function resolveRequestOriginFromHeaders(reqOrCtx) {
  if (!reqOrCtx || typeof reqOrCtx !== 'object') return '';
  const rawProto = readHeaderValue(reqOrCtx, 'x-forwarded-proto');
  const protoToken = String(rawProto || '').split(',')[0].trim().toLowerCase();
  let proto = '';
  if (protoToken === 'http' || protoToken === 'https') {
    proto = protoToken;
  } else {
    const ctxProto = String(reqOrCtx.protocol || '').trim().toLowerCase();
    if (ctxProto === 'http' || ctxProto === 'https') {
      proto = ctxProto;
    } else {
      proto = reqOrCtx.socket?.encrypted ? 'https' : 'http';
    }
  }

  const rawHostHeader = readHeaderValue(reqOrCtx, 'x-forwarded-host') || readHeaderValue(reqOrCtx, 'host');
  const rawHost = String(rawHostHeader || '').split(',')[0].trim();
  if (!rawHost || rawHost.length > 255) return '';
  if (/[\s/\\@?#%\u0000-\u001f\u007f]/.test(rawHost)) return '';

  try {
    const parsed = new URL(`${proto}://${rawHost}`);
    if (parsed.protocol !== `${proto}:`) return '';
    if (parsed.username || parsed.password) return '';
    if ((parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) return '';
    if (!parsed.host || !parsed.hostname) return '';
    const lowerRaw = rawHost.toLowerCase();
    const lowerHost = parsed.host.toLowerCase();
    const isExplicitDefaultPort = (proto === 'http' && lowerRaw === `${parsed.hostname.toLowerCase()}:80`)
      || (proto === 'https' && lowerRaw === `${parsed.hostname.toLowerCase()}:443`);
    if (lowerHost !== lowerRaw && !isExplicitDefaultPort) {
      return '';
    }
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return '';
  }
}

function resolveSafeCardEndpointUrl(baseUrl, env = process.env, reqOrCtx = null) {
  const candidates = [
    baseUrl,
    env?.DXOS_A2A_PUBLIC_URL,
    env?.DXOS_PUBLIC_URL,
    env?.NOCOBASE_PUBLIC_URL,
    resolveRequestOriginFromHeaders(reqOrCtx),
    'http://127.0.0.1:13000',
  ];
  let raw = 'http://127.0.0.1:13000';
  for (const candidate of candidates) {
    const trimmed = String(candidate ?? '').trim();
    if (trimmed) {
      raw = trimmed;
      break;
    }
  }
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return 'http://127.0.0.1:13000/api/dxos-a2a';
    }
    const cleanOrigin = `${parsed.protocol}//${parsed.host}`;
    const cleanPath = normalizePath(parsed.pathname);
    if (cleanPath === A2A_RPC_PATH || cleanPath.endsWith(A2A_RPC_PATH)) {
      return `${cleanOrigin}${cleanPath}`;
    }
    return `${cleanOrigin}${A2A_RPC_PATH}`;
  } catch {
    return 'http://127.0.0.1:13000/api/dxos-a2a';
  }
}

function buildAgentCard({ baseUrl, version, env = process.env, reqOrCtx = null } = {}) {
  const skills = Object.values(A2A_AGENT_CATALOG).map((entry) => ({
    id: entry.id,
    name: entry.name,
    description: entry.description,
    tags: [...entry.tags],
    inputModes: ['text/plain', 'application/json'],
    outputModes: ['text/plain', 'application/json'],
  }));

  return {
    name: 'LatticeDX Enterprise A2A Gateway',
    description: 'Governed Google/LF A2A protocol gateway for LatticeDX enterprise AI agents.',
    url: resolveSafeCardEndpointUrl(baseUrl, env, reqOrCtx),
    version: String(version || resolveGatewayVersion()),
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: true,
    },
    authentication: {
      schemes: ['bearer'],
    },
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['text/plain', 'application/json'],
    skills,
  };
}

function createAgentCardMiddleware({ baseUrl, version, env = process.env } = {}) {
  return async function dxosA2aAgentCardMiddleware(ctx, next) {
    if (!isAgentCardPath(ctx.path)) return next();
    ctx.withoutDataWrapping = true;
    const method = String(ctx.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      ctx.status = 405;
      ctx.set?.('Allow', 'GET, HEAD');
      ctx.set?.('X-Content-Type-Options', 'nosniff');
      ctx.body = { error: { code: 'METHOD_NOT_ALLOWED', message: 'Agent Card endpoint only accepts GET/HEAD.' } };
      return;
    }
    ctx.set?.('Content-Type', 'application/json; charset=utf-8');
    ctx.set?.('Cache-Control', 'no-store');
    ctx.set?.('X-Content-Type-Options', 'nosniff');
    ctx.status = 200;
    ctx.body = buildAgentCard({ baseUrl, version, env, reqOrCtx: ctx });
  };
}

function createGatewayAgentCardRequestHandler({ baseUrl, version, env = process.env } = {}) {
  return async function dxosA2aGatewayAgentCardHandler(req, res) {
    let pathname = '/';
    try {
      pathname = new URL(String(req?.url || '/'), 'http://127.0.0.1').pathname;
    } catch {
      return false;
    }
    if (!isAgentCardPath(pathname)) {
      return false;
    }

    const method = String(req?.method || 'GET').trim().toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      res.statusCode = 405;
      res.setHeader?.('Allow', 'GET, HEAD');
      res.setHeader?.('Content-Type', 'application/json; charset=utf-8');
      res.setHeader?.('Cache-Control', 'no-store');
      res.setHeader?.('X-Content-Type-Options', 'nosniff');
      res.end(JSON.stringify({ error: 'Method Not Allowed' }));
      return true;
    }

    const card = buildAgentCard({ baseUrl, version, env, reqOrCtx: req });
    res.statusCode = 200;
    res.setHeader?.('Content-Type', 'application/json; charset=utf-8');
    res.setHeader?.('Cache-Control', 'no-store');
    res.setHeader?.('X-Content-Type-Options', 'nosniff');
    if (method === 'HEAD') {
      res.end();
    } else {
      res.end(JSON.stringify(card));
    }
    return true;
  };
}

function assertNoPrototypePollution(value, pathPrefix = 'payload', depth = 0) {
  if (depth > 24) {
    throw a2aError('A2A_PAYLOAD_TOO_DEEP', 400, 'JSON-RPC payload nesting exceeds maximum depth.', -32602);
  }
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      assertNoPrototypePollution(value[i], `${pathPrefix}[${i}]`, depth + 1);
    }
    return value;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw a2aError('A2A_PROTOTYPE_POLLUTION', 400, `Unsafe object prototype at ${pathPrefix}.`, -32602);
  }
  for (const key of Object.getOwnPropertyNames(value)) {
    if (PROTO_POLLUTION_KEYS.has(key)) {
      throw a2aError('A2A_PROTOTYPE_POLLUTION', 400, `Forbidden key "${key}" at ${pathPrefix}.`, -32602);
    }
    assertNoPrototypePollution(value[key], `${pathPrefix}.${key}`, depth + 1);
  }
  return value;
}

function cloneSafePlain(value, depth = 0) {
  if (depth > 24) {
    throw a2aError('A2A_PAYLOAD_TOO_DEEP', 400, 'JSON-RPC payload nesting exceeds maximum depth.', -32602);
  }
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => cloneSafePlain(item, depth + 1));
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw a2aError('A2A_PROTOTYPE_POLLUTION', 400, 'Unsafe object prototype detected.', -32602);
  }
  const out = {};
  for (const key of Object.getOwnPropertyNames(value)) {
    if (PROTO_POLLUTION_KEYS.has(key)) {
      throw a2aError('A2A_PROTOTYPE_POLLUTION', 400, `Forbidden key "${key}".`, -32602);
    }
    out[key] = cloneSafePlain(value[key], depth + 1);
  }
  return out;
}

function isBlockedIpv4(host) {
  const parts = String(host || '').split('.');
  if (parts.length !== 4 || !parts.every((p) => /^(?:0|[1-9]\d{0,2})$/.test(p))) return false;
  const octets = parts.map(Number);
  if (octets.some((n) => n < 0 || n > 255)) return true;
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function extractRawAuthorityHost(rawUrl) {
  const m = String(rawUrl || '').match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i);
  if (!m) return '';
  const authority = m[1];
  if (!authority || authority.includes('@') || authority.includes('\\')) return '';
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']');
    if (close < 0) return '';
    return authority.slice(1, close).toLowerCase().replace(/\.+$/, '');
  }
  const colonIdx = authority.indexOf(':');
  const host = colonIdx >= 0 ? authority.slice(0, colonIdx) : authority;
  return host.toLowerCase().replace(/\.+$/, '');
}

function isNonCanonicalNumericHost(host) {
  const clean = String(host || '').toLowerCase().replace(/\.+$/, '');
  if (!clean) return false;
  if (/^\d+$/.test(clean) || /^0x[0-9a-f]+$/i.test(clean)) return true;
  const parts = clean.split('.');
  if (parts.length >= 1 && parts.length <= 4 && parts.every((p) => /^(?:0x[0-9a-f]+|0[0-7]*|[1-9]\d*)$/i.test(p))) {
    if (parts.length !== 4) return true;
    if (parts.some((p) => /^0x/i.test(p) || (p.length > 1 && p.startsWith('0')))) return true;
  }
  return false;
}

function parseIpv6Hextets(rawAddr) {
  let addr = String(rawAddr || '').toLowerCase().replace(/^\[|\]$/g, '');
  const zoneIdx = addr.indexOf('%');
  if (zoneIdx >= 0) addr = addr.slice(0, zoneIdx);
  if (!addr || !addr.includes(':')) return null;
  const doubleColonParts = addr.split('::');
  if (doubleColonParts.length > 2) return null;

  const expandSide = (side, isRight) => {
    if (!side) return [];
    const tokens = side.split(':');
    const out = [];
    for (let i = 0; i < tokens.length; i += 1) {
      const tok = tokens[i];
      if (tok.includes('.')) {
        if (i !== tokens.length - 1 || (doubleColonParts.length === 2 && !isRight)) return null;
        const octs = tok.split('.');
        if (octs.length !== 4 || !octs.every((o) => /^(?:0|[1-9]\d{0,2})$/.test(o) && Number(o) <= 255)) return null;
        const [a, b, c, d] = octs.map(Number);
        out.push(((a << 8) | b) & 0xffff, ((c << 8) | d) & 0xffff);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(tok)) return null;
        out.push(parseInt(tok, 16));
      }
    }
    return out;
  };

  if (doubleColonParts.length === 1) {
    const groups = expandSide(doubleColonParts[0], true);
    return groups && groups.length === 8 ? groups : null;
  }
  const left = expandSide(doubleColonParts[0], false);
  const right = expandSide(doubleColonParts[1], true);
  if (!left || !right) return null;
  const missing = 8 - (left.length + right.length);
  if (missing < 1) return null;
  return [...left, ...Array(missing).fill(0), ...right];
}

function hextetsToIpv4(hi, lo) {
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

function isBlockedIpv6(rawHost) {
  const bareHost = String(rawHost || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (!bareHost.includes(':')) return false;
  if (bareHost.includes('%')) return true;
  const h = parseIpv6Hextets(bareHost);
  if (!h) return true;
  const [h0, h1, h2, h3, h4, h5, h6, h7] = h;
  const isAllZeroPrefix5 = h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0;
  if (isAllZeroPrefix5 && h5 === 0 && h6 === 0 && (h7 === 0 || h7 === 1)) return true;
  if (isAllZeroPrefix5 && h5 === 0xffff) return true;
  if (isAllZeroPrefix5 && h5 === 0 && isBlockedIpv4(hextetsToIpv4(h6, h7))) return true;
  if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0xffff && h5 === 0) return true;
  if (h0 === 0x0064 && h1 === 0xff9b && (h2 === 0 || h2 === 1)) {
    if (h2 === 1 || isBlockedIpv4(hextetsToIpv4(h6, h7))) return true;
  }
  if (h0 === 0x2002 && isBlockedIpv4(hextetsToIpv4(h1, h2))) return true;
  if ((h0 & 0xffc0) === 0xfe80) return true;
  if ((h0 & 0xfe00) === 0xfc00) return true;
  if ((h0 & 0xff00) === 0xff00) return true;
  if (h0 === 0x0100 && h1 === 0 && h2 === 0 && h3 === 0) return true;
  if (h0 === 0x2001 && h1 === 0x0db8) return true;
  return false;
}

function isBlockedMetadataHost(bare) {
  const clean = String(bare || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (!clean) return false;
  return (
    clean === 'metadata.google.internal'
    || clean.endsWith('.metadata.google.internal')
    || clean === 'metadata.azure.com'
    || clean.endsWith('.metadata.azure.com')
    || clean === 'metadata.aws.internal'
    || clean === 'instance-data'
    || (net.isIPv4(clean) && clean.startsWith('169.254.'))
    || clean === 'fd00:ec2::254'
  );
}

function isBlockedResolvedAddress(rawAddr) {
  const clean = String(rawAddr || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!clean) return true;
  if (clean.includes(':')) return isBlockedIpv6(clean);
  if (isNonCanonicalNumericHost(clean)) return true;
  if (net.isIPv4(clean)) return isBlockedIpv4(clean);
  return true;
}

async function assertSafePeerUrl(
  rawUrl,
  {
    env = process.env,
    lookupImpl,
    connectorVault,
    llmClient,
    skipDnsCheck = false,
  } = {},
) {
  const trimmed = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!trimmed || trimmed.length > 2048 || /[\u0000-\u001f\u007f\s]/.test(trimmed)) {
    throw a2aError('A2A_PEER_URL_UNSAFE', 400, 'Peer URL is required and must be <= 2048 valid characters.', -32602);
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw a2aError('A2A_PEER_URL_UNSAFE', 400, 'Malformed A2A peer URL.', -32602);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw a2aError('A2A_PEER_URL_UNSAFE', 400, `Protocol ${parsed.protocol} is blocked by A2A SSRF policy.`, -32602);
  }
  if (parsed.username || parsed.password) {
    throw a2aError('A2A_PEER_URL_UNSAFE', 400, 'Embedded credentials in A2A peer URL are forbidden.', -32602);
  }

  const rawAuthorityHost = extractRawAuthorityHost(trimmed);
  const bare = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (!rawAuthorityHost || !bare || isNonCanonicalNumericHost(rawAuthorityHost) || isNonCanonicalNumericHost(bare)) {
    throw a2aError('A2A_PEER_URL_UNSAFE', 400, `Non-canonical A2A peer hostname blocked: ${bare || rawAuthorityHost}`, -32602);
  }
  if (isBlockedMetadataHost(bare) || isBlockedMetadataHost(rawAuthorityHost)) {
    throw a2aError('A2A_PEER_URL_UNSAFE', 400, `Cloud metadata hostname or IP ${bare} is blocked by A2A SSRF policy.`, -32602);
  }
  if (bare === 'localhost' || bare.endsWith('.localhost') || bare.endsWith('.local') || bare.endsWith('.internal')) {
    throw a2aError('A2A_PEER_URL_UNSAFE', 400, `Internal or local hostname ${bare} is blocked by A2A SSRF policy.`, -32602);
  }
  if (bare.includes(':') || rawAuthorityHost.includes(':')) {
    if (isBlockedIpv6(bare) || (rawAuthorityHost.includes(':') && isBlockedIpv6(rawAuthorityHost))) {
      throw a2aError('A2A_PEER_URL_UNSAFE', 400, `Blocked private or metadata IPv6 address: ${bare}`, -32602);
    }
  } else if (net.isIPv4(bare)) {
    if (isBlockedIpv4(bare)) {
      throw a2aError('A2A_PEER_URL_UNSAFE', 400, `Blocked private or link-local IPv4 address: ${bare}`, -32602);
    }
  } else if (!bare.includes('.')) {
    throw a2aError('A2A_PEER_URL_UNSAFE', 400, `Single-label internal hostname ${bare} is blocked by A2A SSRF policy.`, -32602);
  }

  const vault = connectorVault || loadSiblingModule('plugin-lattice-foundation', 'connector-vault');
  if (typeof vault?.assertSafeConnectorUrlAsync === 'function') {
    try {
      await vault.assertSafeConnectorUrlAsync(trimmed, {
        connectorType: 'http_api',
        env,
        allowInternal: false,
        lookupImpl,
        skipDnsCheck,
      });
    } catch (err) {
      throw a2aError('A2A_PEER_URL_UNSAFE', 400, err?.message || 'Blocked by connector-vault SSRF policy.', -32602);
    }
  }

  const llm = llmClient || loadSiblingModule('plugin-dxos-studio', 'flow/llm-client');
  if (typeof llm?.assertSafeLlmUrl === 'function') {
    try {
      await llm.assertSafeLlmUrl(trimmed, {
        env,
        connectorVault: vault,
        lookupImpl,
        allowExplicitHost: null,
        skipDnsCheck,
      });
    } catch (err) {
      throw a2aError('A2A_PEER_URL_UNSAFE', 400, err?.message || 'Blocked by llm-client SSRF policy.', -32602);
    }
  }

  if ((typeof lookupImpl === 'function' || !skipDnsCheck) && net.isIP(bare) === 0) {
    const lookup = typeof lookupImpl === 'function' ? lookupImpl : dns.promises.lookup;
    let records;
    try {
      records = await lookup(bare, { all: true });
    } catch (err) {
      throw a2aError('A2A_PEER_URL_UNSAFE', 400, `DNS resolution failed for peer ${bare}: ${err?.code || err?.message || 'unknown error'}`, -32602);
    }
    const list = Array.isArray(records) ? records : (records ? [records] : []);
    const addresses = list.map((r) => (typeof r === 'string' ? r : r?.address)).filter(Boolean);
    if (!addresses.length) {
      throw a2aError('A2A_PEER_URL_UNSAFE', 400, `DNS resolution returned no addresses for peer ${bare}.`, -32602);
    }
    for (const addr of addresses) {
      if (isBlockedResolvedAddress(addr)) {
        throw a2aError('A2A_PEER_URL_UNSAFE', 400, `Resolved IP address ${addr} for peer ${bare} is blocked by SSRF policy.`, -32602);
      }
    }
  }

  return parsed.toString();
}

function sanitizeOutboundHeaders(extraHeaders = {}) {
  const out = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (!extraHeaders || typeof extraHeaders !== 'object' || Array.isArray(extraHeaders)) {
    return out;
  }
  for (const [k, v] of Object.entries(extraHeaders)) {
    const lower = String(k || '').trim().toLowerCase();
    if (!lower || PROTO_POLLUTION_KEYS.has(lower) || SENSITIVE_HEADER_KEYS.has(lower)) continue;
    if (/[\r\n\0]/.test(String(v ?? ''))) continue;
    out[String(k).trim()] = String(v ?? '');
  }
  return out;
}

async function delegateToExternalA2aPeer({
  peerUrl,
  taskId,
  message,
  metadata = {},
  timeoutMs = 15000,
  fetchImpl,
  lookupImpl,
  env = process.env,
  headers = {},
  skipDnsCheck,
} = {}) {
  assertNoPrototypePollution(metadata, 'peer.metadata');
  assertNoPrototypePollution(message, 'peer.message');
  const fetchFn = fetchImpl || globalThis.fetch;
  const isMockTransport = typeof fetchImpl === 'function' && fetchImpl !== globalThis.fetch;
  const effectiveSkipDns = typeof skipDnsCheck === 'boolean'
    ? skipDnsCheck
    : (isMockTransport && typeof lookupImpl !== 'function');

  const safeUrl = await assertSafePeerUrl(peerUrl, {
    env,
    lookupImpl,
    skipDnsCheck: effectiveSkipDns,
  });

  if (typeof fetchFn !== 'function') {
    throw a2aError('A2A_FETCH_UNAVAILABLE', 503, 'HTTP fetch transport is unavailable for external A2A delegation.', -32000);
  }

  const redactedMessage = redactPiiDeep(cloneSafePlain(message || {})).value;
  const redactedMetadata = redactPiiDeep(cloneSafePlain(metadata || {})).value;
  const resolvedTaskId = String(taskId || `a2a_${randomUUID()}`);

  const rpcRequest = {
    jsonrpc: '2.0',
    id: resolvedTaskId,
    method: 'tasks/send',
    params: {
      id: resolvedTaskId,
      message: redactedMessage,
      metadata: redactedMetadata,
    },
  };

  const controller = new AbortController();
  const boundedTimeout = Math.max(500, Math.min(120000, Number(timeoutMs) || 15000));
  const timer = setTimeout(() => controller.abort(), boundedTimeout);

  try {
    const response = await fetchFn(safeUrl, {
      method: 'POST',
      redirect: 'error',
      signal: controller.signal,
      headers: sanitizeOutboundHeaders(headers),
      body: JSON.stringify(rpcRequest),
    });

    if (!response?.ok) {
      const rawErr = typeof response?.text === 'function' ? await response.text().catch(() => '') : '';
      const cleanErr = redactPiiText(String(rawErr || `Peer HTTP ${response?.status || 'error'}`)).text.slice(0, 400);
      return {
        ok: false,
        status: 'failed',
        messages: [],
        artifacts: [],
        error: { code: `PEER_HTTP_${response?.status || 'ERR'}`, message: cleanErr },
      };
    }

    const payload = typeof response.json === 'function' ? await response.json() : {};
    if (payload?.error) {
      return {
        ok: false,
        status: 'failed',
        messages: [],
        artifacts: [],
        error: {
          code: String(payload.error.code || 'PEER_RPC_ERROR'),
          message: redactPiiText(String(payload.error.message || 'External A2A peer returned error.')).text.slice(0, 400),
        },
      };
    }

    const result = payload?.result && typeof payload.result === 'object' ? payload.result : payload;
    const rawState = String(result?.status?.state || result?.state || result?.status || 'completed').trim().toLowerCase();
    const status = A2A_VALID_STATUSES.includes(rawState) ? rawState : 'completed';
    const peerMessages = Array.isArray(result?.messages)
      ? result.messages
      : (Array.isArray(result?.history) ? result.history : []);
    const peerArtifacts = Array.isArray(result?.artifacts) ? result.artifacts : [];

    return {
      ok: status !== 'failed',
      status,
      messages: cloneSafePlain(peerMessages),
      artifacts: cloneSafePlain(peerArtifacts),
      error: status === 'failed' ? (result?.error || { code: 'PEER_TASK_FAILED', message: 'Peer reported failed task.' }) : null,
      raw: cloneSafePlain(result),
    };
  } catch (err) {
    const code = err?.name === 'AbortError' ? 'PEER_TIMEOUT' : String(err?.code || 'PEER_REQUEST_FAILED');
    return {
      ok: false,
      status: 'failed',
      messages: [],
      artifacts: [],
      error: {
        code,
        message: redactPiiText(String(err?.message || 'External A2A peer call failed.')).text.slice(0, 400),
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

function extractBearerToken(ctx) {
  const auth = ctx.headers?.authorization
    || ctx.headers?.Authorization
    || ctx.request?.headers?.authorization
    || ctx.request?.headers?.Authorization;
  if (typeof auth === 'string') {
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m && m[1]) return m[1].trim();
  }
  if (typeof ctx.getBearerToken === 'function') {
    const t = ctx.getBearerToken();
    if (t) return String(t).trim();
  }
  return '';
}

async function defaultResolveHostAuth(app, db, ctx, token) {
  if (!token) return null;
  if (!ctx.db && db) ctx.db = db;
  if (!ctx.app && app) ctx.app = app;
  if (!ctx.state) ctx.state = {};
  if (!ctx.action) ctx.action = { resourceName: 'dxosA2a', actionName: 'rpc', params: {} };
  if (!ctx.dataSource) {
    ctx.dataSource = app?.mainDataSource || {
      acl: app?.acl || { allowManager: { isPublic: async () => false } },
    };
  }
  if (!ctx.query) ctx.query = {};
  if (typeof ctx.getBearerToken !== 'function') ctx.getBearerToken = () => token;
  if (typeof ctx.get !== 'function') {
    ctx.get = (header) => {
      const k = String(header || '').toLowerCase();
      return String(ctx.headers?.[k] || ctx.request?.headers?.[k] || '');
    };
  }
  if (!ctx.state?.currentUser?.id && app?.authManager && typeof app.authManager.middleware === 'function') {
    await app.authManager.middleware()(ctx, async () => {});
  }
  const user = ctx.state?.currentUser || ctx.auth?.user;
  const userId = val(user, 'id');
  if (!userId) return null;
  const rolesRepo = db?.getRepository?.('rolesUsers');
  let roleNames = Array.isArray(ctx.state?.currentRoles) ? [...ctx.state.currentRoles] : [];
  if (!roleNames.length && rolesRepo && typeof rolesRepo.find === 'function') {
    const rows = (await rolesRepo.find({ filter: { userId } })) || [];
    roleNames = rows.map((r) => val(r, 'roleName')).filter(Boolean);
  }
  const requestedRole = String(ctx.headers?.['x-role'] || ctx.request?.headers?.['x-role'] || '').trim();
  const effectiveRoles = requestedRole && roleNames.includes(requestedRole) ? [requestedRole] : roleNames;
  return {
    currentUser: typeof user.get === 'function' ? { ...(user.toJSON?.() || {}), id: userId } : { ...user, id: userId },
    currentRoles: effectiveRoles,
  };
}

async function resolveA2aAuthState(ctx, { app, db, authResolver } = {}) {
  const token = extractBearerToken(ctx);
  if (typeof authResolver === 'function') {
    try {
      const resolved = await authResolver(token, ctx);
      return resolved?.currentUser?.id ? resolved : null;
    } catch {
      return null;
    }
  }
  if (token && !ctx.state?.currentUser?.id) {
    try {
      return await defaultResolveHostAuth(app, db, ctx, token);
    } catch {
      return null;
    }
  }
  const preUser = ctx.state?.currentUser || ctx.auth?.user;
  const preUserId = val(preUser, 'id');
  if (!preUserId) return null;
  const roles = await resolveCallerRoleNames(ctx, db, preUserId);
  return {
    currentUser: typeof preUser.get === 'function' ? { ...(preUser.toJSON?.() || {}), id: preUserId } : { ...preUser, id: preUserId },
    currentRoles: roles,
    organizationId: ctx.state?.organizationId || val(preUser, 'organizationId') || null,
  };
}

function collectRequestedOrgIds(ctx, params = {}) {
  const candidates = [
    ctx?.headers?.['x-organization-id'],
    ctx?.headers?.['x-org-id'],
    ctx?.request?.headers?.['x-organization-id'],
    ctx?.request?.headers?.['x-org-id'],
    ctx?.state?.dxosTargetOrganizationId,
    params?.organizationId,
    params?.metadata?.organizationId,
    params?.message?.metadata?.organizationId,
    params?.task?.organizationId,
  ];
  const out = [];
  for (const raw of candidates) {
    if (raw === undefined || raw === null) continue;
    const clean = String(raw).trim();
    if (clean) out.push(clean);
  }
  return out;
}

async function resolveCallerOrganizationAndRoles(ctx, db, authState, params = {}) {
  const user = authState?.currentUser;
  const userId = val(user, 'id');
  if (!userId) {
    throw a2aError('A2A_UNAUTHORIZED', 401, 'Authentication required.', -32001);
  }

  ctx.state = {
    ...(ctx.state || {}),
    currentUser: user,
    ...(Array.isArray(authState.currentRoles) ? { currentRoles: [...authState.currentRoles] } : {}),
  };
  const roleNames = await resolveCallerRoleNames(ctx, db, userId);
  const isAdmin = await isStudioAdmin(ctx, db);
  const isRoot = roleNames.includes('root');

  let empOrg = '';
  const empRepo = db?.getRepository?.('latticeEmployees');
  if (empRepo && typeof empRepo.find === 'function') {
    const rows = (await runWithSystemRlsBypass(db, () => empRepo.find({ filter: { userId, active: true }, limit: 1 }))) || [];
    empOrg = String(val(rows[0], 'organizationId') || '').trim();
  } else if (empRepo && typeof empRepo.findOne === 'function') {
    const row = await runWithSystemRlsBypass(db, () => empRepo.findOne({ filter: { userId, active: true } }));
    empOrg = String(val(row, 'organizationId') || '').trim();
  }

  const stateOrg = String(
    authState?.organizationId
      || ctx.state?.organizationId
      || val(user, 'organizationId')
      || '',
  ).trim();

  let callerOrgId = empOrg || stateOrg;
  if (empOrg && stateOrg && empOrg !== stateOrg) {
    throw a2aError('A2A_CROSS_ORG_FORBIDDEN', 403, 'Caller organization mismatch.', -32003);
  }
  const requestedOrgs = [...new Set(collectRequestedOrgIds(ctx, params))];
  for (const requested of requestedOrgs) {
    if (!isValidOrganizationId(requested)) {
      throw a2aError('A2A_INVALID_ORG', 400, `Invalid organizationId "${requested}".`, -32602);
    }
  }
  if (!callerOrgId && isRoot) {
    if (requestedOrgs.length === 1 && isValidOrganizationId(requestedOrgs[0])) {
      callerOrgId = requestedOrgs[0];
    }
  }
  if (!callerOrgId && isAdmin) {
    callerOrgId = await resolveDefaultOrganizationId(db, { ctx, fallback: '' });
  }
  if (!isValidOrganizationId(callerOrgId)) {
    throw a2aError('A2A_ORG_REQUIRED', 403, 'Valid organization scope is required for A2A requests.', -32003);
  }

  return {
    userId,
    username: val(user, 'username') || val(user, 'nickname') || `user-${userId}`,
    roleNames,
    isAdmin,
    isRoot,
    organizationId: callerOrgId,
  };
}

function assertNoCrossOrgSpoofing(ctx, params = {}, callerOrgId) {
  for (const requested of collectRequestedOrgIds(ctx, params)) {
    if (!isValidOrganizationId(requested)) {
      throw a2aError('A2A_INVALID_ORG', 400, `Invalid organizationId "${requested}".`, -32602);
    }
    if (requested !== callerOrgId) {
      throw a2aError(
        'A2A_CROSS_ORG_FORBIDDEN',
        403,
        `Cross-organization access or organizationId spoofing ("${requested}") is forbidden.`,
        -32003,
      );
    }
  }
}

function parseRolesList(rawRoles) {
  let list = rawRoles;
  if (typeof list === 'string' && list.trim().startsWith('[')) {
    try {
      list = JSON.parse(list);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  return [...new Set(list.map((r) => String(r || '').trim()).filter(Boolean))];
}

async function authorizeTargetAgent(db, actor, targetAgentId, { isExternalPeer = false } = {}) {
  if (!actor.roleNames.length) {
    throw a2aError('A2A_ROLE_FORBIDDEN', 403, 'Caller has no active roles authorized for A2A delegation.', -32003);
  }

  const normalizedAgentId = String(targetAgentId || '').trim().toLowerCase();
  if (!normalizedAgentId || !AGENT_ID_RE.test(normalizedAgentId)) {
    throw a2aError('A2A_INVALID_AGENT', 400, 'Valid targetAgentId is required.', -32602);
  }

  let dbProfile = null;
  const profRepo = db?.getRepository?.('latticeAiProfiles');
  if (profRepo && typeof profRepo.findOne === 'function') {
    const found = await runWithTenantRls(db, actor.organizationId, () => profRepo.findOne({
      filter: { username: normalizedAgentId, organizationId: actor.organizationId },
    }));
    if (found && (!val(found, 'organizationId') || val(found, 'organizationId') === actor.organizationId)) {
      dbProfile = found;
    }
  }

  const catalogEntry = Object.prototype.hasOwnProperty.call(A2A_AGENT_CATALOG, normalizedAgentId)
    ? A2A_AGENT_CATALOG[normalizedAgentId]
    : null;

  if (dbProfile) {
    if (val(dbProfile, 'enabled') === false) {
      throw a2aError('A2A_AGENT_DISABLED', 403, `Target agent "${normalizedAgentId}" is disabled.`, -32003);
    }
    const locked = enforceProfileRoleLock({
      isAdminBuilder: Boolean(val(dbProfile, 'isAdminBuilder')) || normalizedAgentId === 'dxos-architect',
      allowedRoles: parseRolesList(val(dbProfile, 'allowedRoles')),
      toolPermissions: val(dbProfile, 'toolPermissions') || val(dbProfile, 'toolPermissionsJson') || {},
    }, ADMIN_BUILDER_TOOL_NAMES);

    const allowedRoles = normalizedAgentId === 'dxos-architect'
      ? ['root', 'admin']
      : parseRolesList(locked.allowedRoles);

    if (!allowedRoles.length || !actor.roleNames.some((r) => allowedRoles.includes(r))) {
      throw a2aError(
        'A2A_ROLE_FORBIDDEN',
        403,
        `Caller roles [${actor.roleNames.join(', ')}] are not authorized for target agent "${normalizedAgentId}".`,
        -32003,
      );
    }
    return {
      agentId: normalizedAgentId,
      name: String(val(dbProfile, 'nickname') || catalogEntry?.name || normalizedAgentId),
      systemPrompt: String(val(dbProfile, 'systemPrompt') || catalogEntry?.systemPrompt || ''),
      modelName: String(val(dbProfile, 'modelName') || ''),
      allowedRoles,
    };
  }

  if (catalogEntry) {
    const allowedRoles = normalizedAgentId === 'dxos-architect'
      ? ['root', 'admin']
      : catalogEntry.allowedRoles;
    if (!allowedRoles.length || !actor.roleNames.some((r) => allowedRoles.includes(r))) {
      throw a2aError(
        'A2A_ROLE_FORBIDDEN',
        403,
        `Caller roles [${actor.roleNames.join(', ')}] are not authorized for target agent "${normalizedAgentId}".`,
        -32003,
      );
    }
    return {
      agentId: catalogEntry.id,
      name: catalogEntry.name,
      systemPrompt: catalogEntry.systemPrompt,
      modelName: '',
      allowedRoles,
    };
  }

  if (isExternalPeer) {
    return {
      agentId: normalizedAgentId,
      name: normalizedAgentId,
      systemPrompt: '',
      modelName: '',
      allowedRoles: actor.roleNames,
    };
  }

  throw a2aError(
    'A2A_AGENT_UNKNOWN',
    403,
    `Target agent "${normalizedAgentId}" is not registered or permitted in organization "${actor.organizationId}".`,
    -32003,
  );
}

function normalizeIncomingMessage(params = {}) {
  const timestamp = new Date().toISOString();
  if (params.message && typeof params.message === 'object' && !Array.isArray(params.message)) {
    const role = params.message.role === 'agent' ? 'agent' : 'user';
    const rawParts = Array.isArray(params.message.parts) ? params.message.parts : [];
    const parts = [];
    for (const part of rawParts) {
      if (!part || typeof part !== 'object') continue;
      if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
        parts.push({ type: 'text', text: part.text.trim().slice(0, 16000) });
      } else if (part.type === 'data' && part.data && typeof part.data === 'object') {
        parts.push({ type: 'data', data: cloneSafePlain(part.data) });
      } else if (typeof part.text === 'string' && part.text.trim()) {
        parts.push({ type: 'text', text: part.text.trim().slice(0, 16000) });
      }
    }
    if (!parts.length && typeof params.message.text === 'string' && params.message.text.trim()) {
      parts.push({ type: 'text', text: params.message.text.trim().slice(0, 16000) });
    }
    if (parts.length) return { role, parts, timestamp };
  }
  const textPrompt = String(params.prompt || params.text || params.input || '').trim();
  if (textPrompt) {
    return { role: 'user', parts: [{ type: 'text', text: textPrompt.slice(0, 16000) }], timestamp };
  }
  return null;
}

function extractPlainTextFromMessage(message) {
  if (!message || !Array.isArray(message.parts)) return '';
  return message.parts
    .map((p) => (p?.type === 'text' && typeof p.text === 'string' ? p.text : (p?.data ? JSON.stringify(p.data) : '')))
    .filter(Boolean)
    .join('\n')
    .trim();
}

function formatA2aTaskResponse(row) {
  const read = (k) => val(row, k);
  const taskId = String(read('taskId') || '');
  const state = String(read('status') || 'submitted');
  const messages = Array.isArray(read('messagesJson')) ? read('messagesJson') : [];
  const artifacts = Array.isArray(read('artifactsJson')) ? read('artifactsJson') : [];
  const metadata = read('metadataJson') && typeof read('metadataJson') === 'object' ? read('metadataJson') : {};
  const error = read('errorJson') || null;
  const updatedAt = read('updatedAt') || read('createdAt') || new Date().toISOString();
  const timestamp = updatedAt instanceof Date ? updatedAt.toISOString() : String(updatedAt);

  return {
    id: taskId,
    taskId,
    organizationId: String(read('organizationId') || ''),
    sourceAgentId: read('sourceAgentId') || null,
    targetAgentId: read('targetAgentId') || null,
    peerUrl: read('peerUrl') || null,
    status: {
      state,
      timestamp,
    },
    state,
    messages,
    history: messages,
    artifacts,
    metadata,
    ...(error ? { error } : {}),
  };
}

async function updateScopedTask(db, organizationId, taskId, values, existingRow = null) {
  const repo = db?.getRepository?.('latticeA2aTasks');
  if (existingRow && typeof existingRow.update === 'function' && val(existingRow, 'organizationId') === organizationId) {
    await existingRow.update(values);
    return existingRow;
  }
  if (repo && typeof repo.update === 'function') {
    await repo.update({ filter: { taskId, organizationId }, values });
    if (typeof repo.findOne === 'function') {
      return repo.findOne({ filter: { taskId, organizationId } });
    }
  }
  if (existingRow && typeof existingRow === 'object') {
    Object.assign(existingRow, values);
    return existingRow;
  }
  return null;
}

async function executeDefaultLocalAgent({
  db,
  actor,
  agentProfile,
  message,
  taskId,
  metadata,
  asyncMode = false,
  env = process.env,
}) {
  if (asyncMode) {
    return {
      status: 'working',
      messages: [],
      artifacts: [],
      error: null,
    };
  }

  const rawText = extractPlainTextFromMessage(message);
  const redactedText = redactPiiText(rawText).text;
  const llm = loadSiblingModule('plugin-dxos-studio', 'flow/llm-client');
  if (typeof llm?.callConfiguredLlm === 'function' && db) {
    try {
      const llmSvc = typeof llm.resolveActiveLlmService === 'function'
        ? await llm.resolveActiveLlmService(db, env)
        : { configured: false };
      if (llmSvc?.configured) {
        const llmRes = await llm.callConfiguredLlm({
          db,
          env,
          model: agentProfile.modelName || undefined,
          responseFormat: 'text',
          messages: [
            { role: 'system', content: agentProfile.systemPrompt || `You are ${agentProfile.name}.` },
            { role: 'user', content: redactedText },
          ],
        });
        if (llmRes?.ok && llmRes.content) {
          const replyText = redactPiiText(llmRes.content).text;
          return {
            status: 'completed',
            messages: [
              {
                role: 'agent',
                parts: [{ type: 'text', text: replyText }],
                timestamp: new Date().toISOString(),
              },
            ],
            artifacts: [
              {
                name: 'agent-response',
                parts: [{
                  type: 'data',
                  data: {
                    agentId: agentProfile.agentId,
                    organizationId: actor.organizationId,
                    mode: 'llm',
                    model: llmRes.model || null,
                    taskId,
                  },
                }],
              },
            ],
            error: null,
          };
        }
      }
    } catch {
      // Fall back to governed local handoff summary if LLM transport fails or is unavailable
    }
  }

  const summary = `Governed A2A handoff accepted by ${agentProfile.agentId} (${agentProfile.name}) in organization ${actor.organizationId}: ${redactedText.slice(0, 300)}`;
  return {
    status: 'completed',
    messages: [
      {
        role: 'agent',
        parts: [{ type: 'text', text: summary }],
        timestamp: new Date().toISOString(),
      },
    ],
    artifacts: [
      {
        name: 'governed-handoff-receipt',
        parts: [{
          type: 'data',
          data: {
            agentId: agentProfile.agentId,
            organizationId: actor.organizationId,
            mode: 'governed-local-handoff',
            taskId,
            metadataKeys: Object.keys(metadata || {}),
          },
        }],
      },
    ],
    error: null,
  };
}

async function authorizeExistingTaskAccess(db, actor, row) {
  const targetAgentId = String(val(row, 'targetAgentId') || '').trim().toLowerCase();
  if (targetAgentId) {
    await authorizeTargetAgent(db, actor, targetAgentId, { isExternalPeer: Boolean(val(row, 'peerUrl')) });
  } else if (!actor.isAdmin) {
    throw a2aError('A2A_TASK_FORBIDDEN', 403, 'Task has no authorized target agent.', -32003);
  }
  const createdById = val(row, 'createdById');
  const hasCreator = createdById !== undefined && createdById !== null && String(createdById).trim() !== '';
  if (!actor.isAdmin && (!hasCreator || String(createdById) !== String(actor.userId || ''))) {
    throw a2aError('A2A_TASK_FORBIDDEN', 403, 'Non-admin callers cannot access or cancel another user\'s A2A task.', -32003);
  }
}

async function handleA2aJsonRpc(ctx, {
  app,
  db,
  env = process.env,
  fetchImpl,
  lookupImpl,
  authResolver,
  localExecutor,
} = {}) {
  const activeDb = db || ctx.db || app?.db;
  const body = ctx.request?.body;

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    ctx.status = 400;
    ctx.body = { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid JSON-RPC request body.' } };
    return ctx.body;
  }

  const reqId = body.id !== undefined ? body.id : null;

  try {
    assertNoPrototypePollution(body, 'jsonrpc');
  } catch (err) {
    ctx.status = err.status || 400;
    ctx.body = { jsonrpc: '2.0', id: reqId, error: { code: err.rpcCode || -32602, message: err.message } };
    return ctx.body;
  }

  const authState = await resolveA2aAuthState(ctx, { app, db: activeDb, authResolver });
  if (!authState?.currentUser?.id) {
    await recordAiAuditLog(activeDb, {
      channel: 'a2a',
      toolName: `a2a:${String(body.method || 'unknown')}`,
      argsSummary: { path: ctx.path },
      status: 'denied',
      errorCode: 'A2A_UNAUTHORIZED',
      resultSummary: 'Missing or invalid authentication for A2A gateway',
    });
    ctx.status = 401;
    ctx.set?.('WWW-Authenticate', 'Bearer realm="LatticeDX-A2A", error="invalid_token"');
    ctx.body = { jsonrpc: '2.0', id: reqId, error: { code: -32001, message: 'Authentication required' } };
    return ctx.body;
  }

  if (body.jsonrpc !== undefined && body.jsonrpc !== '2.0') {
    ctx.status = 400;
    ctx.body = { jsonrpc: '2.0', id: reqId, error: { code: -32600, message: 'Invalid JSON-RPC version; expected "2.0".' } };
    return ctx.body;
  }

  const rpcMethod = typeof body.method === 'string' ? body.method.trim() : '';
  if (!rpcMethod) {
    ctx.status = 400;
    ctx.body = { jsonrpc: '2.0', id: reqId, error: { code: -32600, message: 'Missing JSON-RPC method.' } };
    return ctx.body;
  }

  const params = body.params === undefined ? {} : body.params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    ctx.status = 400;
    ctx.body = { jsonrpc: '2.0', id: reqId, error: { code: -32602, message: 'JSON-RPC params must be a plain object.' } };
    return ctx.body;
  }

  let actor;
  try {
    actor = await resolveCallerOrganizationAndRoles(ctx, activeDb, authState, params);
    assertNoCrossOrgSpoofing(ctx, params, actor.organizationId);
  } catch (err) {
    await recordAiAuditLog(activeDb, {
      actorUserId: authState.currentUser.id,
      actorUsername: authState.currentUser.username,
      organizationId: actor?.organizationId || null,
      channel: 'a2a',
      toolName: `a2a:${rpcMethod}`,
      argsSummary: { method: rpcMethod },
      status: 'denied',
      errorCode: err.code || 'A2A_FORBIDDEN',
      resultSummary: err.message,
    });
    ctx.status = err.status || 403;
    ctx.body = { jsonrpc: '2.0', id: reqId, error: { code: err.rpcCode || -32003, message: err.message } };
    return ctx.body;
  }

  const tasksRepo = activeDb?.getRepository?.('latticeA2aTasks');
  if (!tasksRepo) {
    ctx.status = 503;
    ctx.body = { jsonrpc: '2.0', id: reqId, error: { code: -32000, message: 'latticeA2aTasks repository is unavailable.' } };
    return ctx.body;
  }

  if (rpcMethod === 'tasks/send') {
    const rawTaskId = params.id ?? params.taskId;
    const taskId = rawTaskId !== undefined && rawTaskId !== null && String(rawTaskId).trim() !== ''
      ? String(rawTaskId).trim()
      : `a2a_${randomUUID()}`;
    if (!TASK_ID_RE.test(taskId)) {
      ctx.status = 400;
      ctx.body = { jsonrpc: '2.0', id: reqId, error: { code: -32602, message: 'Invalid taskId format.' } };
      return ctx.body;
    }

    const peerUrlRaw = params.peerUrl ?? params.metadata?.peerUrl ?? null;
    const peerUrl = peerUrlRaw !== null && peerUrlRaw !== undefined && String(peerUrlRaw).trim() !== ''
      ? String(peerUrlRaw).trim()
      : null;

    const targetAgentId = String(
      params.targetAgentId
        || params.agentId
        || params.metadata?.targetAgentId
        || (peerUrl ? 'external-peer' : 'dxos-coordinator'),
    ).trim().toLowerCase();
    const sourceAgentId = params.sourceAgentId
      ? String(params.sourceAgentId).trim().slice(0, 128)
      : `user:${actor.username}`;

    let agentProfile;
    try {
      agentProfile = await authorizeTargetAgent(activeDb, actor, targetAgentId, { isExternalPeer: Boolean(peerUrl) });
    } catch (err) {
      await recordAiAuditLog(activeDb, {
        actorUserId: actor.userId,
        actorUsername: actor.username,
        organizationId: actor.organizationId,
        channel: 'a2a',
        aiEmployee: targetAgentId,
        toolName: 'a2a:tasks/send',
        argsSummary: { taskId, targetAgentId, hasPeerUrl: Boolean(peerUrl) },
        status: 'denied',
        errorCode: err.code || 'A2A_ROLE_FORBIDDEN',
        resultSummary: err.message,
      });
      ctx.status = err.status || 403;
      ctx.body = { jsonrpc: '2.0', id: reqId, error: { code: err.rpcCode || -32003, message: err.message } };
      return ctx.body;
    }

    const incomingMessage = normalizeIncomingMessage(params);
    if (!incomingMessage) {
      ctx.status = 400;
      ctx.body = { jsonrpc: '2.0', id: reqId, error: { code: -32602, message: 'tasks/send requires a non-empty message or prompt.' } };
      return ctx.body;
    }

    const safeMetadata = params.metadata && typeof params.metadata === 'object'
      ? cloneSafePlain(params.metadata)
      : {};
    const idempotencyKey = params.idempotencyKey ? String(params.idempotencyKey).trim().slice(0, 255) : null;

    if (idempotencyKey && typeof tasksRepo.findOne === 'function') {
      const existingIdem = await runWithTenantRls(activeDb, actor.organizationId, () => tasksRepo.findOne({
        filter: { organizationId: actor.organizationId, idempotencyKey },
      }));
      if (existingIdem && val(existingIdem, 'organizationId') === actor.organizationId) {
        try {
          await authorizeExistingTaskAccess(activeDb, actor, existingIdem);
        } catch (err) {
          await recordAiAuditLog(activeDb, {
            actorUserId: actor.userId,
            actorUsername: actor.username,
            organizationId: actor.organizationId,
            channel: 'a2a',
            aiEmployee: val(existingIdem, 'targetAgentId') || targetAgentId || null,
            toolName: 'a2a:tasks/send',
            argsSummary: {
              taskId: val(existingIdem, 'taskId') || taskId,
              targetAgentId: val(existingIdem, 'targetAgentId') || targetAgentId || null,
              idempotencyKey,
              replay: true,
            },
            status: 'denied',
            errorCode: err.code || 'A2A_TASK_FORBIDDEN',
            resultSummary: err.message,
          });
          ctx.status = err.status || 403;
          ctx.body = { jsonrpc: '2.0', id: reqId, error: { code: err.rpcCode || -32003, message: err.message } };
          return ctx.body;
        }
        ctx.status = 200;
        ctx.body = { jsonrpc: '2.0', id: reqId, result: formatA2aTaskResponse(existingIdem) };
        return ctx.body;
      }
    }

    if (peerUrl) {
      try {
        const isMockTransport = typeof fetchImpl === 'function' && fetchImpl !== globalThis.fetch;
        await assertSafePeerUrl(peerUrl, {
          env,
          lookupImpl,
          skipDnsCheck: isMockTransport && typeof lookupImpl !== 'function',
        });
      } catch (err) {
        await recordAiAuditLog(activeDb, {
          actorUserId: actor.userId,
          actorUsername: actor.username,
          organizationId: actor.organizationId,
          channel: 'a2a',
          aiEmployee: targetAgentId,
          toolName: 'a2a:tasks/send',
          argsSummary: { taskId, targetAgentId, peerUrl },
          status: 'denied',
          errorCode: err.code || 'A2A_PEER_URL_UNSAFE',
          resultSummary: err.message,
        });
        ctx.status = err.status || 400;
        ctx.body = { jsonrpc: '2.0', id: reqId, error: { code: err.rpcCode || -32602, message: err.message } };
        return ctx.body;
      }
    }

    const initialMessages = [incomingMessage];
    const asyncMode = Boolean(params.async === true || params.blocking === false);

    const createdRow = await runWithTenantRls(activeDb, actor.organizationId, async () => {
      const existingTask = typeof tasksRepo.findOne === 'function'
        ? await tasksRepo.findOne({ filter: { organizationId: actor.organizationId, taskId } })
        : null;
      if (existingTask) {
        throw a2aError('A2A_TASK_EXISTS', 409, `Task "${taskId}" already exists in organization scope.`, -32004);
      }
      return tasksRepo.create({
        values: {
          taskId,
          organizationId: actor.organizationId,
          sourceAgentId,
          targetAgentId,
          peerUrl,
          status: 'submitted',
          messagesJson: initialMessages,
          artifactsJson: [],
          metadataJson: safeMetadata,
          errorJson: null,
          createdById: String(actor.userId),
          idempotencyKey,
        },
      });
    }).catch((err) => {
      if (err?.code === 'A2A_TASK_EXISTS') {
        ctx.status = 409;
        ctx.body = { jsonrpc: '2.0', id: reqId, error: { code: -32004, message: err.message } };
        return null;
      }
      throw err;
    });

    if (!createdRow) return ctx.body;

    let execOutcome;
    if (peerUrl) {
      execOutcome = await delegateToExternalA2aPeer({
        peerUrl,
        taskId,
        message: incomingMessage,
        metadata: safeMetadata,
        fetchImpl,
        lookupImpl,
        env,
      });
    } else if (typeof localExecutor === 'function') {
      execOutcome = await localExecutor({
        ctx,
        db: activeDb,
        actor,
        agentProfile,
        taskId,
        message: incomingMessage,
        metadata: safeMetadata,
        asyncMode,
      });
    } else {
      execOutcome = await executeDefaultLocalAgent({
        db: activeDb,
        actor,
        agentProfile,
        message: incomingMessage,
        taskId,
        metadata: safeMetadata,
        asyncMode,
        env,
      });
    }

    const nextStatusRaw = String(execOutcome?.status || 'completed').toLowerCase();
    const nextStatus = A2A_VALID_STATUSES.includes(nextStatusRaw) ? nextStatusRaw : 'completed';
    const nextMessages = [
      ...initialMessages,
      ...(Array.isArray(execOutcome?.messages) ? execOutcome.messages : []),
    ];
    const nextArtifacts = Array.isArray(execOutcome?.artifacts) ? execOutcome.artifacts : [];
    const nextError = execOutcome?.error || null;

    const updatedRow = await runWithTenantRls(activeDb, actor.organizationId, () => updateScopedTask(
      activeDb,
      actor.organizationId,
      taskId,
      {
        status: nextStatus,
        messagesJson: nextMessages,
        artifactsJson: nextArtifacts,
        errorJson: nextError,
      },
      createdRow,
    ));

    await recordAiAuditLog(activeDb, {
      actorUserId: actor.userId,
      actorUsername: actor.username,
      organizationId: actor.organizationId,
      channel: 'a2a',
      aiEmployee: targetAgentId,
      toolName: 'a2a:tasks/send',
      argsSummary: { taskId, targetAgentId, peerUrl: peerUrl || null, status: nextStatus },
      status: nextStatus === 'failed' ? 'error' : 'allowed',
      errorCode: nextError?.code || null,
      resultSummary: `A2A task ${taskId} -> ${nextStatus}`,
    });

    ctx.status = 200;
    ctx.body = { jsonrpc: '2.0', id: reqId, result: formatA2aTaskResponse(updatedRow || createdRow) };
    return ctx.body;
  }

  if (rpcMethod === 'tasks/get') {
    const taskId = String(params.id ?? params.taskId ?? '').trim();
    if (!taskId || !TASK_ID_RE.test(taskId)) {
      ctx.status = 400;
      ctx.body = { jsonrpc: '2.0', id: reqId, error: { code: -32602, message: 'Valid task id is required for tasks/get.' } };
      return ctx.body;
    }

    const row = await runWithTenantRls(activeDb, actor.organizationId, () => tasksRepo.findOne({
      filter: { taskId, organizationId: actor.organizationId },
    }));
    if (!row || val(row, 'organizationId') !== actor.organizationId) {
      ctx.status = 404;
      ctx.body = { jsonrpc: '2.0', id: reqId, error: { code: -32004, message: `Task "${taskId}" not found in organization scope.` } };
      return ctx.body;
    }

    try {
      await authorizeExistingTaskAccess(activeDb, actor, row);
    } catch (err) {
      await recordAiAuditLog(activeDb, {
        actorUserId: actor.userId,
        actorUsername: actor.username,
        organizationId: actor.organizationId,
        channel: 'a2a',
        aiEmployee: val(row, 'targetAgentId') || null,
        toolName: 'a2a:tasks/get',
        argsSummary: { taskId },
        status: 'denied',
        errorCode: err.code || 'A2A_TASK_FORBIDDEN',
        resultSummary: err.message,
      });
      ctx.status = err.status || 403;
      ctx.body = { jsonrpc: '2.0', id: reqId, error: { code: err.rpcCode || -32003, message: err.message } };
      return ctx.body;
    }

    const formatted = formatA2aTaskResponse(row);
    const historyLength = Number(params.historyLength);
    if (Number.isInteger(historyLength) && historyLength >= 0) {
      formatted.messages = formatted.messages.slice(-historyLength);
      formatted.history = formatted.messages;
    }
    ctx.status = 200;
    ctx.body = { jsonrpc: '2.0', id: reqId, result: formatted };
    return ctx.body;
  }

  if (rpcMethod === 'tasks/cancel') {
    const taskId = String(params.id ?? params.taskId ?? '').trim();
    if (!taskId || !TASK_ID_RE.test(taskId)) {
      ctx.status = 400;
      ctx.body = { jsonrpc: '2.0', id: reqId, error: { code: -32602, message: 'Valid task id is required for tasks/cancel.' } };
      return ctx.body;
    }

    const row = await runWithTenantRls(activeDb, actor.organizationId, () => tasksRepo.findOne({
      filter: { taskId, organizationId: actor.organizationId },
    }));
    if (!row || val(row, 'organizationId') !== actor.organizationId) {
      ctx.status = 404;
      ctx.body = { jsonrpc: '2.0', id: reqId, error: { code: -32004, message: `Task "${taskId}" not found in organization scope.` } };
      return ctx.body;
    }

    try {
      await authorizeExistingTaskAccess(activeDb, actor, row);
    } catch (err) {
      await recordAiAuditLog(activeDb, {
        actorUserId: actor.userId,
        actorUsername: actor.username,
        organizationId: actor.organizationId,
        channel: 'a2a',
        aiEmployee: val(row, 'targetAgentId') || null,
        toolName: 'a2a:tasks/cancel',
        argsSummary: { taskId },
        status: 'denied',
        errorCode: err.code || 'A2A_TASK_FORBIDDEN',
        resultSummary: err.message,
      });
      ctx.status = err.status || 403;
      ctx.body = { jsonrpc: '2.0', id: reqId, error: { code: err.rpcCode || -32003, message: err.message } };
      return ctx.body;
    }

    const currentStatus = String(val(row, 'status') || 'submitted').toLowerCase();
    if (A2A_TERMINAL_SET.has(currentStatus)) {
      ctx.status = 409;
      ctx.body = {
        jsonrpc: '2.0',
        id: reqId,
        error: { code: -32004, message: `Task "${taskId}" is already in terminal state "${currentStatus}" and cannot be canceled.` },
      };
      return ctx.body;
    }

    const prevMeta = val(row, 'metadataJson') && typeof val(row, 'metadataJson') === 'object'
      ? cloneSafePlain(val(row, 'metadataJson'))
      : {};
    const cancelReason = params.reason ? String(params.reason).trim().slice(0, 300) : 'Canceled by caller';
    const nextMeta = {
      ...prevMeta,
      canceledByUserId: actor.userId,
      canceledAt: new Date().toISOString(),
      cancelReason,
    };

    const updatedRow = await runWithTenantRls(activeDb, actor.organizationId, () => updateScopedTask(
      activeDb,
      actor.organizationId,
      taskId,
      { status: 'canceled', metadataJson: nextMeta },
      row,
    ));

    await recordAiAuditLog(activeDb, {
      actorUserId: actor.userId,
      actorUsername: actor.username,
      organizationId: actor.organizationId,
      channel: 'a2a',
      aiEmployee: val(row, 'targetAgentId') || null,
      toolName: 'a2a:tasks/cancel',
      argsSummary: { taskId, previousStatus: currentStatus },
      status: 'allowed',
      resultSummary: `A2A task ${taskId} canceled`,
    });

    ctx.status = 200;
    ctx.body = { jsonrpc: '2.0', id: reqId, result: formatA2aTaskResponse(updatedRow || row) };
    return ctx.body;
  }

  ctx.status = 200;
  ctx.body = { jsonrpc: '2.0', id: reqId, error: { code: -32601, message: `Unsupported A2A JSON-RPC method: ${rpcMethod}` } };
  return ctx.body;
}

function createA2aMiddleware({
  app,
  db,
  env = process.env,
  baseUrl,
  version,
  fetchImpl,
  lookupImpl,
  authResolver,
  localExecutor,
} = {}) {
  const agentCardMiddleware = createAgentCardMiddleware({ baseUrl, version, env });

  return async function dxosA2aGateway(ctx, next) {
    if (isAgentCardPath(ctx.path)) {
      return agentCardMiddleware(ctx, next);
    }
    if (!isA2aRpcPath(ctx.path)) {
      return next();
    }

    ctx.withoutDataWrapping = true;
    const method = String(ctx.method || 'GET').toUpperCase();
    if (method !== 'POST') {
      ctx.status = 405;
      ctx.body = {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32000, message: `Method ${method} not allowed on A2A JSON-RPC endpoint; send POST.` },
      };
      return;
    }

    await handleA2aJsonRpc(ctx, {
      app,
      db,
      env,
      fetchImpl,
      lookupImpl,
      authResolver,
      localExecutor,
    });
  };
}

module.exports = {
  A2A_AGENT_CARD_PATHS,
  A2A_RPC_PATH,
  A2A_VALID_STATUSES,
  A2A_TERMINAL_STATES,
  A2A_AGENT_CATALOG,
  resolveRequestOriginFromHeaders,
  resolveSafeCardEndpointUrl,
  buildAgentCard,
  createAgentCardMiddleware,
  createGatewayAgentCardRequestHandler,
  assertSafePeerUrl,
  delegateToExternalA2aPeer,
  handleA2aJsonRpc,
  createA2aMiddleware,
};
