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
  safeGetResource,
  invokeResourceAction,
  createAuditedTool,
  SYSTEM_PROTECTED_COLLECTIONS,
  CUSTOM_COLLECTION_RE,
  FIELD_NAME_RE,
  SLUG_RE,
  ALLOWED_BLOCK_MODELS,
} = require('../src/server/ai-tools-core');
const { createBuilderTools } = require('../src/server/ai-builder-tools');

function makeBuilderHarness() {
  const flowModels = [
    {
      uid: 'grid-ov-services',
      use: 'BlockGridModel',
      parentId: 'tab-ov-services',
      subKey: 'grid',
      props: { rows: { r0: [['dxos-ov-services-hero']], r1: [['dxos-ov-services-para']] }, sizes: { r0: [24], r1: [24] }, rowOrder: ['r0', 'r1'] },
      stepParams: { gridSettings: { grid: { rows: { r0: [['dxos-ov-services-hero']], r1: [['dxos-ov-services-para']] }, sizes: { r0: [24], r1: [24] }, rowOrder: ['r0', 'r1'] } } },
    },
    {
      uid: 'dxos-ov-services-hero',
      use: 'DxosPortalHeroBlockModel',
      parentId: 'grid-ov-services',
      props: { title: 'Hero Services', accentColor: '#6366f1' },
      stepParams: { dxosBlockSettings: { config: { title: 'Hero Services', accentColor: '#6366f1' } } },
    },
    {
      uid: 'dxos-ov-services-para',
      use: 'DxosParaVaultBlockModel',
      parentId: 'grid-ov-services',
      props: { title: 'Kho P.A.R.A.', pageSize: 6 },
      stepParams: { dxosBlockSettings: { config: { title: 'Kho P.A.R.A.', pageSize: 6 } } },
    },
  ];
  const uiLayouts = [{ uid: 'ldx-portal-services', title: 'Dịch vụ', layoutType: 'desktop', routeName: 'p_services', routePath: '/p/services' }];
  const desktopRoutes = [
    { id: 10, title: 'Dịch vụ', type: 'group', parentId: null },
    { id: 11, title: 'Tổng quan Services', type: 'flowPage', parentId: 10, schemaUid: 'pg-ov-1' },
    { id: 12, title: 'Tổng quan Services', type: 'tabs', parentId: 11, schemaUid: 'tab-ov-services' },
  ];
  const desktopRoutesUiLayouts = [
    { desktopRouteId: 10, uiLayoutUid: 'ldx-portal-services' },
    { desktopRouteId: 11, uiLayoutUid: 'ldx-portal-services' },
    { desktopRouteId: 12, uiLayoutUid: 'ldx-portal-services' },
  ];
  const rolesDesktopRoutes = [
    { id: 1, roleName: 'ldx_employee', desktopRouteId: 10 },
    { id: 2, roleName: 'ldx_employee', desktopRouteId: 11 },
  ];
  const collections = [
    { name: 'latticeOrders', title: 'Đơn hàng', fields: [{ name: 'code', type: 'string' }, { name: 'name', type: 'string' }, { name: 'status', type: 'string' }] },
  ];
  const fields = [];
  const roles = [
    { name: 'root', title: 'Root', allowConfigure: true },
    { name: 'admin', title: 'Admin', allowConfigure: true },
    { name: 'ldx_employee', title: 'Nhân viên', allowConfigure: false, allowNewMenu: false, allowNewAiEmployee: false, snippets: [] },
    { name: 'ldx_manager', title: 'Quản lý', allowConfigure: false, allowNewMenu: false, allowNewAiEmployee: false, snippets: [] },
  ];
  const dataSourcesRoles = [{ roleName: 'ldx_employee', dataSourceKey: 'main' }];
  const dataSourcesRolesResources = [];
  const latticeEmployees = [
    { id: 13, userId: 9, code: 'NATIVE-UI-EMPLOYEE', name: 'NV', organizationId: 'native-ui-lab', active: true, user: { roles: [{ name: 'ldx_employee' }] } },
    { id: 14, userId: 10, code: 'NATIVE-UI-MANAGER', name: 'QL', organizationId: 'native-ui-lab', active: true, user: { roles: [{ name: 'ldx_manager' }] } },
    { id: 15, userId: 11, code: 'NATIVE-UI-WORKER', name: 'Kho', organizationId: 'native-ui-lab', active: true, user: { roles: [{ name: 'ldx_warehouse' }] } },
  ];
  const workflows = [
    { id: 50, key: 'wf-50', title: 'Quy trình Vận hành Chuẩn', type: 'collection', enabled: false, current: true, config: { collection: 'latticeOrders', mode: 1 } },
  ];
  const flow_nodes = [
    { id: 501, workflowId: 50, key: 'checkTemp', title: 'Kiểm tra nhiệt độ', type: 'condition', upstreamId: null, downstreamId: 502, config: { threshold: -15 } },
    { id: 502, workflowId: 50, key: 'review', title: 'Quản lý duyệt', type: 'manual', upstreamId: 501, downstreamId: null, config: { assignees: ['14'] } },
  ];
  const auditLogs = [];
  const portalSaveCalls = [];
  const studioInstallCalls = [];
  const workflowUpdateCalls = [];
  const aclRevokes = [];

  const matchFilter = (row, filter = {}) => Object.entries(filter).every(([k, v]) => {
    if (k === '$or' && Array.isArray(v)) return v.some((sub) => matchFilter(row, sub));
    if (v && typeof v === 'object' && '$in' in v) return v.$in.includes(row[k]);
    if (k.startsWith('options.')) {
      const subKey = k.slice('options.'.length);
      return row?.options?.[subKey] === v;
    }
    return row[k] === v;
  });

  const wrap = (arr, row, extra = {}) => ({
    ...row,
    ...extra,
    get: (k) => (k === 'fields' && row.fields ? row.fields : row[k]),
    toJSON: () => ({ ...row }),
    update: async (u) => { Object.assign(row, u); return wrap(arr, row, extra); },
  });

  const store = {
    flowModels, uiLayouts, desktopRoutes, desktopRoutesUiLayouts, rolesDesktopRoutes,
    collections, fields, roles, dataSourcesRoles, dataSourcesRolesResources,
    latticeEmployees, workflows, flow_nodes, latticeAiAuditLogs: auditLogs,
  };

  let nextId = 900;
  const db = {
    store,
    portalSaveCalls,
    studioInstallCalls,
    workflowUpdateCalls,
    aclRevokes,
    hasCollection: (n) => store.collections.some((c) => c.name === n) || n === 'latticeOrders',
    sequelize: { transaction: async (fn) => fn({}) },
    sync: async () => {},
    getRepository(name) {
      const arr = store[name];
      if (!arr) return null;
      const base = {
        find: async ({ filter = {}, limit = 200 } = {}) => arr.filter((r) => matchFilter(r, filter)).slice(0, limit).map((r) => wrap(arr, r)),
        findOne: async ({ filter = {}, filterByTk } = {}) => {
          const hit = filterByTk != null
            ? arr.find((r) => String(r.id ?? r.uid ?? r.name) === String(filterByTk))
            : arr.find((r) => matchFilter(r, filter));
          if (!hit) return null;
          if (name === 'collections') {
            return wrap(arr, hit, {
              load: async () => { db.loadedCollection = hit.name; },
              getFields: async () => hit.fields || [],
            });
          }
          return wrap(arr, hit);
        },
        count: async ({ filter = {} } = {}) => arr.filter((r) => matchFilter(r, filter)).length,
        create: async ({ values }) => {
          const id = values.id ?? ++nextId;
          const row = { id, ...values };
          arr.push(row);
          if (name === 'collections') {
            return wrap(arr, row, {
              load: async () => { db.loadedCollection = row.name; },
              getFields: async () => row.fields || [],
            });
          }
          return wrap(arr, row);
        },
        update: async ({ filter = {}, filterByTk, values }) => {
          const hits = arr.filter((r) => (filterByTk != null ? String(r.id ?? r.uid ?? r.name) === String(filterByTk) : matchFilter(r, filter)));
          for (const h of hits) Object.assign(h, values);
          return hits.map((h) => wrap(arr, h));
        },
        destroy: async ({ filter = {} } = {}) => {
          let removed = 0;
          for (let i = arr.length - 1; i >= 0; i--) {
            if (matchFilter(arr[i], filter)) { arr.splice(i, 1); removed += 1; }
          }
          return removed;
        },
      };
      if (name === 'flowModels') {
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
        base.remove = async (uid) => {
          const idx = arr.findIndex((m) => m.uid === uid);
          if (idx >= 0) arr.splice(idx, 1);
        };
      }
      return base;
    },
  };

  const ctx = {
    db,
    state: { currentUser: { id: 1, username: 'admin' }, currentRoles: ['root'], currentRole: 'root' },
    app: {
      acl: {
        getRole: (roleName) => ({
          revokeResource: (resName) => aclRevokes.push({ roleName, resName }),
          grantAction: () => {},
        }),
      },
      resourceManager: {
        getResource: (resName) => {
          if (resName === 'flowSurfaces') {
            return {
              actions: {
                get: () => ({
                  handler: async (subCtx) => {
                    const bp = subCtx.action.params.values;
                    const groupId = ++nextId;
                    const pageId = ++nextId;
                    const tabId = ++nextId;
                    const tabUid = `tab-${pageId}`;
                    const gridUid = `grid-${pageId}`;
                    desktopRoutes.push({ id: groupId, title: bp.navigation.group.title, type: 'group', parentId: null });
                    desktopRoutes.push({ id: pageId, title: bp.navigation.item.title, type: 'flowPage', parentId: groupId, schemaUid: `pg-${pageId}` });
                    desktopRoutes.push({ id: tabId, title: bp.navigation.item.title, type: 'tabs', parentId: pageId, schemaUid: tabUid });
                    desktopRoutesUiLayouts.push(
                      { desktopRouteId: groupId, uiLayoutUid: bp.navigation.layoutUid },
                      { desktopRouteId: pageId, uiLayoutUid: bp.navigation.layoutUid },
                      { desktopRouteId: tabId, uiLayoutUid: bp.navigation.layoutUid },
                    );
                    flowModels.push({ uid: gridUid, use: 'BlockGridModel', parentId: tabUid, subKey: 'grid', props: { rows: {}, sizes: {}, rowOrder: [] }, stepParams: {} });
                    subCtx.body = { data: { pageUid: `pg-${pageId}`, tabUid, groupId, pageId, tabId } };
                  },
                }),
              },
            };
          }
          if (resName === 'latticePortals') {
            return {
              actions: {
                get: (actionName) => actionName === 'save' ? {
                  handler: async (subCtx) => {
                    const v = subCtx.action.params.values;
                    portalSaveCalls.push(v);
                    const exist = uiLayouts.find((l) => l.uid === v.uid);
                    if (exist) Object.assign(exist, v);
                    else uiLayouts.push({ ...v });
                    subCtx.body = { ...v, routePath: `/p/${v.slug}` };
                  },
                } : null,
              },
            };
          }
          if (resName === 'dxosStudio') {
            return {
              actions: {
                get: (actionName) => actionName === 'installWorkflow' ? {
                  handler: async (subCtx) => {
                    studioInstallCalls.push(subCtx.action.params.values);
                    subCtx.body = { workflowId: 777, enabled: true };
                  },
                } : null,
              },
            };
          }
          if (resName === 'workflows') {
            return {
              actions: {
                get: (actionName) => actionName === 'update' ? {
                  handler: async (subCtx) => {
                    const wf = workflows.find((w) => String(w.id) === String(subCtx.action.params.filterByTk));
                    if (wf) Object.assign(wf, subCtx.action.params.values);
                    workflowUpdateCalls.push(subCtx.action.params);
                    subCtx.body = wf || {};
                  },
                } : null,
              },
            };
          }
          return null;
        },
      },
    },
  };

  const tools = createBuilderTools({
    val, failTool, resolveCallerRoleNames, isStudioAdmin, resolveActorScope,
    safeGetResource, invokeResourceAction, createAuditedTool, SYSTEM_PROTECTED_COLLECTIONS,
    CUSTOM_COLLECTION_RE, FIELD_NAME_RE, SLUG_RE, ALLOWED_BLOCK_MODELS,
  });
  const byName = new Map(tools.map((t) => [t.definition.name, t]));
  return { db, ctx, byName };
}

