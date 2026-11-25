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

const { defineToolSchema } = require('../src/server/schema-helper');
const {
  ADMIN_BUILDER_TOOL_NAMES,
  OPERATIONAL_TOOL_NAMES,
  resolveActorScope,
  createDxosTools,
} = require('../src/server/ai-tools-core');

function makeMockDb({
  employees = [{ id: 13, userId: 9, code: 'EMP-9', organizationId: 'org-a', active: true }, { id: 14, userId: 10, code: 'MGR-10', organizationId: 'org-a', active: true }],
  orders = [{ id: 1, code: 'ORD-01', name: 'Đơn lạnh Cần Thơ', organizationId: 'org-a', status: 'draft', requesterId: 13 }, { id: 2, code: 'ORD-FOREIGN', name: 'Đơn đơn vị B', organizationId: 'org-b', status: 'draft', requesterId: 99 }],
  paraDocs = [{ id: 5, code: 'PARA-01', title: 'SOP Kho lạnh', organizationId: 'org-a', paraSpace: 'resources' }],
  tasks = [
    { id: 301, userId: 10, status: 0, node: { title: 'Bước 2 — Quản lý duyệt đơn', key: 'review' }, execution: { context: { data: { code: 'ORD-01', requesterId: 13 } } } },
    { id: 302, userId: 9, status: 0, node: { title: 'Duyệt yêu cầu', key: 'review' }, execution: { context: { data: { code: 'ORD-SELF', requesterId: 13 } } } },
  ],
  layouts = [{ uid: 'ldx-portal-services', name: 'Dịch vụ', type: 'admin', options: {} }],
  routes = [{ id: 50, title: 'Dịch vụ', type: 'group', uiLayoutUid: 'ldx-portal-services', children: [{ id: 51, title: 'Tổng quan', type: 'flowPage', pageUid: 'page-srv-1' }] }],
} = {}) {
  const createdTickets = [];
  const auditLogs = [];
  const createdCollections = [];
  const roleRoutes = [];
  const blueprintCalls = [];
  const submittedTasks = [];

  const wrap = (row) => ({ ...row, get: (k) => row[k], toJSON: () => row, update: async (u) => Object.assign(row, u) });
  const matchFilter = (row, filter = {}) => Object.entries(filter).every(([k, v]) => {
    if (k === '$or' && Array.isArray(v)) return v.some((sub) => matchFilter(row, sub));
    if (v && typeof v === 'object' && '$in' in v) return v.$in.includes(row[k]);
    if (v && typeof v === 'object' && '$includes' in v) return String(row[k] || '').toLowerCase().includes(String(v.$includes).toLowerCase());
    return row[k] === v;
  });

  const db = {
    createdTickets,
    auditLogs,
    createdCollections,
    roleRoutes,
    blueprintCalls,
    submittedTasks,
    hasCollection: (name) => ['latticeOrders', 'latticeRequests', 'latticeServiceTickets', 'latticeIncidentCases', 'latticeAssets', 'latticeParaDocuments', 'workflowManualTasks', 'uiLayouts', 'desktopRoutes'].includes(name),
    sequelize: { transaction: async (fn) => fn({}) },
    sync: async () => {},
    getRepository(name) {
      const storeMap = {
        latticeEmployees: employees,
        latticeOrders: orders,
        latticeParaDocuments: paraDocs,
        latticeServiceTickets: createdTickets,
        workflowManualTasks: tasks,
        uiLayouts: layouts,
        desktopRoutes: routes,
        collections: createdCollections,
        rolesDesktopRoutes: roleRoutes,
        latticeAiAuditLogs: auditLogs,
        roles: [{ name: 'root', allowConfigure: true }, { name: 'ldx_employee', allowConfigure: false, snippets: [] }, { name: 'ldx_manager', allowConfigure: false, snippets: [] }],
        dataSourcesRolesResources: [
          {
            roleName: 'ldx_employee',
            name: 'latticeOrders',
            dataSourceKey: 'main',
            usingActionsConfig: true,
            actions: [{ name: 'view', fields: ['id', 'code', 'name', 'status', 'requesterId'], scope: { own: true } }],
          },
          {
            roleName: 'ldx_employee',
            name: 'latticeParaDocuments',
            dataSourceKey: 'main',
            usingActionsConfig: true,
            actions: [{ name: 'view', fields: ['id', 'code', 'title', 'paraSpace'] }],
          },
          {
            roleName: 'ldx_employee',
            name: 'latticeServiceTickets',
            dataSourceKey: 'main',
            usingActionsConfig: true,
            actions: [
              { name: 'view', fields: ['id', 'code', 'name', 'status', 'requesterId'], scope: { own: true } },
              { name: 'create', fields: ['code', 'name', 'serviceType', 'priority', 'description'] },
            ],
          },
        ],
        latticeRequests: [],
        latticeIncidentCases: [],
        latticeAssets: [],
        workflows: [{ id: 91, title: 'Logistics 5 bước', current: true, enabled: true }],
        flow_nodes: [],
        latticePortals: [],
        latticeAiProfiles: [{ id: 1, username: 'dxos-direct-allow', enabled: true, toolPermissions: { dxos_execute_record_action: 'ALLOW' } }],
        latticeAiApprovalQueue: [],
      };
      const arr = storeMap[name];
      if (!arr) return null;
      return {
        find: async ({ filter = {}, limit = 50 } = {}) => arr.filter((r) => matchFilter(r, filter)).slice(0, limit).map(wrap),
        findOne: async ({ filter = {}, filterByTk } = {}) => {
          const hit = filterByTk != null ? arr.find((r) => String(r.id ?? r.uid ?? r.name) === String(filterByTk)) : arr.find((r) => matchFilter(r, filter));
          return hit ? wrap(hit) : null;
        },
        count: async ({ filter = {} } = {}) => arr.filter((r) => matchFilter(r, filter)).length,
        create: async ({ values }) => {
          const item = { id: arr.length + 100, ...values };
          arr.push(item);
          return wrap(item);
        },
      };
    },
  };
  return db;
}

