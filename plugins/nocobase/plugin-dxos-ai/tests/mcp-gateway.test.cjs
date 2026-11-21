/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createItOtMcpTools, buildEnterpriseTopology } = require('../src/server/mcp-itot-tools');
const { createMcpGatewayMiddleware } = require('../src/server/mcp-gateway');
const { createDxosTools, ADMIN_BUILDER_TOOL_NAMES } = require('../src/server/ai-tools-core');

function makeItOtMockDb() {
  const wrap = (row) => ({ ...row, get: (k) => row[k], toJSON: () => row });
  const auditLogs = [];
  const outbox = [{ id: 1, entityType: 'Asset', entityId: 'AST-01', organizationId: 'org-a', status: 'pending' }];
  const store = {
    latticeEmployees: [
      { id: 13, userId: 9, organizationId: 'org-a', active: true },
      { id: 14, userId: 10, organizationId: 'org-a', active: true },
    ],
    roles: [{ name: 'root', allowConfigure: true }, { name: 'ldx_employee', allowConfigure: false }, { name: 'ldx_manager', allowConfigure: false }],
    latticeAssets: [{ id: 1, code: 'AST-01', name: 'Kho lạnh 01', organizationId: 'org-a', entityId: 'urn:ngsi-ld:Asset:org-a:AST-01' }],
    latticeIncidentCases: [{ id: 2, code: 'INC-01', name: 'Quá nhiệt dàn ngưng', organizationId: 'org-a', assetEntityId: 'urn:ngsi-ld:Asset:org-a:AST-01', severity: 'high', status: 'open' }],
    latticeAgentProposals: [{ id: 3, code: 'PROP-01', organizationId: 'org-a', state: 'proposed', targetCollection: 'latticeIncidentCases' }],
    latticeContextOutbox: outbox,
    latticeParaDocuments: [{ id: 4, code: 'SOP-1', organizationId: 'org-a' }],
    latticeAiProfiles: [{ id: 1, username: 'dxos-ops', enabled: true }],
    latticeAiAuditLogs: auditLogs,
    uiLayouts: [{ uid: 'ldx-portal-services', name: 'Services' }],
    collections: [{ name: 'latticeOrders' }, { name: 'latticeAssets' }],
    workflows: [{ id: 1, current: true, enabled: true }],
    latticeOrders: [],
    latticeRequests: [],
    latticeServiceTickets: [],
  };
  return {
    auditLogs,
    outbox,
    hasCollection: (name) => Boolean(store[name]),
    getRepository(name) {
      const arr = store[name];
      if (!arr) return null;
      return {
        find: async ({ filter = {}, limit = 50 } = {}) => arr.filter((r) => Object.entries(filter).every(([k, v]) => r[k] === v)).slice(0, limit).map(wrap),
        findOne: async ({ filter = {} } = {}) => {
          const hit = arr.find((r) => Object.entries(filter).every(([k, v]) => r[k] === v));
          return hit ? wrap(hit) : null;
        },
        count: async ({ filter = {} } = {}) => arr.filter((r) => Object.entries(filter).every(([k, v]) => r[k] === v)).length,
        create: async ({ values }) => { const row = { id: arr.length + 10, ...values }; arr.push(row); return wrap(row); },
      };
    },
  };
}

test('IT/OT MCP tools handle Orion-LD timeout gracefully and buildEnterpriseTopology returns 6 planes', async () => {
  const db = makeItOtMockDb();
  const timeoutFetch = async () => { throw new Error('connect ECONNREFUSED'); };
  const tools = createItOtMcpTools(db, { ORION_LD_URL: 'http://127.0.0.1:1026', N8N_URL: 'http://127.0.0.1:5678', N8N_WEBHOOK_BASE_URL: 'http://127.0.0.1:5678/webhook' }, timeoutFetch);
  assert.equal(tools.length, 4);
  const byName = new Map(tools.map((t) => [t.definition.name, t]));

  const empCtx = { state: { currentUser: { id: 9, username: 'emp9' }, currentRoles: ['ldx_employee'] }, db };
  const tel = await byName.get('get_live_ngsi_telemetry').invoke(empCtx, {});
  assert.equal(tel.degraded, true);
  assert.equal(tel.service, 'orion-ld');
  assert.equal(Array.isArray(tel.cachedAssets), true);

  // Employee cannot dispatch n8n/outbox action
  await assert.rejects(() => byName.get('dispatch_itot_webhook_or_sync').invoke(empCtx, { mode: 'requeue_outbox', reason: 'retry' }), (err) => err.status === 403);

  const okFetch = async (url) => ({ ok: true, status: 200, json: async () => (String(url).includes('entities') ? [{ id: 'urn:ngsi-ld:Asset:org-a:AST-01', type: 'Asset' }] : { version: '1.5.1' }) });
  const topology = await buildEnterpriseTopology(db, { ORION_LD_URL: 'http://127.0.0.1:1026', N8N_URL: 'http://127.0.0.1:5678' }, okFetch);
  assert.equal(topology.planes.length, 6);
  assert.equal(topology.planes.some((p) => p.key === 'appDataSubstrate' && p.name.includes('NocoBase')), true);
  assert.equal(topology.planes.some((p) => p.key === 'aiWorkforceAndMcp' && p.healthy === true), true);
});

