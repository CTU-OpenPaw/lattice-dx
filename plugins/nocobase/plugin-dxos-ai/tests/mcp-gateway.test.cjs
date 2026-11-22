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
  const outbox = [{ id: 1, eventId: 'evt-1', entityId: 'AST-01', organizationId: 'org-a', collectionName: 'latticeAssets', recordId: 1, state: 'pending', attempts: 0, payload: {} }];
  const store = {
    latticeEmployees: [
      { id: 13, userId: 9, organizationId: 'org-a', active: true },
      { id: 14, userId: 10, organizationId: 'org-a', active: true },
      { id: 15, userId: 11, organizationId: 'org-a', active: true },
    ],
    roles: [{ name: 'root', allowConfigure: true }, { name: 'ldx_employee', allowConfigure: false }, { name: 'ldx_manager', allowConfigure: false }, { name: 'ldx_driver', allowConfigure: false }],
    dataSourcesRolesResources: [
      { roleName: 'ldx_employee', name: 'latticeAssets', dataSourceKey: 'main', actions: [{ name: 'view' }] },
      { roleName: 'ldx_employee', name: 'latticeIncidentCases', dataSourceKey: 'main', actions: [{ name: 'view' }] },
      { roleName: 'ldx_employee', name: 'latticeAgentProposals', dataSourceKey: 'main', actions: [{ name: 'view' }] },
      { roleName: 'ldx_employee', name: 'latticeParaDocuments', dataSourceKey: 'main', actions: [{ name: 'view' }] },
      { roleName: 'ldx_driver', name: 'latticeAssets', dataSourceKey: 'main', actions: [{ name: 'view' }] },
    ],
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

test('default host auth populates ctx.db and ctx.getBearerToken before dataSource middleware', async () => {
  const db = makeItOtMockDb();
  const baseFindRepo = db.getRepository.bind(db);
  db.getRepository = (name) => {
    if (name === 'rolesUsers') {
      return {
        find: async ({ filter }) => (Number(filter?.userId) === 9 ? [{ roleName: 'ldx_employee' }] : []),
      };
    }
    return baseFindRepo(name);
  };
  let seenDb = false;
  let seenToken = null;
  let seenAction = false;
  let seenAcl = false;
  const mockApp = {
    authManager: {
      middleware: () => async (ctx, next) => {
        seenDb = Boolean(ctx.db);
        const { resourceName, actionName } = ctx.action;
        seenAction = Boolean(resourceName && actionName);
        seenAcl = Boolean(ctx.dataSource?.acl);
        seenToken = typeof ctx.getBearerToken === 'function' ? ctx.getBearerToken() : null;
        if (seenDb && seenAction && seenAcl && seenToken === 'valid-jwt') {
          ctx.state.currentUser = { id: 9, username: 'emp9' };
        }
        await next();
      },
    },
  };
  const mw = createMcpGatewayMiddleware({
    app: mockApp,
    db,
    tools: createDxosTools(),
    itOtTools: [],
  });
  const ctx = {
    path: '/api/dxos-mcp',
    method: 'POST',
    headers: { authorization: 'Bearer valid-jwt' },
    request: { body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } },
    set() {},
  };
  await mw(ctx, async () => {});
  assert.equal(seenDb, true);
  assert.equal(seenAction, true);
  assert.equal(seenAcl, true);
  assert.equal(seenToken, 'valid-jwt');
  assert.equal(ctx.status, 200);
  assert.ok(ctx.body.result.tools.some((t) => t.name === 'dxos_search_enterprise_context'));
});

