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
const Module = require('node:module');
const path = require('node:path');

const {
  A2A_AGENT_CARD_PATHS,
  A2A_RPC_PATH,
  A2A_AGENT_CATALOG,
  buildAgentCard,
  createAgentCardMiddleware,
  assertSafePeerUrl,
  delegateToExternalA2aPeer,
  handleA2aJsonRpc,
  createA2aMiddleware,
} = require('../src/server/a2a-gateway');

function makeMockDb(seed = {}) {
  const wrap = (row) => ({
    ...row,
    get: (k) => row[k],
    toJSON: () => ({ ...row }),
    update: async (patch) => {
      Object.assign(row, patch, { updatedAt: new Date().toISOString() });
      return wrap(row);
    },
  });

  const store = {
    latticeA2aTasks: [],
    latticeAiProfiles: [],
    latticeAiAuditLogs: [],
    latticeEmployees: [
      { id: 1, userId: 1, organizationId: 'org-a', active: true },
      { id: 2, userId: 2, organizationId: 'org-a', active: true },
      { id: 3, userId: 3, organizationId: 'org-a', active: true },
      { id: 4, userId: 4, organizationId: 'org-b', active: true },
    ],
    roles: [
      { name: 'root', allowConfigure: true },
      { name: 'admin', allowConfigure: true },
      { name: 'ldx_operator', allowConfigure: false },
      { name: 'ldx_employee', allowConfigure: false },
      { name: 'ldx_driver', allowConfigure: false },
    ],
    rolesUsers: [
      { userId: 1, roleName: 'root' },
      { userId: 2, roleName: 'ldx_operator' },
      { userId: 3, roleName: 'ldx_driver' },
      { userId: 4, roleName: 'ldx_operator' },
    ],
    ...seed,
  };

  return {
    store,
    hasCollection: (name) => Boolean(store[name]),
    getRepository(name) {
      const arr = store[name];
      if (!arr) return null;
      return {
        find: async ({ filter = {}, limit = 50 } = {}) => arr
          .filter((r) => Object.entries(filter).every(([k, v]) => {
            if (v && typeof v === 'object' && Array.isArray(v.$in)) return v.$in.includes(r[k]);
            return r[k] === v;
          }))
          .slice(0, limit)
          .map(wrap),
        findOne: async ({ filter = {} } = {}) => {
          const hit = arr.find((r) => Object.entries(filter).every(([k, v]) => r[k] === v));
          return hit ? wrap(hit) : null;
        },
        create: async ({ values }) => {
          const now = new Date().toISOString();
          const row = { id: arr.length + 1, createdAt: now, updatedAt: now, ...values };
          arr.push(row);
          return wrap(row);
        },
        update: async ({ filter = {}, values = {} } = {}) => {
          const updated = [];
          for (const row of arr) {
            if (Object.entries(filter).every(([k, v]) => row[k] === v)) {
              Object.assign(row, values, { updatedAt: new Date().toISOString() });
              updated.push(wrap(row));
            }
          }
          return updated;
        },
      };
    },
  };
}

function makeAuthResolver() {
  const users = {
    'tok-root-a': { currentUser: { id: 1, username: 'root_a' }, currentRoles: ['root'] },
    'tok-op-a': { currentUser: { id: 2, username: 'op_a' }, currentRoles: ['ldx_operator'] },
    'tok-drv-a': { currentUser: { id: 3, username: 'drv_a' }, currentRoles: ['ldx_driver'] },
    'tok-op-b': { currentUser: { id: 4, username: 'op_b' }, currentRoles: ['ldx_operator'] },
  };
  return async (token) => users[token] || null;
}

