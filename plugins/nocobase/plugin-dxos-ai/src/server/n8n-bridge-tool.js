/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const path = require('node:path');

function loadCrossModule(pkgName, dirSlug, relPath) {
  const inDist = __dirname.includes(`${path.sep}dist${path.sep}`);
  const cands = inDist
    ? [`${pkgName}/dist/server/${relPath}`, `${pkgName}/src/server/${relPath}`, `../../../${dirSlug}/dist/server/${relPath}`, `../../../${dirSlug}/src/server/${relPath}`]
    : [`${pkgName}/src/server/${relPath}`, `../../../${dirSlug}/src/server/${relPath}`, `${pkgName}/dist/server/${relPath}`, `../../../${dirSlug}/dist/server/${relPath}`];
  for (const modPath of cands) {
    try {
      return require(modPath);
    } catch (err) {
      const direct = err?.code === 'MODULE_NOT_FOUND'
        && (!Array.isArray(err.requireStack) || err.requireStack.length === 0 || err.requireStack[0] === __filename);
      if (!direct) throw err;
    }
  }
  return null;
}

const getVaultMod = () => loadCrossModule('@latticedx/plugin-lattice-foundation', 'plugin-lattice-foundation', 'connector-vault');
const getPgRlsMod = () => loadCrossModule('@latticedx/plugin-lattice-foundation', 'plugin-lattice-foundation', 'pg-rls');
const getIntMod = () => loadCrossModule('@latticedx/plugin-dxos-studio', 'plugin-dxos-studio', 'flow/nodes/integrations');
const getSecMod = () => loadCrossModule('@latticedx/plugin-dxos-studio', 'plugin-dxos-studio', 'flow/security-helpers');
const getN8nApiClientMod = () => loadCrossModule('@latticedx/plugin-dxos-studio', 'plugin-dxos-studio', 'n8n-api-client');

async function withOptionalTenantRls(db, organizationId, fn) {
  const pgRls = getPgRlsMod();
  if (
    pgRls
    && typeof pgRls.canUsePgRlsSession === 'function'
    && pgRls.canUsePgRlsSession(db)
    && !pgRls.getActiveRlsContext?.()?.transaction
    && organizationId
    && typeof pgRls.withTenantRlsContext === 'function'
  ) {
    return pgRls.withTenantRlsContext(db, organizationId, fn);
  }
  return fn(null);
}

function sanitizeKey(raw) {
  const clean = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/.test(clean) ? clean : '';
}

function scrubUrlForOutput(rawUrl) {
  try {
    const u = new URL(String(rawUrl || ''));
    return `${u.origin}${u.pathname}`;
  } catch {
    return String(rawUrl || '');
  }
}

async function resolveTargetConnector(db, organizationId, rawKey, failTool) {
  const repo = db?.getRepository?.('latticeConnectors');
  if (!repo || typeof repo.find !== 'function') {
    throw failTool('VAULT_UNAVAILABLE', 503, 'Repository latticeConnectors chưa sẵn sàng.');
  }
  let key = sanitizeKey(rawKey);
  if (!key) {
    if (typeof rawKey === 'string' && rawKey.trim()) {
      throw failTool('CONNECTOR_KEY_INVALID', 400, 'connectorKey không hợp lệ.');
    }
    const rows = (await withOptionalTenantRls(db, organizationId, (transaction) => (
      repo.find({ filter: { organizationId, active: true }, sort: ['id'], limit: 50, ...(transaction ? { transaction } : {}) })
    ))) || [];
    const n8nRow = rows.find((r) => String(r?.connectorType || r?.get?.('connectorType') || '').toLowerCase() === 'n8n');
    key = sanitizeKey(n8nRow?.connectorKey || n8nRow?.get?.('connectorKey') || '');
    if (!key) throw failTool('CONNECTOR_NOT_FOUND', 404, 'Chưa tìm thấy connector n8n nào đang kích hoạt trong tổ chức.');
  }
  return key;
}

