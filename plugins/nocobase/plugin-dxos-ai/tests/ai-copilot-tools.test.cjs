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

const {
  val,
  failTool,
  resolveCallerRoleNames,
  isStudioAdmin,
  resolveActorScope,
  resolveReadablePolicies,
  isRowVisibleToActor,
  invokeResourceAction,
  createAuditedTool,
  WRITABLE_BUSINESS_COLLECTIONS,
  PROTECTED_SERVER_FIELDS,
  SEARCHABLE_COLLECTIONS,
  CUSTOM_COLLECTION_RE,
} = require('../src/server/ai-tools-core');
const { createCopilotTools } = require('../src/server/ai-copilot-tools');

function makeCopilotHarness() {
  const coldAudits = [];
  const tickets = [];
  const paraDocs = [
    { id: 5, code: 'SOP-COLD-01', title: 'SOP Kiểm định Kho lạnh dưới -15C', organizationId: 'org-a', paraSpace: 'resources', summary: 'Lập phiếu bảo trì khi nhiệt độ > -15C' },
  ];
  const incidents = [
    { id: 41, code: 'INC-COLD-09', name: 'Cảnh báo nhiệt độ Zone-A vượt ngưỡng', organizationId: 'org-a', status: 'open', severity: 'critical', assetEntityId: 'urn:ngsi-ld:ColdStorage:A1' },
  ];
  const orders = [
    { id: 1, code: 'ORD-COLD-01', name: 'Đơn lạnh Vaccine CT', organizationId: 'org-a', status: 'submitted', requesterId: 13 },
    { id: 2, code: 'ORD-OTHER', name: 'Đơn ngoài đơn vị', organizationId: 'org-b', status: 'draft', requesterId: 99 },
  ];
  const collections = [
    { name: 'latticeCustomColdAudits', title: 'Kiểm định Kho lạnh' },
  ];
  const dataSourcesRolesResources = [
    {
      roleName: 'ldx_employee',
      name: 'latticeCustomColdAudits',
      dataSourceKey: 'main',
      usingActionsConfig: true,
      actions: [
        { name: 'view', fields: ['id', 'code', 'name', 'batchCode', 'temperatureC', 'auditVerdict', 'status'] },
        { name: 'create', fields: ['code', 'name', 'batchCode', 'warehouseZone', 'temperatureC', 'inspectorNotes'] },
      ],
    },
    {
      roleName: 'ldx_manager',
      name: 'latticeCustomColdAudits',
      dataSourceKey: 'main',
      usingActionsConfig: true,
      actions: [
        { name: 'view', fields: ['id', 'code', 'name', 'batchCode', 'temperatureC', 'auditVerdict', 'status'] },
        { name: 'create', fields: ['code', 'name', 'batchCode', 'warehouseZone', 'temperatureC', 'auditVerdict', 'inspectorNotes'] },
        { name: 'update', fields: ['code', 'name', 'batchCode', 'warehouseZone', 'temperatureC', 'auditVerdict', 'inspectorNotes'] },
      ],
    },
    ...['latticeServiceTickets', 'latticeParaDocuments', 'latticeAssets', 'latticeIncidentCases', 'latticeRequests', 'latticeOrders'].flatMap((col) => ([
      {
        roleName: 'ldx_employee',
        name: col,
        dataSourceKey: 'main',
        usingActionsConfig: true,
        actions: [
          { name: 'view', fields: ['id', 'code', 'name', 'title', 'summary', 'status', 'severity', 'assetEntityId', 'requesterId', 'ownerId'], ...(col === 'latticeOrders' || col === 'latticeRequests' ? { scope: { own: true } } : {}) },
          ...(['latticeServiceTickets', 'latticeParaDocuments'].includes(col) ? [{ name: 'create', fields: ['code', 'name', 'title', 'summary', 'serviceType', 'priority', 'description', 'paraSpace', 'relatedCollection', 'relatedRecordId'] }] : []),
        ],
      },
      {
        roleName: 'ldx_manager',
        name: col,
        dataSourceKey: 'main',
        usingActionsConfig: true,
        actions: [
          { name: 'view', fields: ['id', 'code', 'name', 'title', 'summary', 'status', 'severity', 'assetEntityId'] },
          { name: 'create', fields: ['code', 'name', 'title', 'summary', 'serviceType', 'priority', 'description', 'paraSpace', 'relatedCollection', 'relatedRecordId'] },
          { name: 'update', fields: ['name', 'title', 'summary', 'status'] },
        ],
      },
    ])),
  ];
  const tasks = [
    { id: 301, userId: 10, status: 0, node: { title: 'Duyệt phiếu Kiểm định Kho lạnh', key: 'review' }, execution: { context: { data: { code: 'QA-COLD-001', requesterId: 13 } } } },
  ];
  const auditLogs = [];

  const matchFilter = (row, filter = {}) => Object.entries(filter).every(([k, v]) => {
    if (k === '$or' && Array.isArray(v)) return v.some((sub) => matchFilter(row, sub));
    if (v && typeof v === 'object' && '$in' in v) return v.$in.includes(row[k]);
    return row[k] === v;
  });

  const store = {
    latticeEmployees: [
      { id: 13, userId: 9, code: 'EMP-9', organizationId: 'org-a', active: true },
      { id: 14, userId: 10, code: 'MGR-10', organizationId: 'org-a', active: true },
    ],
    latticeOrders: orders,
    latticeRequests: [{ id: 11, code: 'REQ-01', name: 'Mua cảm biến', organizationId: 'org-a', status: 'submitted' }],
    latticeServiceTickets: tickets,
    latticeIncidentCases: incidents,
    latticeAssets: [{ id: 21, code: 'COLD-ROOM-A1', name: 'Kho lạnh A1', organizationId: 'org-a', status: 'warning' }],
    latticeParaDocuments: paraDocs,
    latticeCustomColdAudits: coldAudits,
    collections,
    dataSourcesRolesResources,
    workflowManualTasks: tasks,
    latticeAiAuditLogs: auditLogs,
    latticeAiProfiles: [
      { id: 1, username: 'dxos-direct-allow', enabled: true, toolPermissions: { dxos_execute_record_action: 'ALLOW' } },
    ],
    latticeAiApprovalQueue: [],
  };

  let nextId = 500;
  const wrap = (row) => ({
    ...row,
    get: (k) => row[k],
    toJSON: () => ({ ...row }),
    update: async (u) => Object.assign(row, u),
  });

  const db = {
    store,
    hasCollection: (n) => Object.prototype.hasOwnProperty.call(store, n),
    sequelize: { transaction: async (fn) => fn({}) },
    getRepository(name) {
      const arr = store[name];
      if (!arr) return null;
      return {
        find: async ({ filter = {}, limit = 50 } = {}) => arr.filter((r) => matchFilter(r, filter)).slice(0, limit).map(wrap),
        findOne: async ({ filter = {}, filterByTk } = {}) => {
          const hit = filterByTk != null ? arr.find((r) => String(r.id ?? r.uid ?? r.name) === String(filterByTk)) : arr.find((r) => matchFilter(r, filter));
          return hit ? wrap(hit) : null;
        },
        count: async ({ filter = {} } = {}) => arr.filter((r) => matchFilter(r, filter)).length,
        create: async ({ values }) => {
          const item = { id: ++nextId, ...values };
          arr.push(item);
          return wrap(item);
        },
      };
    },
  };

  const makeCtx = (userId, username, roles) => ({
    db,
    state: { currentUser: { id: userId, username }, currentRoles: roles, currentRole: roles[0], dxosAiUsername: 'dxos-direct-allow' },
    app: { resourceManager: { getResource: () => null } },
  });

  const tools = createCopilotTools({
    val, failTool, resolveCallerRoleNames, isStudioAdmin, resolveActorScope,
    resolveReadablePolicies, isRowVisibleToActor,
    invokeResourceAction, createAuditedTool, WRITABLE_BUSINESS_COLLECTIONS,
    PROTECTED_SERVER_FIELDS, SEARCHABLE_COLLECTIONS, CUSTOM_COLLECTION_RE,
  });
  const byName = new Map(tools.map((t) => [t.definition.name, t]));
  return {
    db,
    byName,
    empCtx: makeCtx(9, 'emp9', ['ldx_employee']),
    mgrCtx: makeCtx(10, 'mgr10', ['ldx_manager']),
    adminCtx: makeCtx(1, 'admin', ['root']),
  };
}

