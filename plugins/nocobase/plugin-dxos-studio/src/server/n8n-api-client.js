/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const crypto = require('node:crypto');
const {
  assertPatScope,
  fail,
  isOrgAdmin,
  loadFoundationModule,
  loadFoundationSet,
  readParams,
  resolveTenantActor,
  resolveVerifiedRoles,
  val,
} = require('./wms-dmn-shared');

const ADMIN_ROLES = new Set(['root', 'admin', 'ldx_admin']);
const MUTATING_HTTP_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const DEFAULT_N8N_TIMEOUT_MS = 10_000;

function getVaultModule(options = {}) {
  return options.connectorVault || loadFoundationModule('connector-vault');
}

function scrubN8nSecrets(text, secretValues = []) {
  let out = String(text ?? '');
  for (const valItem of secretValues) {
    if (typeof valItem === 'string' && valItem.length >= 4) {
      out = out.split(valItem).join('[REDACTED]');
    }
  }
  return out;
}

function collectSecretValues(obj, out = []) {
  if (!obj || typeof obj !== 'object') return out;
  for (const v of Object.values(obj)) {
    if (typeof v === 'string' && v.length >= 4) out.push(v);
    else if (v && typeof v === 'object') collectSecretValues(v, out);
  }
  return out;
}

function assertSafeN8nBaseUrlSync(rawUrl, options = {}) {
  const env = options.env || process.env;
  const vaultMod = getVaultModule(options);
  if (typeof vaultMod?.assertSafeConnectorUrl === 'function') {
    return vaultMod.assertSafeConnectorUrl(rawUrl, {
      connectorType: 'n8n',
      env,
      allowInternal: options.allowInternal,
    });
  }
  const trimmed = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!trimmed) {
    throw fail('CONNECTOR_URL_UNSAFE', 400, 'n8n baseUrl is required.');
  }
  const parsed = new URL(trimmed);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw fail('CONNECTOR_URL_UNSAFE', 400, 'Unsafe n8n baseUrl protocol or embedded credentials.');
  }
  return parsed.toString();
}

async function assertSafeN8nBaseUrlAsync(rawUrl, options = {}) {
  const env = options.env || process.env;
  const vaultMod = getVaultModule(options);
  const fetchFn = options.fetchFn || options.fetchImpl || globalThis.fetch;
  const isMockFetch = typeof fetchFn === 'function' && fetchFn !== globalThis.fetch;
  const skipDnsCheck = options.skipDnsCheck ?? (isMockFetch && typeof options.lookupImpl !== 'function');
  if (typeof vaultMod?.assertSafeConnectorUrlAsync === 'function') {
    return vaultMod.assertSafeConnectorUrlAsync(rawUrl, {
      connectorType: 'n8n',
      env,
      allowInternal: options.allowInternal,
      lookupImpl: options.lookupImpl,
      skipDnsCheck,
    });
  }
  return assertSafeN8nBaseUrlSync(rawUrl, options);
}

