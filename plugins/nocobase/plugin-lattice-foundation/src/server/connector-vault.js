/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} = require('node:crypto');
const net = require('node:net');
const { resolveNativeActor } = require('./native-scope');
const { val, getRepo, callerRoles } = require('./native-portal-helpers');
const { assertApiKeyScope, readParams } = require('./paas-api-keys');

const ORG_ID_RE = /^[a-zA-Z0-9_-]{1,80}$/;
const CONNECTOR_KEY_RE = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;
const PROTO_POLLUTION_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const VALID_CONNECTOR_TYPES = Object.freeze(new Set([
  'n8n',
  'webhook',
  'mqtt',
  'orion_ld',
  'http_api',
  'smtp_notify',
]));
const VALID_AUTH_TYPES = Object.freeze(new Set([
  'bearer',
  'hmac',
  'basic',
  'api_key',
  'none',
]));
const INTERNAL_CONNECTOR_HOST_ALLOWLIST = Object.freeze(new Set([
  'n8n',
  'orion-ld',
  'mosquitto',
  'nodered',
  'nocobase',
  'localhost',
  '127.0.0.1',
]));
const ELEVATED_ROLES = new Set(['root', 'admin', 'ldx_admin']);
const TEST_TIMEOUT_MS = 3000;

function failVault(code, status = 400, message = code) {
  return Object.assign(new Error(message), { code, status });
}

function resolveVaultMasterKey(env = process.env) {
  const secret = String(
    env?.DX_VAULT_MASTER_KEY
      || env?.ENCRYPTION_FIELD_KEY
      || env?.NOCOBASE_APP_KEY
      || env?.APP_KEY
      || '',
  ).trim();
  if (!secret) {
    if (String(env?.NODE_ENV || '').trim().toLowerCase() === 'production') {
      throw failVault(
        'VAULT_MASTER_KEY_MISSING',
        500,
        'DX_VAULT_MASTER_KEY, ENCRYPTION_FIELD_KEY, NOCOBASE_APP_KEY, or APP_KEY must be set in production.',
      );
    }
    return createHash('sha256').update('latticedx-vault-dev-fallback-key', 'utf8').digest();
  }
  return createHash('sha256').update(secret, 'utf8').digest();
}

function encryptSecretText(plaintext, env = process.env) {
  const masterKey = resolveVaultMasterKey(env);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey, iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext ?? ''), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decryptSecretText(ciphertext, env = process.env) {
  const parts = String(ciphertext || '').split(':');
  if (
    parts.length !== 3
    || !/^[0-9a-f]{24}$/i.test(parts[0])
    || !/^[0-9a-f]{32}$/i.test(parts[1])
    || !/^[0-9a-f]*$/i.test(parts[2])
    || parts[2].length % 2 !== 0
  ) {
    throw failVault('VAULT_CIPHERTEXT_INVALID', 500, 'Encrypted vault payload is malformed.');
  }
  const [ivHex, tagHex, dataHex] = parts;
  const masterKey = resolveVaultMasterKey(env);
  try {
    const decipher = createDecipheriv('aes-256-gcm', masterKey, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    const plain = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]);
    return plain.toString('utf8');
  } catch (err) {
    if (err?.code === 'VAULT_MASTER_KEY_MISSING') throw err;
    throw failVault('VAULT_CIPHERTEXT_INVALID', 500, 'Encrypted vault payload is invalid or tampered.');
  }
}

function sanitizeSecretsObject(rawSecrets) {
  if (rawSecrets === undefined || rawSecrets === null) return {};
  if (typeof rawSecrets !== 'object' || Array.isArray(rawSecrets)) {
    throw failVault('VAULT_SECRETS_INVALID', 400, 'Connector secrets must be a plain JSON object.');
  }
  const clean = {};
  for (const [k, v] of Object.entries(rawSecrets)) {
    if (PROTO_POLLUTION_KEYS.has(k)) continue;
    if (v === undefined || typeof v === 'function' || typeof v === 'symbol') continue;
    if (v !== null && typeof v === 'object') {
      clean[k] = sanitizeSecretsObject(v);
    } else {
      clean[k] = v;
    }
  }
  return clean;
}