/** Lists tenant-scoped non-secret connectors (n8n, webhook, mqtt, orion_ld, http_api). */
async function runListConnectors(ctx, db, actor, args, deps) {
  const { val, failTool, hasRes, invokeResourceAction } = deps;
  const connType = typeof args.connectorType === 'string' && args.connectorType.trim()
    ? args.connectorType.trim().toLowerCase()
    : '';
  if (hasRes(ctx, 'dxosVault')) {
    const res = await invokeResourceAction(ctx, 'dxosVault', 'list', {
      method: 'GET',
      organizationId: actor.organizationId,
      ...(connType ? { connectorType: connType } : {}),
      values: { organizationId: actor.organizationId, ...(connType ? { connectorType: connType } : {}) },
    });
    return { operation: 'listConnectors', organizationId: actor.organizationId, ...(res || {}) };
  }
  const repo = db?.getRepository?.('latticeConnectors');
  if (!repo || typeof repo.find !== 'function') {
    throw failTool('VAULT_UNAVAILABLE', 503, 'Repository latticeConnectors chưa sẵn sàng.');
  }
  const vaultMod = getVaultMod();
  const rows = (await withOptionalTenantRls(db, actor.organizationId, (transaction) => (
    repo.find({ filter: { organizationId: actor.organizationId }, sort: ['id'], limit: 100, ...(transaction ? { transaction } : {}) })
  ))) || [];
  const items = rows
    .filter((r) => val(r, 'organizationId') === actor.organizationId && (!connType || String(val(r, 'connectorType') || '').toLowerCase() === connType))
    .map((r) => (typeof vaultMod?.serializeConnector === 'function' ? vaultMod.serializeConnector(r) : {
      id: val(r, 'id') ?? null,
      organizationId: val(r, 'organizationId'),
      connectorKey: val(r, 'connectorKey'),
      name: val(r, 'name'),
      connectorType: val(r, 'connectorType'),
      baseUrl: val(r, 'baseUrl') || null,
      authType: val(r, 'authType') || 'none',
      hasSecrets: Boolean(val(r, 'encryptedSecretsJson')),
      lastTestStatus: val(r, 'lastTestStatus') || null,
      active: val(r, 'active') !== false,
    }));
  return { operation: 'listConnectors', organizationId: actor.organizationId, count: items.length, items };
}

/** Tests connectivity (/healthz for n8n) for a tenant-scoped Vault connector. */
async function runTestConnector(ctx, db, actor, args, deps) {
  const { val, failTool, hasRes, invokeResourceAction } = deps;
  const connectorKey = await resolveTargetConnector(db, actor.organizationId, args.connectorKey, failTool);
  if (hasRes(ctx, 'dxosVault')) {
    const res = await invokeResourceAction(ctx, 'dxosVault', 'testConnection', {
      method: 'POST',
      organizationId: actor.organizationId,
      connectorKey,
      values: { organizationId: actor.organizationId, connectorKey },
    });
    return { operation: 'testConnector', organizationId: actor.organizationId, connectorKey, ...(res || {}) };
  }
  const vaultMod = getVaultMod();
  if (!vaultMod?.resolveConnectorSecrets || !vaultMod?.probeConnectorEndpoint) {
    throw failTool('VAULT_UNAVAILABLE', 503, 'Connector Vault module unavailable.');
  }
  const { connector, secrets } = await vaultMod.resolveConnectorSecrets(db, actor.organizationId, connectorKey, { env: deps.env || process.env });
  const env = deps.env || process.env;
  const allowInternal = vaultMod.resolveAllowInternalConnectorHosts?.({ isRoot: Boolean(actor?.isRoot || actor?.isAdmin), env }) ?? true;
  const probe = await vaultMod.probeConnectorEndpoint(
    { connectorType: connector.connectorType, baseUrl: connector.baseUrl, authType: connector.authType, secrets },
    { env, fetchImpl: deps.fetchImpl, tcpProbeImpl: deps.tcpProbeImpl, lookupImpl: deps.lookupImpl, allowInternal },
  );
  return { operation: 'testConnector', organizationId: actor.organizationId, connectorKey: val(connector, 'connectorKey') || connectorKey, connectorType: connector.connectorType, ...probe };
}