test('dxos_compose_page_blocks v2 supports listBlocks, composePageBlueprint + role propagation, updateBlock, reorderBlocks, and removeBlock', async () => {
  const { db, ctx, byName } = makeBuilderHarness();
  const blockTool = byName.get('dxos_compose_page_blocks');

  const listed = await blockTool.invoke(ctx, { action: 'listBlocks', portalSlug: 'services' });
  assert.equal(listed.blocks.length, 2);
  assert.equal(listed.blocks[0].uid, 'dxos-ov-services-hero');

  const composed = await blockTool.invoke(ctx, {
    action: 'composePageBlueprint',
    portalSlug: 'services',
    groupTitle: 'QA Kho lạnh',
    title: 'Kiểm định Lô lạnh',
    collection: 'latticeOrders',
    tableFields: ['code', 'name', 'status'],
    includeCreateForm: true,
    dxosBlocks: [
      { blockUse: 'DxosPortalHeroBlockModel', title: 'Hero Cold QA', config: { accentColor: '#0284c7' } },
      { blockUse: 'DxosKpiMetricBlockModel', title: 'KPI Cold QA', config: { columns: 2 } },
    ],
  });
  assert.equal(composed.applied, true);
  assert.equal(composed.attachedDxosBlocks.length, 2);
  // Propagated ldx_employee visibility onto new portal routes
  assert.equal(db.store.rolesDesktopRoutes.filter((r) => r.roleName === 'ldx_employee').length > 2, true);

  const heroUid = composed.attachedDxosBlocks[0].uid;
  const dryEdit = await blockTool.invoke(ctx, { action: 'updateBlock', portalSlug: 'services', blockUid: heroUid, config: { accentColor: '#dc2626' }, dryRun: true });
  assert.equal(dryEdit.dryRun, true);
  assert.equal(dryEdit.afterProps.accentColor, '#dc2626');

  const updated = await blockTool.invoke(ctx, { action: 'updateBlock', portalSlug: 'services', blockUid: heroUid, title: 'Hero Updated', config: { accentColor: '#dc2626' } });
  assert.equal(updated.updated, true);
  assert.equal(db.store.flowModels.find((m) => m.uid === heroUid).props.accentColor, '#dc2626');

  const reordered = await blockTool.invoke(ctx, { action: 'reorderBlocks', portalSlug: 'services', orderedBlockUids: ['dxos-ov-services-para', 'dxos-ov-services-hero'] });
  assert.equal(reordered.reordered, true);
  const ovGrid = db.store.flowModels.find((m) => m.uid === 'grid-ov-services');
  assert.deepEqual(ovGrid.props.rows[ovGrid.props.rowOrder[0]][0], ['dxos-ov-services-para']);

  const removed = await blockTool.invoke(ctx, { action: 'removeBlock', portalSlug: 'services', blockUid: heroUid });
  assert.equal(removed.removed, true);
  assert.equal(db.store.flowModels.some((m) => m.uid === heroUid), false);
});

