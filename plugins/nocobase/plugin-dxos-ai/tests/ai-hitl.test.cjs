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
const { readFileSync } = require('node:fs');
const Module = require('node:module');
const path = require('node:path');

const PLUGIN_ROOT = path.resolve(__dirname, '..');

function makeHitlHarness() {
  const store = {
    latticeAiProfiles: [
      {
        id: 1,
        username: 'dxos-ops',
        enabled: true,
        toolPermissions: { dxos_execute_record_action: 'ASK', dxos_search_enterprise_context: 'ALLOW' },
      },
      {
        id: 2,
        username: 'dxos-auto',
        enabled: true,
        toolPermissions: { dxos_execute_record_action: 'ALLOW' },
      },
      {
        id: 3,
        username: 'dxos-off',
        enabled: true,
        toolPermissions: { dxos_execute_record_action: 'OFF' },
      },
      {
        id: 4,
        username: 'dxos-disabled',
        enabled: false,
        toolPermissions: { dxos_execute_record_action: 'ALLOW' },
      },
    ],
    latticeAiApprovalQueue: [],
    latticeNotifications: [],
    latticeAiAuditLogs: [],
    latticeAiQuotaUsage: [],
    latticeServiceTickets: [
      { id: 10, code: 'SRV-EXIST-10', name: 'Kiểm tra máy nén A1', organizationId: 'org-a', status: 'draft', requesterId: 13 },
      { id: 11, code: 'SRV-ORG-B', name: 'Phiếu org B', organizationId: 'org-b', status: 'draft', requesterId: 91 },
    ],
    latticeParaDocuments: [
      { id: 20, code: 'PARA-A-20', title: 'SOP Kho A', organizationId: 'org-a', paraSpace: 'resources', ownerId: 13, status: 'active' },
    ],
    latticeCustomColdAudits: [
      { id: 30, code: 'QA-30', name: 'Audit A1', temperatureC: -18, organizationId: 'org-a', status: 'draft', requesterId: 13 },
    ],
    latticeEmployees: [
      { id: 13, userId: 9, code: 'EMP-9', organizationId: 'org-a', active: true },
      { id: 14, userId: 10, code: 'MGR-10', organizationId: 'org-a', active: true },
      { id: 15, userId: 11, code: 'EMP-11', organizationId: 'org-a', active: true },
      { id: 21, userId: 20, code: 'MGR-20', organizationId: 'org-b', active: true },
    ],
    roles: [
      { name: 'root', allowConfigure: true, snippets: ['*'] },
      { name: 'admin', allowConfigure: true, snippets: ['pm'] },
      { name: 'ldx_manager', allowConfigure: false, snippets: [] },
      { name: 'ldx_employee', allowConfigure: false, snippets: [] },
    ],
    rolesUsers: [
      { userId: 1, roleName: 'root' },
      { userId: 9, roleName: 'ldx_employee' },
      { userId: 10, roleName: 'ldx_manager' },
      { userId: 11, roleName: 'ldx_employee' },
      { userId: 20, roleName: 'ldx_manager' },
    ],
    collections: [{ name: 'latticeCustomColdAudits', title: 'Cold Audits' }],
    dataSourcesRolesResources: [
      {
        roleName: 'ldx_employee',
        name: 'latticeServiceTickets',
        dataSourceKey: 'main',
        usingActionsConfig: true,
        actions: [
          { name: 'view', fields: ['id', 'code', 'name', 'status', 'requesterId'] },
          { name: 'create', fields: ['code', 'name', 'serviceType', 'priority', 'description'] },
          { name: 'update', fields: ['name', 'description', 'priority'] },
        ],
      },
      {
        roleName: 'ldx_manager',
        name: 'latticeServiceTickets',
        dataSourceKey: 'main',
        usingActionsConfig: true,
        actions: [
          { name: 'view', fields: ['id', 'code', 'name', 'status', 'requesterId'] },
          { name: 'create', fields: ['code', 'name', 'serviceType', 'priority', 'description'] },
          { name: 'update', fields: ['name', 'description', 'priority'] },
        ],
      },
      {
        roleName: 'ldx_employee',
        name: 'latticeCustomColdAudits',
        dataSourceKey: 'main',
        usingActionsConfig: true,
        actions: [
          { name: 'view', fields: ['id', 'code', 'name', 'temperatureC', 'auditVerdict', 'status'] },
          { name: 'create', fields: ['code', 'name', 'temperatureC'] },
        ],
      },
      {
        roleName: 'ldx_manager',
        name: 'latticeCustomColdAudits',
        dataSourceKey: 'main',
        usingActionsConfig: true,
        actions: [
          { name: 'view', fields: ['id', 'code', 'name', 'temperatureC', 'auditVerdict', 'status'] },
          { name: 'create', fields: ['code', 'name', 'temperatureC'] },
          { name: 'update', fields: ['name', 'temperatureC', 'auditVerdict'] },
        ],
      },
    ],
  };

  let seq = 100;
  const matchFilter = (row, filter = {}) => Object.entries(filter).every(([k, cond]) => {
    if (cond && typeof cond === 'object' && '$in' in cond) return cond.$in.includes(row[k]);
    return row[k] === cond;
  });

  const wrap = (row) => ({
    ...row,
    get: (k) => row[k],
    set: (k, v) => { row[k] = v; },
    toJSON: () => ({ ...row }),
    update: async (patch = {}) => { Object.assign(row, patch); return wrap(row); },
  });

  const db = {
    store,
    hasCollection: (name) => Object.prototype.hasOwnProperty.call(store, name),
    sequelize: { transaction: async (fn) => fn({}) },
    getRepository(name) {
      const arr = store[name];
      if (!arr) return null;
      return {
        find: async ({ filter = {}, sort, limit = 50 } = {}) => {
          let rows = arr.filter((r) => matchFilter(r, filter));
          if (Array.isArray(sort) && sort.includes('-id')) {
            rows = [...rows].sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
          }
          return rows.slice(0, limit).map(wrap);
        },
        findOne: async ({ filter = {}, filterByTk } = {}) => {
          const hit = filterByTk != null
            ? arr.find((r) => String(r.id ?? r.username ?? r.name) === String(filterByTk))
            : arr.find((r) => matchFilter(r, filter));
          return hit ? wrap(hit) : null;
        },
        create: async ({ values = {} } = {}) => {
          const row = { id: ++seq, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...values };
          arr.push(row);
          return wrap(row);
        },
        update: async ({ filter = {}, filterByTk, values = {} } = {}) => {
          const matched = [];
          for (const row of arr) {
            if (filterByTk != null && String(row.id) !== String(filterByTk)) continue;
            if (!matchFilter(row, filter)) continue;
            Object.assign(row, values, { updatedAt: new Date().toISOString() });
            matched.push(wrap(row));
          }
          return matched;
        },
        count: async ({ filter = {} } = {}) => arr.filter((r) => matchFilter(r, filter)).length,
      };
    },
  };

  const makeCtx = ({ userId, username, roles, dxosAiUsername = null, values, params = {}, method } = {}) => ({
    db,
    method,
    state: {
      currentUser: { id: userId, username },
      currentRoles: roles,
      currentRole: roles[0],
      ...(dxosAiUsername ? { dxosAiUsername } : {}),
    },
    action: {
      params: {
        ...params,
        ...(values !== undefined ? { values } : {}),
      },
    },
    app: { resourceManager: { getResource: () => null } },
  });

  return { db, store, makeCtx };
}

