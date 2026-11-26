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
  val,
  failTool,
  isStudioAdmin,
  resolveActorScope,
  resolveReadablePolicies,
  isRowVisibleToActor,
  SYSTEM_PROTECTED_COLLECTIONS,
} = require('./ai-tools-core');
const { buildEnterpriseTopology } = require('./mcp-itot-tools');
const { recordAiAuditLog } = require('./ai-schemas');
const { redactPiiText, redactPiiDeep } = require('./ai-governance');
const { analyzeGraphImpact } = require('./ai-operational-tools');
const { runWithTenantRls, runWithSystemRlsBypass } = require('./ai-rls');

const SUPPORTED_PROTOCOL_VERSIONS = ['2025-03-26', '2024-11-05'];
const ORG_ALARMS_URI_RE = /^dxos:\/\/org\/([a-zA-Z0-9_-]{1,80})\/alarms\/active$/;
const ORG_LINEAGE_URI_RE = /^dxos:\/\/org\/([a-zA-Z0-9_-]{1,80})\/lineage\/([A-Za-z_][A-Za-z0-9_]{0,80})\/([^/?#]{1,120})$/;
const FORBIDDEN_COLLECTION_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

function cleanPromptArg(raw) {
  return String(raw ?? '').replace(/[\r\n\0]+/g, ' ').trim().slice(0, 200);
}

const MCP_PROMPT_CATALOG = [
  {
    name: 'dxos-cold-chain-incident-triage',
    title: 'Phân tích & Xử lý Sự cố Chuỗi lạnh (GraphRAG + SOP)',
    description: 'Kiểm tra telemetry Orion-LD, truy vết GraphRAG các lô/đơn hàng bị ảnh hưởng, đối chiếu SOP P.A.R.A. và đề xuất xử lý cảnh báo.',
    adminOnly: false,
    arguments: [
      { name: 'assetCode', description: 'Mã tài sản hoặc URN kho lạnh (vd: COLD-ROOM-A1)', required: true },
      { name: 'incidentCode', description: 'Mã sự cố tùy chọn (vd: INC-COLD-09)', required: false },
    ],
    render: ({ assetCode, incidentCode }) => [
      `Thực hiện quy trình phân tích sự cố chuỗi lạnh cho tài sản "${assetCode}"${incidentCode ? ` (sự cố ${incidentCode})` : ''}:`,
      '1. Gọi get_live_ngsi_telemetry để kiểm tra nhiệt độ và outbox hiện tại.',
      `2. Gọi dxos_graph_impact_analysis trên latticeAssets (recordCode="${assetCode}", includeTelemetry=true) để liệt kê lô hàng, đơn hàng và ePOD bị ảnh hưởng.`,
      '3. Gọi dxos_search_enterprise_context tìm SOP P.A.R.A. liên quan kèm trích dẫn nguồn.',
      '4. Đề xuất bước ack/clear qua dxos_alarm_action hoặc tạo phiếu bảo trì nếu cần phê duyệt.',
    ].join('\n'),
  },
  {
    name: 'dxos-fefo-dispatch-audit',
    title: 'Kiểm toán Xuất kho FEFO & Truy vết Lô lạnh',
    description: 'Đánh giá trạng thái MKT lô tồn kho FEFO, đơn hàng phân bổ và hồ sơ giao nhận ePOD liên quan.',
    adminOnly: false,
    arguments: [
      { name: 'lotCode', description: 'Mã lô tồn kho FEFO (vd: LOT-VAC-001)', required: true },
      { name: 'sku', description: 'Mã SKU tùy chọn', required: false },
    ],
    render: ({ lotCode, sku }) => [
      `Kiểm toán chuỗi cung ứng FEFO cho lô "${lotCode}"${sku ? ` (SKU: ${sku})` : ''}:`,
      `1. Gọi dxos_graph_impact_analysis trên latticeStockLots (recordCode="${lotCode}", maxDepth=3) để kiểm tra đơn hàng, dòng đơn và ePOD phụ thuộc.`,
      '2. Kiểm tra chỉ số mktCelsius so với targetTempMaxC và các sự cố IoT đang mở.',
      '3. Tổng hợp danh sách trích dẫn [collection:code#id] cần rà soát trước khi xuất kho.',
    ].join('\n'),
  },
  {
    name: 'dxos-executive-radar-brief',
    title: 'Báo cáo Radar Điều hành 6 Phân hệ',
    description: 'Tổng hợp điểm nghẽn liên phòng ban, tác vụ quy trình đang chờ duyệt và cảnh báo tồn đọng trong tổ chức.',
    adminOnly: false,
    arguments: [
      { name: 'focusArea', description: 'Phân hệ trọng tâm tùy chọn (logistics, incidents, procurement, services)', required: false },
    ],
    render: ({ focusArea }) => [
      `Tạo báo cáo nhanh điều hành doanh nghiệp${focusArea ? ` (trọng tâm: ${focusArea})` : ''}:`,
      '1. Gọi dxos_orchestrate_enterprise_case(mode="radar") để tổng hợp số liệu các phân hệ được cấp quyền.',
      '2. Gọi dxos_my_workflow_tasks(action="list") kiểm tra tác vụ tồn đọng.',
      '3. Nêu rõ các điểm nghẽn ưu tiên cao nhất kèm mã tham chiếu.',
    ].join('\n'),
  },
  {
    name: 'dxos-system-blueprint-architect',
    title: 'Kiến trúc sư Giao diện & Phân quyền DX-OS (Admin)',
    description: 'Gợi ý blueprint giao diện đa cột, thiết kế Creative Block và phân quyền vai trò ldx_* an toàn có Time-Machine snapshot.',
    adminOnly: true,
    arguments: [
      { name: 'portalSlug', description: 'Slug cổng mục tiêu (vd: incidents, logistics, services)', required: true },
      { name: 'goal', description: 'Yêu cầu thiết kế hoặc phân quyền', required: true },
    ],
    render: ({ portalSlug, goal }) => [
      `Thiết kế nâng cấp cổng "${portalSlug}" theo mục tiêu: ${goal}`,
      `1. Gọi dxos_recommend_page_blueprint(portalSlug="${portalSlug}") để kiểm tra cấu trúc và collection hiện tại.`,
      '2. Dùng dxos_design_creative_block hoặc dxos_provision_role_workspace với Time-Machine snapshot tự động trước khi ghi.',
    ].join('\n'),
  },
];

function resolveGatewayVersion() {
  try {
    return String(require('../../package.json')?.version || '0.4.2');
  } catch {
    return '0.4.2';
  }
}

function extractBearerToken(ctx) {
  const auth = ctx.headers?.authorization || ctx.headers?.Authorization || ctx.request?.headers?.authorization || ctx.request?.headers?.Authorization;
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
  if (!ctx.action) ctx.action = { resourceName: 'dxosMcp', actionName: 'rpc', params: {} };
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
  const userId = user && (typeof user.get === 'function' ? user.get('id') : user.id);
  if (!userId) return null;
  const rolesRepo = db?.getRepository?.('rolesUsers');
  let roleNames = Array.isArray(ctx.state?.currentRoles) ? [...ctx.state.currentRoles] : [];
  if (!roleNames.length && rolesRepo) {
    const rows = (await rolesRepo.find({ filter: { userId } })) || [];
    roleNames = rows.map((r) => (typeof r.get === 'function' ? r.get('roleName') : r.roleName)).filter(Boolean);
  }
  const requestedRole = String(ctx.headers?.['x-role'] || ctx.request?.headers?.['x-role'] || '').trim();
  const effectiveRoles = requestedRole && roleNames.includes(requestedRole) ? [requestedRole] : roleNames;
  return { currentUser: { ...user, id: userId }, currentRoles: effectiveRoles };
}

function sendUnauthorized(ctx, message = 'Authentication required') {
  ctx.withoutDataWrapping = true;
  ctx.status = 401;
  ctx.set?.('WWW-Authenticate', 'Bearer realm="LatticeDX-MCP", error="invalid_token"');
  ctx.body = { jsonrpc: '2.0', id: ctx.request?.body?.id ?? null, error: { code: -32001, message } };
}

function normalizeMcpPath(rawPath) {
  const p = String(rawPath || '').replace(/\/+$/, '');
  if (p === '/api/dxos-mcp' || p.endsWith('/api/dxos-mcp')) return 'enterprise';
  if (p === '/api/dxos-mcp/it-ot' || p.endsWith('/api/dxos-mcp/it-ot')) return 'itot';
  return null;
}

function createMcpGatewayMiddleware({ app, db, tools = [], itOtTools = [], env = process.env, fetchImpl, authResolver } = {}) {
  return async function dxosMcpGateway(ctx, next) {
    const mode = normalizeMcpPath(ctx.path);
    if (!mode) return next();

    ctx.withoutDataWrapping = true;
    const method = String(ctx.method || 'GET').toUpperCase();
    const channel = mode === 'itot' ? 'mcp-itot' : 'mcp-enterprise';
    const activeDb = db || ctx.db || app?.db;
    const token = extractBearerToken(ctx);

    let authState = null;
    try {
      authState = authResolver ? await authResolver(token, ctx) : await defaultResolveHostAuth(app, activeDb, ctx, token);
    } catch (err) {
      app?.log?.warn?.('[dxos-mcp] host auth resolution failed', { error: err?.message, status: err?.status });
      authState = null;
    }

    if (!authState?.currentUser?.id) {
      await recordAiAuditLog(activeDb, { channel, toolName: `mcp:${method}`, argsSummary: { path: ctx.path }, status: 'denied', errorCode: 'MCP_UNAUTHORIZED', resultSummary: 'Missing or invalid Bearer token' });
      sendUnauthorized(ctx);
      return;
    }

    ctx.state = {
      ...(ctx.state || {}),
      currentUser: authState.currentUser,
      currentRoles: authState.currentRoles || [],
      currentRole: authState.currentRoles?.includes('root') ? 'root' : (authState.currentRoles?.[0] || null),
      dxosAuditChannel: channel,
    };

    if (method === 'GET' || method === 'DELETE') {
      ctx.status = 405;
      ctx.body = { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Method not allowed on stateless Streamable HTTP MCP endpoint; send JSON-RPC POST.' } };
      return;
    }
    if (method !== 'POST') {
      ctx.status = 405;
      ctx.body = { jsonrpc: '2.0', id: null, error: { code: -32000, message: `Unsupported HTTP method ${method}` } };
      return;
    }

    const req = ctx.request?.body && typeof ctx.request.body === 'object' ? ctx.request.body : {};
    const reqId = req.id !== undefined ? req.id : null;
    const rpcMethod = req.method;
    const isAdmin = await isStudioAdmin(ctx, activeDb);
    const pool = (mode === 'itot' ? itOtTools : tools).filter((t) => isAdmin || !t.adminOnly);

    if (rpcMethod === 'notifications/initialized') {
      ctx.status = 202;
      ctx.body = { ok: true };
      return;
    }
    if (rpcMethod === 'ping') {
      ctx.status = 200;
      ctx.body = { jsonrpc: '2.0', id: reqId, result: {} };
      return;
    }
    if (rpcMethod === 'initialize') {
      const requestedVersion = req.params?.protocolVersion;
      ctx.status = 200;
      ctx.body = {
        jsonrpc: '2.0',
        id: reqId,
        result: {
          protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requestedVersion) ? requestedVersion : SUPPORTED_PROTOCOL_VERSIONS[0],
          capabilities: {
            tools: { listChanged: false },
            resources: { subscribe: false },
            prompts: { listChanged: false },
          },
          serverInfo: {
            name: mode === 'itot' ? 'latticedx-itot-mcp' : 'latticedx-enterprise-mcp',
            version: resolveGatewayVersion(),
          },
        },
      };
      return;
    }
    if (rpcMethod === 'tools/list') {
      ctx.status = 200;
      ctx.body = {
        jsonrpc: '2.0',
        id: reqId,
        result: {
          tools: pool.map((t) => ({ name: t.definition.name, description: t.definition.description, inputSchema: t.jsonSchema || { type: 'object', properties: {} } })),
        },
      };
      return;
    }
    if (rpcMethod === 'prompts/list') {
      const visiblePrompts = MCP_PROMPT_CATALOG
        .filter((p) => isAdmin || !p.adminOnly)
        .map(({ name, title, description, arguments: promptArgs }) => ({
          name,
          title,
          description,
          arguments: promptArgs,
        }));
      ctx.status = 200;
      ctx.body = { jsonrpc: '2.0', id: reqId, result: { prompts: visiblePrompts } };
      return;
    }
    if (rpcMethod === 'prompts/get') {
      const promptName = String(req.params?.name || '').trim();
      const prompt = MCP_PROMPT_CATALOG.find((p) => p.name === promptName);
      if (!prompt) {
        ctx.status = 200;
        ctx.body = { jsonrpc: '2.0', id: reqId, error: { code: -32602, message: `Unknown MCP prompt: ${promptName}` } };
        return;
      }
      if (prompt.adminOnly && !isAdmin) {
        await recordAiAuditLog(activeDb, {
          actorUserId: authState.currentUser.id,
          actorUsername: authState.currentUser.username,
          channel,
          toolName: `mcp:prompt:${promptName}`,
          argsSummary: { name: promptName },
          status: 'denied',
          errorCode: 'MCP_PROMPT_FORBIDDEN',
          resultSummary: `Prompt ${promptName} requires administrator access`,
        });
        ctx.status = 200;
        ctx.body = { jsonrpc: '2.0', id: reqId, error: { code: -32003, message: `Prompt "${promptName}" requires administrator access.` } };
        return;
      }
      const rawArgs = req.params?.arguments;
      if (rawArgs !== undefined && (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs))) {
        ctx.status = 200;
        ctx.body = { jsonrpc: '2.0', id: reqId, error: { code: -32602, message: 'Prompt arguments must be an object.' } };
        return;
      }
      const providedArgs = rawArgs || {};
      const cleanArgs = {};
      for (const spec of prompt.arguments) {
        const cleaned = cleanPromptArg(providedArgs[spec.name]);
        if (spec.required && !cleaned) {
          ctx.status = 200;
          ctx.body = { jsonrpc: '2.0', id: reqId, error: { code: -32602, message: `Missing required prompt argument: ${spec.name}` } };
          return;
        }
        cleanArgs[spec.name] = cleaned;
      }
      ctx.status = 200;
      ctx.body = {
        jsonrpc: '2.0',
        id: reqId,
        result: {
          description: prompt.description,
          messages: [
            {
              role: 'user',
              content: { type: 'text', text: prompt.render(cleanArgs) },
            },
          ],
        },
      };
      return;
    }
    if (rpcMethod === 'resources/templates/list') {
      const resourceTemplates = [
        {
          uriTemplate: 'dxos://org/{organizationId}/lineage/{collection}/{recordId}',
          name: 'LatticeDX Organization Lineage & Impact Graph',
          description: 'Truy vết phả hệ và ảnh hưởng chuỗi lạnh theo tổ chức.',
          mimeType: 'application/json',
        },
        {
          uriTemplate: 'dxos://org/{organizationId}/alarms/active',
          name: 'LatticeDX Active Organization Alarms',
          description: 'Danh sách cảnh báo chuỗi lạnh/IoT đang mở trong tổ chức.',
          mimeType: 'application/json',
        },
      ];
      if (isAdmin) {
        resourceTemplates.push({
          uriTemplate: mode === 'itot' ? 'dxos://itot/health' : 'dxos://topology/planes',
          name: mode === 'itot' ? 'LatticeDX IT/OT Connector Health' : 'LatticeDX 6-Plane Enterprise OS Topology',
          description: 'Tài nguyên hạ tầng hệ thống (chỉ Quản trị viên).',
          mimeType: 'application/json',
        });
      }
      ctx.status = 200;
      ctx.body = { jsonrpc: '2.0', id: reqId, result: { resourceTemplates } };
      return;
    }
    if (rpcMethod === 'resources/list') {
      const resources = [];
      try {
        ctx.db = activeDb;
        const actor = await resolveActorScope(ctx, activeDb);
        if (actor?.organizationId) {
          resources.push({
            uri: `dxos://org/${actor.organizationId}/alarms/active`,
            name: `Active Alarms (${actor.organizationId})`,
            mimeType: 'application/json',
          });
        }
      } catch {
        // Unmapped non-admin user gets no org resources
      }
      if (isAdmin) {
        resources.push(
          mode === 'itot'
            ? { uri: 'dxos://itot/health', name: 'LatticeDX IT/OT Connector Health', mimeType: 'application/json' }
            : { uri: 'dxos://topology/planes', name: 'LatticeDX 6-Plane Enterprise OS Topology', mimeType: 'application/json' },
        );
      }
      ctx.status = 200;
      ctx.body = { jsonrpc: '2.0', id: reqId, result: { resources } };
      return;
    }
    if (rpcMethod === 'resources/read') {
      const uri = String(req.params?.uri || '').trim();
      const alarmsMatch = ORG_ALARMS_URI_RE.exec(uri);
      const lineageMatch = ORG_LINEAGE_URI_RE.exec(uri);

      if (alarmsMatch || lineageMatch) {
        let actor;
        try {
          ctx.db = activeDb;
          actor = await resolveActorScope(ctx, activeDb);
        } catch (err) {
          ctx.status = 200;
          ctx.body = { jsonrpc: '2.0', id: reqId, error: { code: -32003, message: err?.message || 'Organization scope required.' } };
          return;
        }
        const uriOrgId = alarmsMatch ? alarmsMatch[1] : lineageMatch[1];
        if (!actor.isRoot && uriOrgId !== actor.organizationId) {
          await recordAiAuditLog(activeDb, {
            actorUserId: authState.currentUser.id,
            actorUsername: authState.currentUser.username,
            organizationId: actor.organizationId,
            channel,
            toolName: `mcp:resource:${uri}`,
            argsSummary: { uri, targetOrg: uriOrgId },
            status: 'denied',
            errorCode: 'MCP_CROSS_ORG_FORBIDDEN',
            resultSummary: 'Blocked cross-organization MCP resource read',
          });
          ctx.status = 200;
          ctx.body = { jsonrpc: '2.0', id: reqId, error: { code: -32003, message: 'Cross-organization MCP resource access is forbidden.' } };
          return;
        }

        if (alarmsMatch) {
          const effectiveActor = actor.isRoot ? { ...actor, organizationId: uriOrgId } : actor;
          const { allowedCollections, ownOnlySet } = await runWithTenantRls(
            activeDb,
            uriOrgId,
            () => resolveReadablePolicies(activeDb, effectiveActor, ['latticeIncidentCases']),
          );
          if (!allowedCollections.includes('latticeIncidentCases')) {
            await recordAiAuditLog(activeDb, {
              actorUserId: authState.currentUser.id,
              actorUsername: authState.currentUser.username,
              organizationId: effectiveActor.organizationId,
              channel,
              toolName: `mcp:resource:${uri}`,
              argsSummary: { uri },
              status: 'denied',
              errorCode: 'MCP_RESOURCE_FORBIDDEN',
              resultSummary: 'Missing view grant on latticeIncidentCases',
            });
            ctx.status = 200;
            ctx.body = { jsonrpc: '2.0', id: reqId, error: { code: -32003, message: 'Insufficient permission to read organization alarms.' } };
            return;
          }
          const repo = activeDb?.getRepository?.('latticeIncidentCases');
          const rows = repo
            ? ((await runWithTenantRls(activeDb, uriOrgId, () => repo.find({ filter: { organizationId: uriOrgId }, sort: ['-id'], limit: 50 }))) || [])
            : [];
          const isOwn = ownOnlySet.has('latticeIncidentCases');
          const alarms = rows
            .filter((r) => (
              val(r, 'organizationId') === uriOrgId
              && !['closed', 'cleared'].includes(String(val(r, 'status') || 'open').toLowerCase())
              && isRowVisibleToActor(r, effectiveActor, isOwn)
            ))
            .map((r) => redactPiiDeep({
              id: val(r, 'id'),
              code: val(r, 'code') || null,
              name: val(r, 'name') || null,
              severity: val(r, 'severity') || 'medium',
              status: val(r, 'status') || 'open',
              assetEntityId: val(r, 'assetEntityId') || null,
              occurrenceCount: Number(val(r, 'occurrenceCount')) || 1,
            }).value);
          ctx.status = 200;
          ctx.body = {
            jsonrpc: '2.0',
            id: reqId,
            result: { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify({ organizationId: uriOrgId, count: alarms.length, alarms }) }] },
          };
          return;
        }

        const collection = lineageMatch[2];
        if (FORBIDDEN_COLLECTION_NAMES.has(collection)) {
          ctx.status = 200;
          ctx.body = { jsonrpc: '2.0', id: reqId, error: { code: -32602, message: 'Invalid collection name in lineage URI.' } };
          return;
        }
        let decodedRecordId;
        try {
          decodedRecordId = decodeURIComponent(lineageMatch[3]).trim();
        } catch {
          ctx.status = 200;
          ctx.body = { jsonrpc: '2.0', id: reqId, error: { code: -32602, message: 'Invalid encoded recordId in lineage URI.' } };
          return;
        }
        if (!decodedRecordId) {
          ctx.status = 200;
          ctx.body = { jsonrpc: '2.0', id: reqId, error: { code: -32602, message: 'Missing recordId in lineage URI.' } };
          return;
        }
        const effectiveActor = actor.isRoot ? { ...actor, organizationId: uriOrgId } : actor;
        const targetArg = /^[1-9]\d*$/.test(decodedRecordId)
          ? { recordId: decodedRecordId }
          : { recordCode: decodedRecordId };
        try {
          const graphResult = await runWithTenantRls(
            activeDb,
            uriOrgId,
            () => analyzeGraphImpact(
              activeDb,
              effectiveActor,
              { collection, ...targetArg, maxDepth: 2 },
              { val, failTool, resolveReadablePolicies, isRowVisibleToActor, SYSTEM_PROTECTED_COLLECTIONS, redactPiiText },
            ),
          );
          ctx.status = 200;
          ctx.body = {
            jsonrpc: '2.0',
            id: reqId,
            result: { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(graphResult) }] },
          };
          return;
        } catch (err) {
          const isForbidden = err?.status === 401 || err?.status === 403;
          if (isForbidden) {
            await recordAiAuditLog(activeDb, {
              actorUserId: authState.currentUser.id,
              actorUsername: authState.currentUser.username,
              organizationId: effectiveActor.organizationId,
              channel,
              toolName: `mcp:resource:${uri}`,
              argsSummary: { uri },
              status: 'denied',
              errorCode: err?.code || 'MCP_RESOURCE_FORBIDDEN',
              resultSummary: err?.message || 'Forbidden lineage resource read',
            });
          }
          ctx.status = 200;
          ctx.body = {
            jsonrpc: '2.0',
            id: reqId,
            error: { code: isForbidden ? -32003 : -32602, message: err?.message || 'Invalid lineage resource request.' },
          };
          return;
        }
      }

      if (uri === 'dxos://topology/planes' || uri === 'dxos://itot/health') {
        if (!isAdmin) {
          await recordAiAuditLog(activeDb, { actorUserId: authState.currentUser.id, actorUsername: authState.currentUser.username, channel, toolName: `mcp:resource:${uri}`, argsSummary: { uri }, status: 'denied', errorCode: 'MCP_RESOURCE_FORBIDDEN', resultSummary: 'Only administrators may inspect infrastructure topology resources' });
          ctx.status = 200;
          ctx.body = { jsonrpc: '2.0', id: reqId, error: { code: -32003, message: 'Administrator access required for infrastructure resources.' } };
          return;
        }
        const topology = await runWithSystemRlsBypass(
          activeDb,
          () => buildEnterpriseTopology(activeDb, env, fetchImpl, app || ctx?.app),
        );
        const data = uri === 'dxos://itot/health' ? topology.planes.filter((p) => ['itOtDigitalTwin', 'integrationEventBus'].includes(p.key)) : topology;
        ctx.status = 200;
        ctx.body = { jsonrpc: '2.0', id: reqId, result: { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(data) }] } };
        return;
      }
      if (!isAdmin) {
        await recordAiAuditLog(activeDb, { actorUserId: authState.currentUser.id, actorUsername: authState.currentUser.username, channel, toolName: `mcp:resource:${uri}`, argsSummary: { uri }, status: 'denied', errorCode: 'MCP_RESOURCE_FORBIDDEN', resultSummary: 'Unknown or restricted MCP resource' });
      }
      ctx.status = 200;
      ctx.body = { jsonrpc: '2.0', id: reqId, error: { code: -32602, message: `Unknown MCP resource URI: ${uri}` } };
      return;
    }
    if (rpcMethod === 'tools/call') {
      const toolName = String(req.params?.name || '');
      const tool = pool.find((t) => t.definition.name === toolName);
      if (!tool) {
        await recordAiAuditLog(activeDb, { actorUserId: authState.currentUser.id, actorUsername: authState.currentUser.username, channel, toolName, argsSummary: req.params?.arguments || {}, status: 'denied', errorCode: 'MCP_TOOL_DENIED', resultSummary: `Tool ${toolName} not found or forbidden for caller role` });
        ctx.status = 200;
        ctx.body = { jsonrpc: '2.0', id: reqId, error: { code: -32003, message: `Tool "${toolName}" is unavailable or forbidden for this account.` } };
        return;
      }
      try {
        ctx.app = app || ctx.app;
        ctx.db = activeDb;
        if (tool.definition.name === 'dxos_my_workflow_tasks' && ctx.state.currentRoles) {
          await resolveActorScope(ctx, activeDb);
        }
        const out = await tool.invoke(ctx, req.params?.arguments || {});
        ctx.status = 200;
        ctx.body = { jsonrpc: '2.0', id: reqId, result: { content: [{ type: 'text', text: JSON.stringify(out) }], isError: false } };
        return;
      } catch (err) {
        if (err?.status === 401 || err?.status === 403) {
          ctx.status = 200;
          ctx.body = { jsonrpc: '2.0', id: reqId, error: { code: -32003, message: err.message } };
          return;
        }
        ctx.status = 200;
        ctx.body = { jsonrpc: '2.0', id: reqId, result: { content: [{ type: 'text', text: err?.message || 'Tool failed' }], isError: true } };
        return;
      }
    }

    ctx.status = 200;
    ctx.body = { jsonrpc: '2.0', id: reqId, error: { code: -32601, message: `Unsupported JSON-RPC method: ${String(rpcMethod || '')}` } };
  };
}

module.exports = {
  SUPPORTED_PROTOCOL_VERSIONS,
  MCP_PROMPT_CATALOG,
  extractBearerToken,
  normalizeMcpPath,
  createMcpGatewayMiddleware,
};