async function invokeMiddleware(mw, { path: reqPath = A2A_RPC_PATH, method = 'POST', body = {}, headers = {}, token } = {}) {
  const reqHeaders = {
    ...headers,
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  const ctx = {
    path: reqPath,
    method,
    headers: reqHeaders,
    request: { body, headers: reqHeaders },
    state: {},
    status: 200,
    setHeaders: {},
    set(k, v) { this.setHeaders[k] = v; },
  };
  let nextCalled = false;
  await mw(ctx, async () => { nextCalled = true; });
  return { ctx, nextCalled };
}

test('Agent Card serves fail-closed capability metadata at both well-known and /api paths with zero PII or secrets', async () => {
  const card = buildAgentCard({
    env: {
      DX_VAULT_MASTER_KEY: 'super-secret-master-key',
      AGENT_API_KEY: 'sk-secret-9router-key',
      DX_DEFAULT_ORG_ID: 'secret-tenant-org',
    },
  });
  const serialized = JSON.stringify(card);
  assert.equal(serialized.includes('super-secret-master-key'), false);
  assert.equal(serialized.includes('sk-secret-9router-key'), false);
  assert.equal(serialized.includes('secret-tenant-org'), false);
  assert.equal(serialized.includes('allowedRoles'), false);
  assert.equal(serialized.includes('organizationId'), false);
  assert.equal(serialized.includes('credentials'), false);
  assert.deepEqual(card.authentication, { schemes: ['bearer'] });

  const skillIds = new Set(card.skills.map((s) => s.id));
  for (const requiredId of [
    'dxos-architect',
    'dxos-operator',
    'dxos-analyst',
    'dxos-coordinator',
    'dxos-ops',
    'dxos-logistics',
    'dxos-workspace',
  ]) {
    assert.equal(skillIds.has(requiredId), true, `Agent Card must include skill ${requiredId}`);
    assert.equal(Object.hasOwn(A2A_AGENT_CATALOG, requiredId), true);
  }

  const mw = createA2aMiddleware({ db: makeMockDb(), authResolver: makeAuthResolver() });
  for (const cardPath of A2A_AGENT_CARD_PATHS) {
    const res = await invokeMiddleware(mw, { path: cardPath, method: 'GET' });
    assert.equal(res.nextCalled, false);
    assert.equal(res.ctx.status, 200);
    assert.equal(res.ctx.withoutDataWrapping, true);
    assert.equal(res.ctx.body.name, card.name);
    assert.equal(res.ctx.body.skills.length, 7);
  }

  const cardOnlyMw = createAgentCardMiddleware();
  const postReject = await invokeMiddleware(cardOnlyMw, { path: '/.well-known/agent-card.json', method: 'POST' });
  assert.equal(postReject.ctx.status, 405);
  const unrelated = await invokeMiddleware(cardOnlyMw, { path: '/api/other', method: 'GET' });
  assert.equal(unrelated.nextCalled, true);
});

test('A2A JSON-RPC rejects unauthenticated callers with 401 and non-POST with 405', async () => {
  const db = makeMockDb();
  const mw = createA2aMiddleware({ db, authResolver: makeAuthResolver() });

  const missingAuth = await invokeMiddleware(mw, {
    body: { jsonrpc: '2.0', id: 1, method: 'tasks/get', params: { id: 't1' } },
  });
  assert.equal(missingAuth.ctx.status, 401);
  assert.match(missingAuth.ctx.setHeaders['WWW-Authenticate'], /Bearer/i);
  assert.equal(missingAuth.ctx.body.error.code, -32001);

  const badToken = await invokeMiddleware(mw, {
    token: 'invalid-token',
    body: { jsonrpc: '2.0', id: 2, method: 'tasks/send', params: { prompt: 'hello' } },
  });
  assert.equal(badToken.ctx.status, 401);
  assert.equal(db.store.latticeAiAuditLogs.some((l) => l.status === 'denied' && l.errorCode === 'A2A_UNAUTHORIZED'), true);

  const getMethod = await invokeMiddleware(mw, { method: 'GET', token: 'tok-op-a' });
  assert.equal(getMethod.ctx.status, 405);
});

test('A2A JSON-RPC enforces strict RBAC per targetAgentId including fail-closed dxos-architect lock', async () => {
  const db = makeMockDb({
    latticeAiProfiles: [
      {
        id: 10,
        username: 'dxos-architect',
        organizationId: 'org-a',
        enabled: true,
        isAdminBuilder: false,
        // Even if DB profile is tampered to allow ldx_operator, architect lock must reject non-admin
        allowedRoles: ['ldx_operator', 'ldx_employee'],
      },
      {
        id: 11,
        username: 'dxos-analyst',
        organizationId: 'org-a',
        enabled: true,
        isAdminBuilder: false,
        allowedRoles: ['ldx_manager', 'admin'],
      },
    ],
  });
  const mw = createA2aMiddleware({ db, authResolver: makeAuthResolver() });

  // Operator cannot invoke dxos-architect
  const opToArch = await invokeMiddleware(mw, {
    token: 'tok-op-a',
    body: {
      jsonrpc: '2.0',
      id: 10,
      method: 'tasks/send',
      params: { targetAgentId: 'dxos-architect', prompt: 'Modify schema' },
    },
  });
  assert.equal(opToArch.ctx.status, 403);
  assert.equal(opToArch.ctx.body.error.code, -32003);

  // Driver cannot invoke dxos-operator
  const drvToOp = await invokeMiddleware(mw, {
    token: 'tok-drv-a',
    body: {
      jsonrpc: '2.0',
      id: 11,
      method: 'tasks/send',
      params: { targetAgentId: 'dxos-operator', prompt: 'Run operations task' },
    },
  });
  assert.equal(drvToOp.ctx.status, 403);

  // Operator cannot invoke dxos-analyst when org-a profile restricts allowedRoles to ['ldx_manager', 'admin']
  const opToRestrictedAnalyst = await invokeMiddleware(mw, {
    token: 'tok-op-a',
    body: {
      jsonrpc: '2.0',
      id: 12,
      method: 'tasks/send',
      params: { targetAgentId: 'dxos-analyst', prompt: 'Analyze KPIs' },
    },
  });
  assert.equal(opToRestrictedAnalyst.ctx.status, 403);

  // Root CAN invoke dxos-architect
  const rootToArch = await invokeMiddleware(mw, {
    token: 'tok-root-a',
    body: {
      jsonrpc: '2.0',
      id: 13,
      method: 'tasks/send',
      params: { targetAgentId: 'dxos-architect', prompt: 'Plan maintenance module' },
    },
  });
  assert.equal(rootToArch.ctx.status, 200);
  assert.equal(rootToArch.ctx.body.result.status.state, 'completed');
  assert.equal(rootToArch.ctx.body.result.targetAgentId, 'dxos-architect');
});

test('A2A tasks/get and tasks/cancel enforce target agent RBAC and non-admin task ownership within same organization', async () => {
  const db = makeMockDb({
    latticeEmployees: [
      { id: 1, userId: 1, organizationId: 'org-a', active: true },
      { id: 2, userId: 2, organizationId: 'org-a', active: true },
      { id: 5, userId: 5, organizationId: 'org-a', active: true },
      { id: 6, userId: 6, organizationId: 'org-a', active: true },
    ],
    rolesUsers: [
      { userId: 1, roleName: 'root' },
      { userId: 2, roleName: 'ldx_operator' },
      { userId: 5, roleName: 'ldx_employee' },
      { userId: 6, roleName: 'ldx_operator' },
    ],
  });
  const baseResolver = makeAuthResolver();
  const authResolver = async (token) => {
    if (token === 'tok-emp-a') return { currentUser: { id: 5, username: 'emp_a' }, currentRoles: ['ldx_employee'] };
    if (token === 'tok-op2-a') return { currentUser: { id: 6, username: 'op2_a' }, currentRoles: ['ldx_operator'] };
    return baseResolver(token);
  };

  const mw = createA2aMiddleware({
    db,
    authResolver,
    localExecutor: async ({ asyncMode, agentProfile }) => ({
      status: asyncMode ? 'working' : 'completed',
      messages: asyncMode ? [] : [{ role: 'agent', parts: [{ type: 'text', text: `Done by ${agentProfile.agentId}` }] }],
      artifacts: [],
    }),
  });

  // 1. Root creates an async dxos-architect task in org-a
  const archSend = await invokeMiddleware(mw, {
    token: 'tok-root-a',
    body: {
      jsonrpc: '2.0',
      id: 100,
      method: 'tasks/send',
      params: { id: 'arch-task-secret-1', targetAgentId: 'dxos-architect', async: true, prompt: 'Confidential architectural plan' },
    },
  });
  assert.equal(archSend.ctx.status, 200);

  // Same-org ldx_employee & ldx_operator CANNOT read or cancel admin-only dxos-architect task (403 / -32003)
  for (const tok of ['tok-emp-a', 'tok-op-a']) {
    const getArch = await invokeMiddleware(mw, {
      token: tok,
      body: { jsonrpc: '2.0', id: 101, method: 'tasks/get', params: { id: 'arch-task-secret-1' } },
    });
    assert.equal(getArch.ctx.status, 403);
    assert.equal(getArch.ctx.body.error.code, -32003);

    const cancelArch = await invokeMiddleware(mw, {
      token: tok,
      body: { jsonrpc: '2.0', id: 102, method: 'tasks/cancel', params: { id: 'arch-task-secret-1' } },
    });
    assert.equal(cancelArch.ctx.status, 403);
    assert.equal(cancelArch.ctx.body.error.code, -32003);
  }

  // 2. Operator #1 creates an async dxos-operator task in org-a; Operator #2 cannot read or cancel Operator #1's task
  const opSend = await invokeMiddleware(mw, {
    token: 'tok-op-a',
    body: {
      jsonrpc: '2.0',
      id: 103,
      method: 'tasks/send',
      params: { id: 'op-task-private-1', targetAgentId: 'dxos-operator', async: true, prompt: 'Operator 1 private workflow' },
    },
  });
  assert.equal(opSend.ctx.status, 200);

  const otherOpGet = await invokeMiddleware(mw, {
    token: 'tok-op2-a',
    body: { jsonrpc: '2.0', id: 104, method: 'tasks/get', params: { id: 'op-task-private-1' } },
  });
  assert.equal(otherOpGet.ctx.status, 403);
  assert.equal(otherOpGet.ctx.body.error.code, -32003);

  const otherOpCancel = await invokeMiddleware(mw, {
    token: 'tok-op2-a',
    body: { jsonrpc: '2.0', id: 105, method: 'tasks/cancel', params: { id: 'op-task-private-1' } },
  });
  assert.equal(otherOpCancel.ctx.status, 403);
  assert.equal(otherOpCancel.ctx.body.error.code, -32003);

  // Admin/root CAN still read and cancel both tasks
  const rootGetArch = await invokeMiddleware(mw, {
    token: 'tok-root-a',
    body: { jsonrpc: '2.0', id: 106, method: 'tasks/get', params: { id: 'arch-task-secret-1' } },
  });
  assert.equal(rootGetArch.ctx.status, 200);
  assert.equal(rootGetArch.ctx.body.result.targetAgentId, 'dxos-architect');

  const rootCancelOp = await invokeMiddleware(mw, {
    token: 'tok-root-a',
    body: { jsonrpc: '2.0', id: 107, method: 'tasks/cancel', params: { id: 'op-task-private-1' } },
  });
  assert.equal(rootCancelOp.ctx.status, 200);
  assert.equal(rootCancelOp.ctx.body.result.status.state, 'canceled');
});

test('A2A tasks/send idempotencyKey replay enforces targetAgent RBAC and non-admin creator ownership', async () => {
  const db = makeMockDb({
    latticeEmployees: [
      { id: 1, userId: 1, organizationId: 'org-a', active: true },
      { id: 2, userId: 2, organizationId: 'org-a', active: true },
      { id: 5, userId: 5, organizationId: 'org-a', active: true },
      { id: 6, userId: 6, organizationId: 'org-a', active: true },
    ],
    rolesUsers: [
      { userId: 1, roleName: 'root' },
      { userId: 2, roleName: 'ldx_operator' },
      { userId: 5, roleName: 'ldx_employee' },
      { userId: 6, roleName: 'ldx_operator' },
    ],
  });
  const baseResolver = makeAuthResolver();
  const authResolver = async (token) => {
    if (token === 'tok-emp-a') return { currentUser: { id: 5, username: 'emp_a' }, currentRoles: ['ldx_employee'] };
    if (token === 'tok-op2-a') return { currentUser: { id: 6, username: 'op2_a' }, currentRoles: ['ldx_operator'] };
    return baseResolver(token);
  };

  const mw = createA2aMiddleware({
    db,
    authResolver,
    localExecutor: async ({ asyncMode, agentProfile }) => ({
      status: asyncMode ? 'working' : 'completed',
      messages: asyncMode ? [] : [{ role: 'agent', parts: [{ type: 'text', text: `Done by ${agentProfile.agentId}` }] }],
      artifacts: [],
    }),
  });

  // 1. Admin creates dxos-architect task with idempotencyKey
  const archSend = await invokeMiddleware(mw, {
    token: 'tok-root-a',
    body: {
      jsonrpc: '2.0',
      id: 200,
      method: 'tasks/send',
      params: {
        id: 'arch-idem-task-1',
        targetAgentId: 'dxos-architect',
        idempotencyKey: 'idem-arch-secret',
        prompt: 'Top secret architect blueprint',
      },
    },
  });
  assert.equal(archSend.ctx.status, 200);

  // Same-org ldx_employee calling tasks/send with allowed dxos-coordinator + admin's idempotencyKey MUST reject 403 / -32003
  const empReplayArch = await invokeMiddleware(mw, {
    token: 'tok-emp-a',
    body: {
      jsonrpc: '2.0',
      id: 201,
      method: 'tasks/send',
      params: {
        targetAgentId: 'dxos-coordinator',
        idempotencyKey: 'idem-arch-secret',
        prompt: 'Probe architect task',
      },
    },
  });
  assert.equal(empReplayArch.ctx.status, 403);
  assert.equal(empReplayArch.ctx.body.error.code, -32003);

  // 2. Operator #1 (user 2) creates dxos-operator task with idempotencyKey
  const op1Send = await invokeMiddleware(mw, {
    token: 'tok-op-a',
    body: {
      jsonrpc: '2.0',
      id: 202,
      method: 'tasks/send',
      params: {
        id: 'op1-idem-task-1',
        targetAgentId: 'dxos-operator',
        idempotencyKey: 'idem-op1-private',
        prompt: 'Operator 1 private command',
      },
    },
  });
  assert.equal(op1Send.ctx.status, 200);

  // Another ldx_operator (user 6) replaying user 2's idempotencyKey MUST reject 403 / -32003
  const op2ReplayOp1 = await invokeMiddleware(mw, {
    token: 'tok-op2-a',
    body: {
      jsonrpc: '2.0',
      id: 203,
      method: 'tasks/send',
      params: {
        targetAgentId: 'dxos-operator',
        idempotencyKey: 'idem-op1-private',
        prompt: 'Replay op1 key',
      },
    },
  });
  assert.equal(op2ReplayOp1.ctx.status, 403);
  assert.equal(op2ReplayOp1.ctx.body.error.code, -32003);

  // 3. Same creator (user 2) replaying their own idempotencyKey returns 200 with the same task
  const op1SelfReplay = await invokeMiddleware(mw, {
    token: 'tok-op-a',
    body: {
      jsonrpc: '2.0',
      id: 204,
      method: 'tasks/send',
      params: {
        targetAgentId: 'dxos-operator',
        idempotencyKey: 'idem-op1-private',
        prompt: 'Operator 1 private command',
      },
    },
  });
  assert.equal(op1SelfReplay.ctx.status, 200);
  assert.equal(op1SelfReplay.ctx.body.result.id, 'op1-idem-task-1');

  // 4. Legacy/unowned task (missing createdById) cannot be replayed by non-admin
  db.store.latticeA2aTasks.push({
    id: 999,
    taskId: 'orphan-idem-task',
    organizationId: 'org-a',
    targetAgentId: 'dxos-operator',
    status: 'completed',
    messagesJson: [{ role: 'user', parts: [{ type: 'text', text: 'Orphan secret' }] }],
    artifactsJson: [],
    metadataJson: {},
    createdById: null,
    idempotencyKey: 'idem-orphan',
  });
  const op1ReplayOrphan = await invokeMiddleware(mw, {
    token: 'tok-op-a',
    body: {
      jsonrpc: '2.0',
      id: 205,
      method: 'tasks/send',
      params: {
        targetAgentId: 'dxos-operator',
        idempotencyKey: 'idem-orphan',
        prompt: 'Try orphan key',
      },
    },
  });
  assert.equal(op1ReplayOrphan.ctx.status, 403);
  assert.equal(op1ReplayOrphan.ctx.body.error.code, -32003);

  assert.equal(
    db.store.latticeAiAuditLogs.filter((l) => l.toolName === 'a2a:tasks/send' && l.status === 'denied').length >= 3,
    true,
  );
});

test('A2A JSON-RPC executes tasks/send -> tasks/get -> tasks/cancel and enforces cross-tenant organizationId isolation', async () => {
  const db = makeMockDb();
  const mw = createA2aMiddleware({
    db,
    authResolver: makeAuthResolver(),
    localExecutor: async ({ actor, agentProfile, taskId, asyncMode }) => ({
      status: asyncMode ? 'working' : 'completed',
      messages: asyncMode
        ? []
        : [{ role: 'agent', parts: [{ type: 'text', text: `Handled by ${agentProfile.agentId} for ${actor.organizationId}` }] }],
      artifacts: asyncMode ? [] : [{ name: 'result', parts: [{ type: 'data', data: { taskId } }] }],
    }),
  });

  // 1. Cross-org spoofing in params/metadata/header -> 403
  const spoofParam = await invokeMiddleware(mw, {
    token: 'tok-op-a',
    body: {
      jsonrpc: '2.0',
      id: 20,
      method: 'tasks/send',
      params: { organizationId: 'org-b', targetAgentId: 'dxos-operator', prompt: 'Spoofed' },
    },
  });
  assert.equal(spoofParam.ctx.status, 403);
  assert.equal(spoofParam.ctx.body.error.code, -32003);

  const spoofHeader = await invokeMiddleware(mw, {
    token: 'tok-op-a',
    headers: { 'x-organization-id': 'org-b' },
    body: {
      jsonrpc: '2.0',
      id: 21,
      method: 'tasks/get',
      params: { id: 'any-task' },
    },
  });
  assert.equal(spoofHeader.ctx.status, 403);

  // 2. Async tasks/send in org-a -> working
  const sendRes = await invokeMiddleware(mw, {
    token: 'tok-op-a',
    body: {
      jsonrpc: '2.0',
      id: 22,
      method: 'tasks/send',
      params: {
        id: 'task-org-a-1',
        targetAgentId: 'dxos-operator',
        blocking: false,
        idempotencyKey: 'idem-a-1',
        message: { role: 'user', parts: [{ type: 'text', text: 'Inspect cold room A1' }] },
      },
    },
  });
  assert.equal(sendRes.ctx.status, 200);
  assert.equal(sendRes.ctx.body.result.id, 'task-org-a-1');
  assert.equal(sendRes.ctx.body.result.organizationId, 'org-a');
  assert.equal(sendRes.ctx.body.result.status.state, 'working');

  // Idempotent replay returns same task
  const replayRes = await invokeMiddleware(mw, {
    token: 'tok-op-a',
    body: {
      jsonrpc: '2.0',
      id: 23,
      method: 'tasks/send',
      params: {
        id: 'task-org-a-duplicate-attempt',
        targetAgentId: 'dxos-operator',
        idempotencyKey: 'idem-a-1',
        prompt: 'Inspect cold room A1',
      },
    },
  });
  assert.equal(replayRes.ctx.status, 200);
  assert.equal(replayRes.ctx.body.result.id, 'task-org-a-1');

  // 3. Cross-tenant isolation: org-b caller cannot tasks/get or tasks/cancel org-a task
  const crossGet = await invokeMiddleware(mw, {
    token: 'tok-op-b',
    body: { jsonrpc: '2.0', id: 24, method: 'tasks/get', params: { id: 'task-org-a-1' } },
  });
  assert.equal(crossGet.ctx.status, 404);

  const crossCancel = await invokeMiddleware(mw, {
    token: 'tok-op-b',
    body: { jsonrpc: '2.0', id: 25, method: 'tasks/cancel', params: { id: 'task-org-a-1' } },
  });
  assert.equal(crossCancel.ctx.status, 404);

  // 4. Same-tenant tasks/get -> working, tasks/cancel -> canceled, second cancel -> 409
  const getRes = await invokeMiddleware(mw, {
    token: 'tok-op-a',
    body: { jsonrpc: '2.0', id: 26, method: 'tasks/get', params: { id: 'task-org-a-1' } },
  });
  assert.equal(getRes.ctx.status, 200);
  assert.equal(getRes.ctx.body.result.status.state, 'working');

  const cancelRes = await invokeMiddleware(mw, {
    token: 'tok-op-a',
    body: { jsonrpc: '2.0', id: 27, method: 'tasks/cancel', params: { id: 'task-org-a-1', reason: 'Operator aborted' } },
  });
  assert.equal(cancelRes.ctx.status, 200);
  assert.equal(cancelRes.ctx.body.result.status.state, 'canceled');
  assert.equal(cancelRes.ctx.body.result.state, 'canceled');

  const doubleCancel = await invokeMiddleware(mw, {
    token: 'tok-op-a',
    body: { jsonrpc: '2.0', id: 28, method: 'tasks/cancel', params: { id: 'task-org-a-1' } },
  });
  assert.equal(doubleCancel.ctx.status, 409);
  assert.equal(doubleCancel.ctx.body.error.code, -32004);
});

test('Outbound peerUrl delegation rejects SSRF targets (loopback, metadata, RFC1918, IPv6, DNS rebinding) and succeeds for safe public peers', async () => {
  const blockedUrls = [
    'http://127.0.0.1:8080/api/a2a',
    'http://169.254.169.254/latest/meta-data',
    'http://10.0.0.1/api/a2a',
    'http://172.16.0.5/api/a2a',
    'http://192.168.1.10/api/a2a',
    'http://localhost:3000/api/a2a',
    'http://[::1]:8080/api/a2a',
    'http://[fe80::1]/api/a2a',
    'http://[fd00:ec2::254]/latest',
    'http://[::ffff:127.0.0.1]/api/a2a',
    'http://[::ffff:169.254.169.254]/api/a2a',
    'http://metadata.google.internal/computeMetadata/v1',
    'https://user:secret@partner.example.com/a2a',
    'file:///etc/passwd',
  ];

  const db = makeMockDb();
  let fetchCalled = false;
  const mw = createA2aMiddleware({
    db,
    authResolver: makeAuthResolver(),
    fetchImpl: async () => {
      fetchCalled = true;
      return { ok: true, status: 200, json: async () => ({}) };
    },
  });

  for (const badUrl of blockedUrls) {
    await assert.rejects(
      () => assertSafePeerUrl(badUrl, { skipDnsCheck: true }),
      (err) => err?.code === 'A2A_PEER_URL_UNSAFE',
      `assertSafePeerUrl must reject ${badUrl}`,
    );

    const rpcRes = await invokeMiddleware(mw, {
      token: 'tok-op-a',
      body: {
        jsonrpc: '2.0',
        id: 30,
        method: 'tasks/send',
        params: { targetAgentId: 'dxos-operator', peerUrl: badUrl, prompt: 'Ping peer' },
      },
    });
    assert.equal(rpcRes.ctx.status, 400, `RPC must reject SSRF URL ${badUrl}`);
    assert.equal(rpcRes.ctx.body.error.code, -32602);
  }
  assert.equal(fetchCalled, false);

  // DNS rebinding check
  await assert.rejects(
    () => assertSafePeerUrl('https://rebind.partner.example/a2a', {
      lookupImpl: async () => [{ address: '127.0.0.1', family: 4 }],
    }),
    (err) => err?.code === 'A2A_PEER_URL_UNSAFE',
  );
  await assert.rejects(
    () => assertSafePeerUrl('https://rebind6.partner.example/a2a', {
      lookupImpl: async () => [{ address: 'fe80::1', family: 6 }],
    }),
    (err) => err?.code === 'A2A_PEER_URL_UNSAFE',
  );

  // Valid external peer with mocked DNS + fetch
  const outboundCalls = [];
  const peerRes = await delegateToExternalA2aPeer({
    peerUrl: 'https://partner-agent.example.com/a2a',
    taskId: 'ext-task-1',
    message: { role: 'user', parts: [{ type: 'text', text: 'Check shipment lot LOT-01 contact alice@corp.vn' }] },
    metadata: { route: 'cold-chain' },
    headers: { authorization: 'Bearer internal-secret-must-not-leak', 'x-trace-id': 'trace-1' },
    lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
    fetchImpl: async (url, init) => {
      outboundCalls.push({ url, init });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          jsonrpc: '2.0',
          id: 'ext-task-1',
          result: {
            id: 'ext-task-1',
            status: { state: 'completed' },
            messages: [{ role: 'agent', parts: [{ type: 'text', text: 'Peer confirmed LOT-01' }] }],
            artifacts: [{ name: 'peer-receipt', parts: [{ type: 'data', data: { ok: true } }] }],
          },
        }),
      };
    },
  });

  assert.equal(peerRes.ok, true);
  assert.equal(peerRes.status, 'completed');
  assert.equal(outboundCalls.length, 1);
  assert.equal(outboundCalls[0].init.redirect, 'error');
  assert.equal(outboundCalls[0].init.headers.authorization, undefined);
  assert.equal(outboundCalls[0].init.headers['x-trace-id'], 'trace-1');
  assert.equal(outboundCalls[0].init.body.includes('alice@corp.vn'), false);
  assert.equal(outboundCalls[0].init.body.includes('[REDACTED_EMAIL]'), true);

  // End-to-end tasks/send with peerUrl through middleware
  const safeMw = createA2aMiddleware({
    db,
    authResolver: makeAuthResolver(),
    lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        jsonrpc: '2.0',
        id: 'ext-rpc-1',
        result: {
          id: 'ext-rpc-1',
          status: { state: 'completed' },
          messages: [{ role: 'agent', parts: [{ type: 'text', text: 'External ack' }] }],
        },
      }),
    }),
  });
  const extRpcRes = await invokeMiddleware(safeMw, {
    token: 'tok-op-a',
    body: {
      jsonrpc: '2.0',
      id: 31,
      method: 'tasks/send',
      params: {
        id: 'ext-rpc-1',
        targetAgentId: 'dxos-operator',
        peerUrl: 'https://partner-agent.example.com/a2a',
        prompt: 'Sync cold chain status',
      },
    },
  });
  assert.equal(extRpcRes.ctx.status, 200);
  assert.equal(extRpcRes.ctx.body.result.status.state, 'completed');
  assert.equal(extRpcRes.ctx.body.result.peerUrl, 'https://partner-agent.example.com/a2a');
});