test('latticeAiApprovalQueue schema, migration 20261123000400, and SYSTEM_PROTECTED_COLLECTIONS lock are defined', async () => {
  const { aiApprovalQueue } = require(path.join(PLUGIN_ROOT, 'src/server/ai-schemas.js'));
  const { SYSTEM_PROTECTED_COLLECTIONS } = require(path.join(PLUGIN_ROOT, 'src/server/ai-tools-core.js'));

  assert.ok(aiApprovalQueue, 'aiApprovalQueue schema must be exported from ai-schemas.js');
  assert.equal(aiApprovalQueue.name, 'latticeAiApprovalQueue');
  assert.equal(SYSTEM_PROTECTED_COLLECTIONS.has('latticeAiApprovalQueue'), true);

  const fields = aiApprovalQueue.fields.map((f) => f.name);
  for (const requiredField of [
    'organizationId', 'requesterUserId', 'requesterUsername', 'aiEmployee',
    'toolName', 'targetCollection', 'targetRecordId', 'operation',
    'proposedArgs', 'diffPreview', 'riskLevel', 'status',
    'decidedByUserId', 'decidedByUsername', 'decisionNote', 'decidedAt',
    'executionResult', 'expiresAt',
  ]) {
    assert.equal(fields.includes(requiredField), true, `Missing field ${requiredField}`);
  }

  const colSrc = readFileSync(path.join(PLUGIN_ROOT, 'src/server/collections/ai-approval-queue.js'), 'utf8');
  assert.match(colSrc, /aiApprovalQueue/);

  const migPath = path.join(PLUGIN_ROOT, 'src/server/migrations/20261123000400-ai-hitl-approvals.js');
  const migSrc = readFileSync(migPath, 'utf8');
  assert.match(migSrc, /CREATE TABLE IF NOT EXISTS "latticeAiApprovalQueue"/);
  assert.match(migSrc, /idx_lattice_ai_hitl_org_status_created/);
  assert.match(migSrc, /DROP TABLE IF EXISTS "latticeAiApprovalQueue"/);

  const origLoad = Module._load;
  const executedSql = [];
  class MockMigration { constructor(context) { this.context = context; } }
  Module._load = function (req, parent, isMain) {
    if (req === '@nocobase/server') return { Migration: MockMigration };
    return origLoad.call(this, req, parent, isMain);
  };
  try {
    const MigClass = require(migPath);
    const mig = new MigClass({
      db: {
        sequelize: {
          transaction: async (fn) => fn({}),
          query: async (sql) => { executedSql.push(sql); return [[], 0]; },
        },
      },
    });
    await mig.up();
    await mig.down();
    assert.equal(executedSql.some((s) => /CREATE TABLE IF NOT EXISTS "latticeAiApprovalQueue"/.test(s)), true);
    assert.equal(executedSql.some((s) => /idx_lattice_ai_hitl_org_status_created/.test(s)), true);
    assert.equal(executedSql.some((s) => /DROP TABLE IF EXISTS "latticeAiApprovalQueue"/.test(s)), true);
  } finally {
    Module._load = origLoad;
  }
});