test('dxos_manage_rbac_permissions configures granular resource/field ACLs and blocks root/admin & system collections', async () => {
  const { db, ctx, byName } = makeBuilderHarness();
  const rbacTool = byName.get('dxos_manage_rbac_permissions');

  await assert.rejects(() => rbacTool.invoke(ctx, { operation: 'grantResource', roleName: 'root', collectionName: 'latticeOrders', actions: ['view'] }), (e) => e.status === 403);
  await assert.rejects(() => rbacTool.invoke(ctx, { operation: 'grantResource', roleName: 'ldx_employee', collectionName: 'users', actions: ['view'] }), (e) => e.status === 403);

  const customRole = await rbacTool.invoke(ctx, { operation: 'ensureCustomRole', roleName: 'ldx_qa_inspector', title: 'Lattice — Thanh tra Kho lạnh', cloneFromRole: 'ldx_employee' });
  assert.equal(customRole.roleName, 'ldx_qa_inspector');
  assert.equal(db.store.roles.some((r) => r.name === 'ldx_qa_inspector' && r.allowConfigure === false), true);

  const granted = await rbacTool.invoke(ctx, {
    operation: 'grantResource',
    roleName: 'ldx_employee',
    collectionName: 'latticeCustomColdAudits',
    actions: ['view', 'create', 'update'],
    readableFields: ['id', 'code', 'batchCode', 'temperatureC', 'auditVerdict'],
    writableFields: ['code', 'batchCode', 'temperatureC', 'organizationId', 'auditVerdict'],
    lockedFields: ['auditVerdict'],
    scopeMode: 'own_draft',
  });
  assert.equal(granted.applied, true);
  assert.equal(db.store.dataSourcesRolesResources.length, 1);
  const createAction = db.store.dataSourcesRolesResources[0].actions.find((a) => a.name === 'create');
  assert.equal(createAction.fields.includes('organizationId'), false);
  assert.equal(createAction.fields.includes('auditVerdict'), false);
  assert.equal(createAction.fields.includes('batchCode'), true);

  const inspected = await rbacTool.invoke(ctx, { operation: 'inspectRole', roleName: 'ldx_employee' });
  assert.equal(inspected.resources.some((r) => r.collectionName === 'latticeCustomColdAudits'), true);

  const revoked = await rbacTool.invoke(ctx, { operation: 'revokeResource', roleName: 'ldx_employee', collectionName: 'latticeCustomColdAudits', actions: ['update'] });
  assert.equal(revoked.revoked, true);
  assert.equal(db.store.dataSourcesRolesResources[0].actions.some((a) => a.name === 'update'), false);

  const revokedAll = await rbacTool.invoke(ctx, { operation: 'revokeResource', roleName: 'ldx_employee', collectionName: 'latticeCustomColdAudits' });
  assert.equal(revokedAll.revokedAll, true);
  assert.equal(db.aclRevokes.some((r) => r.roleName === 'ldx_employee' && r.resName === 'latticeCustomColdAudits'), true);
});