/** Invokes an HTTP / n8n webhook connector directly with HMAC signing, SSRF lock, and secret scrubbing. */
async function runInvokeN8n(ctx, db, actor, args, deps) {
  const { failTool, hasForbiddenProtoKeys, sanitizeAutomationValue } = deps;
  if (hasForbiddenProtoKeys(args.payload)) {
    throw failTool('AUTOMATION_AI_REFUSED', 400, 'Payload chứa khóa prototype bị cấm.');
  }
  const rawPath = args.webhookPath != null ? String(args.webhookPath).trim() : '/webhook/latticedx/v1/enterprise-compliance-orchestrator';
  if (/^\/\//.test(rawPath) || /\\/.test(rawPath) || /[\u0000-\u001f\u007f]/.test(rawPath)) {
    throw failTool('CONNECTOR_URL_OVERRIDE_FORBIDDEN', 400, 'webhookPath không hợp lệ.');
  }
  const connectorKey = await resolveTargetConnector(db, actor.organizationId, args.connectorKey, failTool);
  const vaultApi = ctx?.app?.latticeVault || getVaultMod();
  const intMod = getIntMod();
  const secMod = getSecMod();
  if (!vaultApi?.resolveConnectorSecrets) {
    throw failTool('VAULT_UNAVAILABLE', 503, 'Connector Vault module unavailable.');
  }
  const env = deps.env || process.env;
  const { connector, secrets } = await vaultApi.resolveConnectorSecrets(db, actor.organizationId, connectorKey, { env });
  if (connector.connectorType === 'mqtt' || connector.connectorType === 'smtp_notify') {
    throw failTool('CONNECTOR_PROTOCOL_UNSUPPORTED', 400, `Connector "${connectorKey}" (${connector.connectorType}) không hỗ trợ HTTP webhook.`);
  }
  const targetUrl = intMod?.buildConnectorUrl
    ? intMod.buildConnectorUrl(connector.baseUrl, rawPath)
    : (() => {
        const b = new URL(String(connector.baseUrl));
        const cand = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(rawPath) ? rawPath : `${b.origin}${rawPath.startsWith('/') ? rawPath : `/${rawPath}`}`;
        const u = new URL(cand);
        if (u.origin !== b.origin) throw failTool('CONNECTOR_URL_OVERRIDE_FORBIDDEN', 400, 'Origin override forbidden.');
        return u.toString();
      })();
  const fetchFn = deps.fetchImpl || globalThis.fetch;
  const isMockFetch = typeof deps.fetchImpl === 'function' && deps.fetchImpl !== globalThis.fetch;
  const ssrfOpts = { connectorType: connector.connectorType || 'n8n', env, ...(typeof deps.lookupImpl === 'function' ? { lookupImpl: deps.lookupImpl } : {}), skipDnsCheck: isMockFetch && typeof deps.lookupImpl !== 'function' };
  if (typeof vaultApi.assertSafeConnectorUrl === 'function') vaultApi.assertSafeConnectorUrl(targetUrl, ssrfOpts);
  if (typeof vaultApi.assertSafeConnectorUrlAsync === 'function') await vaultApi.assertSafeConnectorUrlAsync(targetUrl, ssrfOpts);

  const safePathUrl = scrubUrlForOutput(targetUrl);
  if (args.dryRun === true) {
    return { operation: 'invokeN8n', dryRun: true, organizationId: actor.organizationId, connectorKey, method: 'POST', url: safePathUrl, authType: connector.authType };
  }
  if (typeof fetchFn !== 'function') throw failTool('FETCH_UNAVAILABLE', 503, 'fetch implementation unavailable');

  const bodyObj = sanitizeAutomationValue({ ...(args.payload && typeof args.payload === 'object' && !Array.isArray(args.payload) ? args.payload : {}), organizationId: actor.organizationId });
  const bodyStr = JSON.stringify(bodyObj);
  const authHeaders = typeof vaultApi.buildConnectorAuthHeaders === 'function'
    ? vaultApi.buildConnectorAuthHeaders(connector.authType, secrets)
    : (intMod?.buildFallbackAuthHeaders?.(connector.authType, secrets) || {});
  const hmacHeaders = connector.authType === 'hmac' && typeof intMod?.buildHmacHeaders === 'function'
    ? intMod.buildHmacHeaders(bodyStr, secrets)
    : {};
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json', ...authHeaders, ...hmacHeaders };
  const t0 = Date.now();
  const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(15000) : undefined;
  let response;
  try {
    response = await fetchFn(targetUrl, { method: 'POST', headers, body: bodyStr, redirect: 'error', ...(signal ? { signal } : {}) });
  } catch (err) {
    const msg = typeof intMod?.scrubSecrets === 'function' ? intMod.scrubSecrets(err?.message || 'n8n call failed', secrets) : 'n8n call failed';
    throw failTool('CONNECTOR_HTTP_FAILED', 502, msg);
  }
  const txt = typeof response?.text === 'function' ? await response.text().catch(() => '') : '';
  let parsed = null;
  if (txt.trim()) { try { parsed = JSON.parse(txt); } catch { parsed = txt; } }
  else if (typeof response?.json === 'function') parsed = await response.json().catch(() => null);
  const cleanBody = typeof secMod?.scrubAndCapHttpBody === 'function' ? secMod.scrubAndCapHttpBody(parsed, secrets) : parsed;
  if (!response?.ok) {
    throw failTool('CONNECTOR_HTTP_ERROR', 502, `Connector ${connectorKey} responded with HTTP ${response?.status}`);
  }
  return { operation: 'invokeN8n', ok: true, organizationId: actor.organizationId, connectorKey, url: safePathUrl, status: response.status, durationMs: Math.max(0, Date.now() - t0), response: cleanBody };
}