test('dynamic latticeCustom* collections are searchable and enforce field-level RBAC on writes', async () => {
  const { db, byName, empCtx, mgrCtx } = makeCopilotHarness();
  const execTool = byName.get('dxos_execute_record_action');
  const searchTool = byName.get('dxos_search_enterprise_context');

  // Employee tries writing locked field auditVerdict -> 403 RBAC_FIELD_LOCKED
  await assert.rejects(() => execTool.invoke(empCtx, {
    collection: 'latticeCustomColdAudits',
    operation: 'create',
    values: { code: 'QA-BAD', name: 'Check', auditVerdict: 'PASS_OVERRIDE' },
  }), (err) => err.status === 403 && err.code === 'RBAC_FIELD_LOCKED');

  // Employee writes only unlocked fields -> allowed & searchable dynamically
  const created = await execTool.invoke(empCtx, {
    collection: 'latticeCustomColdAudits',
    operation: 'create',
    values: { code: 'QA-COLD-001', name: 'Kiểm định Kho A1', batchCode: 'LOT-01', warehouseZone: 'Zone-A', temperatureC: -11 },
  });
  assert.equal(created.record.organizationId, 'org-a');
  assert.equal(created.record.status, 'draft');

  // Employee tries update when only view/create granted -> 403 RBAC_ACTION_DENIED
  await assert.rejects(() => execTool.invoke(empCtx, {
    collection: 'latticeCustomColdAudits',
    operation: 'update',
    recordId: created.record.id,
    values: { inspectorNotes: 'Hack' },
  }), (err) => err.status === 403 && err.code === 'RBAC_ACTION_DENIED');

  // Manager CAN update auditVerdict
  const updated = await execTool.invoke(mgrCtx, {
    collection: 'latticeCustomColdAudits',
    operation: 'update',
    recordId: created.record.id,
    values: { auditVerdict: 'CANH_BAO_NHIET_DO', inspectorNotes: 'Cần bảo trì máy nén' },
  });
  assert.equal(updated.updatedFields.includes('auditVerdict'), true);
  assert.equal(db.store.latticeCustomColdAudits[0].auditVerdict, 'CANH_BAO_NHIET_DO');

  // Search discovers dynamic latticeCustomColdAudits record with citation
  const found = await searchTool.invoke(empCtx, { query: 'QA-COLD-001' });
  assert.equal(found.items.some((i) => i.collection === 'latticeCustomColdAudits' && i.code === 'QA-COLD-001'), true);
});

