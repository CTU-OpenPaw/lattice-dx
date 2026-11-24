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
const getIntMod = () => loadCrossModule('@latticedx/plugin-dxos-studio', 'plugin-dxos-studio', 'flow/nodes/integrations');
const getSecMod = () => loadCrossModule('@latticedx/plugin-dxos-studio', 'plugin-dxos-studio', 'flow/security-helpers');

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
    const rows = (await repo.find({ filter: { organizationId, active: true }, sort: ['id'], limit: 50 })) || [];
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
  const rows = (await repo.find({ filter: { organizationId: actor.organizationId }, sort: ['id'], limit: 100 })) || [];
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

module.exports = { runListConnectors, runTestConnector, runInvokeN8n };