async function resolveOrgN8nApiClient(ctx, db, actor, args, deps) {
  const { val, failTool } = deps;
  if (deps.n8nClient && typeof deps.n8nClient === 'object') {
    return { client: deps.n8nClient, connectorKey: args.n8nConnectorKey || args.connectorKey || 'injected-n8n' };
  }
  const n8nApiMod = getN8nApiClientMod();
  if (!n8nApiMod || typeof n8nApiMod.createN8nApiClient !== 'function') {
    throw failTool('N8N_API_CLIENT_UNAVAILABLE', 503, 'Module n8n-api-client chưa sẵn sàng.');
  }
  const vaultMod = ctx?.app?.latticeVault || getVaultMod();
  const env = deps.env || process.env;
  const repo = db?.getRepository?.('latticeConnectors');
  let connectorKey = sanitizeKey(args.n8nConnectorKey || args.connectorKey);
  let baseUrl = '';
  let apiKey = '';

  if (args.n8nConnectorKey && !connectorKey) {
    throw failTool('CONNECTOR_KEY_INVALID', 400, 'n8nConnectorKey không hợp lệ.');
  }

  if (repo && typeof repo.find === 'function') {
    const rows = (await withOptionalTenantRls(db, actor.organizationId, (transaction) => (
      repo.find({ filter: { organizationId: actor.organizationId, active: true }, sort: ['id'], limit: 100, ...(transaction ? { transaction } : {}) })
    ))) || [];
    const n8nRows = rows.filter((r) => {
      if (val(r, 'organizationId') !== actor.organizationId) return false;
      const cType = String(val(r, 'connectorType') || '').toLowerCase();
      const aType = String(val(r, 'appType') || '').toLowerCase();
      return cType === 'n8n' || cType === 'n8n_api' || aType === 'n8n_api';
    });
    const picked = connectorKey
      ? n8nRows.find((r) => String(val(r, 'connectorKey') || '').toLowerCase() === connectorKey)
      : (n8nRows.find((r) => String(val(r, 'appType') || '').toLowerCase() === 'n8n_api') || n8nRows[0]);
    if (connectorKey && !picked) {
      throw failTool('CONNECTOR_NOT_FOUND', 404, `Không tìm thấy connector n8n "${connectorKey}" trong phạm vi tổ chức.`);
    }
    if (picked && typeof vaultMod?.resolveConnectorSecrets === 'function') {
      const resolved = await vaultMod.resolveConnectorSecrets(db, actor.organizationId, val(picked, 'connectorKey'), { env });
      baseUrl = resolved.connector.baseUrl || '';
      apiKey = String(resolved.secrets.apiKey || resolved.secrets.token || resolved.secrets.key || '').trim();
      connectorKey = resolved.connector.connectorKey;
    }
  }

  if (!baseUrl && env?.DX_N8N_API_URL) baseUrl = String(env.DX_N8N_API_URL).trim();
  if (!apiKey && env?.DX_N8N_API_KEY) apiKey = String(env.DX_N8N_API_KEY).trim();
  if (!baseUrl) {
    throw failTool('N8N_CONNECTOR_NOT_CONFIGURED', 404, 'Chưa cấu hình connector n8n API cho tổ chức.');
  }

  const allowInternal = vaultMod?.resolveAllowInternalConnectorHosts?.({ isRoot: Boolean(actor?.isRoot || actor?.isAdmin), env }) ?? true;
  const client = n8nApiMod.createN8nApiClient({
    baseUrl,
    apiKey,
    fetchFn: deps.fetchImpl || globalThis.fetch,
    env,
    lookupImpl: deps.lookupImpl,
    allowInternal,
    connectorVault: vaultMod,
  });
  return { client, connectorKey: connectorKey || null };
}