function makeCtx(db, { userId = 9, username = 'emp9', roles = ['ldx_employee'], applyBlueprint, onTaskSubmit, dxosAiUsername = 'dxos-direct-allow' } = {}) {
  return {
    state: { currentUser: { id: userId, username }, currentRoles: roles, currentRole: roles[0], ...(dxosAiUsername ? { dxosAiUsername } : {}) },
    db,
    app: {
      resourceManager: {
        getResource: (name) => {
          if (name === 'flowSurfaces') {
            return {
              actions: {
                get: () => ({
                  handler: async (subCtx) => {
                    db.blueprintCalls.push(subCtx.action.params.values);
                    subCtx.body = { data: { pageUid: 'page-srv-1', attached: true } };
                  },
                }),
              },
            };
          }
          if (name === 'workflowManualTasks') {
            return {
              actions: {
                get: () => ({
                  handler: async (subCtx) => {
                    if (onTaskSubmit) onTaskSubmit(subCtx.action.params);
                    db.submittedTasks.push(subCtx.action.params);
                    subCtx.body = { ok: true };
                  },
                }),
              },
            };
          }
          return applyBlueprint ? null : null;
        },
      },
    },
  };
}

test('schema-helper builds pure-JS JSON Schema and validates args cleanly', () => {
  const helper = defineToolSchema({
    description: 'Create ticket',
    properties: {
      code: { type: 'string', required: true, maxLength: 32 },
      priority: { type: 'string', enum: ['low', 'medium', 'high'], required: true },
      dryRun: { type: 'boolean' },
    },
  });
  assert.equal(helper.jsonSchema.required.includes('code'), true);
  assert.equal(helper.validate({ code: 'SRV-1', priority: 'high' }).ok, true);
  assert.equal(helper.validate({ priority: 'high' }).ok, false);
  assert.equal(helper.validate({ code: 'SRV-1', priority: 'urgent' }).ok, false);
});