test('A2A JSON-RPC rejects prototype pollution payloads in params and metadata', async () => {
  const db = makeMockDb();
  const mw = createA2aMiddleware({ db, authResolver: makeAuthResolver() });

  const jsonPolluted = JSON.parse(
    '{"jsonrpc":"2.0","id":40,"method":"tasks/send","params":{"targetAgentId":"dxos-operator","prompt":"hi","__proto__":{"polluted":true}}}',
  );
  const res1 = await invokeMiddleware(mw, { token: 'tok-op-a', body: jsonPolluted });
  assert.equal(res1.ctx.status, 400);
  assert.equal(res1.ctx.body.error.code, -32602);
  assert.equal({}.polluted, undefined);

  const nestedPolluted = JSON.parse(
    '{"jsonrpc":"2.0","id":41,"method":"tasks/send","params":{"targetAgentId":"dxos-operator","prompt":"hi","metadata":{"constructor":{"prototype":{"pwned":true}}}}}',
  );
  const res2 = await invokeMiddleware(mw, { token: 'tok-op-a', body: nestedPolluted });
  assert.equal(res2.ctx.status, 400);
  assert.equal(res2.ctx.body.error.code, -32602);
  assert.equal({}.pwned, undefined);

  // Direct handleA2aJsonRpc with JS literal __proto__
  const ctxDirect = {
    path: A2A_RPC_PATH,
    method: 'POST',
    headers: {},
    request: {
      body: {
        jsonrpc: '2.0',
        id: 42,
        method: 'tasks/send',
        params: {
          targetAgentId: 'dxos-operator',
          prompt: 'hi',
          metadata: { __proto__: { hacked: true } },
        },
      },
    },
    state: { currentUser: { id: 2, username: 'op_a' }, currentRoles: ['ldx_operator'] },
  };
  await handleA2aJsonRpc(ctxDirect, { db });
  assert.equal(ctxDirect.status, 400);
  assert.equal(ctxDirect.body.error.code, -32602);
  assert.equal({}.hacked, undefined);
});