function encryptVaultSecrets(secretsObj, env = process.env) {
  const clean = sanitizeSecretsObject(secretsObj);
  return encryptSecretText(JSON.stringify(clean), env);
}

function decryptVaultSecrets(ciphertext, env = process.env) {
  if (!ciphertext || !String(ciphertext).trim()) return {};
  const raw = decryptSecretText(ciphertext, env);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw failVault('VAULT_CIPHERTEXT_INVALID', 500, 'Decrypted vault secrets JSON is malformed.');
  }
  return sanitizeSecretsObject(parsed);
}

function isBlockedIpv4(host) {
  const parts = host.split('.');
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p))) return false;
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

function isBlockedIpv6(bareHost) {
  if (!bareHost.includes(':')) return false;
  return (
    bareHost === '::'
    || bareHost === '::1'
    || bareHost.startsWith('::ffff:')
    || /^fe[89ab][0-9a-f]?:/i.test(bareHost)
    || /^f[cd][0-9a-f]{0,2}:/i.test(bareHost)
    || /^ff[0-9a-f]{2}:/i.test(bareHost)
  );
}

function resolveAllowedProtocols(connectorType) {
  if (connectorType === 'mqtt') return new Set(['mqtt:', 'mqtts:', 'http:', 'https:']);
  if (connectorType === 'smtp_notify') return new Set(['smtp:', 'smtps:', 'http:', 'https:']);
  return new Set(['http:', 'https:']);
}

function assertSafeConnectorUrl(rawUrl, { connectorType = 'http_api', env = process.env } = {}) {
  const trimmed = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!trimmed || trimmed.length > 2048) {
    throw failVault('CONNECTOR_URL_UNSAFE', 400, 'Connector URL is required and must be <= 2048 characters.');
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw failVault('CONNECTOR_URL_UNSAFE', 400, 'Malformed connector URL.');
  }

  const allowedProtocols = resolveAllowedProtocols(connectorType);
  if (!allowedProtocols.has(parsed.protocol)) {
    throw failVault('CONNECTOR_URL_UNSAFE', 400, `Protocol ${parsed.protocol} is blocked by SSRF policy.`);
  }
  if (parsed.username || parsed.password) {
    throw failVault('CONNECTOR_URL_UNSAFE', 400, 'Embedded credentials in connector URL are forbidden.');
  }

  const bare = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (!bare) {
    throw failVault('CONNECTOR_URL_UNSAFE', 400, 'Connector URL hostname is empty.');
  }

  const extraAllowlist = String(env?.DX_CONNECTOR_INTERNAL_ALLOWLIST || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (INTERNAL_CONNECTOR_HOST_ALLOWLIST.has(bare) || extraAllowlist.includes(bare)) {
    return parsed.toString();
  }

  if (
    bare.endsWith('.localhost')
    || bare.endsWith('.local')
    || bare.endsWith('.internal')
    || bare === 'metadata.google.internal'
    || bare === 'metadata.azure.com'
  ) {
    throw failVault('CONNECTOR_URL_UNSAFE', 400, `Internal metadata or local hostname ${bare} is blocked.`);
  }
  if (isBlockedIpv6(bare)) {
    throw failVault('CONNECTOR_URL_UNSAFE', 400, `Blocked IPv6 address: ${bare}`);
  }
  if (isBlockedIpv4(bare)) {
    throw failVault('CONNECTOR_URL_UNSAFE', 400, `Blocked private or link-local IPv4 address: ${bare}`);
  }
  if (!bare.includes('.') && !bare.includes(':')) {
    throw failVault('CONNECTOR_URL_UNSAFE', 400, `Non-allowlisted internal service hostname ${bare} is blocked.`);
  }
  return parsed.toString();
}