function buildCredentialPayloadFromConnector({
  connector = {},
  secrets = {},
  accessToken = null,
  n8nCredentialType,
  credentialName,
} = {}) {
  const appType = String(connector.appType || '').trim().toLowerCase();
  const connKey = String(connector.connectorKey || 'connector').trim();
  const name = String(credentialName || connector.name || `LatticeDX ${connKey}`).trim().slice(0, 120);

  if (n8nCredentialType === 'telegramApi' || appType === 'telegram') {
    return {
      name,
      type: n8nCredentialType || 'telegramApi',
      data: {
        accessToken: String(secrets.botToken || secrets.accessToken || secrets.token || secrets.apiKey || ''),
      },
    };
  }
  if (n8nCredentialType === 'smtp' || appType === 'email_smtp') {
    return {
      name,
      type: n8nCredentialType || 'smtp',
      data: {
        user: String(secrets.username || secrets.user || ''),
        password: String(secrets.password || ''),
        host: String(secrets.host || ''),
        port: Number(secrets.port) || 587,
        secure: Boolean(secrets.secure),
      },
    };
  }
  if (appType === 'gmail_oauth2' || appType === 'google_sheets_oauth2') {
    const type = n8nCredentialType || (appType === 'gmail_oauth2' ? 'gmailOAuth2' : 'googleSheetsOAuth2Api');
    return {
      name,
      type,
      data: {
        clientId: String(connector.oauthConfigJson?.clientId || secrets.clientId || ''),
        clientSecret: String(secrets.clientSecret || ''),
        oauthTokenData: {
          access_token: String(accessToken || secrets.accessToken || secrets.token || ''),
        },
      },
    };
  }
  if (appType === 'slack' || appType === 'teams' || appType === 'github') {
    const defaultType = appType === 'slack' ? 'slackOAuth2Api' : (appType === 'teams' ? 'microsoftTeamsOAuth2Api' : 'githubOAuth2Api');
    const tok = String(accessToken || secrets.accessToken || secrets.botToken || secrets.token || '');
    return {
      name,
      type: n8nCredentialType || defaultType,
      data: {
        accessToken: tok,
        oauthTokenData: tok ? { access_token: tok } : undefined,
      },
    };
  }
  if (appType === 'rustfs_s3') {
    return {
      name,
      type: n8nCredentialType || 's3',
      data: {
        endpoint: String(connector.baseUrl || secrets.endpoint || ''),
        region: String(secrets.region || 'us-east-1'),
        accessKeyId: String(secrets.accessKeyId || secrets.apiKey || ''),
        secretAccessKey: String(secrets.secretAccessKey || secrets.secret || ''),
      },
    };
  }

  const headerName = String(
    secrets.headerName
      || (connector.authType === 'bearer' || connector.authType === 'oauth2' ? 'Authorization' : 'X-API-Key'),
  ).trim();
  const tokenVal = String(accessToken || secrets.apiKey || secrets.token || secrets.secret || '');
  const headerValue = headerName.toLowerCase() === 'authorization' && tokenVal && !/^Bearer\s+/i.test(tokenVal)
    ? `Bearer ${tokenVal}`
    : tokenVal;

  return {
    name,
    type: n8nCredentialType || 'httpHeaderAuth',
    data: {
      name: headerName,
      value: headerValue,
    },
  };
}