function shouldPreferDxosN8nResource(ctx, deps) {
  const hasMockTransport = Boolean(deps?.n8nClient || (typeof deps?.fetchImpl === 'function' && deps.fetchImpl !== globalThis.fetch));
  if (hasMockTransport) return false;
  return Boolean(deps?.hasRes?.(ctx, 'dxosN8n'));
}

async function runListN8nWorkflows(ctx, db, actor, args, deps) {
  if (shouldPreferDxosN8nResource(ctx, deps)) {
    const res = await deps.invokeResourceAction(ctx, 'dxosN8n', 'workflows', {
      method: 'GET',
      organizationId: actor.organizationId,
      ...(args.connectorKey ? { connectorKey: args.connectorKey } : {}),
      ...(args.active !== undefined ? { active: args.active } : {}),
      ...(args.tags ? { tags: args.tags } : {}),
      ...(args.name || args.title ? { name: args.name || args.title } : {}),
      ...(args.limit ? { limit: args.limit } : {}),
      ...(args.cursor ? { cursor: args.cursor } : {}),
    });
    return { operation: 'list_n8n_workflows', organizationId: actor.organizationId, ...(res || {}) };
  }
  const { client, connectorKey } = await resolveOrgN8nApiClient(ctx, db, actor, args, deps);
  const res = await client.listWorkflows({
    active: args.active,
    tags: args.tags,
    name: args.name || args.title,
    limit: args.limit,
    cursor: args.cursor,
  });
  return { operation: 'list_n8n_workflows', organizationId: actor.organizationId, connectorKey, ...(res || {}) };
}

async function runCreateN8nWorkflow(ctx, db, actor, args, deps) {
  const { failTool, hasForbiddenProtoKeys, sanitizeAutomationValue } = deps;
  const rawWorkflow = args.workflow && typeof args.workflow === 'object' ? args.workflow : args.payload;
  if (!rawWorkflow || typeof rawWorkflow !== 'object' || Array.isArray(rawWorkflow)) {
    throw failTool('N8N_WORKFLOW_INVALID', 400, 'Cần đối tượng workflow (workflow/payload) để tạo workflow trên n8n.');
  }
  if (hasForbiddenProtoKeys?.(rawWorkflow)) {
    throw failTool('AUTOMATION_AI_REFUSED', 400, 'Workflow payload chứa khóa prototype bị cấm.');
  }
  const cleanWorkflow = typeof sanitizeAutomationValue === 'function' ? sanitizeAutomationValue(rawWorkflow) : rawWorkflow;
  if (args.dryRun === true) {
    return { operation: 'create_n8n_workflow', dryRun: true, organizationId: actor.organizationId, workflow: cleanWorkflow };
  }
  if (shouldPreferDxosN8nResource(ctx, deps)) {
    const res = await deps.invokeResourceAction(ctx, 'dxosN8n', 'createWorkflow', {
      method: 'POST',
      organizationId: actor.organizationId,
      ...(args.connectorKey ? { connectorKey: args.connectorKey } : {}),
      workflow: cleanWorkflow,
      ...(args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : {}),
      values: { organizationId: actor.organizationId, workflow: cleanWorkflow },
    });
    return { operation: 'create_n8n_workflow', organizationId: actor.organizationId, ...(res || {}) };
  }
  const { client, connectorKey } = await resolveOrgN8nApiClient(ctx, db, actor, args, deps);
  const res = await client.createWorkflow(cleanWorkflow, { idempotencyKey: args.idempotencyKey });
  return { operation: 'create_n8n_workflow', organizationId: actor.organizationId, connectorKey, ...(res || {}) };
}