test('schema-helper coerces stringified object/array JSON and builds propertyNames-free schemas', () => {
  const { buildZodSchema } = require('../src/server/schema-helper');
  const helper = defineToolSchema({
    description: 'Coerce & Gemini-safe test',
    properties: {
      tags: { type: 'array', items: { type: 'string' } },
      itemsWithoutExplicitItems: { type: 'array' },
      payload: { type: 'object', required: true },
    },
  });
  assert.deepEqual(helper.jsonSchema.properties.itemsWithoutExplicitItems.items, { type: 'string' });
  const coerced = helper.validate({ tags: '["a","b"]', payload: '{"code":"QA-1"}' });
  assert.equal(coerced.ok, true);
  assert.deepEqual(coerced.value.tags, ['a', 'b']);
  assert.deepEqual(coerced.value.payload, { code: 'QA-1' });
  assert.equal(helper.validate({ payload: 'not-json' }).ok, false);

  // Verify buildZodSchema uses passthrough object (not record) and typed array items even without host zod
  const recordedCalls = [];
  const fakeZod = {
    string: () => ({ describe: () => ({ optional: () => 'z:string:opt' }), optional: () => 'z:string:opt' }),
    boolean: () => ({ describe: () => ({ optional: () => 'z:bool' }), optional: () => 'z:bool' }),
    number: () => ({ describe: () => ({ optional: () => 'z:num' }), optional: () => 'z:num' }),
    array: (itemType) => {
      recordedCalls.push(['array', itemType]);
      return { describe: () => ({ optional: () => 'z:array' }), optional: () => 'z:array' };
    },
    object: (shape) => ({
      passthrough: () => {
        recordedCalls.push(['object.passthrough']);
        return { describe: () => ({ optional: () => 'z:obj' }), optional: () => 'z:obj' };
      },
      describe: () => 'z:root',
    }),
    record: () => { throw new Error('z.record emits propertyNames and must not be used'); },
    enum: () => ({ optional: () => 'z:enum' }),
    any: () => 'z:any',
  };
  buildZodSchema({
    properties: {
      roles: { type: 'array', items: { type: 'string' } },
      nodes: { type: 'array', items: { type: 'object' } },
      values: { type: 'object', required: true },
    },
  }, fakeZod);
  assert.equal(recordedCalls.some((c) => c[0] === 'object.passthrough'), true);
});

test('non-admin is strictly blocked from all 11 Admin Builder tools and foreign org data', async () => {
  const db = makeMockDb();
  const tools = createDxosTools();
  const byName = new Map(tools.map((t) => [t.definition.name, t]));
  assert.equal(ADMIN_BUILDER_TOOL_NAMES.length, 11);
  assert.equal(OPERATIONAL_TOOL_NAMES.length, 6);

  const empCtx = makeCtx(db, { userId: 9, roles: ['ldx_employee'] });
  const scope = await resolveActorScope(empCtx, db);
  assert.equal(scope.organizationId, 'org-a');
  assert.equal(scope.isAdmin, false);

  for (const adminTool of ADMIN_BUILDER_TOOL_NAMES) {
    await assert.rejects(() => byName.get(adminTool).invoke(empCtx, { portalSlug: 'services', blockUse: 'DxosAiProposalBlockModel', slug: 'new', title: 'New', operation: 'createCollection', roleName: 'ldx_employee', roleTitle: 'Test', pageTitle: 'Page', collectionName: 'latticeCustomX', templateKey: 'internal-service', action: 'listSnapshots' }), (err) => err.status === 403);
  }
  assert.equal(db.auditLogs.filter((l) => l.status === 'denied').length, 11);

  const searchRes = await byName.get('dxos_search_enterprise_context').invoke(empCtx, { query: 'Đơn' });
  assert.equal(searchRes.items.some((i) => i.code === 'ORD-01'), true);
  assert.equal(searchRes.items.some((i) => i.code === 'ORD-FOREIGN'), false);
});

test('dxos_execute_record_action strips protected fields and dxos_my_workflow_tasks blocks self-approval & foreign hijack', async () => {
  const db = makeMockDb();
  const byName = new Map(createDxosTools().map((t) => [t.definition.name, t]));
  const empCtx = makeCtx(db, { userId: 9, roles: ['ldx_employee'] });

  const created = await byName.get('dxos_execute_record_action').invoke(empCtx, {
    collection: 'latticeServiceTickets',
    operation: 'create',
    values: { code: 'SRV-AI-99', name: 'Thay cảm biến', organizationId: 'org-b', status: 'approved', requesterId: 999 },
  });
  assert.equal(created.record.organizationId, 'org-a');
  assert.equal(created.record.requesterId, 13);
  assert.equal(created.record.status, 'draft');

  // Employee #9 trying to submit Manager #10's task 301 -> blocked
  await assert.rejects(() => byName.get('dxos_my_workflow_tasks').invoke(empCtx, { action: 'submit', taskId: 301, formKey: 'review', decision: 'approve' }), (err) => err.status === 403);
  // Employee #9 trying to self-approve their own task 302 (requesterId=13) -> blocked
  await assert.rejects(() => byName.get('dxos_my_workflow_tasks').invoke(empCtx, { action: 'submit', taskId: 302, formKey: 'review', decision: 'approve' }), (err) => err.status === 403);

  // Manager #10 validly submits task 301 -> allowed
  const mgrCtx = makeCtx(db, { userId: 10, roles: ['ldx_manager'] });
  const submitRes = await byName.get('dxos_my_workflow_tasks').invoke(mgrCtx, { action: 'submit', taskId: 301, formKey: 'review', decision: 'approve' });
  assert.equal(submitRes.submitted, true);
});