function serializeConnector(row, { env = process.env } = {}) {
  if (!row) return null;
  const enc = val(row, 'encryptedSecretsJson');
  let secretKeys = [];
  let hasSecrets = false;
  if (enc && String(enc).trim()) {
    const decrypted = decryptVaultSecrets(enc, env);
    secretKeys = Object.keys(decrypted).sort();
    hasSecrets = secretKeys.length > 0;
  }
  const lastTestedAt = val(row, 'lastTestedAt');
  return {
    id: val(row, 'id') ?? null,
    organizationId: val(row, 'organizationId') || null,
    connectorKey: val(row, 'connectorKey') || '',
    name: val(row, 'name') || '',
    connectorType: val(row, 'connectorType') || 'webhook',
    baseUrl: val(row, 'baseUrl') || null,
    authType: val(row, 'authType') || 'none',
    hasSecrets,
    secretKeys,
    secretVersion: Number(val(row, 'secretVersion')) || 1,
    lastTestedAt: lastTestedAt ? (lastTestedAt instanceof Date ? lastTestedAt.toISOString() : String(lastTestedAt)) : null,
    lastTestStatus: val(row, 'lastTestStatus') || null,
    active: val(row, 'active') !== false,
    createdAt: val(row, 'createdAt') || null,
    updatedAt: val(row, 'updatedAt') || null,
  };
}

async function resolveConnectorSecrets(db, organizationId, connectorKeyOrId, options = {}) {
  const orgId = typeof organizationId === 'string' ? organizationId.trim() : '';
  if (!ORG_ID_RE.test(orgId)) {
    throw failVault('VAULT_ORG_REQUIRED', 400, 'Valid organizationId is required.');
  }
  if (connectorKeyOrId === undefined || connectorKeyOrId === null || String(connectorKeyOrId).trim() === '') {
    throw failVault('CONNECTOR_REF_REQUIRED', 400, 'connectorKey or id is required.');
  }
  const repo = getRepo(db, 'latticeConnectors');
  if (!repo || typeof repo.findOne !== 'function') {
    throw failVault('CONNECTOR_REPO_UNAVAILABLE', 503, 'latticeConnectors repository is unavailable.');
  }

  const rawRef = String(connectorKeyOrId).trim();
  const filter = /^[1-9]\d*$/.test(rawRef)
    ? { organizationId: orgId, id: Number(rawRef) }
    : { organizationId: orgId, connectorKey: rawRef.toLowerCase() };

  const row = await repo.findOne({ filter });
  if (!row || val(row, 'organizationId') !== orgId) {
    throw failVault('CONNECTOR_NOT_FOUND', 404, 'Connector not found in organization scope.');
  }
  if (!options.allowInactive && val(row, 'active') === false) {
    throw failVault('CONNECTOR_INACTIVE', 403, 'Connector is inactive.');
  }

  const env = options.env || process.env;
  const secrets = decryptVaultSecrets(val(row, 'encryptedSecretsJson'), env);
  return {
    connector: serializeConnector(row, { env }),
    secrets,
  };
}

async function resolveVerifiedRoles(db, ctx) {
  const claimed = callerRoles(ctx);
  const userId = val(ctx?.state?.currentUser, 'id');
  const ruRepo = getRepo(db, 'rolesUsers');
  if (ruRepo && typeof ruRepo.find === 'function' && userId != null && /^[1-9]\d*$/.test(String(userId))) {
    const bindings = (await ruRepo.find({ filter: { userId: Number(userId) } })) || [];
    const assigned = new Set(
      bindings
        .filter((r) => val(r, 'userId') == null || Number(val(r, 'userId')) === Number(userId))
        .map((r) => String(val(r, 'roleName') || '').trim())
        .filter(Boolean),
    );
    if (claimed.length > 0) {
      return claimed.filter((r) => assigned.has(r));
    }
    return [...assigned];
  }
  return claimed;
}