async function runUpdateN8nWorkflow(ctx, db, actor, args, deps) {
  const { failTool, hasForbiddenProtoKeys, sanitizeAutomationValue } = deps;
  const workflowId = String(args.workflowId ?? args.workflow?.id ?? '').trim();
  if (!workflowId) throw failTool('N8N_WORKFLOW_ID_REQUIRED', 400, 'Cần workflowId để cập nhật workflow trên n8n.');
  const rawWorkflow = args.workflow && typeof args.workflow === 'object' ? args.workflow : args.payload;
  if (!rawWorkflow || typeof rawWorkflow !== 'object' || Array.isArray(rawWorkflow)) {
    throw failTool('N8N_WORKFLOW_INVALID', 400, 'Cần đối tượng workflow (workflow/payload) để cập nhật trên n8n.');
  }
  if (hasForbiddenProtoKeys?.(rawWorkflow)) {
    throw failTool('AUTOMATION_AI_REFUSED', 400, 'Workflow payload chứa khóa prototype bị cấm.');
  }
  const cleanWorkflow = typeof sanitizeAutomationValue === 'function' ? sanitizeAutomationValue(rawWorkflow) : rawWorkflow;
  if (args.dryRun === true) {
    return { operation: 'update_n8n_workflow', dryRun: true, organizationId: actor.organizationId, workflowId, workflow: cleanWorkflow };
  }
  if (shouldPreferDxosN8nResource(ctx, deps)) {
    const res = await deps.invokeResourceAction(ctx, 'dxosN8n', 'updateWorkflow', {
      method: 'POST',
      organizationId: actor.organizationId,
      workflowId,
      ...(args.connectorKey ? { connectorKey: args.connectorKey } : {}),
      workflow: cleanWorkflow,
      ...(args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : {}),
      values: { organizationId: actor.organizationId, workflowId, workflow: cleanWorkflow },
    });
    return { operation: 'update_n8n_workflow', organizationId: actor.organizationId, ...(res || {}) };
  }
  const { client, connectorKey } = await resolveOrgN8nApiClient(ctx, db, actor, args, deps);
  const res = await client.updateWorkflow(workflowId, cleanWorkflow, { idempotencyKey: args.idempotencyKey });
  return { operation: 'update_n8n_workflow', organizationId: actor.organizationId, connectorKey, ...(res || {}) };
}

async function runActivateN8nWorkflow(ctx, db, actor, args, deps) {
  const { failTool } = deps;
  const workflowId = String(args.workflowId ?? '').trim();
  if (!workflowId) throw failTool('N8N_WORKFLOW_ID_REQUIRED', 400, 'Cần workflowId để bật/tắt workflow trên n8n.');
  const active = args.active === undefined ? true : Boolean(args.active);
  if (args.dryRun === true) {
    return { operation: 'activate_n8n_workflow', dryRun: true, organizationId: actor.organizationId, workflowId, active };
  }
  if (shouldPreferDxosN8nResource(ctx, deps)) {
    const res = await deps.invokeResourceAction(ctx, 'dxosN8n', 'activateWorkflow', {
      method: 'POST',
      organizationId: actor.organizationId,
      workflowId,
      active,
      ...(args.connectorKey ? { connectorKey: args.connectorKey } : {}),
      ...(args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : {}),
      values: { organizationId: actor.organizationId, workflowId, active },
    });
    return { operation: 'activate_n8n_workflow', organizationId: actor.organizationId, ...(res || {}) };
  }
  const { client, connectorKey } = await resolveOrgN8nApiClient(ctx, db, actor, args, deps);
  const res = await client.activateWorkflow(workflowId, active, { idempotencyKey: args.idempotencyKey });
  return { operation: 'activate_n8n_workflow', organizationId: actor.organizationId, connectorKey, ...(res || {}) };
}