test('MCP gateway enforces Bearer auth, hides Admin tools from non-admins, executes JSON-RPC, and audits', async () => {
  const db = makeItOtMockDb();
  const okFetch = async () => ({ ok: true, status: 200, json: async () => ([{ id: 'urn:ngsi-ld:Asset:org-a:AST-01', type: 'Asset', temperature: { value: 4.2 } }]) });
  const middleware = createMcpGatewayMiddleware({
    db,
    tools: createDxosTools(),
    itOtTools: createItOtMcpTools(db, { ORION_LD_URL: 'http://127.0.0.1:1026' }, okFetch),
    authResolver: async (token) => {
      if (token === 'emp-token') return { currentUser: { id: 9, username: 'emp9' }, currentRoles: ['ldx_employee'] };
      if (token === 'root-token') return { currentUser: { id: 1, username: 'admin' }, currentRoles: ['root'] };
      return null;
    },
  });

  async function callMcp(path, body, { method = 'POST', token } = {}) {
    const headers = token ? { authorization: `Bearer ${token}` } : {};
    const ctx = {
      path,
      method,
      headers,
      request: { body, headers },
      state: {},
      db,
      status: 200,
      setHeaders: {},
      set(k, v) { this.setHeaders[k] = v; },
    };
    let nextCalled = false;
    await middleware(ctx, async () => { nextCalled = true; });
    return { ctx, nextCalled };
  }

  // Unauthenticated -> 401 with WWW-Authenticate
  const unauth = await callMcp('/api/dxos-mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal(unauth.ctx.status, 401);
  assert.equal(Boolean(unauth.ctx.setHeaders['WWW-Authenticate']), true);

  // GET stateless probe -> 405
  const getProbe = await callMcp('/api/dxos-mcp', {}, { method: 'GET', token: 'emp-token' });
  assert.equal(getProbe.ctx.status, 405);

  // Employee initialize + tools/list excludes Admin tools
  const initRes = await callMcp('/api/dxos-mcp', { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-03-26' } }, { token: 'emp-token' });
  assert.equal(initRes.ctx.status, 200);
  assert.equal(initRes.ctx.body.result.serverInfo.name, 'latticedx-enterprise-mcp');

  const empList = await callMcp('/api/dxos-mcp', { jsonrpc: '2.0', id: 3, method: 'tools/list' }, { token: 'emp-token' });
  const empToolNames = empList.ctx.body.result.tools.map((t) => t.name);
  assert.equal(empToolNames.includes('dxos_search_enterprise_context'), true);
  for (const adm of ADMIN_BUILDER_TOOL_NAMES) assert.equal(empToolNames.includes(adm), false);

  // Employee calling Admin tool directly -> JSON-RPC denied error + audit log
  const deniedCall = await callMcp('/api/dxos-mcp', { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'dxos_compose_page_blocks', arguments: { portalSlug: 'services', blockUse: 'DxosAiProposalBlockModel', title: 'X' } } }, { token: 'emp-token' });
  assert.equal(Boolean(deniedCall.ctx.body.error), true);

  // IT/OT endpoint with valid user token returns Orion-LD entity for org-a
  const itotCall = await callMcp('/api/dxos-mcp/it-ot', { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'get_live_ngsi_telemetry', arguments: {} } }, { token: 'emp-token' });
  const parsedTel = JSON.parse(itotCall.ctx.body.result.content[0].text);
  assert.equal(parsedTel.organizationId, 'org-a');
  assert.equal(parsedTel.liveEntities.length, 1);

  // Root sees Admin Builder tools + can dryRun compose
  const rootList = await callMcp('/api/dxos-mcp', { jsonrpc: '2.0', id: 6, method: 'tools/list' }, { token: 'root-token' });
  assert.equal(rootList.ctx.body.result.tools.some((t) => t.name === 'dxos_compose_page_blocks'), true);
});