async function isVerifiedVaultAdmin(db, verifiedRoles) {
  if (!Array.isArray(verifiedRoles) || verifiedRoles.length === 0) return false;
  if (verifiedRoles.some((r) => ELEVATED_ROLES.has(String(r).toLowerCase()))) return true;
  const rolesRepo = getRepo(db, 'roles');
  if (!rolesRepo || typeof rolesRepo.find !== 'function') return false;
  const matched = (await rolesRepo.find({ filter: { name: { $in: verifiedRoles } } })) || [];
  return matched.some((role) => {
    const name = val(role, 'name');
    if (name && !verifiedRoles.includes(name)) return false;
    if (val(role, 'allowAll') === true || val(role, 'allowConfigure') === true) return true;
    const snippets = val(role, 'snippets');
    return Array.isArray(snippets) && (snippets.includes('pm') || snippets.includes('pm.*'));
  });
}

async function resolveVaultCaller(db, ctx, requestedOrgId = null, { requireOrg = true } = {}) {
  if (!ctx?.state?.currentUser) {
    throw failVault('NATIVE_LOGIN_REQUIRED', 401, 'Authentication required.');
  }
  const verifiedRoles = await resolveVerifiedRoles(db, ctx);
  const isRoot = verifiedRoles.includes('root');
  const isAdmin = isRoot || (await isVerifiedVaultAdmin(db, verifiedRoles));

  if (isRoot) {
    const cleanReq = requestedOrgId != null ? String(requestedOrgId).trim() : '';
    if (cleanReq) {
      if (!ORG_ID_RE.test(cleanReq)) {
        throw failVault('VAULT_ORG_INVALID', 400, 'Invalid organizationId.');
      }
      return { isRoot: true, isAdmin: true, verifiedRoles, organizationId: cleanReq };
    }
    try {
      const actor = await resolveNativeActor(db, ctx.state.currentUser);
      return { isRoot: true, isAdmin: true, verifiedRoles, organizationId: actor.organizationId };
    } catch {
      if (requireOrg) {
        throw failVault('VAULT_ORG_REQUIRED', 400, 'organizationId is required for root vault operations.');
      }
      return { isRoot: true, isAdmin: true, verifiedRoles, organizationId: null };
    }
  }

  const actor = await resolveNativeActor(db, ctx.state.currentUser);
  if (
    requestedOrgId !== undefined
    && requestedOrgId !== null
    && String(requestedOrgId).trim() !== ''
    && String(requestedOrgId).trim() !== actor.organizationId
  ) {
    throw failVault('NATIVE_ORGANIZATION_MISMATCH', 403, 'Cross-organization vault access is forbidden.');
  }

  return {
    isRoot: false,
    isAdmin,
    verifiedRoles,
    organizationId: actor.organizationId,
  };
}

function buildConnectorAuthHeaders(authType, secrets = {}) {
  const headers = {};
  if (!secrets || typeof secrets !== 'object') return headers;
  if (authType === 'bearer') {
    const token = String(secrets.token || secrets.bearerToken || '').trim();
    if (token) headers.Authorization = `Bearer ${token}`;
  } else if (authType === 'api_key') {
    const apiKey = String(secrets.apiKey || secrets.key || secrets.token || '').trim();
    const headerName = String(secrets.headerName || 'X-API-Key').trim();
    if (apiKey && /^[A-Za-z0-9-]+$/.test(headerName)) {
      headers[headerName] = apiKey;
    }
  } else if (authType === 'basic') {
    const username = String(secrets.username || '');
    const password = String(secrets.password || '');
    if (username || password) {
      headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
    }
  }
  return headers;
}

function defaultTcpProbe(host, port, timeoutMs = TEST_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    const finish = (ok, message) => {
      if (settled) return;
      settled = true;
      resolve({ ok, statusCode: ok ? 200 : null, latencyMs: Date.now() - started, message });
    };
    const socket = net.createConnection({ host, port });
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      socket.destroy();
      finish(true, `TCP connection to ${host}:${port} succeeded`);
    });
    socket.once('timeout', () => {
      socket.destroy();
      finish(false, `TCP connection to ${host}:${port} timed out after ${timeoutMs}ms`);
    });
    socket.once('error', (err) => {
      socket.destroy();
      finish(false, err?.message || 'TCP connection error');
    });
  });
}