test('Admin Builder tools support dryRun preview, attach blocks, manage portals, and block system schema mutations', async () => {
  const db = makeMockDb();
  const byName = new Map(createDxosTools().map((t) => [t.definition.name, t]));
  const adminCtx = makeCtx(db, { userId: 1, username: 'admin', roles: ['root'] });

  const inspected = await byName.get('dxos_inspect_architecture').invoke(adminCtx, { portalSlug: 'services' });
  assert.equal(inspected.portals.length >= 1, true);

  const preview = await byName.get('dxos_compose_page_blocks').invoke(adminCtx, { portalSlug: 'services', blockUse: 'DxosAiProposalBlockModel', title: 'Đề xuất AI', dryRun: true });
  assert.equal(preview.dryRun, true);
  assert.equal(db.blueprintCalls.length, 0);

  const applied = await byName.get('dxos_compose_page_blocks').invoke(adminCtx, { portalSlug: 'services', blockUse: 'DxosAiProposalBlockModel', title: 'Đề xuất AI', dryRun: false });
  assert.equal(applied.applied, true);
  assert.equal(db.blueprintCalls.length, 1);

  await assert.rejects(() => byName.get('dxos_extend_collection_schema').invoke(adminCtx, { operation: 'addFields', collectionName: 'users', fields: [{ name: 'hack', type: 'string' }] }), (err) => err.status === 403 || err.status === 400);

  const customPreview = await byName.get('dxos_extend_collection_schema').invoke(adminCtx, { operation: 'createCollection', collectionName: 'latticeCustomAssetsQa', title: 'Kiểm định QA', fields: [{ name: 'batchCode', type: 'string', title: 'Mã lô' }], dryRun: false });
  assert.equal(customPreview.created, true);
  assert.equal(db.createdCollections[0].fields.some((f) => f.name === 'organizationId'), true);
});