test('latticeA2aTasks collection and 20261202000500-a2a-tasks-rls migration enforce FORCE ROW LEVEL SECURITY', async () => {
  const origLoad = Module._load;
  class MockMigration {
    constructor(context) { this.context = context; }
  }
  Module._load = function mockedNocobase(request, parent, isMain) {
    if (request === '@nocobase/server') return { Migration: MockMigration };
    if (request === '@nocobase/database') return { defineCollection: (def) => def };
    return origLoad.call(this, request, parent, isMain);
  };

  let collectionDef;
  let MigrationCls;
  try {
    const colPath = path.resolve(__dirname, '../src/server/collections/a2a-tasks.js');
    const migPath = path.resolve(__dirname, '../src/server/migrations/20261202000500-a2a-tasks-rls.js');
    delete require.cache[colPath];
    delete require.cache[migPath];
    collectionDef = require(colPath);
    MigrationCls = require(migPath);
  } finally {
    Module._load = origLoad;
  }

  assert.equal(collectionDef.name, 'latticeA2aTasks');
  const fieldNames = new Set(collectionDef.fields.map((f) => f.name));
  for (const col of [
    'taskId', 'organizationId', 'sourceAgentId', 'targetAgentId', 'peerUrl',
    'status', 'messagesJson', 'artifactsJson', 'metadataJson', 'errorJson',
    'createdById', 'idempotencyKey',
  ]) {
    assert.equal(fieldNames.has(col), true, `Missing field ${col} on latticeA2aTasks`);
  }

  // 1. db.attachLatticeRlsPolicy hook
  const attached = [];
  const tx1 = { id: 'tx1' };
  const migHook = new MigrationCls({
    db: {
      attachLatticeRlsPolicy: async (tableName, opts) => attached.push({ tableName, tx: opts?.transaction }),
      sequelize: {
        getDialect: () => 'postgres',
        transaction: async (fn) => fn(tx1),
        query: async () => [[]],
      },
    },
  });
  assert.equal(migHook.on, 'afterSync');
  await migHook.up();
  assert.deepEqual(attached, [{ tableName: 'latticeA2aTasks', tx: tx1 }]);

  // 2. pg-rls attachRlsPolicyToTable fallback
  const sqlLog = [];
  const tx2 = { id: 'tx2' };
  const migPgRls = new MigrationCls({
    db: {
      sequelize: {
        getDialect: () => 'postgres',
        transaction: async (fn) => fn(tx2),
        query: async (sql, opts) => { sqlLog.push({ sql, opts }); return [[]]; },
      },
    },
  });
  await migPgRls.up();
  assert.equal(
    sqlLog.some((q) => q.sql.includes('ALTER TABLE public."latticeA2aTasks" ENABLE ROW LEVEL SECURITY')
      && q.sql.includes('ALTER TABLE public."latticeA2aTasks" FORCE ROW LEVEL SECURITY')
      && q.opts?.transaction === tx2),
    true,
  );
  assert.equal(
    sqlLog.some((q) => q.sql.includes('CREATE POLICY lattice_tenant_isolation ON public."latticeA2aTasks"')
      && q.sql.includes('TO PUBLIC')),
    true,
  );

  // 3. down() removes policy and disables FORCE RLS
  sqlLog.length = 0;
  await migPgRls.down();
  assert.equal(sqlLog.some((q) => q.sql.includes('DROP POLICY IF EXISTS lattice_tenant_isolation ON public."latticeA2aTasks"')), true);
  assert.equal(sqlLog.some((q) => q.sql.includes('NO FORCE ROW LEVEL SECURITY')), true);
  assert.equal(sqlLog.some((q) => q.sql.includes('DISABLE ROW LEVEL SECURITY')), true);

  // 4. Direct SQL fallback when pg-rls is absent
  const origLoadSql = Module._load;
  Module._load = function mockedMissingPgRls(request, parent, isMain) {
    if (request === '@nocobase/server') return { Migration: MockMigration };
    if (typeof request === 'string' && request.includes('pg-rls')) {
      const err = new Error('Cannot find pg-rls');
      err.code = 'MODULE_NOT_FOUND';
      err.requireStack = [path.resolve(__dirname, '../src/server/migrations/20261202000500-a2a-tasks-rls.js')];
      throw err;
    }
    return origLoadSql.call(this, request, parent, isMain);
  };
  try {
    const migPath = path.resolve(__dirname, '../src/server/migrations/20261202000500-a2a-tasks-rls.js');
    delete require.cache[migPath];
    const FallbackMig = require(migPath);
    const fallbackSql = [];
    await new FallbackMig({
      db: {
        sequelize: {
          getDialect: () => 'postgres',
          transaction: async (fn) => fn({ id: 'tx3' }),
          query: async (sql) => { fallbackSql.push(sql); return [[]]; },
        },
      },
    }).up();
    assert.equal(fallbackSql.some((s) => s.includes('FORCE ROW LEVEL SECURITY')), true);
    assert.equal(fallbackSql.some((s) => s.includes('TO PUBLIC')), true);
  } finally {
    Module._load = origLoadSql;
  }

  // 5. SQLite skips RLS cleanly
  const sqliteSql = [];
  await new MigrationCls({
    db: {
      sequelize: {
        getDialect: () => 'sqlite',
        transaction: async (fn) => fn({}),
        query: async (sql) => { sqliteSql.push(sql); return [[]]; },
      },
    },
  }).up();
  assert.equal(sqliteSql.some((s) => /ROW LEVEL SECURITY|CREATE POLICY/i.test(s)), false);
});