test('resolveEffectiveToolMode & enqueueAiApproval handle ASK/ALLOW/OFF, 24h expiry, and Wave 2 notifications', async () => {
  const {
    resolveEffectiveToolMode,
    enqueueAiApproval,
  } = require(path.join(PLUGIN_ROOT, 'src/server/ai-hitl.js'));
  const { db, store } = makeHitlHarness();

  assert.equal(await resolveEffectiveToolMode(db, { aiEmployee: 'dxos-ops', toolName: 'dxos_execute_record_action' }), 'ASK');
  assert.equal(await resolveEffectiveToolMode(db, { aiEmployee: 'dxos-auto', toolName: 'dxos_execute_record_action' }), 'ALLOW');
  assert.equal(await resolveEffectiveToolMode(db, { aiEmployee: 'dxos-off', toolName: 'dxos_execute_record_action' }), 'OFF');
  assert.equal(await resolveEffectiveToolMode(db, { aiEmployee: 'dxos-disabled', toolName: 'dxos_execute_record_action' }), 'OFF');
  assert.equal(await resolveEffectiveToolMode(db, { aiEmployee: null, toolName: 'dxos_execute_record_action', defaultPermission: 'ASK' }), 'ASK');

  const queued = await enqueueAiApproval(db, {
    actor: { userId: 9, username: 'emp9', organizationId: 'org-a', employeeId: 13 },
    aiEmployee: 'dxos-ops',
    toolName: 'dxos_execute_record_action',
    targetCollection: 'latticeServiceTickets',
    targetRecordId: 10,
    operation: 'update',
    proposedArgs: { collection: 'latticeServiceTickets', operation: 'update', recordId: 10, values: { priority: 'high' } },
    diffPreview: { before: { priority: 'low' }, after: { priority: 'high' }, changes: [{ field: 'priority', before: 'low', after: 'high' }] },
    riskLevel: 'high',
  });

  assert.equal(queued.status, 'pending');
  assert.equal(queued.organizationId, 'org-a');
  assert.equal(queued.requesterUserId, 9);
  assert.ok(new Date(queued.expiresAt).getTime() > Date.now() + 23 * 60 * 60 * 1000);
  assert.equal(store.latticeAiApprovalQueue.length, 1);

  // Wave 2 notification emitted to org-a manager (userId=10, employeeId=14), NOT org-b manager (userId=20) and NOT requester (userId=9)
  assert.equal(store.latticeNotifications.length, 1);
  const notif = store.latticeNotifications[0];
  assert.equal(notif.organizationId, 'org-a');
  assert.equal(notif.recipientUserId, 10);
  assert.equal(notif.recipientEmployeeId, 14);
  assert.equal(notif.category, 'approval');
  assert.equal(notif.targetCollection, 'latticeAiApprovalQueue');
  assert.equal(notif.targetRecordId, queued.id);
  assert.equal(notif.targetPath, '/admin/settings/dxos-ai');
  assert.deepEqual(notif.channelsDispatched, ['in_app']);
  assert.equal(notif.active, true);
});

