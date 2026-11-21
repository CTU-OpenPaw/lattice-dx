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
        latticeRequests: [],
        latticeIncidentCases: [],
        latticeAssets: [],
        workflows: [{ id: 91, title: 'Logistics 5 bước', current: true, enabled: true }],
        flow_nodes: [],
        latticePortals: [],
        latticeAiProfiles: [],
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

function makeCtx(db, { userId = 9, username = 'emp9', roles = ['ldx_employee'], applyBlueprint, onTaskSubmit } = {}) {
  return {
    state: { currentUser: { id: userId, username }, currentRoles: roles, currentRole: roles[0] },
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

test('non-admin is strictly blocked from all 5 Admin Builder tools and foreign org data', async () => {
  const db = makeMockDb();
  const tools = createDxosTools();
  const byName = new Map(tools.map((t) => [t.definition.name, t]));
  assert.equal(ADMIN_BUILDER_TOOL_NAMES.length, 5);
  assert.equal(OPERATIONAL_TOOL_NAMES.length, 3);

  const empCtx = makeCtx(db, { userId: 9, roles: ['ldx_employee'] });
  const scope = await resolveActorScope(empCtx, db);
  assert.equal(scope.organizationId, 'org-a');
  assert.equal(scope.isAdmin, false);

  for (const adminTool of ADMIN_BUILDER_TOOL_NAMES) {
    await assert.rejects(() => byName.get(adminTool).invoke(empCtx, { portalSlug: 'services', blockUse: 'DxosAiProposalBlockModel', slug: 'new', title: 'New', operation: 'createCollection', collectionName: 'latticeCustomX', templateKey: 'internal-service' }), (err) => err.status === 403);
  }
  assert.equal(db.auditLogs.filter((l) => l.status === 'denied').length, 5);

  const searchRes = await byName.get('dxos_search_enterprise_context').invoke(empCtx, { query: 'Đơn' });
  assert.equal(searchRes.items.some((i) => i.code === 'ORD-01'), true);
  assert.equal(searchRes.items.some((i) => i.code === 'ORD-FOREIGN'), false);
});

test('dxos_execute_record_action strips protected fields and dxos_my_tasks_copilot blocks self-approval & foreign hijack', async () => {
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
  await assert.rejects(() => byName.get('dxos_my_tasks_copilot').invoke(empCtx, { action: 'submit', taskId: 301, formKey: 'review', decision: 'approve' }), (err) => err.status === 403);
  // Employee #9 trying to self-approve their own task 302 (requesterId=13) -> blocked
  await assert.rejects(() => byName.get('dxos_my_tasks_copilot').invoke(empCtx, { action: 'submit', taskId: 302, formKey: 'review', decision: 'approve' }), (err) => err.status === 403);

  // Manager #10 validly submits task 301 -> allowed
  const mgrCtx = makeCtx(db, { userId: 10, roles: ['ldx_manager'] });
  const submitRes = await byName.get('dxos_my_tasks_copilot').invoke(mgrCtx, { action: 'submit', taskId: 301, formKey: 'review', decision: 'approve' });
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