test('dxos_configure_workflow and dxos_deploy_workflow inspect, edit nodes, auto-bind crew, build custom workflow, and toggle enabled', async () => {
  const { db, ctx, byName } = makeBuilderHarness();
  const deployTool = byName.get('dxos_deploy_workflow');
  const wfTool = byName.get('dxos_configure_workflow');

  const deployed = await deployTool.invoke(ctx, { templateKey: 'internal-service', organizationId: 'native-ui-lab', enabled: true });
  assert.equal(deployed.workflowId, 777);
  assert.equal(db.studioInstallCalls[0].reviewerEmployeeId, 14);
  assert.equal(db.studioInstallCalls[0].assigneeEmployeeId, 15);

  const inspected = await wfTool.invoke(ctx, { operation: 'inspectWorkflow', workflowId: 50 });
  assert.equal(inspected.nodes.length, 2);

  const edited = await wfTool.invoke(ctx, { operation: 'updateNodeConfig', workflowId: 50, nodeId: 501, title: 'Ngưỡng lạnh nghiêm ngặt', configPatch: { threshold: -18 } });
  assert.equal(edited.updated, true);
  assert.equal(db.store.flow_nodes.find((n) => n.id === 501).config.threshold, -18);

  const added = await wfTool.invoke(ctx, { operation: 'addNode', workflowId: 50, upstreamNodeId: 502, nodeType: 'update', title: 'Đóng trạng thái', config: { params: { values: { status: 'completed' } } } });
  assert.equal(added.added, true);
  assert.equal(db.store.flow_nodes.find((n) => n.id === 502).downstreamId, added.node.id);

  const customWf = await wfTool.invoke(ctx, {
    operation: 'buildCustomWorkflow',
    title: 'Quy trình Kiểm định Kho lạnh Tự động',
    collectionName: 'latticeCustomColdAudits',
    triggerMode: 1,
    assigneeEmployeeId: 14,
    conditionField: 'temperatureC',
    conditionGt: -15,
    enabled: true,
  });
  assert.equal(customWf.created, true);
  assert.equal(customWf.nodeCount >= 3, true);
  assert.equal(db.store.workflows.find((w) => w.id === customWf.workflowId).enabled, true);

  const toggled = await wfTool.invoke(ctx, { operation: 'toggleWorkflow', workflowId: 50, enabled: true });
  assert.equal(toggled.enabled, true);
  assert.equal(db.workflowUpdateCalls.length >= 1, true);
});