test('dxos_orchestrate_enterprise_case performs cross-module radar, correlateCase, and coordinated response with RBAC guard', async () => {
  const { db, byName, empCtx, mgrCtx } = makeCopilotHarness();
  const orch = byName.get('dxos_orchestrate_enterprise_case');

  const correlated = await orch.invoke(empCtx, { mode: 'correlateCase', query: 'Kho lạnh' });
  assert.equal(correlated.sops.some((s) => s.code === 'SOP-COLD-01'), true);
  assert.equal(correlated.incidents.some((i) => i.code === 'INC-COLD-09'), true);

  // Blocked if employee sneaks locked field into primaryRecord
  await assert.rejects(() => orch.invoke(empCtx, {
    mode: 'executeCoordinatedResponse',
    primaryRecord: {
      collection: 'latticeCustomColdAudits',
      values: { code: 'QA-SNEAK', name: 'Bypass test', auditVerdict: 'PASS' },
    },
  }), (err) => err.status === 403 && err.code === 'RBAC_FIELD_LOCKED');

  // Coordinated multi-record response: custom audit + service ticket + PARA handover note
  const res = await orch.invoke(empCtx, {
    mode: 'executeCoordinatedResponse',
    primaryRecord: {
      collection: 'latticeCustomColdAudits',
      values: { code: 'QA-COLD-002', name: 'Kiểm định Kho A1 ca tối', batchCode: 'LOT-02', temperatureC: -10 },
    },
    followUpTicket: {
      code: 'SRV-COLD-002',
      name: 'Bảo trì máy nén Kho lạnh A1',
      serviceType: 'facilities',
      priority: 'high',
      description: 'Theo SOP-COLD-01 xử lý vượt ngưỡng -10C',
    },
    paraHandoverNote: {
      code: 'PARA-HO-002',
      title: 'Biên bản bàn giao ca lạnh A1',
      paraSpace: 'projects',
      summary: 'Đã lập QA-COLD-002 & SRV-COLD-002 chờ Quản lý duyệt.',
    },
  });
  assert.equal(res.executed, true);
  assert.equal(res.created.primary.record.code, 'QA-COLD-002');
  assert.equal(res.created.followUpTicket.code, 'SRV-COLD-002');
  assert.equal(res.created.paraHandoverNote.code, 'PARA-HO-002');
  assert.equal(res.created.paraHandoverNote.status, 'active');
  assert.equal(res.created.paraHandoverNote.relatedCollection, 'latticeCustomColdAudits');
  assert.equal(typeof res.created.paraHandoverNote.relatedRecordId, 'string');

  const radar = await orch.invoke(mgrCtx, { mode: 'radar' });
  assert.equal(radar.modules.latticeCustomColdAudits.total >= 1, true);
  assert.equal(radar.modules.latticeServiceTickets.total >= 1, true);
  assert.equal(radar.pendingManualTasks, 1);
  assert.equal(db.store.latticeOrders.every((o) => o.organizationId !== 'org-b' || radar.organizationId === 'org-a'), true);
});

