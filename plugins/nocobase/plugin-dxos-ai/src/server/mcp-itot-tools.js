/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { existsSync } = require('node:fs');
const { createAuditedTool, resolveActorScope, failTool, val } = require('./ai-tools-core');
const { validateMcpServerUrl } = require('./ai-schemas');

const DEFAULT_TIMEOUT_MS = 5000;
const DISPATCH_ALLOWED_ROLES = new Set(['root', 'admin', 'ldx_admin', 'ldx_manager', 'ldx_dispatcher']);
const WEBHOOK_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,60}$/;

async function safeCount(db, name, filter = {}) {
  if (!db?.getRepository) return 0;
  if (typeof db.hasCollection === 'function' && !db.hasCollection(name)) return 0;
  const repo = db.getRepository(name);
  if (!repo || typeof repo.count !== 'function') return 0;
  try {
    return await repo.count({ filter });
  } catch {
    return 0;
  }
}

async function probeService(url, fetchImpl) {
  const fn = fetchImpl || globalThis.fetch;
  if (typeof fn !== 'function') return { reachable: false, status: 0, reason: 'fetch unavailable' };
  try {
    validateMcpServerUrl(url);
    const res = await fn(url, { method: 'GET', signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS) });
    return { reachable: Boolean(res?.ok), status: Number(res?.status || 0), reason: res?.ok ? 'ok' : `HTTP ${res?.status}` };
  } catch (err) {
    return { reachable: false, status: 0, reason: err?.message || 'unreachable' };
  }
}

function resolveServiceUrls(env = process.env) {
  const defaultHost = existsSync('/.dockerenv') ? 'http://host.docker.internal' : 'http://127.0.0.1';
  return {
    orionUrl: String(env.ORION_LD_URL || `${defaultHost}:1026`).replace(/\/+$/, ''),
    n8nUrl: String(env.N8N_URL || `${defaultHost}:5678`).replace(/\/+$/, ''),
    n8nWebhookBase: String(env.N8N_WEBHOOK_BASE_URL || `${defaultHost}:5678/webhook`).replace(/\/+$/, ''),
    keycloakUrl: String(env.KEYCLOAK_URL || `${defaultHost}:8081`).replace(/\/+$/, ''),
  };
}