test('workflow & portal tools survive NocoBase Resourcer.getResource throwing "resource does not exist"', async () => {
  const { db, ctx, byName } = makeBuilderHarness();
  const throwingRm = {
    isDefined: (n) => n === 'flowSurfaces',
    getResource: (n) => {
      if (n !== 'flowSurfaces') throw new Error(`${n} resource does not exist`);
      return ctx.app.resourceManager.getResource(n);
    },
  };
  const strictCtx = { ...ctx, app: { ...ctx.app, resourceManager: throwingRm } };
  const built = await byName.get('dxos_configure_workflow').invoke(strictCtx, {
    operation: 'buildCustomWorkflow',
    title: 'WF With Strict Resourcer',
    collectionName: 'latticeCustomColdAudits',
    enabled: true,
  });
  assert.equal(built.created, true);
  assert.equal(built.enabled, true);
  const portalRes = await byName.get('dxos_manage_portal_and_acl').invoke(strictCtx, {
    slug: 'cold-qa-fallback',
    title: 'Fallback Portal',
    roleNames: ['ldx_employee'],
  });
  assert.equal(portalRes.applied, true);
});

test('lockFields preserves scope/scopeId + writeToACL, addNode splices safely, and buildCustomWorkflow scopes organizationId', async () => {
  const { db, ctx, byName } = makeBuilderHarness();
  const rbacTool = byName.get('dxos_manage_rbac_permissions');
  const wfTool = byName.get('dxos_configure_workflow');

  let writeToAclCalled = 0;
  db.store.dataSourcesRolesResources.push({
    roleName: 'ldx_employee',
    name: 'latticeOrders',
    dataSourceKey: 'main',
    usingActionsConfig: true,
    actions: [
      { name: 'view', fields: ['id', 'code', 'status'], scopeId: 42, scope: { own: true } },
      { name: 'update', fields: ['code', 'auditVerdict'], scopeId: 43, scope: { ownDraft: true } },
    ],
  });
  const baseGetRepo = db.getRepository.bind(db);
  db.getRepository = (n) => {
    const repo = baseGetRepo(n);
    if (n !== 'dataSourcesRolesResources') return repo;
    return {
      ...repo,
      update: async ({ filter, values }) => {
        const hit = db.store.dataSourcesRolesResources.find((r) => r.roleName === filter.roleName && r.name === filter.name);
        Object.assign(hit, values);
        hit.writeToACL = async () => { writeToAclCalled += 1; };
        return [hit];
      },
    };
  };

  await rbacTool.invoke(ctx, {
    operation: 'lockFields',
    roleName: 'ldx_employee',
    collectionName: 'latticeOrders',
    lockedFields: ['auditVerdict'],
  });
  const updatedRes = db.store.dataSourcesRolesResources.find((r) => r.roleName === 'ldx_employee' && r.name === 'latticeOrders');
  const viewAct = updatedRes.actions.find((a) => a.name === 'view');
  const updAct = updatedRes.actions.find((a) => a.name === 'update');
  assert.equal(viewAct.scopeId, 42);
  assert.deepEqual(viewAct.scope, { own: true });
  assert.equal(updAct.scopeId, 43);
  assert.deepEqual(updAct.scope, { ownDraft: true });
  assert.equal(writeToAclCalled, 1);

  // addNode between node 501 (downstreamId: 502) and 502 splices instead of orphaning 502
  const spliced = await wfTool.invoke(ctx, {
    operation: 'addNode',
    workflowId: 50,
    upstreamNodeId: 501,
    nodeType: 'calculation',
    title: 'Bước trung gian',
    config: {},
  });
  const node501 = db.store.flow_nodes.find((n) => n.id === 501);
  const node502 = db.store.flow_nodes.find((n) => n.id === 502);
  const midNode = db.store.flow_nodes.find((n) => n.id === spliced.node.id);
  assert.equal(node501.downstreamId, midNode.id);
  assert.equal(midNode.upstreamId, 501);
  assert.equal(midNode.downstreamId, 502);
  assert.equal(node502.upstreamId, midNode.id);

  // buildCustomWorkflow scopes trigger condition & update node by actor.organizationId
  const customWf = await wfTool.invoke(ctx, {
    operation: 'buildCustomWorkflow',
    title: 'Multi-tenant Scoped WF',
    collectionName: 'latticeCustomColdAudits',
    enabled: false,
  });
  const createdWf = db.store.workflows.find((w) => w.id === customWf.workflowId);
  assert.deepEqual(createdWf.config.condition, { $and: [{ organizationId: 'native-ui-lab' }] });
  const markNode = db.store.flow_nodes.find((n) => n.workflowId === customWf.workflowId && n.key === 'markReviewed');
  assert.equal(markNode.config.params.filter.organizationId, 'native-ui-lab');
});