test('fail-closed read & write RBAC blocks unpermitted collections and row-scopes employee reads', async () => {
  const { db, byName } = makeCopilotHarness();
  db.store.latticeOrders.push({ id: 3, code: 'ORD-PEER-SAMEORG', name: 'Đơn đồng nghiệp cùng công ty', organizationId: 'org-a', status: 'submitted', requesterId: 14 });
  db.store.latticeEmployees.push({ id: 15, userId: 11, code: 'DRV-11', organizationId: 'org-a', active: true });
  const driverCtx = {
    db,
    state: { currentUser: { id: 11, username: 'drv11' }, currentRoles: ['ldx_driver'], currentRole: 'ldx_driver' },
    app: { resourceManager: { getResource: () => null } },
  };
  const empCtx = {
    db,
    state: { currentUser: { id: 9, username: 'emp9' }, currentRoles: ['ldx_employee'], currentRole: 'ldx_employee' },
    app: { resourceManager: { getResource: () => null } },
  };

  // ldx_driver has ZERO grants on latticeIncidentCases or latticeServiceTickets -> search & write denied/empty
  const drvSearch = await byName.get('dxos_search_enterprise_context').invoke(driverCtx, { query: '' });
  assert.equal(drvSearch.items.some((i) => i.collection === 'latticeIncidentCases'), false);
  await assert.rejects(
    () => byName.get('dxos_execute_record_action').invoke(driverCtx, { collection: 'latticeServiceTickets', operation: 'create', values: { code: 'T1', name: 'Hack' } }),
    (err) => err.status === 403,
  );

  // ldx_employee with own-scope on latticeOrders sees ORD-COLD-01 (requesterId=13) but NOT peer's ORD-PEER-SAMEORG (requesterId=14)
  const empOrders = await byName.get('dxos_search_enterprise_context').invoke(empCtx, { collections: ['latticeOrders'], query: '' });
  assert.equal(empOrders.items.some((i) => i.code === 'ORD-COLD-01'), true);
  assert.equal(empOrders.items.some((i) => i.code === 'ORD-PEER-SAMEORG'), false);
});

test('dxos_search_enterprise_context ranks diacritic-stripped Vietnamese queries via hybrid RRF with P.A.R.A. citations', async () => {
  const { db, byName } = makeCopilotHarness();
  db.store.latticeParaDocuments.push({
    id: 99,
    code: 'SOP-POWER-01',
    title: 'Hướng dẫn xử lý mất điện kho lạnh',
    organizationId: 'org-a',
    paraSpace: 'resources',
    summary: 'Khởi động máy phát điện trong 5 phút để giữ -18 độ C',
  });
  db.store.latticeParaDocuments.push({
    id: 100,
    code: 'SOP-FOREIGN-99',
    title: 'Mất điện kho lạnh org B',
    organizationId: 'org-b',
    paraSpace: 'resources',
    summary: 'Bị chặn khác tổ chức',
  });

  const empCtx = {
    db,
    state: { currentUser: { id: 9, username: 'emp9' }, currentRoles: ['ldx_employee'], currentRole: 'ldx_employee' },
    app: { resourceManager: { getResource: () => null } },
  };
  const res = await byName.get('dxos_search_enterprise_context').invoke(empCtx, { query: 'mat dien kho lanh' });
  assert.ok(res.count >= 1);
  assert.equal(res.items[0].code, 'SOP-POWER-01');
  assert.equal(res.items[0].citation, '[latticeParaDocuments:SOP-POWER-01#99]');
  assert.equal(res.items[0].paraCitation, '[latticeParaDocuments:SOP-POWER-01#99 · resources]');
  assert.ok(res.items[0].score > 0);
  assert.equal(res.items.some((it) => it.code === 'SOP-FOREIGN-99'), false);
});