function createItOtMcpTools(dbArg, env = process.env, fetchImpl = globalThis.fetch) {
  const urls = resolveServiceUrls(env);

  return [
    createAuditedTool({
      name: 'get_live_ngsi_telemetry',
      adminOnly: false,
      defaultPermission: 'ALLOW',
      introduction: { title: 'Đọc Telemetry NGSI-LD Trực tiếp', about: 'Truy vấn FIWARE Orion-LD và Outbox theo tổ chức với fallback an toàn.' },
      description: 'Fetch live Asset/Shipment NGSI-LD telemetry from FIWARE Orion-LD scoped strictly to caller organizationId, degrading gracefully if Orion-LD is offline.',
      schema: {
        description: 'Optional asset filter.',
        properties: { assetCode: { type: 'string', maxLength: 80 } },
      },
      async run(ctx, db, actor, args) {
        const activeDb = db || dbArg;
        ctx.state = { ...ctx.state, dxosAuditChannel: ctx.state?.dxosAuditChannel || 'mcp-itot' };
        const assetsRepo = activeDb?.getRepository?.('latticeAssets');
        const outboxRepo = activeDb?.getRepository?.('latticeContextOutbox');
        const cachedAssets = assetsRepo ? (await assetsRepo.find({ filter: { organizationId: actor.organizationId }, limit: 30 })) || [] : [];
        const assetIds = new Set(cachedAssets.map((a) => val(a, 'entityId')).filter(Boolean));
        const pendingOutboxCount = outboxRepo ? await safeCount(activeDb, 'latticeContextOutbox', { organizationId: actor.organizationId, status: 'pending' }) : 0;

        try {
          validateMcpServerUrl(urls.orionUrl);
          const headers = { Accept: 'application/ld+json, application/json' };
          if (env.NGSILD_TENANT) headers['NGSILD-Tenant'] = String(env.NGSILD_TENANT);
          const res = await fetchImpl(`${urls.orionUrl}/ngsi-ld/v1/entities?limit=50`, { headers, signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS) });
          if (!res?.ok) throw new Error(`Orion-LD HTTP ${res?.status}`);
          const entities = await res.json();
          const orgMarker = `:${actor.organizationId}:`;
          const liveEntities = (Array.isArray(entities) ? entities : []).filter((e) => {
            const eid = String(e?.id || '');
            const matchesOrg = assetIds.has(eid) || eid.includes(orgMarker);
            const matchesCode = !args.assetCode || eid.includes(args.assetCode);
            return matchesOrg && matchesCode;
          });
          return {
            degraded: false,
            service: 'orion-ld',
            organizationId: actor.organizationId,
            pendingOutboxCount,
            liveEntities,
            cachedAssets: cachedAssets.map((a) => ({ code: val(a, 'code'), name: val(a, 'name'), entityId: val(a, 'entityId') })),
          };
        } catch (err) {
          return {
            degraded: true,
            service: 'orion-ld',
            reason: err?.message || 'Orion-LD unavailable',
            organizationId: actor.organizationId,
            pendingOutboxCount,
            liveEntities: [],
            cachedAssets: cachedAssets.map((a) => ({ code: val(a, 'code'), name: val(a, 'name'), entityId: val(a, 'entityId') })),
          };
        }
      },
    }),

    createAuditedTool({
      name: 'get_sensor_and_incident_timeline',
      adminOnly: false,
      defaultPermission: 'ALLOW',
      introduction: { title: 'Chuỗi Lịch sử Sự cố & Đề xuất AI', about: 'Đọc các ca sự cố IoT và đề xuất AI có bằng chứng của tổ chức.' },
      description: 'Retrieve chronological incident cases and AI evidence proposals scoped to caller organizationId.',
      schema: {
        description: 'Timeline query parameters.',
        properties: {
          assetEntityId: { type: 'string', maxLength: 140 },
          limit: { type: 'integer', default: 10 },
        },
      },
      async run(ctx, db, actor, args) {
        const activeDb = db || dbArg;
        ctx.state = { ...ctx.state, dxosAuditChannel: ctx.state?.dxosAuditChannel || 'mcp-itot' };
        const limit = Math.max(1, Math.min(25, Number(args.limit) || 10));
        const casesRepo = activeDb?.getRepository?.('latticeIncidentCases');
        const propRepo = activeDb?.getRepository?.('latticeAgentProposals');
        const filter = { organizationId: actor.organizationId, ...(args.assetEntityId ? { assetEntityId: args.assetEntityId } : {}) };
        const cases = casesRepo ? (await casesRepo.find({ filter, limit, sort: ['-id'] })) || [] : [];
        const proposals = propRepo ? (await propRepo.find({ filter: { organizationId: actor.organizationId }, limit, sort: ['-id'] })) || [] : [];
        return {
          organizationId: actor.organizationId,
          incidents: cases.map((c) => ({ id: val(c, 'id'), code: val(c, 'code'), name: val(c, 'name'), severity: val(c, 'severity'), status: val(c, 'status'), assetEntityId: val(c, 'assetEntityId') })),
          proposals: proposals.map((p) => ({ id: val(p, 'id'), code: val(p, 'code'), state: val(p, 'state'), targetCollection: val(p, 'targetCollection') })),
        };
      },
    }),

    createAuditedTool({
      name: 'get_stack_connector_health',
      adminOnly: false,
      defaultPermission: 'ALLOW',
      introduction: { title: 'Kiểm tra Sức khỏe Kết nối Stack', about: 'Kiểm tra live Orion-LD, n8n, Keycloak và database doanh nghiệp.' },
      description: 'Check live health of LatticeDX enterprise connectors (FIWARE Orion-LD, n8n, Keycloak, and NocoBase DB) with 5s timeouts.',
      schema: { description: 'Health check trigger.', properties: {} },
      async run(ctx, db) {
        ctx.state = { ...ctx.state, dxosAuditChannel: ctx.state?.dxosAuditChannel || 'mcp-itot' };
        const activeDb = db || dbArg;
        const [orion, n8n, keycloak] = await Promise.all([
          probeService(`${urls.orionUrl}/version`, fetchImpl),
          probeService(`${urls.n8nUrl}/healthz`, fetchImpl),
          probeService(`${urls.keycloakUrl}/realms/lattice`, fetchImpl),
        ]);
        const workflowCount = await safeCount(activeDb, 'workflows', { current: true });
        return {
          checkedAt: new Date().toISOString(),
          connectors: {
            orionLd: orion,
            n8n,
            keycloak,
            database: { reachable: Boolean(activeDb), workflowCount },
          },
        };
      },
    }),

    createAuditedTool({
      name: 'dispatch_itot_webhook_or_sync',
      adminOnly: false,
      defaultPermission: 'ASK',
      introduction: { title: 'Đẩy Đồng bộ Outbox / Webhook n8n', about: 'Thực thi có kiểm soát sang outbox NGSI-LD hoặc webhook n8n được phép.' },
      description: 'Queue NGSI-LD outbox replay or trigger an allowlisted n8n webhook with idempotency key (Manager/Dispatcher/Admin only).',
      schema: {
        description: 'IT/OT dispatch action.',
        properties: {
          mode: { type: 'string', required: true, enum: ['requeue_outbox', 'trigger_n8n'] },
          entityId: { type: 'string', maxLength: 140 },
          webhookSlug: { type: 'string', maxLength: 60 },
          reason: { type: 'string', required: true, maxLength: 300 },
          idempotencyKey: { type: 'string', maxLength: 80 },
        },
      },
      async run(ctx, db, actor, args) {
        ctx.state = { ...ctx.state, dxosAuditChannel: ctx.state?.dxosAuditChannel || 'mcp-itot' };
        const activeDb = db || dbArg;
        const allowed = actor.isAdmin || actor.roleNames.some((r) => DISPATCH_ALLOWED_ROLES.has(r));
        if (!allowed) {
          throw failTool('ITOT_DISPATCH_FORBIDDEN', 403, 'Chỉ Quản lý, Điều phối hoặc Admin mới được kích hoạt đồng bộ IT/OT.');
        }
        const key = args.idempotencyKey || `mcp-${Date.now().toString(36)}`;
        if (args.mode === 'requeue_outbox') {
          const outboxRepo = activeDb?.getRepository?.('latticeContextOutbox');
          if (!outboxRepo) return { queued: false, reason: 'latticeContextOutbox unavailable' };
          const row = await outboxRepo.create({
            values: {
              organizationId: actor.organizationId,
              entityType: 'Asset',
              entityId: args.entityId || `urn:ngsi-ld:Asset:${actor.organizationId}:sync`,
              status: 'pending',
              payload: { reason: args.reason, idempotencyKey: key, requestedBy: actor.username },
            },
          });
          return { queued: true, mode: 'requeue_outbox', id: val(row, 'id'), idempotencyKey: key };
        }
        const slug = String(args.webhookSlug || 'dxos-itot-event').trim();
        if (!WEBHOOK_SLUG_RE.test(slug)) throw failTool('WEBHOOK_SLUG_INVALID', 400, 'Slug webhook n8n không hợp lệ.');
        const targetUrl = validateMcpServerUrl(`${urls.n8nWebhookBase}/${slug}`);
        try {
          const res = await fetchImpl(targetUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
            body: JSON.stringify({ organizationId: actor.organizationId, entityId: args.entityId || null, reason: args.reason, actor: actor.username }),
            signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
          });
          return { degraded: !res?.ok, service: 'n8n', status: Number(res?.status || 0), webhookSlug: slug, idempotencyKey: key };
        } catch (err) {
          return { degraded: true, service: 'n8n', reason: err?.message || 'n8n unreachable', webhookSlug: slug, idempotencyKey: key };
        }
      },
    }),
  ];
}