test('dxos_execute_record_action intercepts ASK mode & requireApproval=true without mutating, enforces RBAC before queuing, and executes via approveAction', async () => {
  const { createDxosTools } = require(path.join(PLUGIN_ROOT, 'src/server/ai-tools-core.js'));
  const { createDxosAiActions } = require(path.join(PLUGIN_ROOT, 'src/server/ai-resource.js'));
  const { db, store, makeCtx } = makeHitlHarness();

  const execTool = createDxosTools().find((t) => t.definition.name === 'dxos_execute_record_action');
  const actions = createDxosAiActions(db);
  const empAskCtx = makeCtx({ userId: 9, username: 'emp9', roles: ['ldx_employee'], dxosAiUsername: 'dxos-ops' });

  // 1. Locked field fails 403 RBAC BEFORE entering HITL queue
  await assert.rejects(
    () => execTool.invoke(empAskCtx, {
      collection: 'latticeCustomColdAudits',
      operation: 'create',
      values: { code: 'QA-BAD', name: 'Bad', auditVerdict: 'OVERRIDE' },
    }),
    (err) => err.status === 403 && err.code === 'RBAC_FIELD_LOCKED',
  );
  assert.equal(store.latticeAiApprovalQueue.length, 0);

  // 2. ASK mode intercepts update on SRV-EXIST-10 without mutating target collection
  const pendingRes = await execTool.invoke(empAskCtx, {
    collection: 'latticeServiceTickets',
    operation: 'update',
    recordId: 10,
    values: { name: 'Kiểm tra máy nén A1 (Khẩn)', priority: 'critical' },
  });
  assert.equal(pendingRes.status, 'pending_approval');
  assert.ok(pendingRes.approvalId);
  assert.equal(pendingRes.diffPreview.before.name, 'Kiểm tra máy nén A1');
  assert.equal(pendingRes.diffPreview.after.name, 'Kiểm tra máy nén A1 (Khẩn)');
  assert.equal(store.latticeServiceTickets[0].name, 'Kiểm tra máy nén A1');

  // 3. Even ALLOW mode is intercepted when requireApproval: true
  const empAutoCtx = makeCtx({ userId: 9, username: 'emp9', roles: ['ldx_employee'], dxosAiUsername: 'dxos-auto' });
  const forcedAsk = await execTool.invoke(empAutoCtx, {
    collection: 'latticeServiceTickets',
    operation: 'create',
    requireApproval: true,
    values: { code: 'SRV-NEW-99', name: 'Phiếu mới cần duyệt' },
  });
  assert.equal(forcedAsk.status, 'pending_approval');
  assert.equal(store.latticeServiceTickets.length, 2);

  // 4. OFF profile is blocked with 403
  const empOffCtx = makeCtx({ userId: 9, username: 'emp9', roles: ['ldx_employee'], dxosAiUsername: 'dxos-off' });
  await assert.rejects(
    () => execTool.invoke(empOffCtx, {
      collection: 'latticeServiceTickets',
      operation: 'create',
      values: { code: 'SRV-OFF', name: 'Blocked' },
    }),
    (err) => err.status === 403,
  );

  // 5. listApprovals scoping: peer emp11 sees 0 items, requester emp9 sees 2 items, mgr10 (org-a) sees 2 items, mgr20 (org-b) sees 0 items
  const peerListCtx = makeCtx({ userId: 11, username: 'emp11', roles: ['ldx_employee'], method: 'GET' });
  await actions.listApprovals(peerListCtx, async () => {});
  assert.equal(peerListCtx.body.items.length, 0);

  const reqListCtx = makeCtx({ userId: 9, username: 'emp9', roles: ['ldx_employee'], method: 'GET' });
  await actions.listApprovals(reqListCtx, async () => {});
  assert.equal(reqListCtx.body.items.length, 2);

  const mgrOrgBCtx = makeCtx({ userId: 20, username: 'mgr20', roles: ['ldx_manager'], method: 'GET' });
  await actions.listApprovals(mgrOrgBCtx, async () => {});
  assert.equal(mgrOrgBCtx.body.items.length, 0);

  const mgrListCtx = makeCtx({ userId: 10, username: 'mgr10', roles: ['ldx_manager'], method: 'GET' });
  await actions.listApprovals(mgrListCtx, async () => {});
  assert.equal(mgrListCtx.body.items.length, 2);

  // 6. Self-approval strictly forbidden (even if requester has manager role!), non-manager forbidden, cross-org 404
  store.rolesUsers.push({ userId: 9, roleName: 'ldx_manager' });
  const selfApproveCtx = makeCtx({ userId: 9, username: 'emp9', roles: ['ldx_manager'], method: 'POST', values: { approvalId: pendingRes.approvalId, note: 'Tự duyệt' } });
  await assert.rejects(
    () => actions.approveAction(selfApproveCtx, async () => {}),
    (err) => err.status === 403 && err.code === 'SELF_APPROVAL_FORBIDDEN',
  );
  store.rolesUsers.pop();

  const empApproveCtx = makeCtx({ userId: 11, username: 'emp11', roles: ['ldx_employee'], method: 'POST', values: { approvalId: pendingRes.approvalId } });
  await assert.rejects(
    () => actions.approveAction(empApproveCtx, async () => {}),
    (err) => err.status === 403,
  );

  const foreignMgrApproveCtx = makeCtx({ userId: 20, username: 'mgr20', roles: ['ldx_manager'], method: 'POST', values: { approvalId: pendingRes.approvalId } });
  await assert.rejects(
    () => actions.approveAction(foreignMgrApproveCtx, async () => {}),
    (err) => err.status === 404,
  );

  // 7. Manager #10 approves pendingRes -> executes target update cleanly with dxosApprovedQueueId & writes hitl-approval audit log
  const approveCtx = makeCtx({
    userId: 10,
    username: 'mgr10',
    roles: ['ldx_manager'],
    method: 'POST',
    values: { approvalId: pendingRes.approvalId, note: 'Đã xác nhận xử lý khẩn' },
  });
  await actions.approveAction(approveCtx, async () => {});
  assert.equal(approveCtx.body.status, 'executed');
  assert.equal(store.latticeServiceTickets[0].name, 'Kiểm tra máy nén A1 (Khẩn)');
  assert.equal(store.latticeServiceTickets[0].priority, 'critical');
  assert.ok(store.latticeAiAuditLogs.some((l) => l.channel === 'hitl-approval' && l.status === 'allowed'));

  // 8. Re-approving executed item returns 409
  await assert.rejects(
    () => actions.approveAction(approveCtx, async () => {}),
    (err) => err.status === 409,
  );

  // 9. Rejecting forcedAsk requires note >= 3 chars, marks rejected without mutating, writes audit log
  const shortRejectCtx = makeCtx({
    userId: 10,
    username: 'mgr10',
    roles: ['ldx_manager'],
    method: 'POST',
    values: { approvalId: forcedAsk.approvalId, note: 'no' },
  });
  await assert.rejects(
    () => actions.rejectAction(shortRejectCtx, async () => {}),
    (err) => err.status === 400,
  );

  const rejectCtx = makeCtx({
    userId: 10,
    username: 'mgr10',
    roles: ['ldx_manager'],
    method: 'POST',
    values: { approvalId: forcedAsk.approvalId, note: 'Chưa đủ thông tin mô tả thiết bị' },
  });
  await actions.rejectAction(rejectCtx, async () => {});
  assert.equal(rejectCtx.body.status, 'rejected');
  assert.equal(store.latticeServiceTickets.length, 2);
  assert.ok(store.latticeAiAuditLogs.some((l) => l.channel === 'hitl-approval' && l.status === 'rejected'));
});