function createN8nApiClient({
  baseUrl,
  apiKey,
  fetchFn = globalThis.fetch,
  env = process.env,
  lookupImpl,
  allowInternal,
  connectorVault,
  timeoutMs = DEFAULT_N8N_TIMEOUT_MS,
} = {}) {
  const normalizedBase = assertSafeN8nBaseUrlSync(baseUrl, { env, allowInternal, connectorVault }).replace(/\/+$/, '');
  const baseOrigin = new URL(normalizedBase).origin;
  const cleanApiKey = typeof apiKey === 'string' ? apiKey.trim() : '';
  const secretScrubList = cleanApiKey ? [cleanApiKey] : [];

  async function request(method, pathStr, { query, body, idempotencyKey, requireApiKey = true } = {}) {
    const httpMethod = String(method || 'GET').toUpperCase();
    if (requireApiKey && !cleanApiKey) {
      throw fail('N8N_API_KEY_MISSING', 400, 'n8n X-N8N-API-KEY is required.');
    }
    if (typeof fetchFn !== 'function') {
      throw fail('N8N_FETCH_UNAVAILABLE', 503, 'HTTP fetch implementation is unavailable.');
    }

    const rel = pathStr.startsWith('/') ? pathStr : `/${pathStr}`;
    const urlObj = new URL(`${baseOrigin}${rel}`);
    if (query && typeof query === 'object') {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && String(v) !== '') {
          urlObj.searchParams.set(k, String(v));
        }
      }
    }

    const targetUrl = await assertSafeN8nBaseUrlAsync(urlObj.toString(), {
      env,
      allowInternal,
      lookupImpl,
      fetchFn,
      connectorVault,
    });

    const headers = {
      Accept: 'application/json',
    };
    if (cleanApiKey) {
      headers['X-N8N-API-KEY'] = cleanApiKey;
    }
    let bodyStr;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      bodyStr = JSON.stringify(body);
    }
    if (MUTATING_HTTP_METHODS.has(httpMethod)) {
      headers['Idempotency-Key'] = idempotencyKey ? String(idempotencyKey) : `ldx-${crypto.randomUUID()}`;
    }

    const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(Math.max(500, Number(timeoutMs) || DEFAULT_N8N_TIMEOUT_MS))
      : undefined;

    let response;
    try {
      response = await fetchFn(targetUrl, {
        method: httpMethod,
        headers,
        ...(bodyStr !== undefined ? { body: bodyStr } : {}),
        redirect: 'error',
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      const safeMsg = scrubN8nSecrets(err?.message || 'n8n API request failed', secretScrubList);
      throw fail('N8N_API_REQUEST_FAILED', 502, safeMsg);
    }

    let rawText = '';
    if (typeof response?.text === 'function') {
      rawText = await response.text().catch(() => '');
    } else if (typeof response?.json === 'function') {
      const parsedJson = await response.json().catch(() => null);
      rawText = parsedJson !== null ? JSON.stringify(parsedJson) : '';
    }

    let parsed = null;
    if (rawText.trim()) {
      try {
        parsed = JSON.parse(rawText);
      } catch {
        parsed = { raw: scrubN8nSecrets(rawText.slice(0, 4096), secretScrubList) };
      }
    }

    if (!response?.ok) {
      const upstreamMsg = scrubN8nSecrets(
        parsed?.message || parsed?.error || `n8n API returned HTTP ${response?.status || 'unknown'}`,
        secretScrubList,
      );
      throw fail('N8N_API_HTTP_ERROR', Number(response?.status) >= 400 && Number(response?.status) < 500 ? Number(response.status) : 502, upstreamMsg);
    }

    return parsed ?? {};
  }

  return {
    baseUrl: baseOrigin,

    async healthCheck({ verifyApi = true } = {}) {
      const started = Date.now();
      let healthzOk = false;
      let status = null;
      try {
        const hzTarget = await assertSafeN8nBaseUrlAsync(`${baseOrigin}/healthz`, {
          env,
          allowInternal,
          lookupImpl,
          fetchFn,
          connectorVault,
        });
        const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
          ? AbortSignal.timeout(Math.max(500, Number(timeoutMs) || DEFAULT_N8N_TIMEOUT_MS))
          : undefined;
        const hzRes = await fetchFn(hzTarget, { method: 'GET', redirect: 'error', ...(signal ? { signal } : {}) });
        status = Number(hzRes?.status) || null;
        healthzOk = Boolean(hzRes?.ok);
        try { await hzRes?.body?.cancel?.(); } catch {}
      } catch {
        healthzOk = false;
      }

      let apiOk = false;
      if (verifyApi && cleanApiKey) {
        try {
          await request('GET', '/api/v1/workflows', { query: { limit: 1 } });
          apiOk = true;
        } catch {
          apiOk = false;
        }
      }

      return {
        ok: healthzOk && (!verifyApi || !cleanApiKey || apiOk),
        healthzOk,
        apiOk,
        hasApiKey: Boolean(cleanApiKey),
        status,
        baseUrl: baseOrigin,
        latencyMs: Math.max(0, Date.now() - started),
      };
    },

    listWorkflows({ active, tags, name, limit = 50, cursor } = {}) {
      return request('GET', '/api/v1/workflows', {
        query: {
          ...(active !== undefined ? { active: Boolean(active) } : {}),
          ...(tags ? { tags: Array.isArray(tags) ? tags.join(',') : String(tags) } : {}),
          ...(name ? { name: String(name) } : {}),
          limit: Math.max(1, Math.min(250, Number(limit) || 50)),
          ...(cursor ? { cursor: String(cursor) } : {}),
        },
      });
    },

    getWorkflow(workflowId) {
      const id = String(workflowId || '').trim();
      if (!id) throw fail('N8N_WORKFLOW_ID_REQUIRED', 400, 'workflowId is required.');
      return request('GET', `/api/v1/workflows/${encodeURIComponent(id)}`);
    },

    createWorkflow(workflowPayload, { idempotencyKey } = {}) {
      if (!workflowPayload || typeof workflowPayload !== 'object' || Array.isArray(workflowPayload)) {
        throw fail('N8N_WORKFLOW_INVALID', 400, 'workflowPayload must be a JSON object.');
      }
      return request('POST', '/api/v1/workflows', { body: workflowPayload, idempotencyKey });
    },

    updateWorkflow(workflowId, workflowPayload, { idempotencyKey } = {}) {
      const id = String(workflowPayload?.id || workflowId || '').trim();
      if (!id) throw fail('N8N_WORKFLOW_ID_REQUIRED', 400, 'workflowId is required.');
      if (!workflowPayload || typeof workflowPayload !== 'object' || Array.isArray(workflowPayload)) {
        throw fail('N8N_WORKFLOW_INVALID', 400, 'workflowPayload must be a JSON object.');
      }
      return request('PUT', `/api/v1/workflows/${encodeURIComponent(id)}`, { body: workflowPayload, idempotencyKey });
    },

    activateWorkflow(workflowId, active = true, { idempotencyKey } = {}) {
      const id = String(workflowId || '').trim();
      if (!id) throw fail('N8N_WORKFLOW_ID_REQUIRED', 400, 'workflowId is required.');
      const verb = active === false ? 'deactivate' : 'activate';
      return request('POST', `/api/v1/workflows/${encodeURIComponent(id)}/${verb}`, { body: {}, idempotencyKey });
    },

    listExecutions({ workflowId, status, includeData = false, limit = 50, cursor } = {}) {
      return request('GET', '/api/v1/executions', {
        query: {
          ...(workflowId ? { workflowId: String(workflowId) } : {}),
          ...(status ? { status: String(status) } : {}),
          includeData: Boolean(includeData),
          limit: Math.max(1, Math.min(250, Number(limit) || 50)),
          ...(cursor ? { cursor: String(cursor) } : {}),
        },
      });
    },

    getExecution(executionId, { includeData = true } = {}) {
      const id = String(executionId || '').trim();
      if (!id) throw fail('N8N_EXECUTION_ID_REQUIRED', 400, 'executionId is required.');
      return request('GET', `/api/v1/executions/${encodeURIComponent(id)}`, {
        query: { includeData: Boolean(includeData) },
      });
    },

    retryExecution(executionId, { loadWorkflow = true, idempotencyKey } = {}) {
      const id = String(executionId || '').trim();
      if (!id) throw fail('N8N_EXECUTION_ID_REQUIRED', 400, 'executionId is required.');
      return request('POST', `/api/v1/executions/${encodeURIComponent(id)}/retry`, {
        body: { loadWorkflow: Boolean(loadWorkflow) },
        idempotencyKey,
      });
    },

    listCredentials({ limit = 50, cursor } = {}) {
      return request('GET', '/api/v1/credentials', {
        query: {
          limit: Math.max(1, Math.min(250, Number(limit) || 50)),
          ...(cursor ? { cursor: String(cursor) } : {}),
        },
      });
    },

    createCredential(credentialPayload, { idempotencyKey } = {}) {
      if (!credentialPayload || typeof credentialPayload !== 'object' || Array.isArray(credentialPayload)) {
        throw fail('N8N_CREDENTIAL_INVALID', 400, 'credentialPayload must be a JSON object.');
      }
      return request('POST', '/api/v1/credentials', { body: credentialPayload, idempotencyKey });
    },

    async syncConnectorCredentialToN8n({
      connector = {},
      secrets = {},
      accessToken = null,
      n8nCredentialType,
      credentialName,
      idempotencyKey,
    } = {}) {
      const payload = buildCredentialPayloadFromConnector({
        connector,
        secrets,
        accessToken,
        n8nCredentialType,
        credentialName,
      });
      const derivedKey = idempotencyKey
        || `ldx-cred-${connector.organizationId || 'org'}-${connector.connectorKey || 'conn'}-v${Number(connector.secretVersion) || 1}`;
      let created;
      try {
        created = await request('POST', '/api/v1/credentials', {
          body: payload,
          idempotencyKey: derivedKey,
        });
      } catch (err) {
        const extraSecrets = collectSecretValues(secrets);
        if (accessToken) extraSecrets.push(String(accessToken));
        throw fail(
          err?.code || 'N8N_CREDENTIAL_SYNC_FAILED',
          err?.status || 502,
          scrubN8nSecrets(err?.message || 'Failed to sync credential to n8n.', extraSecrets),
        );
      }

      const credentialId = String(created?.id || created?.data?.id || '').trim() || null;
      return {
        synced: Boolean(credentialId),
        credentialId,
        n8nCredentialId: credentialId,
        name: created?.name || payload.name,
        type: created?.type || payload.type,
        connectorKey: connector.connectorKey || null,
      };
    },
  };
}