test('dxos_search_enterprise_context bridges latticeParaChunks with section citations, org isolation, and PARA view RBAC', async () => {
  const { db, byName } = makeCopilotHarness();
  db.store.latticeParaChunks = [
    {
      id: 701,
      documentId: 5,
      organizationId: 'org-a',
      code: 'SOP-COLD-01',
      title: 'SOP Kiểm định Kho lạnh dưới -15C',
      paraSpace: 'resources',
      chunkIndex: 2,
      sectionTitle: 'Quy trình ứng phó mất điện máy nén',
      pageNumber: 3,
      content: 'Khi áp suất máy nén sụt giảm dưới ngưỡng an toàn, bật máy phát dự phòng trong 120 giây.',
      active: true,
    },
    {
      id: 702,
      documentId: 999,
      organizationId: 'org-b',
      code: 'SOP-ORG-B',
      title: 'Tài liệu Org B',
      paraSpace: 'resources',
      chunkIndex: 0,
      sectionTitle: 'Bí mật tổ chức B',
      pageNumber: 1,
      content: 'Áp suất máy nén tổ chức B không được phép rò rỉ.',
      active: true,
    },
  ];

  const empCtx = {
    db,
    state: { currentUser: { id: 9, username: 'emp9' }, currentRoles: ['ldx_employee'], currentRole: 'ldx_employee' },
    app: { resourceManager: { getResource: () => null } },
  };
  const found = await byName.get('dxos_search_enterprise_context').invoke(empCtx, { query: 'ap suat may nen du phong' });
  const chunkHit = found.items.find((it) => it.collection === 'latticeParaChunks');
  assert.ok(chunkHit, 'Expected latticeParaChunks match in search results');
  assert.equal(chunkHit.sectionTitle, 'Quy trình ứng phó mất điện máy nén');
  assert.equal(chunkHit.chunkIndex, 2);
  assert.equal(chunkHit.pageNumber, 3);
  assert.ok(chunkHit.citation.includes('SOP-COLD-01'));
  assert.ok(chunkHit.citation.includes('Quy trình ứng phó mất điện máy nén'));
  assert.equal(found.items.some((it) => it.code === 'SOP-ORG-B'), false);

  // Driver has NO view grant on latticeParaDocuments -> chunks must NOT be exposed either
  db.store.latticeEmployees.push({ id: 15, userId: 11, code: 'DRV-11', organizationId: 'org-a', active: true });
  const driverCtx = {
    db,
    state: { currentUser: { id: 11, username: 'drv11' }, currentRoles: ['ldx_driver'], currentRole: 'ldx_driver' },
    app: { resourceManager: { getResource: () => null } },
  };
  const drvRes = await byName.get('dxos_search_enterprise_context').invoke(driverCtx, { query: 'ap suat may nen' });
  assert.equal(drvRes.items.some((it) => it.collection === 'latticeParaChunks'), false);

  // Own-scoped reader on latticeParaDocuments only sees chunks belonging to their own documents
  const ownPolicyIdx = db.store.dataSourcesRolesResources.findIndex((p) => p.roleName === 'ldx_employee' && p.name === 'latticeParaDocuments');
  db.store.dataSourcesRolesResources[ownPolicyIdx] = {
    roleName: 'ldx_employee',
    name: 'latticeParaDocuments',
    dataSourceKey: 'main',
    usingActionsConfig: true,
    actions: [{ name: 'view', fields: ['id', 'code', 'title', 'paraSpace', 'ownerId'], scope: { own: true } }],
  };
  db.store.latticeParaDocuments.push(
    { id: 50, code: 'SOP-OWN-50', title: 'Tài liệu riêng emp9', organizationId: 'org-a', paraSpace: 'projects', ownerId: 13 },
    { id: 51, code: 'SOP-PEER-51', title: 'Tài liệu riêng mgr10', organizationId: 'org-a', paraSpace: 'projects', ownerId: 14 },
  );
  db.store.latticeParaChunks.push(
    { id: 703, documentId: 50, organizationId: 'org-a', code: 'SOP-OWN-50', title: 'Tài liệu riêng emp9', paraSpace: 'projects', chunkIndex: 0, sectionTitle: 'Mục riêng emp9', pageNumber: 1, content: 'Quy trình nội bộ emp9 máy nén lạnh', active: true },
    { id: 704, documentId: 51, organizationId: 'org-a', code: 'SOP-PEER-51', title: 'Tài liệu riêng mgr10', paraSpace: 'projects', chunkIndex: 0, sectionTitle: 'Mục riêng mgr10', pageNumber: 1, content: 'Quy trình bí mật mgr10 máy nén lạnh', active: true },
  );
  const ownRes = await byName.get('dxos_search_enterprise_context').invoke(empCtx, { query: 'may nen lanh' });
  assert.equal(ownRes.items.some((it) => it.collection === 'latticeParaChunks' && it.code === 'SOP-OWN-50'), true);
  assert.equal(ownRes.items.some((it) => it.collection === 'latticeParaChunks' && it.code === 'SOP-PEER-51'), false);
});