test('decideApproval handles concurrency (single execution), expiry 409, root override, and server index ACL/REST locks', async () => {
  const { enqueueAiApproval, decideApproval } = require(path.join(PLUGIN_ROOT, 'src/server/ai-hitl.js'));
  const { db, store } = makeHitlHarness();

  // 1. Concurrent double-approve only executes executeApprovedWrite ONCE
  const item = await enqueueAiApproval(db, {
    actor: { userId: 9, username: 'emp9', organizationId: 'org-a', employeeId: 13 },
    aiEmployee: 'dxos-ops',
    toolName: 'dxos_execute_record_action',
    targetCollection: 'latticeServiceTickets',
    operation: 'create',
    proposedArgs: { collection: 'latticeServiceTickets', operation: 'create', values: { code: 'SRV-RACE', name: 'Race test' } },
  });

  let execCalls = 0;
  const slowWrite = async () => {
    execCalls += 1;
    await new Promise((r) => setTimeout(r, 15));
    return { operation: 'create', ok: true };
  };
  const mgrActor = { userId: 10, username: 'mgr10', organizationId: 'org-a', roleNames: ['ldx_manager'], isAdmin: false, isRoot: false };

  const outcomes = await Promise.allSettled([
    decideApproval(db, { actor: mgrActor, approvalId: item.id, decision: 'approve', note: 'OK 1', executeApprovedWrite: slowWrite }),
    decideApproval(db, { actor: mgrActor, approvalId: item.id, decision: 'approve', note: 'OK 2', executeApprovedWrite: slowWrite }),
  ]);
  const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
  const rejected = outcomes.filter((o) => o.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.status, 409);
  assert.equal(execCalls, 1);

  // 2. Expired row returns 409
  const expiredRow = await enqueueAiApproval(db, {
    actor: { userId: 9, username: 'emp9', organizationId: 'org-a', employeeId: 13 },
    aiEmployee: 'dxos-ops',
    toolName: 'dxos_execute_record_action',
    targetCollection: 'latticeServiceTickets',
    operation: 'create',
    proposedArgs: { collection: 'latticeServiceTickets', operation: 'create', values: { code: 'SRV-EXP', name: 'Expired' } },
  });
  const storedExpired = store.latticeAiApprovalQueue.find((r) => r.id === expiredRow.id);
  storedExpired.expiresAt = new Date(Date.now() - 60_000).toISOString();
  await assert.rejects(
    () => decideApproval(db, { actor: mgrActor, approvalId: expiredRow.id, decision: 'approve', executeApprovedWrite: slowWrite }),
    (err) => err.status === 409,
  );

  // 3. Root can override self-approval if root initiated
  const rootItem = await enqueueAiApproval(db, {
    actor: { userId: 1, username: 'root', organizationId: 'org-b', employeeId: null },
    aiEmployee: 'dxos-ops',
    toolName: 'dxos_execute_record_action',
    targetCollection: 'latticeServiceTickets',
    operation: 'create',
    proposedArgs: { collection: 'latticeServiceTickets', operation: 'create', values: { code: 'SRV-ROOT', name: 'Root item' } },
  });
  const rootRes = await decideApproval(db, {
    actor: { userId: 1, username: 'root', organizationId: 'native-ui-lab', roleNames: ['root'], isAdmin: true, isRoot: true },
    approvalId: rootItem.id,
    decision: 'approve',
    executeApprovedWrite: async () => ({ ok: true }),
  });
  assert.equal(rootRes.status, 'executed');

  // 4. src/server/index.js allows listApprovals, approveAction, rejectAction (loggedIn) & blocks direct REST CRUD on latticeAiApprovalQueue
  const origLoad = Module._load;
  const rmMiddlewares = [];
  const allowed = [];
  class MockPlugin { constructor(app) { this.app = app; this.db = app?.db; } }
  Module._load = function (req, parent, isMain) {
    if (req === '@nocobase/server') return { Plugin: MockPlugin };
    return origLoad.call(this, req, parent, isMain);
  };
  try {
    const pluginApp = {
      db,
      use: () => {},
      resourceManager: {
        define: () => {},
        use: (fn, opts) => rmMiddlewares.push({ fn, opts }),
      },
      acl: {
        registerSnippet: () => {},
        allow: (res, act, cond) => allowed.push(`${res}:${act}:${cond}`),
      },
    };
    const ServerPlugin = require(path.join(PLUGIN_ROOT, 'src/server/index.js'));
    await new ServerPlugin(pluginApp).load();
    assert.ok(allowed.includes('dxosAi:listApprovals:loggedIn'));
    assert.ok(allowed.includes('dxosAi:approveAction:loggedIn'));
    assert.ok(allowed.includes('dxosAi:rejectAction:loggedIn'));

    const hitlEntry = rmMiddlewares.find((m) => m.opts?.tag === 'dxosAiHitlScope');
    assert.equal(hitlEntry?.opts?.after, 'acl');
    assert.equal(hitlEntry?.opts?.before, 'latticeNativeScope');
    const hitlGuard = hitlEntry?.fn;
    assert.equal(typeof hitlGuard, 'function');
    await assert.rejects(
      () => hitlGuard({ state: { currentUser: { id: 10 }, currentRole: 'ldx_manager' }, action: { resourceName: 'latticeAiApprovalQueue', actionName: 'update', params: {} } }, async () => {}),
      (err) => err.status === 403,
    );
  } finally {
    Module._load = origLoad;
  }
});