function createN8nRouteHandlers(db, options = {}) {
  const foundation = options.foundation || loadFoundationSet();
  const env = options.env || process.env;

  async function requireN8nAdmin(ctx, params, { mutating = false } = {}) {
    assertPatScope(ctx, mutating ? ['write', 'ai'] : ['read', 'write', 'ai'], foundation);
    const requestedOrgId = params.organizationId != null ? String(params.organizationId).trim() : null;
    const { organizationId, actor, isRoot } = await resolveTenantActor(
      db,
      ctx,
      {
        requireOrg: true,
        requestedOrgId: requestedOrgId || null,
        aclCollections: [],
      },
      foundation,
    );
    const verifiedRoles = await resolveVerifiedRoles(db, ctx);
    const orgAdmin = await isOrgAdmin(db, ctx);
    const hasElevatedRole = verifiedRoles.some((r) => ADMIN_ROLES.has(String(r).toLowerCase()));
    if (!isRoot && !hasElevatedRole && !orgAdmin) {
      throw fail('N8N_ADMIN_REQUIRED', 403, 'Administrator role (root/admin/ldx_admin) is required for n8n operations.');
    }
    return { organizationId, actor, isRoot };
  }

  async function resolveOrgN8nClient(organizationId, params = {}, isRoot = false) {
    const vaultMod = getVaultModule(options);
    const repo = db?.getRepository?.('latticeConnectors');
    let baseUrl = '';
    let apiKey = '';
    let connectorKey = typeof params.connectorKey === 'string' ? params.connectorKey.trim().toLowerCase() : '';

    if (repo && typeof repo.find === 'function') {
      const rows = (await repo.find({ filter: { organizationId, active: true }, sort: ['id'], limit: 100 })) || [];
      const n8nRows = rows.filter((r) => {
        if (val(r, 'organizationId') !== organizationId) return false;
        const cType = String(val(r, 'connectorType') || '').toLowerCase();
        const aType = String(val(r, 'appType') || '').toLowerCase();
        return cType === 'n8n' || aType === 'n8n_api';
      });
      const picked = connectorKey
        ? n8nRows.find((r) => String(val(r, 'connectorKey') || '').toLowerCase() === connectorKey)
        : (n8nRows.find((r) => String(val(r, 'appType') || '').toLowerCase() === 'n8n_api') || n8nRows[0]);

      if (picked && typeof vaultMod?.resolveConnectorSecrets === 'function') {
        const resolved = await vaultMod.resolveConnectorSecrets(db, organizationId, val(picked, 'connectorKey'), { env });
        baseUrl = resolved.connector.baseUrl || '';
        apiKey = String(resolved.secrets.apiKey || resolved.secrets.token || resolved.secrets.key || '').trim();
        connectorKey = resolved.connector.connectorKey;
      }
    }

    if (!baseUrl && env?.DX_N8N_API_URL) {
      baseUrl = String(env.DX_N8N_API_URL).trim();
    }
    if (!apiKey && env?.DX_N8N_API_KEY) {
      apiKey = String(env.DX_N8N_API_KEY).trim();
    }

    if (!baseUrl) {
      throw fail('N8N_CONNECTOR_NOT_CONFIGURED', 404, 'No active n8n API connector configured for this organization.');
    }

    const allowInternal = vaultMod?.resolveAllowInternalConnectorHosts?.({ isRoot, env });
    const client = createN8nApiClient({
      baseUrl,
      apiKey,
      fetchFn: options.fetchImpl || options.fetchFn || globalThis.fetch,
      env,
      lookupImpl: options.lookupImpl,
      allowInternal,
      connectorVault: vaultMod,
    });
    return { client, connectorKey };
  }

  const actions = {
    async status(ctx, next) {
      if ((ctx.method || 'GET') !== 'GET') ctx.throw(405);
      const params = readParams(ctx);
      const { organizationId, isRoot } = await requireN8nAdmin(ctx, params, { mutating: false });
      const { client, connectorKey } = await resolveOrgN8nClient(organizationId, params, isRoot);
      const health = await client.healthCheck({ verifyApi: true });
      ctx.body = { organizationId, connectorKey: connectorKey || null, ...health };
      if (next) return next();
    },

    async appCatalog(ctx, next) {
      if ((ctx.method || 'GET') !== 'GET') ctx.throw(405);
      const params = readParams(ctx);
      const { organizationId } = await requireN8nAdmin(ctx, params, { mutating: false });
      const vaultMod = getVaultModule(options);
      const catalog = Array.isArray(vaultMod?.APP_CONNECTOR_CATALOG) ? vaultMod.APP_CONNECTOR_CATALOG : [];
      const repo = db?.getRepository?.('latticeConnectors');
      const rows = repo && typeof repo.find === 'function'
        ? (await repo.find({ filter: { organizationId }, sort: ['id'], limit: 200 })) || []
        : [];
      const configuredByApp = new Map();
      for (const r of rows) {
        if (val(r, 'organizationId') !== organizationId) continue;
        const appType = String(val(r, 'appType') || '').trim().toLowerCase();
        if (appType) configuredByApp.set(appType, (configuredByApp.get(appType) || 0) + 1);
      }
      ctx.body = {
        organizationId,
        items: catalog.map((item) => ({
          ...item,
          configuredCount: configuredByApp.get(item.appType) || 0,
        })),
      };
      if (next) return next();
    },

    async workflows(ctx, next) {
      if ((ctx.method || 'GET') !== 'GET') ctx.throw(405);
      const params = readParams(ctx);
      const { organizationId, isRoot } = await requireN8nAdmin(ctx, params, { mutating: false });
      const { client } = await resolveOrgN8nClient(organizationId, params, isRoot);
      ctx.body = await client.listWorkflows({
        active: params.active !== undefined ? (params.active === true || params.active === 'true') : undefined,
        tags: params.tags,
        name: params.name,
        limit: params.limit,
        cursor: params.cursor,
      });
      if (next) return next();
    },

    async getWorkflow(ctx, next) {
      if ((ctx.method || 'GET') !== 'GET') ctx.throw(405);
      const params = readParams(ctx);
      const { organizationId, isRoot } = await requireN8nAdmin(ctx, params, { mutating: false });
      const { client } = await resolveOrgN8nClient(organizationId, params, isRoot);
      ctx.body = await client.getWorkflow(params.workflowId ?? params.id);
      if (next) return next();
    },

    async createWorkflow(ctx, next) {
      if ((ctx.method || 'POST') !== 'POST') ctx.throw(405);
      const params = readParams(ctx);
      const { organizationId, isRoot } = await requireN8nAdmin(ctx, params, { mutating: true });
      const { client } = await resolveOrgN8nClient(organizationId, params, isRoot);
      const payload = params.workflow && typeof params.workflow === 'object' ? params.workflow : params;
      ctx.body = await client.createWorkflow(payload, { idempotencyKey: params.idempotencyKey });
      if (next) return next();
    },

    async updateWorkflow(ctx, next) {
      if ((ctx.method || 'POST') !== 'POST') ctx.throw(405);
      const params = readParams(ctx);
      const { organizationId, isRoot } = await requireN8nAdmin(ctx, params, { mutating: true });
      const { client } = await resolveOrgN8nClient(organizationId, params, isRoot);
      const workflowId = params.workflowId ?? params.id;
      const payload = params.workflow && typeof params.workflow === 'object' ? params.workflow : params;
      ctx.body = await client.updateWorkflow(workflowId, payload, { idempotencyKey: params.idempotencyKey });
      if (next) return next();
    },

    async activateWorkflow(ctx, next) {
      if ((ctx.method || 'POST') !== 'POST') ctx.throw(405);
      const params = readParams(ctx);
      const { organizationId, isRoot } = await requireN8nAdmin(ctx, params, { mutating: true });
      const { client } = await resolveOrgN8nClient(organizationId, params, isRoot);
      const workflowId = params.workflowId ?? params.id;
      const active = params.active === undefined ? true : Boolean(params.active === true || params.active === 'true');
      ctx.body = await client.activateWorkflow(workflowId, active, { idempotencyKey: params.idempotencyKey });
      if (next) return next();
    },

    async executions(ctx, next) {
      if ((ctx.method || 'GET') !== 'GET') ctx.throw(405);
      const params = readParams(ctx);
      const { organizationId, isRoot } = await requireN8nAdmin(ctx, params, { mutating: false });
      const { client } = await resolveOrgN8nClient(organizationId, params, isRoot);
      ctx.body = await client.listExecutions({
        workflowId: params.workflowId,
        status: params.status,
        includeData: params.includeData === true || params.includeData === 'true',
        limit: params.limit,
        cursor: params.cursor,
      });
      if (next) return next();
    },

    async retryExecution(ctx, next) {
      if ((ctx.method || 'POST') !== 'POST') ctx.throw(405);
      const params = readParams(ctx);
      const { organizationId, isRoot } = await requireN8nAdmin(ctx, params, { mutating: true });
      const { client } = await resolveOrgN8nClient(organizationId, params, isRoot);
      const executionId = params.executionId ?? params.id;
      ctx.body = await client.retryExecution(executionId, {
        loadWorkflow: params.loadWorkflow !== false,
        idempotencyKey: params.idempotencyKey,
      });
      if (next) return next();
    },

    async syncCredential(ctx, next) {
      if ((ctx.method || 'POST') !== 'POST') ctx.throw(405);
      const params = readParams(ctx);
      const { organizationId, isRoot } = await requireN8nAdmin(ctx, params, { mutating: true });
      const vaultMod = getVaultModule(options);
      if (typeof vaultMod?.resolveConnectorSecrets !== 'function') {
        throw fail('VAULT_UNAVAILABLE', 503, 'Connector Vault module is unavailable.');
      }

      const targetRef = params.targetConnectorKey ?? params.connectorKey ?? params.connectorId ?? params.id;
      const { connector, secrets } = await vaultMod.resolveConnectorSecrets(db, organizationId, targetRef, { env });
      let accessToken = null;
      if (connector.authType === 'oauth2' && typeof vaultMod?.getFreshConnectorToken === 'function') {
        const fresh = await vaultMod.getFreshConnectorToken(db, connector.id ?? connector.connectorKey, {
          organizationId,
          env,
          fetchImpl: options.fetchImpl || options.fetchFn,
          lookupImpl: options.lookupImpl,
        });
        accessToken = fresh.accessToken;
      }

      const { client } = await resolveOrgN8nClient(organizationId, { connectorKey: params.n8nConnectorKey }, isRoot);
      const syncResult = await client.syncConnectorCredentialToN8n({
        connector,
        secrets,
        accessToken,
        n8nCredentialType: params.n8nCredentialType,
        credentialName: params.credentialName,
        idempotencyKey: params.idempotencyKey,
      });

      const repo = db?.getRepository?.('latticeConnectors');
      if (syncResult.n8nCredentialId && repo) {
        const pgRls = foundation?.pgRls;
        const persistCredId = async (transaction) => {
          const txOpt = transaction ? { transaction } : {};
          await repo.update({
            filterByTk: connector.id,
            filter: { organizationId },
            values: { n8nCredentialId: syncResult.n8nCredentialId },
            ...txOpt,
          });
        };
        if (typeof pgRls?.canUsePgRlsSession === 'function' && pgRls.canUsePgRlsSession(db)) {
          await pgRls.withTenantRlsContext(db, organizationId, persistCredId);
        } else {
          await persistCredId(undefined);
        }
      }

      ctx.body = syncResult;
      if (next) return next();
    },
  };

  return {
    name: 'dxosN8n',
    actions,
    resourceDef: { name: 'dxosN8n', actions },
    aclAllow: { resource: 'dxosN8n', actions: Object.keys(actions), scope: 'loggedIn' },
  };
}

module.exports = {
  ADMIN_ROLES,
  createN8nApiClient,
  createN8nRouteHandlers,
  createDxosN8nActions: (db, options = {}) => createN8nRouteHandlers(db, options).actions,
  buildCredentialPayloadFromConnector,
  scrubN8nSecrets,
};