async function probeConnectorEndpoint(
  { connectorType, baseUrl, authType = 'none', secrets = {} },
  { env = process.env, fetchImpl = globalThis.fetch, tcpProbeImpl = defaultTcpProbe } = {},
) {
  const validatedUrl = assertSafeConnectorUrl(baseUrl, { connectorType, env });
  const parsed = new URL(validatedUrl);
  const started = Date.now();

  if (connectorType === 'mqtt' || connectorType === 'smtp_notify') {
    if (parsed.protocol === 'mqtt:' || parsed.protocol === 'mqtts:' || parsed.protocol === 'smtp:' || parsed.protocol === 'smtps:') {
      const defaultPort = parsed.protocol === 'mqtt:' ? 1883 : (parsed.protocol === 'mqtts:' ? 8883 : (parsed.protocol === 'smtps:' ? 465 : 25));
      const port = Number(parsed.port) || defaultPort;
      return tcpProbeImpl(parsed.hostname.replace(/^\[|\]$/g, ''), port, TEST_TIMEOUT_MS);
    }
  }

  if (typeof fetchImpl !== 'function') {
    return { ok: false, statusCode: null, latencyMs: Date.now() - started, message: 'HTTP fetch unavailable' };
  }

  let targetUrl = validatedUrl;
  let method = 'HEAD';
  if (connectorType === 'orion_ld') {
    method = 'GET';
    if (parsed.pathname === '/' || !parsed.pathname) {
      targetUrl = `${parsed.origin}/version`;
    }
  } else if (connectorType === 'n8n') {
    method = 'GET';
    if (parsed.pathname === '/' || !parsed.pathname) {
      targetUrl = `${parsed.origin}/healthz`;
    }
  }

  const headers = buildConnectorAuthHeaders(authType, secrets);
  const doFetch = async (httpMethod) => {
    const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(TEST_TIMEOUT_MS)
      : undefined;
    const response = await fetchImpl(targetUrl, {
      method: httpMethod,
      redirect: 'error',
      headers,
      ...(signal ? { signal } : {}),
    });
    try { await response?.body?.cancel?.(); } catch {}
    return response;
  };

  try {
    let response = await doFetch(method);
    if (method === 'HEAD' && response?.status === 405) {
      response = await doFetch('GET');
    }
    const statusCode = Number(response?.status) || null;
    const ok = Boolean(response?.ok);
    return {
      ok,
      statusCode,
      latencyMs: Date.now() - started,
      message: ok ? `Endpoint reachable (HTTP ${statusCode})` : `Endpoint returned HTTP ${statusCode || 'unknown'}`,
    };
  } catch (err) {
    return {
      ok: false,
      statusCode: null,
      latencyMs: Date.now() - started,
      message: err?.message || 'Connection test failed',
    };
  }
}

async function findConnectorInOrg(repo, organizationId, params) {
  const id = Number(params.id ?? params.filterByTk);
  const connectorKey = typeof params.connectorKey === 'string' ? params.connectorKey.trim().toLowerCase() : '';
  if (Number.isInteger(id) && id > 0) {
    const row = await repo.findOne({ filter: { id, organizationId } });
    return row && val(row, 'organizationId') === organizationId ? row : null;
  }
  if (connectorKey) {
    const row = await repo.findOne({ filter: { organizationId, connectorKey } });
    return row && val(row, 'organizationId') === organizationId ? row : null;
  }
  return null;
}

function registerConnectorVaultDirectGuard(app) {
  app.resourceManager?.use?.(async (ctx, next) => {
    if (ctx.state?.currentRole === 'root') return next();
    const fullResource = String(ctx.action?.resourceName || '');
    const baseResource = fullResource.split('.')[0];
    const actionName = String(ctx.action?.actionName || '');
    if (baseResource === 'latticeConnectors') {
      throw failVault('VAULT_DIRECT_CRUD_FORBIDDEN', 403, 'Direct access to latticeConnectors is forbidden; use dxosVault.');
    }
    if (
      fullResource === 'charts'
      && actionName === 'queryData'
      && String(ctx.action?.params?.values?.collection || '') === 'latticeConnectors'
    ) {
      throw failVault('VAULT_DIRECT_CRUD_FORBIDDEN', 403, 'Direct chart access to latticeConnectors is forbidden.');
    }
    return next();
  }, { tag: 'latticeVaultDirectGuard', after: 'acl' });
}