test('approveAction enforces target collection ACL (no privilege bypass) and rejects unsupported/admin tools & unauth/method checks', async () => {
  const { createDxosAiActions } = require(path.join(PLUGIN_ROOT, 'src/server/ai-resource.js'));
  const { enqueueAiApproval } = require(path.join(PLUGIN_ROOT, 'src/server/ai-hitl.js'));
  const { db, store, makeCtx } = makeHitlHarness();
  const actions = createDxosAiActions(db);

  // 1. Unauthenticated caller -> 401; wrong HTTP method -> 405
  await assert.rejects(() => actions.listApprovals({ db, state: {}, action: { params: {} } }, async () => {}), (err) => err.status === 401);
  await assert.rejects(
    () => actions.approveAction(makeCtx({ userId: 10, username: 'mgr10', roles: ['ldx_manager'], method: 'GET', values: { approvalId: 1 } }), async () => {}),
    (err) => err.status === 405,
  );

  // 2. Tampered row targeting an Admin Builder tool -> 400 HITL_UNSUPPORTED_TOOL
  const forged = await enqueueAiApproval(db, {
    actor: { userId: 9, username: 'emp9', organizationId: 'org-a', employeeId: 13 },
    aiEmployee: 'dxos-ops',
    toolName: 'dxos_manage_rbac_permissions',
    targetCollection: 'roles',
    operation: 'create',
    proposedArgs: { operation: 'grantResource', roleName: 'ldx_employee' },
  });
  await assert.rejects(
    () => actions.approveAction(makeCtx({ userId: 10, username: 'mgr10', roles: ['ldx_manager'], method: 'POST', values: { approvalId: forged.id } }), async () => {}),
    (err) => err.status === 400 && err.code === 'HITL_UNSUPPORTED_TOOL',
  );

  // 3. Approver missing write ACL on target collection (e.g. latticeParaDocuments has no grant for ldx_manager) -> 403 and row reverts to pending!
  const paraReq = await enqueueAiApproval(db, {
    actor: { userId: 9, username: 'emp9', organizationId: 'org-a', employeeId: 13 },
    aiEmployee: 'dxos-ops',
    toolName: 'dxos_execute_record_action',
    targetCollection: 'latticeParaDocuments',
    operation: 'create',
    proposedArgs: { collection: 'latticeParaDocuments', operation: 'create', values: { code: 'PARA-ACL', title: 'Test' } },
  });
  await assert.rejects(
    () => actions.approveAction(makeCtx({ userId: 10, username: 'mgr10', roles: ['ldx_manager'], method: 'POST', values: { approvalId: paraReq.id } }), async () => {}),
    (err) => err.status === 403,
  );
  const storedParaReq = store.latticeAiApprovalQueue.find((r) => r.id === paraReq.id);
  assert.equal(storedParaReq.status, 'pending');
});