async function buildEnterpriseTopology(db, env = process.env, fetchImpl = globalThis.fetch) {
  const urls = resolveServiceUrls(env);
  const [orion, n8n, keycloak, rolesCount, assetsCount, outboxPending, workflowsCount, portalsCount, paraCount, profilesCount, auditCount, collectionsCount] = await Promise.all([
    probeService(`${urls.orionUrl}/version`, fetchImpl),
    probeService(`${urls.n8nUrl}/healthz`, fetchImpl),
    probeService(`${urls.keycloakUrl}/realms/lattice`, fetchImpl),
    safeCount(db, 'roles', {}),
    safeCount(db, 'latticeAssets', {}),
    safeCount(db, 'latticeContextOutbox', { status: 'pending' }),
    safeCount(db, 'workflows', { current: true }),
    safeCount(db, 'uiLayouts', {}),
    safeCount(db, 'latticeParaDocuments', {}),
    safeCount(db, 'latticeAiProfiles', { enabled: true }),
    safeCount(db, 'latticeAiAuditLogs', {}),
    safeCount(db, 'collections', {}),
  ]);

  return {
    platform: 'LatticeDX Enterprise Digital OS (DX-OS)',
    generatedAt: new Date().toISOString(),
    positioningStatement: 'NocoBase 2.2.38 đóng vai trò phân hệ dữ liệu & metadata ứng dụng (Plane #6) bên dưới kiến trúc điều phối 6 phân hệ của LatticeDX.',
    clause52Preserved: true,
    planes: [
      {
        key: 'identitySecurity',
        order: 1,
        name: 'Identity, Gateway & Security Guardrails',
        technologies: ['Keycloak OIDC + PKCE', 'APISIX', 'ClamAV TCP', '7-Role RBAC (ldx_*)'],
        healthy: keycloak.reachable || rolesCount > 0,
        liveProbe: keycloak,
        metrics: { rolesCount },
      },
      {
        key: 'itOtDigitalTwin',
        order: 2,
        name: 'IT/OT Digital Twin & Context Broker',
        technologies: ['FIWARE Orion-LD', 'MongoDB', 'NGSI-LD Outbox', 'Sensor Rules'],
        healthy: orion.reachable,
        liveProbe: orion,
        metrics: { assetsCount, outboxPending },
      },
      {
        key: 'integrationEventBus',
        order: 3,
        name: 'Integration & Automation Event Bus',
        technologies: ['n8n Event Workflows', 'Idempotent Receipts', 'Webhook Ingress/Egress'],
        healthy: n8n.reachable || workflowsCount > 0,
        liveProbe: n8n,
        metrics: { activeWorkflowsCount: workflowsCount },
      },
      {
        key: 'knowledgeAndPortals',
        order: 4,
        name: 'Multi-Portal Workspaces & P.A.R.A. Knowledge Vault',
        technologies: ['Role Portals (/p/*)', 'P.A.R.A. Documents', '5-Step Poka-yoke Flows'],
        healthy: true,
        metrics: { layoutCount: portalsCount, paraDocumentsCount: paraCount },
      },
      {
        key: 'aiWorkforceAndMcp',
        order: 5,
        name: 'Admin-Configurable AI Workforce & 2-Way Streamable MCP',
        technologies: ['latticeAiProfiles', 'Admin System Builder', '/api/dxos-mcp', '/api/dxos-mcp/it-ot', 'latticeAiAuditLogs'],
        healthy: true,
        endpoints: ['/api/dxos-mcp', '/api/dxos-mcp/it-ot'],
        metrics: { activeAiProfilesCount: profilesCount, auditLogsCount: auditCount },
      },
      {
        key: 'appDataSubstrate',
        order: 6,
        name: 'NocoBase 2.2.38 Application Data & UI Substrate',
        technologies: ['Collections & Schema Engine', 'FlowEngine Native UI', 'Plugin Manager (7 Apache-2.0 Plugins)'],
        healthy: Boolean(db),
        clause52Attribution: 'Powered by NocoBase (v2.2.38 preserved)',
        metrics: { collectionsCount },
      },
    ],
  };
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  DISPATCH_ALLOWED_ROLES,
  createItOtMcpTools,
  buildEnterpriseTopology,
};