test('v0.2.0 security: X-Role active precedence, fail-closed write RBAC, draft ownership update guard, structural self-approval guard, and audit redaction', async () => {
  const { resolveCallerRoleNames } = require('../src/server/ai-tools-core');
  const db = makeMockDb();
  const byName = new Map(createDxosTools().map((t) => [t.definition.name, t]));

  // 1. Active X-Role / currentRole drops elevated root when caller switches down to ldx_employee
  const switchedCtx = makeCtx(db, { userId: 9, roles: ['ldx_employee'] });
  switchedCtx.state.currentRoles = ['root', 'ldx_employee'];
  switchedCtx.state.currentRole = 'ldx_employee';
  switchedCtx.headers = { 'x-role': 'ldx_employee' };
  const resolvedRoles = await resolveCallerRoleNames(switchedCtx, db, 9);
  assert.deepEqual(resolvedRoles, ['ldx_employee']);
  await assert.rejects(() => byName.get('dxos_inspect_architecture').invoke(switchedCtx, {}), (err) => err.status === 403);

  // 2. Fail-closed write when dataSourcesRolesResources has no policy for collection
  const empCtx = makeCtx(db, { userId: 9, roles: ['ldx_employee'] });
  await assert.rejects(() => byName.get('dxos_execute_record_action').invoke(empCtx, {
    collection: 'latticeRequests',
    operation: 'create',
    values: { code: 'REQ-FAIL', name: 'No policy grant' },
  }), (err) => err.status === 403);

  // 3. Employee cannot update approved or foreign records via dxos_execute_record_action
  db.getRepository('latticeRequests');
  const bareDb = makeMockDb({
    orders: [
      { id: 10, code: 'ORD-APPROVED', name: 'Approved', organizationId: 'org-a', status: 'approved', requesterId: 13 },
      { id: 11, code: 'ORD-PEER', name: 'Peer draft', organizationId: 'org-a', status: 'draft', requesterId: 999 },
    ],
  });
  const baseGetRepo = bareDb.getRepository.bind(bareDb);
  const policies = [
    { roleName: 'ldx_employee', name: 'latticeOrders', dataSourceKey: 'main', actions: [{ name: 'view', fields: ['id', 'code', 'name', 'status', 'requesterId'] }, { name: 'update', fields: ['name'] }] },
  ];
  bareDb.getRepository = (n) => (n === 'dataSourcesRolesResources'
    ? { find: async ({ filter = {} } = {}) => policies.filter((p) => !filter.name || p.name === filter.name).map((p) => ({ ...p, get: (k) => p[k] })) }
    : baseGetRepo(n));
  const restrictedEmpCtx = makeCtx(bareDb, { userId: 9, roles: ['ldx_employee'] });
  await assert.rejects(() => byName.get('dxos_execute_record_action').invoke(restrictedEmpCtx, {
    collection: 'latticeOrders',
    operation: 'update',
    recordId: 10,
    values: { name: 'Tamper approved' },
  }), (err) => err.status === 403);
  await assert.rejects(() => byName.get('dxos_execute_record_action').invoke(restrictedEmpCtx, {
    collection: 'latticeOrders',
    operation: 'update',
    recordId: 11,
    values: { name: 'Tamper peer' },
  }), (err) => err.status === 403);

  // 4. Structural self-approval guard ignores disguised non-approval nodeTitle
  const disguisedTasksDb = makeMockDb({
    tasks: [
      { id: 401, userId: 9, status: 0, node: { title: 'Chốt hoàn tất bước 2', key: 'stage2', type: 'manual' }, execution: { context: { data: { code: 'ORD-SELF-2', requesterId: 13 } } } },
    ],
  });
  const empDisguisedCtx = makeCtx(disguisedTasksDb, { userId: 9, roles: ['ldx_employee'] });
  await assert.rejects(
    () => byName.get('dxos_my_workflow_tasks').invoke(empDisguisedCtx, { action: 'submit', taskId: 401, formKey: 'review', decision: 'approve' }),
    (err) => err.status === 403 && err.code === 'SELF_APPROVAL_FORBIDDEN',
  );

  // 5. Audit error/resultSummary redacts Bearer/JWT/sk- tokens
  const fakeSecretErrCtx = makeCtx(db, {
    userId: 9,
    roles: ['ldx_employee'],
  });
  await assert.rejects(
    () => byName.get('dxos_execute_record_action').invoke(fakeSecretErrCtx, {
      collection: 'latticeOrders',
      operation: 'create',
      values: { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig', note: 'sk-testsecret999' },
    }),
    () => true,
  );
  // Explicit audit log check with createAuditedTool redaction
  const { createAuditedTool } = require('../src/server/ai-tools-core');
  const leakTool = createAuditedTool({
    name: 'dxos_test_leak_redact',
    description: 'test',
    schema: { properties: {} },
    async run() {
      return { note: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.sig123 and sk-live123456' };
    },
  });
  await leakTool.invoke(empCtx, {});
  const lastLog = db.auditLogs.at(-1);
  assert.equal(lastLog.resultSummary.includes('eyJhbGciOi'), false);
  assert.equal(lastLog.resultSummary.includes('sk-live123456'), false);
});

test('Task 10: dxos_extend_collection_schema updateFieldMeta & deprecateField, dxos_provision_role_workspace registry ops (skipOuterTx), NL router & admin REST endpoints', async () => {
  const { parseVietnameseNaturalIntent } = require('../src/server/ai-nl-router');
  const { createDxosAiActions } = require('../src/server/ai-resource');

  // 1. Setup harness with fields repo, latticeBuiltApps, and pg-rls session tracking
  const store = {
    latticeEmployees: [{ id: 1, userId: 1, organizationId: 'org-a', active: true }],
    roles: [{ name: 'root', allowConfigure: true }, { name: 'ldx_employee', allowConfigure: false, snippets: [] }],
    rolesUsers: [{ userId: 1, roleName: 'root' }, { userId: 9, roleName: 'ldx_employee' }],
    collections: [
      {
        name: 'latticeCustomInspections',
        title: 'Inspections',
        fields: [
          { id: 1, collectionName: 'latticeCustomInspections', name: 'organizationId', type: 'string' },
          { id: 2, collectionName: 'latticeCustomInspections', name: 'inspectorNote', type: 'string', uiSchema: { title: 'Ghi chú cũ' } },
          { id: 3, collectionName: 'latticeCustomInspections', name: 'legacyGrade', type: 'string', uiSchema: { title: 'Hạng cũ' } },
        ],
      },
    ],
    fields: [
      { id: 1, collectionName: 'latticeCustomInspections', name: 'organizationId', type: 'string', uiSchema: { title: 'Mã tổ chức' } },
      { id: 2, collectionName: 'latticeCustomInspections', name: 'inspectorNote', type: 'string', uiSchema: { title: 'Ghi chú cũ' } },
      { id: 3, collectionName: 'latticeCustomInspections', name: 'legacyGrade', type: 'string', uiSchema: { title: 'Hạng cũ' } },
    ],
    latticeBuiltApps: [],
    latticeUiSnapshots: [],
    latticeAiProfiles: [],
    latticeAiAuditLogs: [],
    latticeAiQuotaUsage: [],
    latticeDecisionTables: [],
    latticeAutomationRules: [],
    latticeSlaPolicies: [],
    latticeIncidentRules: [],
    latticeConnectors: [],
    uiLayouts: [{ uid: 'ldx-portal-services', title: 'Dịch vụ', layoutType: 'desktop', routeName: 'p_services', routePath: '/p/services' }],
    desktopRoutes: [],
    desktopRoutesUiLayouts: [],
    rolesDesktopRoutes: [],
    flowModels: [],
    dataSourcesRoles: [],
    dataSourcesRolesResources: [],
    aiEmployees: [],
    rolesAiEmployees: [],
    workflows: [],
    flow_nodes: [],
  };

  let seq = 500;
  let activeTx = 0;
  const wrap = (row) => ({ ...row, get: (k) => row[k], toJSON: () => ({ ...row }), update: async (u) => { Object.assign(row, u); return wrap(row); } });
  const match = (r, f = {}) => Object.entries(f).every(([k, v]) => (v && typeof v === 'object' && '$in' in v ? v.$in.includes(r[k]) : r[k] === v));
  const db = {
    hasCollection: (n) => store.collections.some((c) => c.name === n) || Boolean(store[n]),
    getCollection: (n) => {
      const c = store.collections.find((x) => x.name === n);
      return c ? { ...c, fields: c.fields || [], sync: async () => {} } : null;
    },
    attachLatticeRlsPolicy: async () => ({ applied: true }),
    sequelize: {
      getDialect: () => 'postgres',
      transaction: async (fn) => {
        activeTx += 1;
        try { return await fn({ id: `tx-${activeTx}` }); } finally { activeTx -= 1; }
      },
      query: async () => [[]],
    },
    sync: async () => {},
    getRepository: (n) => {
      const arr = store[n];
      if (!arr) return null;
      const base = {
        find: async ({ filter = {}, limit = 200 } = {}) => arr.filter((r) => match(r, filter)).slice(0, limit).map(wrap),
        findOne: async ({ filter = {}, filterByTk } = {}) => {
          const hit = filterByTk != null ? arr.find((r) => String(r.id ?? r.uid ?? r.name) === String(filterByTk)) : arr.find((r) => match(r, filter));
          return hit ? wrap(hit) : null;
        },
        count: async ({ filter = {} } = {}) => arr.filter((r) => match(r, filter)).length,
        create: async ({ values }) => {
          const row = { id: ++seq, ...values };
          arr.push(row);
          return wrap(row);
        },
        update: async ({ filter = {}, values }) => {
          const hits = arr.filter((r) => match(r, filter));
          for (const h of hits) Object.assign(h, values);
          return hits.map(wrap);
        },
        destroy: async ({ filter = {} } = {}) => {
          let c = 0;
          for (let i = arr.length - 1; i >= 0; i--) { if (match(arr[i], filter)) { arr.splice(i, 1); c += 1; } }
          return c;
        },
      };
      if (n === 'flowModels') {
        base.findModelByParentId = async (parentUid, { subKey } = {}) => {
          const hit = arr.find((m) => m.parentId === parentUid && (!subKey || m.subKey === subKey));
          return hit ? { ...hit, subModels: { items: arr.filter((c) => c.parentId === hit.uid) } } : null;
        };
        base.findModelById = async (uid) => arr.find((m) => m.uid === uid) || null;
        base.upsertModel = async (model) => {
          const idx = arr.findIndex((m) => m.uid === model.uid);
          if (idx >= 0) Object.assign(arr[idx], model);
          else arr.push({ ...model });
          return model.uid;
        };
        base.updateSingleNode = async (node) => {
          const hit = arr.find((m) => m.uid === node.uid);
          if (!hit) return false;
          Object.assign(hit, { ...node, props: { ...(hit.props || {}), ...(node.props || {}) }, stepParams: { ...(hit.stepParams || {}), ...(node.stepParams || {}) } });
          return true;
        };
      }
      return base;
    },
  };

  const adminCtx = {
    db,
    state: { currentUser: { id: 1, username: 'admin' }, currentRoles: ['root'], currentRole: 'root' },
    app: { resourceManager: { getResource: () => null } },
  };
  const empCtx = {
    db,
    state: { currentUser: { id: 9, username: 'emp9' }, currentRoles: ['ldx_employee'], currentRole: 'ldx_employee' },
    app: { resourceManager: { getResource: () => null } },
  };

  const byName = new Map(createDxosTools().map((t) => [t.definition.name, t]));
  const extendTool = byName.get('dxos_extend_collection_schema');

  // updateFieldMeta & deprecateField
  const metaUp = await extendTool.invoke(adminCtx, {
    operation: 'updateFieldMeta',
    collectionName: 'latticeCustomInspections',
    fieldName: 'inspectorNote',
    title: 'Ghi chú kiểm định',
    uiSchema: { description: 'Nhập kết quả thực tế' },
  });
  assert.equal(metaUp.updated, true);
  assert.equal(store.fields.find((f) => f.name === 'inspectorNote').uiSchema.title, 'Ghi chú kiểm định');

  const depRes = await extendTool.invoke(adminCtx, {
    operation: 'deprecateField',
    collectionName: 'latticeCustomInspections',
    fieldName: 'legacyGrade',
    reason: 'Replaced by score',
  });
  assert.equal(depRes.deprecated, true);
  assert.equal(depRes.nonDestructive, true);
  assert.equal(store.fields.some((f) => f.name === 'legacyGrade'), true, 'deprecateField must not drop field');
  assert.equal(store.fields.find((f) => f.name === 'legacyGrade').uiSchema.deprecated, true);

  // Protected system field cannot be deprecated
  await assert.rejects(
    () => extendTool.invoke(adminCtx, { operation: 'deprecateField', collectionName: 'latticeCustomInspections', fieldName: 'organizationId' }),
    (err) => err.status === 403,
  );
  // Newly synced system collections (e.g. collections, llmServices, workflows) & case variants must be blocked (403)
  for (const sysCol of ['collections', 'Collections', 'llmServices', 'LlmServices', 'workflows', 'latticeBuiltApps', 'latticebuiltapps']) {
    await assert.rejects(
      () => extendTool.invoke(adminCtx, { operation: 'updateFieldMeta', collectionName: sysCol, fieldName: 'title', title: 'Hijacked' }),
      (err) => err.status === 403 && err.code === 'SYSTEM_COLLECTION_FORBIDDEN',
    );
  }

  // 2. dxos_provision_role_workspace registry ops + skipOuterTx check
  const prevRls = process.env.DX_PG_RLS_SESSION;
  process.env.DX_PG_RLS_SESSION = 'true';
  try {
    const provTool = byName.get('dxos_provision_role_workspace');
    // Check activeTx === 0 during tool run (skipOuterTx)
    const built = await provTool.invoke(adminCtx, {
      operation: 'build_enterprise_app',
      appKey: 'inspections-app',
      portalSlug: 'services',
      pageTitle: 'Kiểm định Chất lượng',
      collections: [{ collectionName: 'latticeCustomQaChecks', fields: [{ name: 'score', type: 'integer', title: 'Điểm' }] }],
    });
    assert.equal(built.built, true);
    assert.equal(activeTx, 0);

    const listed = await provTool.invoke(adminCtx, { operation: 'list_built_apps' });
    assert.equal(listed.apps.length, 1);

    const rebuilt = await provTool.invoke(adminCtx, { operation: 'rebuild_enterprise_app', appKey: 'inspections-app' });
    assert.equal(rebuilt.rebuilt, true);
    assert.equal(rebuilt.appVersion, 2);

    const bundle = await provTool.invoke(adminCtx, { operation: 'export_app_bundle', appKey: 'inspections-app' });
    assert.equal(bundle.metadata.schemaVersion, 'latticedx.solution-bundle/v3');

    const torn = await provTool.invoke(adminCtx, { operation: 'teardown_built_app', appKey: 'inspections-app' });
    assert.equal(torn.torndown, true);
    assert.equal(torn.keepData, true);
  } finally {
    if (prevRls === undefined) delete process.env.DX_PG_RLS_SESSION;
    else process.env.DX_PG_RLS_SESSION = prevRls;
  }

  // 3. Admin REST endpoints in ai-resource.js
  const actions = createDxosAiActions(db);
  for (const fnName of ['listBuiltApps', 'rebuildBuiltApp', 'exportBuiltAppBundle', 'teardownBuiltApp']) {
    assert.equal(typeof actions[fnName], 'function', `ai-resource must export ${fnName}`);
  }
  await assert.rejects(
    () => actions.listBuiltApps({ ...empCtx, method: 'GET', action: { params: {} } }),
    (err) => err.status === 403,
  );
  const listCtx = { ...adminCtx, method: 'GET', action: { params: {} }, body: null };
  await actions.listBuiltApps(listCtx);
  assert.equal(listCtx.body.apps.length, 1);

  const rebuildCtx = { ...adminCtx, method: 'POST', action: { params: { values: { appKey: 'inspections-app' } } }, body: null };
  await actions.rebuildBuiltApp(rebuildCtx);
  assert.equal(rebuildCtx.body.appVersion, 3);

  const exportCtx = { ...adminCtx, method: 'GET', action: { params: { appKey: 'inspections-app' } }, body: null };
  await actions.exportBuiltAppBundle(exportCtx);
  assert.equal(exportCtx.body.metadata.schemaVersion, 'latticedx.solution-bundle/v3');

  const tdCtx = { ...adminCtx, method: 'POST', action: { params: { values: { appKey: 'inspections-app', keepData: true } } }, body: null };
  await actions.teardownBuiltApp(tdCtx);
  assert.equal(tdCtx.body.torndown, true);

  // 4. NL router intents for multi-entity build, list built apps, rebuild, export, teardown
  const multiBuildNl = parseVietnameseNaturalIntent('Xây dựng hệ thống đa bảng latticeCustomVendors và latticeCustomOrders có quan hệ belongsTo', { isAdmin: true, portalSlug: 'procurement' });
  assert.equal(multiBuildNl.refused, false);
  assert.equal(multiBuildNl.toolName, 'dxos_provision_role_workspace');
  assert.equal(multiBuildNl.args.operation, 'build_enterprise_app');
  assert.equal(Array.isArray(multiBuildNl.args.collections) && multiBuildNl.args.collections.length, 2);

  const listNl = parseVietnameseNaturalIntent('Liệt kê danh sách các ứng dụng đã dựng', { isAdmin: true });
  assert.equal(listNl.args.operation, 'list_built_apps');

  const rebuildNl = parseVietnameseNaturalIntent('Dựng lại ứng dụng appKey:inspections-app', { isAdmin: true });
  assert.equal(rebuildNl.args.operation, 'rebuild_enterprise_app');
  assert.equal(rebuildNl.args.appKey, 'inspections-app');

  const exportNl = parseVietnameseNaturalIntent('Xuất gói giải pháp bundle v3 của ứng dụng appKey:inspections-app', { isAdmin: true });
  assert.equal(exportNl.args.operation, 'export_app_bundle');
  assert.equal(exportNl.args.appKey, 'inspections-app');

  const tdNl = parseVietnameseNaturalIntent('Gỡ bỏ ứng dụng appKey:inspections-app và giữ dữ liệu', { isAdmin: true });
  assert.equal(tdNl.args.operation, 'teardown_built_app');
  assert.equal(tdNl.args.keepData, true);

  const nonAdminRebuild = parseVietnameseNaturalIntent('Dựng lại ứng dụng appKey:inspections-app', { isAdmin: false });
  assert.equal(nonAdminRebuild.refused, true);
});

test('dxos_provision_role_workspace exposes strict nested collections/portals schema and architect prompt documents multi-entity lifecycle', () => {
  const { STARTER_AI_BLUEPRINTS } = require('../src/server/ai-schemas');
  const tools = createDxosTools();
  const provisionTool = tools.find((t) => t.definition.name === 'dxos_provision_role_workspace');
  assert.ok(provisionTool);
  const props = provisionTool.jsonSchema.properties;
  assert.ok(props.collections.items?.properties?.collectionName);
  assert.ok(props.collections.items?.properties?.fields?.items?.properties?.target);
  assert.ok(props.portals.items?.properties?.blocks?.items?.properties?.blockUse);
  assert.ok(props.portals.items?.properties?.blocks?.items?.properties?.collection);
  assert.ok(props.roles.items?.properties?.roleName);

  const architect = STARTER_AI_BLUEPRINTS.find((b) => b.username === 'dxos-architect');
  assert.ok(architect);
  assert.match(architect.systemPrompt, /collections:.*belongsTo/);
  assert.match(architect.systemPrompt, /list_built_apps/);
  assert.match(architect.systemPrompt, /rebuild_enterprise_app/);
  assert.match(architect.systemPrompt, /DxosKanbanScheduleBlockModel/);
});