async function runListN8nExecutions(ctx, db, actor, args, deps) {
  if (shouldPreferDxosN8nResource(ctx, deps)) {
    const res = await deps.invokeResourceAction(ctx, 'dxosN8n', 'executions', {
      method: 'GET',
      organizationId: actor.organizationId,
      ...(args.workflowId != null ? { workflowId: String(args.workflowId) } : {}),
      ...(args.status ? { status: args.status } : {}),
      ...(args.includeData !== undefined ? { includeData: Boolean(args.includeData) } : {}),
      ...(args.limit ? { limit: args.limit } : {}),
      ...(args.cursor ? { cursor: args.cursor } : {}),
    });
    return { operation: 'list_n8n_executions', organizationId: actor.organizationId, ...(res || {}) };
  }
  const { client, connectorKey } = await resolveOrgN8nApiClient(ctx, db, actor, args, deps);
  const res = await client.listExecutions({
    workflowId: args.workflowId,
    status: args.status,
    includeData: Boolean(args.includeData),
    limit: args.limit,
    cursor: args.cursor,
  });
  return { operation: 'list_n8n_executions', organizationId: actor.organizationId, connectorKey, ...(res || {}) };
}

async function runRetryN8nExecution(ctx, db, actor, args, deps) {
  const { failTool } = deps;
  const executionId = String(args.executionId ?? '').trim();
  if (!executionId) throw failTool('N8N_EXECUTION_ID_REQUIRED', 400, 'Cần executionId để chạy lại execution trên n8n.');
  if (args.dryRun === true) {
    return { operation: 'retry_n8n_execution', dryRun: true, organizationId: actor.organizationId, executionId };
  }
  if (shouldPreferDxosN8nResource(ctx, deps)) {
    const res = await deps.invokeResourceAction(ctx, 'dxosN8n', 'retryExecution', {
      method: 'POST',
      organizationId: actor.organizationId,
      executionId,
      ...(args.connectorKey ? { connectorKey: args.connectorKey } : {}),
      ...(args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : {}),
      values: { organizationId: actor.organizationId, executionId },
    });
    return { operation: 'retry_n8n_execution', organizationId: actor.organizationId, ...(res || {}) };
  }
  const { client, connectorKey } = await resolveOrgN8nApiClient(ctx, db, actor, args, deps);
  const res = await client.retryExecution(executionId, { loadWorkflow: true, idempotencyKey: args.idempotencyKey });
  return { operation: 'retry_n8n_execution', organizationId: actor.organizationId, connectorKey, ...(res || {}) };
}

async function runSyncN8nCredential(ctx, db, actor, args, deps) {
  const { failTool } = deps;
  const targetKey = sanitizeKey(args.connectorKey);
  if (!targetKey) throw failTool('CONNECTOR_KEY_INVALID', 400, 'Cần connectorKey hợp lệ để đồng bộ credential sang n8n.');
  if (args.dryRun === true) {
    return { operation: 'sync_n8n_credential', dryRun: true, organizationId: actor.organizationId, connectorKey: targetKey };
  }
  if (shouldPreferDxosN8nResource(ctx, deps)) {
    const res = await deps.invokeResourceAction(ctx, 'dxosN8n', 'syncCredential', {
      method: 'POST',
      organizationId: actor.organizationId,
      connectorKey: targetKey,
      ...(args.n8nConnectorKey ? { n8nConnectorKey: args.n8nConnectorKey } : {}),
      ...(args.n8nCredentialType ? { n8nCredentialType: args.n8nCredentialType } : {}),
      ...(args.credentialName ? { credentialName: args.credentialName } : {}),
      ...(args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : {}),
      values: {
        organizationId: actor.organizationId,
        connectorKey: targetKey,
        ...(args.n8nConnectorKey ? { n8nConnectorKey: args.n8nConnectorKey } : {}),
        ...(args.n8nCredentialType ? { n8nCredentialType: args.n8nCredentialType } : {}),
        ...(args.credentialName ? { credentialName: args.credentialName } : {}),
      },
    });
    return { operation: 'sync_n8n_credential', organizationId: actor.organizationId, ...(res || {}) };
  }

  const vaultMod = ctx?.app?.latticeVault || getVaultMod();
  if (typeof vaultMod?.resolveConnectorSecrets !== 'function') {
    throw failTool('VAULT_UNAVAILABLE', 503, 'Connector Vault module unavailable.');
  }
  const env = deps.env || process.env;
  const { connector, secrets } = await vaultMod.resolveConnectorSecrets(db, actor.organizationId, targetKey, { env });
  let accessToken = null;
  if (connector.authType === 'oauth2' && typeof vaultMod?.getFreshConnectorToken === 'function') {
    const fresh = await vaultMod.getFreshConnectorToken(db, connector.id ?? connector.connectorKey, {
      organizationId: actor.organizationId,
      env,
      fetchImpl: deps.fetchImpl,
      lookupImpl: deps.lookupImpl,
    });
    accessToken = fresh.accessToken;
  }

  const { client } = await resolveOrgN8nApiClient(ctx, db, actor, { n8nConnectorKey: args.n8nConnectorKey }, deps);
  const syncResult = await client.syncConnectorCredentialToN8n({
    connector,
    secrets,
    accessToken,
    n8nCredentialType: args.n8nCredentialType,
    credentialName: args.credentialName,
    idempotencyKey: args.idempotencyKey,
  });

  const repo = db?.getRepository?.('latticeConnectors');
  if (syncResult.n8nCredentialId && repo) {
    const pgRls = getPgRlsMod();
    const persistCredId = async (transaction) => {
      const txOpt = transaction ? { transaction } : {};
      await repo.update({
        filterByTk: connector.id,
        filter: { organizationId: actor.organizationId },
        values: { n8nCredentialId: syncResult.n8nCredentialId },
        ...txOpt,
      });
    };
    if (typeof pgRls?.canUsePgRlsSession === 'function' && pgRls.canUsePgRlsSession(db)) {
      await pgRls.withTenantRlsContext(db, actor.organizationId, persistCredId);
    } else {
      await persistCredId(undefined);
    }
  }
  return { operation: 'sync_n8n_credential', organizationId: actor.organizationId, ...syncResult };
}

