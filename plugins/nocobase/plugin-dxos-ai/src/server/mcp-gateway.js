/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { isStudioAdmin, resolveActorScope } = require('./ai-tools-core');
const { buildEnterpriseTopology } = require('./mcp-itot-tools');
const { recordAiAuditLog } = require('./ai-schemas');

const SUPPORTED_PROTOCOL_VERSIONS = ['2025-03-26', '2024-11-05'];

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
      currentRole: authState.currentRoles?.[0] || null,
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
          capabilities: { tools: { listChanged: false }, resources: { subscribe: false } },
          serverInfo: {
            name: mode === 'itot' ? 'latticedx-itot-mcp' : 'latticedx-enterprise-mcp',
            version: '0.1.0',
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
    if (rpcMethod === 'resources/list') {
      const resources = !isAdmin
        ? []
        : mode === 'itot'
          ? [{ uri: 'dxos://itot/health', name: 'LatticeDX IT/OT Connector Health', mimeType: 'application/json' }]
          : [{ uri: 'dxos://topology/planes', name: 'LatticeDX 6-Plane Enterprise OS Topology', mimeType: 'application/json' }];
      ctx.status = 200;
      ctx.body = { jsonrpc: '2.0', id: reqId, result: { resources } };
      return;
    }
    if (rpcMethod === 'resources/read') {
      const uri = String(req.params?.uri || '');
      if (!isAdmin) {
        await recordAiAuditLog(activeDb, { actorUserId: authState.currentUser.id, actorUsername: authState.currentUser.username, channel, toolName: `mcp:resource:${uri}`, argsSummary: { uri }, status: 'denied', errorCode: 'MCP_RESOURCE_FORBIDDEN', resultSummary: 'Only administrators may inspect infrastructure topology resources' });
        ctx.status = 200;
        ctx.body = { jsonrpc: '2.0', id: reqId, error: { code: -32003, message: 'Administrator access required for infrastructure resources.' } };
        return;
      }
      if (uri === 'dxos://topology/planes' || uri === 'dxos://itot/health') {
        const topology = await buildEnterpriseTopology(activeDb, env, fetchImpl);
        const data = uri === 'dxos://itot/health' ? topology.planes.filter((p) => ['itOtDigitalTwin', 'integrationEventBus'].includes(p.key)) : topology;
        ctx.status = 200;
        ctx.body = { jsonrpc: '2.0', id: reqId, result: { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(data) }] } };
        return;
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
        if (tool.definition.name === 'dxos_my_tasks_copilot' && ctx.state.currentRoles) {
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
  extractBearerToken,
  normalizeMcpPath,
  createMcpGatewayMiddleware,
};