test('DxosRecordWorkbenchBlockModel is allowed and createCollection ensures organizationId & status indexes', async () => {
  assert.equal(ALLOWED_BLOCK_MODELS.includes('DxosRecordWorkbenchBlockModel'), true);
  const { db, ctx, byName } = makeBuilderHarness();

  const wbPreview = await byName.get('dxos_compose_page_blocks').invoke(ctx, {
    action: 'addBlock',
    portalSlug: 'services',
    blockUse: 'DxosRecordWorkbenchBlockModel',
    title: 'Bàn làm việc Chứng từ',
    config: { collection: 'latticeServiceTickets', showExport: true, showVoucherActions: true, showChatter: true },
    dryRun: true,
  });
  assert.equal(wbPreview.dryRun, true);
  assert.equal(wbPreview.blockUse, 'DxosRecordWorkbenchBlockModel');

  const sqlQueries = [];
  const rlsAttached = [];
  db.attachLatticeRlsPolicy = async (tableName) => { rlsAttached.push(tableName); };
  db.sequelize = {
    transaction: async (fn) => fn({}),
    query: async (sql) => { sqlQueries.push(sql); return [[], 0]; },
  };
  const created = await byName.get('dxos_extend_collection_schema').invoke(ctx, {
    operation: 'createCollection',
    collectionName: 'latticeCustomColdAudits',
    title: 'Kiểm định Chuỗi lạnh',
    fields: [{ name: 'temperatureC', type: 'float', title: 'Nhiệt độ' }],
    dryRun: false,
  });
  assert.equal(created.created, true);
  assert.deepEqual(rlsAttached, ['latticeCustomColdAudits']);
  assert.equal(
    sqlQueries.some((q) => /CREATE INDEX IF NOT EXISTS "idx_latticecustomcoldaudits_org"\s+ON\s+"latticeCustomColdAudits"\s*\("organizationId"\)/i.test(q)),
    true,
  );
  assert.equal(
    sqlQueries.some((q) => /CREATE INDEX IF NOT EXISTS "idx_latticecustomcoldaudits_org_status"\s+ON\s+"latticeCustomColdAudits"\s*\("organizationId",\s*"status"\)/i.test(q)),
    true,
  );

  // addFields attaching organizationId on custom collection also triggers attachLatticeRlsPolicy
  const addedOrgField = await byName.get('dxos_extend_collection_schema').invoke(ctx, {
    operation: 'addFields',
    collectionName: 'latticeCustomColdAudits',
    fields: [{ name: 'organizationId', type: 'string', title: 'Tổ chức' }],
    dryRun: false,
  });
  assert.equal(addedOrgField.updated, true);
  assert.deepEqual(rlsAttached, ['latticeCustomColdAudits', 'latticeCustomColdAudits']);

  // Very long collectionName truncates/hashes index name <= 63 chars for PostgreSQL NAMEDATALEN
  const longQueries = [];
  db.sequelize.query = async (sql) => { longQueries.push(sql); return [[], 0]; };
  const longCol = 'latticeCustomVeryLongEnterpriseCollectionNameAlpha12';
  await byName.get('dxos_extend_collection_schema').invoke(ctx, {
    operation: 'createCollection',
    collectionName: longCol,
    title: 'Long Name Collection',
    fields: [{ name: 'note', type: 'string', title: 'Ghi chú' }],
    dryRun: false,
  });
  const indexSqls = longQueries.filter((q) => /CREATE INDEX/i.test(q));
  assert.equal(indexSqls.length, 2);
  for (const q of indexSqls) {
    const m = q.match(/CREATE INDEX IF NOT EXISTS "([^"]+)"/);
    assert.ok(m && m[1].length <= 63, `Expected index name <= 63 chars, got ${m?.[1]?.length}: ${m?.[1]}`);
  }
});