async function runListConnectedApps(ctx, db, actor, _args, deps) {
  const { val, failTool } = deps;
  if (shouldPreferDxosN8nResource(ctx, deps)) {
    const res = await deps.invokeResourceAction(ctx, 'dxosN8n', 'appCatalog', {
      method: 'GET',
      organizationId: actor.organizationId,
    });
    return { operation: 'list_connected_apps', organizationId: actor.organizationId, ...(res || {}) };
  }
  const vaultMod = ctx?.app?.latticeVault || getVaultMod();
  const catalog = Array.isArray(vaultMod?.APP_CONNECTOR_CATALOG) ? vaultMod.APP_CONNECTOR_CATALOG : [];
  if (!catalog.length) {
    throw failTool('VAULT_UNAVAILABLE', 503, 'App connector catalog unavailable.');
  }
  const repo = db?.getRepository?.('latticeConnectors');
  const rows = repo && typeof repo.find === 'function'
    ? (await repo.find({ filter: { organizationId: actor.organizationId }, sort: ['id'], limit: 200 })) || []
    : [];
  const configuredMap = new Map();
  for (const r of rows) {
    if (val(r, 'organizationId') !== actor.organizationId) continue;
    const appType = String(val(r, 'appType') || '').trim().toLowerCase();
    if (!appType) continue;
    const list = configuredMap.get(appType) || [];
    list.push(String(val(r, 'connectorKey') || ''));
    configuredMap.set(appType, list);
  }
  return {
    operation: 'list_connected_apps',
    organizationId: actor.organizationId,
    items: catalog.map((item) => {
      const keys = configuredMap.get(item.appType) || [];
      return {
        appType: item.appType,
        name: item.name,
        category: item.category,
        connectorType: item.connectorType,
        defaultAuthType: item.defaultAuthType,
        capabilities: item.capabilities,
        n8nCredentialType: item.n8nCredentialType,
        configuredCount: keys.length,
        connectorKeys: keys,
      };
    }),
  };
}

module.exports = {
  loadCrossPluginModule: loadCrossModule,
  runListConnectors,
  runTestConnector,
  runInvokeN8n,
  runListN8nWorkflows,
  runCreateN8nWorkflow,
  runUpdateN8nWorkflow,
  runActivateN8nWorkflow,
  runListN8nExecutions,
  runRetryN8nExecution,
  runSyncN8nCredential,
  runListConnectedApps,
};