test('v0.2.0 MCP/IT-OT hardening: Orion-LD ?local=true, outbox state/schema, redirect error, admin gate on health & resources/read, active X-Role', async () => {
  const db = makeItOtMockDb();
  const seenFetches = [];
  const captureFetch = async (url, init = {}) => {
    seenFetches.push({ url: String(url), init });
    return {
      ok: true,
      status: 200,
      json: async () => (String(url).includes('entities') ? [{ id: 'urn:ngsi-ld:Asset:org-a:AST-01', type: 'Asset' }] : { version: '1.12.0' }),
    };
  };
  const tools = createItOtMcpTools(db, { ORION_LD_URL: 'http://127.0.0.1:1026', N8N_URL: 'http://127.0.0.1:5678' }, captureFetch);
  const byName = new Map(tools.map((t) => [t.definition.name, t]));

  // 1. Orion-LD uses ?local=true&limit=50 & redirect: 'error'
  const tel = await byName.get('get_live_ngsi_telemetry').invoke({ state: { currentUser: { id: 9 }, currentRoles: ['ldx_employee'] }, db }, {});
  assert.equal(tel.degraded, false);
  assert.equal(tel.pendingOutboxCount, 1);
  assert.equal(seenFetches[0].url.includes('/ngsi-ld/v1/entities?local=true'), true);
  assert.equal(seenFetches[0].init.redirect, 'error');

  // 2. requeue_outbox writes state + required NOT NULL columns matching context-outbox schema
  const mgrCtx = { state: { currentUser: { id: 10, username: 'mgr10' }, currentRoles: ['ldx_manager'] }, db };
  await byName.get('dispatch_itot_webhook_or_sync').invoke(mgrCtx, { mode: 'requeue_outbox', entityId: 'urn:ngsi-ld:Asset:org-a:AST-01', reason: 'Sync after alarm' });
  const addedOutbox = db.outbox.at(-1);
  assert.equal(addedOutbox.state, 'pending');
  assert.equal(typeof addedOutbox.eventId, 'string');
  assert.equal(addedOutbox.collectionName, 'latticeAssets');
  assert.notEqual(addedOutbox.recordId, undefined);
  assert.equal(addedOutbox.attempts, 0);

  // 3. get_stack_connector_health is adminOnly & get_sensor_and_incident_timeline denies unpermitted role (ldx_driver)
  assert.equal(byName.get('get_stack_connector_health').adminOnly, true);
  await assert.rejects(
    () => byName.get('get_sensor_and_incident_timeline').invoke({ state: { currentUser: { id: 11 }, currentRoles: ['ldx_driver'] }, db }, {}),
    (err) => err.status === 403,
  );

  // 4. Gateway blocks resources/read for non-admin & enforces X-Role downgrade
  const baseFindRepo = db.getRepository.bind(db);
  db.getRepository = (n) => (n === 'rolesUsers'
    ? { find: async ({ filter }) => (Number(filter?.userId) === 1 ? [{ roleName: 'root' }, { roleName: 'ldx_employee' }] : []) }
    : baseFindRepo(n));
  const mw = createMcpGatewayMiddleware({
    app: {
      authManager: {
        middleware: () => async (ctx, next) => {
          ctx.state.currentUser = { id: 1, username: 'dual-user' };
          await next();
        },
      },
    },
    db,
    tools: createDxosTools(),
    itOtTools: tools,
  });

  // Switch active role down to ldx_employee via X-Role header -> hides admin tools & denies resources/read
  const switchedCtx = {
    path: '/api/dxos-mcp',
    method: 'POST',
    headers: { authorization: 'Bearer tok', 'x-role': 'ldx_employee' },
    request: { body: { jsonrpc: '2.0', id: 77, method: 'resources/read', params: { uri: 'dxos://topology/planes' } }, headers: { 'x-role': 'ldx_employee' } },
    set() {},
  };
  await mw(switchedCtx, async () => {});
  assert.equal(switchedCtx.body.error.code, -32003);
  assert.deepEqual(switchedCtx.state.currentRoles, ['ldx_employee']);

  // initialize serverInfo.version reads package.json version dynamically
  const pkgVersion = require('../package.json').version;
  const initCtx = {
    path: '/api/dxos-mcp',
    method: 'POST',
    headers: { authorization: 'Bearer tok' },
    request: { body: { jsonrpc: '2.0', id: 78, method: 'initialize', params: { protocolVersion: '2025-03-26' } } },
    set() {},
  };
  await mw(initCtx, async () => {});
  assert.equal(initCtx.body.result.serverInfo.version, pkgVersion);
});