test('Fix Round 1: Studio OFF profile rejects 403, approveAction keeps requester attribution & skips double quota, root cross-org override works, proposedArgs mismatch 409, decisionNote<=255', async () => {
  const { validateAiProfilePayload } = require(path.join(PLUGIN_ROOT, 'src/server/ai-schemas.js'));
  const { createDxosTools } = require(path.join(PLUGIN_ROOT, 'src/server/ai-tools-core.js'));
  const { createDxosAiActions } = require(path.join(PLUGIN_ROOT, 'src/server/ai-resource.js'));
  const { resolveEffectiveToolMode, enqueueAiApproval } = require(path.join(PLUGIN_ROOT, 'src/server/ai-hitl.js'));
  const { resetQuotaBuckets } = require(path.join(PLUGIN_ROOT, 'src/server/ai-governance.js'));

  resetQuotaBuckets();
  const { db, store, makeCtx } = makeHitlHarness();
  const actions = createDxosAiActions(db);
  const execTool = createDxosTools().find((t) => t.definition.name === 'dxos_execute_record_action');

  // 1. Profile saved via validateAiProfilePayload / saveProfile with dxos_execute_record_action='OFF' stays OFF (never escalates to ASK)
  const sanitizedProfile = validateAiProfilePayload({
    username: 'studio-off-bot',
    nickname: 'Studio OFF Bot',
    organizationId: 'org-a',
    allowedRoles: ['ldx_employee'],
    toolPermissions: { dxos_search_enterprise_context: 'ALLOW', dxos_execute_record_action: 'OFF' },
  });
  store.latticeAiProfiles.push({ id: 50, ...sanitizedProfile });
  assert.equal(await resolveEffectiveToolMode(db, { aiEmployee: 'studio-off-bot', toolName: 'dxos_execute_record_action' }), 'OFF');
  const offCtx = makeCtx({ userId: 9, username: 'emp9', roles: ['ldx_employee'], dxosAiUsername: 'studio-off-bot' });
  await assert.rejects(
    () => execTool.invoke(offCtx, {
      collection: 'latticeServiceTickets',
      operation: 'create',
      values: { code: 'SRV-NO', name: 'Should be blocked' },
    }),
    (err) => err.status === 403 && err.code === 'TOOL_PERMISSION_OFF',
  );

  // 2. Manager #10 approves Employee #9's create -> keeps requesterId=13 (emp9's employeeId) and skips second quota deduction
  const pendingCreate = await execTool.invoke(
    makeCtx({ userId: 9, username: 'emp9', roles: ['ldx_employee'], dxosAiUsername: 'dxos-ops' }),
    { collection: 'latticeServiceTickets', operation: 'create', values: { code: 'SRV-ATTR-1', name: 'Employee Ticket' } },
  );
  const quotaBeforeApprove = store.latticeAiQuotaUsage.reduce((sum, r) => sum + Number(r.calls || 0), 0);
  const approveCtx = makeCtx({
    userId: 10,
    username: 'mgr10',
    roles: ['ldx_manager'],
    method: 'POST',
    values: { approvalId: pendingCreate.approvalId, note: 'A'.repeat(400) },
  });
  await actions.approveAction(approveCtx, async () => {});
  assert.equal(approveCtx.body.status, 'executed');
  assert.equal(approveCtx.body.decisionNote.length <= 255, true, 'decisionNote must fit VARCHAR(255)');
  const createdTicket = store.latticeServiceTickets.find((t) => t.code === 'SRV-ATTR-1');
  assert.ok(createdTicket);
  assert.equal(createdTicket.requesterId, 13, 'Approved create must attribute requesterId to original employee 13, not manager 14');
  assert.equal(createdTicket.organizationId, 'org-a');
  const quotaAfterApprove = store.latticeAiQuotaUsage.reduce((sum, r) => sum + Number(r.calls || 0), 0);
  assert.equal(quotaAfterApprove, quotaBeforeApprove, 'approveAction replay must NOT double-charge AI quota');

  // 3. Root with a latticeEmployees row in org-a approving org-b request still executes in org-b
  store.latticeEmployees.push({ id: 99, userId: 1, code: 'ROOT-A', organizationId: 'org-a', active: true });
  const orgBReq = await enqueueAiApproval(db, {
    actor: { userId: 20, username: 'mgr20', organizationId: 'org-b', employeeId: 21 },
    aiEmployee: 'dxos-ops',
    toolName: 'dxos_execute_record_action',
    targetCollection: 'latticeServiceTickets',
    targetRecordId: 11,
    operation: 'update',
    proposedArgs: { collection: 'latticeServiceTickets', operation: 'update', recordId: 11, values: { name: 'Phiếu org B updated by root' } },
  });
  const rootApproveCtx = makeCtx({
    userId: 1,
    username: 'root',
    roles: ['root'],
    method: 'POST',
    values: { approvalId: orgBReq.id, note: 'Root cross-org approve' },
  });
  await actions.approveAction(rootApproveCtx, async () => {});
  assert.equal(rootApproveCtx.body.status, 'executed');
  assert.equal(store.latticeServiceTickets.find((t) => t.id === 11).name, 'Phiếu org B updated by root');

  // 4. Corrupted proposedArgs mismatching targetCollection/operation/targetRecordId fails 409 HITL_ARGS_MISMATCH
  const tamperedReq = await enqueueAiApproval(db, {
    actor: { userId: 9, username: 'emp9', organizationId: 'org-a', employeeId: 13 },
    aiEmployee: 'dxos-ops',
    toolName: 'dxos_execute_record_action',
    targetCollection: 'latticeServiceTickets',
    targetRecordId: 10,
    operation: 'update',
    proposedArgs: { collection: 'latticeCustomColdAudits', operation: 'update', recordId: 30, values: { auditVerdict: 'TAMPER' } },
  });
  await assert.rejects(
    () => actions.approveAction(
      makeCtx({ userId: 10, username: 'mgr10', roles: ['ldx_manager'], method: 'POST', values: { approvalId: tamperedReq.id } }),
      async () => {},
    ),
    (err) => err.status === 409 && err.code === 'HITL_ARGS_MISMATCH',
  );

  // 5. Migration decisionNote column aligns with VARCHAR(255)
  const migSrc = readFileSync(path.join(PLUGIN_ROOT, 'src/server/migrations/20261123000400-ai-hitl-approvals.js'), 'utf8');
  assert.match(migSrc, /"decisionNote"\s+VARCHAR\(255\)/i);
  resetQuotaBuckets();
});