function registerConnectorVault(app, { env = process.env, fetchImpl, tcpProbeImpl } = {}) {
  const db = app.db;
  registerConnectorVaultDirectGuard(app);

  app.resourceManager.define({
    name: 'dxosVault',
    actions: {
      list: async (ctx, next) => {
        if ((ctx.method || 'GET') !== 'GET') ctx.throw(405);
        const params = readParams(ctx);
        const scope = await resolveVaultCaller(db, ctx, params.organizationId, { requireOrg: false });
        const repo = getRepo(db, 'latticeConnectors');
        if (!repo || typeof repo.find !== 'function') {
          ctx.body = { organizationId: scope.organizationId, items: [] };
          if (next) return next();
          return;
        }
        const filter = {};
        if (scope.organizationId) filter.organizationId = scope.organizationId;
        if (typeof params.connectorType === 'string' && VALID_CONNECTOR_TYPES.has(params.connectorType.trim())) {
          filter.connectorType = params.connectorType.trim();
        }
        if (params.active !== undefined) {
          filter.active = params.active === true || params.active === 'true';
        }
        const limit = Math.max(1, Math.min(200, Math.floor(Number(params.limit) || 100)));
        const rows = (await repo.find({ filter, sort: ['id'], limit })) || [];
        const items = rows
          .filter((r) => !scope.organizationId || val(r, 'organizationId') === scope.organizationId)
          .map((r) => serializeConnector(r, { env }));
        ctx.body = { organizationId: scope.organizationId, items };
        if (next) return next();
      },

      save: async (ctx, next) => {
        if ((ctx.method || 'POST') !== 'POST') ctx.throw(405);
        assertApiKeyScope(ctx, ['write']);
        const params = readParams(ctx);
        const scope = await resolveVaultCaller(db, ctx, params.organizationId, { requireOrg: true });
        if (!scope.isAdmin) {
          throw failVault('VAULT_ADMIN_REQUIRED', 403, 'Administrator role is required to save connectors.');
        }

        const repo = getRepo(db, 'latticeConnectors');
        if (!repo || typeof repo.create !== 'function') {
          throw failVault('CONNECTOR_REPO_UNAVAILABLE', 503, 'latticeConnectors repository is unavailable.');
        }

        const connectorKey = typeof params.connectorKey === 'string' ? params.connectorKey.trim().toLowerCase() : '';
        if (!CONNECTOR_KEY_RE.test(connectorKey)) {
          throw failVault('CONNECTOR_KEY_INVALID', 400, 'connectorKey must be a valid lowercase slug (2..64 chars).');
        }
        const name = typeof params.name === 'string' ? params.name.trim() : '';
        if (!name || name.length > 120) {
          throw failVault('CONNECTOR_NAME_REQUIRED', 400, 'Connector name is required (1..120 chars).');
        }
        const connectorType = String(params.connectorType || 'webhook').trim().toLowerCase();
        if (!VALID_CONNECTOR_TYPES.has(connectorType)) {
          throw failVault('CONNECTOR_TYPE_INVALID', 400, `Unsupported connectorType: ${connectorType}`);
        }
        const authType = String(params.authType || 'none').trim().toLowerCase();
        if (!VALID_AUTH_TYPES.has(authType)) {
          throw failVault('CONNECTOR_AUTH_TYPE_INVALID', 400, `Unsupported authType: ${authType}`);
        }

        let baseUrl = null;
        if (params.baseUrl !== undefined && params.baseUrl !== null && String(params.baseUrl).trim() !== '') {
          baseUrl = assertSafeConnectorUrl(String(params.baseUrl), { connectorType, env });
        } else if (connectorType !== 'smtp_notify') {
          throw failVault('CONNECTOR_URL_UNSAFE', 400, 'baseUrl is required for this connectorType.');
        }

        const existing = await findConnectorInOrg(repo, scope.organizationId, {
          id: params.id ?? params.filterByTk,
          connectorKey,
        });

        let encryptedSecretsJson = existing ? val(existing, 'encryptedSecretsJson') || null : null;
        let secretVersion = existing ? (Number(val(existing, 'secretVersion')) || 1) : 1;
        if (params.secrets !== undefined) {
          const cleanSecrets = sanitizeSecretsObject(params.secrets);
          encryptedSecretsJson = Object.keys(cleanSecrets).length > 0
            ? encryptVaultSecrets(cleanSecrets, env)
            : null;
          if (existing) secretVersion += 1;
        }

        const values = {
          organizationId: scope.organizationId,
          connectorKey,
          name,
          connectorType,
          baseUrl,
          authType,
          encryptedSecretsJson,
          secretVersion,
          active: params.active === undefined ? (existing ? val(existing, 'active') !== false : true) : Boolean(params.active),
        };

        let saved;
        if (existing) {
          const existingId = val(existing, 'id');
          if (typeof existing.update === 'function') {
            saved = await existing.update(values);
          } else if (typeof repo.update === 'function') {
            const res = await repo.update({
              filterByTk: existingId,
              filter: { organizationId: scope.organizationId },
              values,
            });
            saved = Array.isArray(res) && res[0] ? res[0] : { ...values, id: existingId };
          }
        } else {
          saved = await repo.create({ values });
        }

        ctx.body = serializeConnector(saved || values, { env });
        if (next) return next();
      },

      rotateSecret: async (ctx, next) => {
        if ((ctx.method || 'POST') !== 'POST') ctx.throw(405);
        assertApiKeyScope(ctx, ['write']);
        const params = readParams(ctx);
        const scope = await resolveVaultCaller(db, ctx, params.organizationId, { requireOrg: true });
        if (!scope.isAdmin) {
          throw failVault('VAULT_ADMIN_REQUIRED', 403, 'Administrator role is required to rotate secrets.');
        }

        const repo = getRepo(db, 'latticeConnectors');
        if (!repo) throw failVault('CONNECTOR_REPO_UNAVAILABLE', 503, 'latticeConnectors repository is unavailable.');
        const row = await findConnectorInOrg(repo, scope.organizationId, params);
        if (!row) throw failVault('CONNECTOR_NOT_FOUND', 404, 'Connector not found.');

        const cleanSecrets = sanitizeSecretsObject(params.secrets);
        if (Object.keys(cleanSecrets).length === 0) {
          throw failVault('VAULT_SECRETS_REQUIRED', 400, 'Non-empty secrets object is required to rotate secret.');
        }
        const encryptedSecretsJson = encryptVaultSecrets(cleanSecrets, env);
        const nextVersion = (Number(val(row, 'secretVersion')) || 1) + 1;
        const patch = { encryptedSecretsJson, secretVersion: nextVersion };

        let updated = row;
        if (typeof row.update === 'function') {
          updated = await row.update(patch);
        } else if (typeof repo.update === 'function') {
          const res = await repo.update({
            filterByTk: val(row, 'id'),
            filter: { organizationId: scope.organizationId },
            values: patch,
          });
          if (Array.isArray(res) && res[0]) updated = res[0];
        }

        ctx.body = serializeConnector(updated, { env });
        if (next) return next();
      },

      delete: async (ctx, next) => {
        if (ctx.method && !['POST', 'DELETE'].includes(ctx.method)) ctx.throw(405);
        assertApiKeyScope(ctx, ['write']);
        const params = readParams(ctx);
        const scope = await resolveVaultCaller(db, ctx, params.organizationId, { requireOrg: true });
        if (!scope.isAdmin) {
          throw failVault('VAULT_ADMIN_REQUIRED', 403, 'Administrator role is required to delete connectors.');
        }

        const repo = getRepo(db, 'latticeConnectors');
        if (!repo) throw failVault('CONNECTOR_REPO_UNAVAILABLE', 503, 'latticeConnectors repository is unavailable.');
        const row = await findConnectorInOrg(repo, scope.organizationId, params);
        if (!row) throw failVault('CONNECTOR_NOT_FOUND', 404, 'Connector not found.');

        const id = val(row, 'id');
        const connectorKey = val(row, 'connectorKey');
        if (typeof repo.destroy === 'function') {
          await repo.destroy({ filter: { id, organizationId: scope.organizationId } });
        } else if (typeof row.destroy === 'function') {
          await row.destroy();
        }
        ctx.body = { deleted: true, id, connectorKey };
        if (next) return next();
      },

      testConnection: async (ctx, next) => {
        if ((ctx.method || 'POST') !== 'POST') ctx.throw(405);
        assertApiKeyScope(ctx, ['write']);
        const params = readParams(ctx);
        const scope = await resolveVaultCaller(db, ctx, params.organizationId, { requireOrg: true });
        if (!scope.isAdmin) {
          throw failVault('VAULT_ADMIN_REQUIRED', 403, 'Administrator role is required to test connectors.');
        }

        const repo = getRepo(db, 'latticeConnectors');
        const row = repo ? await findConnectorInOrg(repo, scope.organizationId, params) : null;
        if ((params.id != null || params.filterByTk != null || params.connectorKey) && !row) {
          throw failVault('CONNECTOR_NOT_FOUND', 404, 'Connector not found.');
        }

        const connectorType = row
          ? (val(row, 'connectorType') || 'webhook')
          : String(params.connectorType || 'webhook').trim().toLowerCase();
        const baseUrl = row ? val(row, 'baseUrl') : params.baseUrl;
        const authType = row ? (val(row, 'authType') || 'none') : String(params.authType || 'none').trim().toLowerCase();
        const secrets = row
          ? decryptVaultSecrets(val(row, 'encryptedSecretsJson'), env)
          : sanitizeSecretsObject(params.secrets);

        const result = await probeConnectorEndpoint(
          { connectorType, baseUrl, authType, secrets },
          { env, fetchImpl, tcpProbeImpl },
        );

        const testedAt = new Date();
        const testStatus = result.ok ? 'ok' : (result.statusCode ? `http_${result.statusCode}` : 'error');
        if (row) {
          const patch = { lastTestedAt: testedAt, lastTestStatus: testStatus };
          if (typeof row.update === 'function') {
            await row.update(patch);
          } else if (typeof repo?.update === 'function') {
            await repo.update({
              filterByTk: val(row, 'id'),
              filter: { organizationId: scope.organizationId },
              values: patch,
            });
          }
        }

        ctx.body = {
          ...result,
          connectorKey: row ? val(row, 'connectorKey') : (params.connectorKey || null),
          connectorType,
          lastTestedAt: testedAt.toISOString(),
          lastTestStatus: testStatus,
        };
        if (next) return next();
      },
    },
  });

  app.acl?.allow?.('dxosVault', ['list', 'save', 'rotateSecret', 'delete', 'testConnection'], 'loggedIn');

  return {
    resolveConnectorSecrets: (arg1, arg2, arg3, arg4) => {
      if (arg1 && typeof arg1.getRepository === 'function') {
        return resolveConnectorSecrets(arg1, arg2, arg3, { env, ...(arg4 || {}) });
      }
      return resolveConnectorSecrets(db, arg1, arg2, { env, ...(arg3 || {}) });
    },
    assertSafeConnectorUrl: (rawUrl, opts = {}) =>
      assertSafeConnectorUrl(rawUrl, { env, ...opts }),
    encryptVaultSecrets: (secretsObj) => encryptVaultSecrets(secretsObj, env),
    decryptVaultSecrets: (ciphertext) => decryptVaultSecrets(ciphertext, env),
  };
}

module.exports = {
  VALID_CONNECTOR_TYPES,
  VALID_AUTH_TYPES,
  INTERNAL_CONNECTOR_HOST_ALLOWLIST,
  resolveVaultMasterKey,
  encryptSecretText,
  decryptSecretText,
  encryptVaultSecrets,
  decryptVaultSecrets,
  assertSafeConnectorUrl,
  serializeConnector,
  resolveConnectorSecrets,
  probeConnectorEndpoint,
  registerConnectorVault,
};
