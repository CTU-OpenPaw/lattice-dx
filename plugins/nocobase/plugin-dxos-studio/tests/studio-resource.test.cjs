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
const path = require('node:path');

const PLUGIN_ROOT = path.resolve(__dirname, '..');

test('latticeServiceTickets enforces org scope, chart query scoping, and idempotent 7-role ACL', async () => {
  const { serviceTickets, validateServiceTicket } = require(path.join(PLUGIN_ROOT, 'src/server/service-schema.js'));
  const { createServiceScopeMiddleware } = require(path.join(PLUGIN_ROOT, 'src/server/service-scope.js'));
  const { installServiceRoleGrants } = require(path.join(PLUGIN_ROOT, 'src/server/service-roles.js'));

  assert.equal(serviceTickets.name, 'latticeServiceTickets');
  assert.equal(serviceTickets.uiManageable, true);

  // Validation stamps org/requester/draft/version from actor
  const data = new Map([['code', ' SVC-1 '], ['name', ' Xin nghỉ phép '], ['serviceType', 'leave'], ['priority', 'high']]);
  validateServiceTicket(
    { isNewRecord: true, get: (k) => data.get(k), set: (k, v) => data.set(k, v) },
    { context: { state: { latticeNativeActor: { organizationId: 'org-a', employeeId: 8 } } } },
  );
  assert.equal(data.get('organizationId'), 'org-a');
  assert.equal(data.get('requesterId'), 8);
  assert.equal(data.get('status'), 'draft');

  // Middleware guards charts:queryData & ticket writes
  const employees = [{ id: 8, userId: 80, organizationId: 'org-a', departmentId: 2, active: true }];
  const db = {
    sequelize: { transaction: async (fn) => fn({}) },
    getRepository(name) {
      if (name === 'latticeEmployees') return { find: async ({ filter }) => employees.filter((e) => Number(e.userId) === Number(filter?.userId)) };
      if (name === 'roles') return { findOne: async ({ filter }) => ({ name: filter.name }) };
      if (name === 'dataSourcesRolesResources') {
        const grants = [];
        return {
          _grants: grants,
          findOne: async ({ filter }) => grants.find((g) => g.roleName === filter.roleName && g.name === filter.name) || null,
          create: async ({ values }) => { grants.push(values); return values; },
        };
      }
      return null;
    },
  };
  const mw = createServiceScopeMiddleware(db);
  const chartCtx = {
    state: { currentRole: 'ldx_employee', currentUser: { id: 80 } },
    action: { resourceName: 'charts', actionName: 'queryData', params: { values: { mode: 'builder', collection: 'latticeServiceTickets', filter: {} } } },
  };
  await mw(chartCtx, async () => {});
  assert.deepEqual(chartCtx.action.params.values.filter, { $and: [{ organizationId: 'org-a' }, {}] });

  await assert.rejects(
    () => mw({
      state: { currentRole: 'ldx_employee', currentUser: { id: 80 } },
      action: { resourceName: 'latticeServiceTickets', actionName: 'create', params: { values: { code: 'X', name: 'Y', status: 'approved' } } },
    }, async () => {}),
    (err) => err.status === 403 && err.code === 'NATIVE_DOCUMENT_PROTECTED_FIELD',
  );

  // ACL grants idempotency
  const grantStore = [];
  const aclDb = {
    sequelize: { transaction: async (fn) => fn({}) },
    getRepository(name) {
      if (name === 'roles') return { findOne: async ({ filter }) => ({ name: filter.name }) };
      if (name === 'dataSourcesRolesResources') {
        return {
          findOne: async ({ filter }) => grantStore.find((g) => g.roleName === filter.roleName && g.name === filter.name) || null,
          create: async ({ values }) => { grantStore.push(values); return values; },
        };
      }
      return null;
    },
  };
  await installServiceRoleGrants(aclDb);
  assert.equal(grantStore.length, 7);
  await installServiceRoleGrants(aclDb);
  assert.equal(grantStore.length, 7);
});

test('dxosStudio actions enforce admin gate, idempotent installWorkflow, safe composePortals, and plugin graceful degradation', async () => {
  const { createDxosStudioActions } = require(path.join(PLUGIN_ROOT, 'src/server/studio-resource.js'));

  const workflows = [];
  const flowNodes = [];
  const portals = {};
  const desktopRoutes = [];
  const flowModels = [];
  let routeSeq = 100;
  let wfSeq = 1;
  let nodeSeq = 1;

  const db = {
    sequelize: { transaction: async (fn) => fn({}) },
    hasCollection: (n) => n !== 'latticeParaDocuments',
    getRepository(name) {
      if (name === 'roles') {
        return {
          find: async ({ filter }) => {
            const names = filter?.name?.$in || [];
            return names.map((n) => ({ name: n, allowConfigure: n === 'ldx_sysadmin', snippets: n === 'ldx_sysadmin' ? ['pm'] : [] }));
          },
        };
      }
      if (name === 'latticeEmployees') {
        return {
          find: async ({ filter }) => [
            { id: 2, userId: 20, organizationId: 'org-a', active: true, name: 'Mgr', code: 'E2', user: { id: 20, roles: [{ name: 'ldx_manager' }] } },
            { id: 3, userId: 30, organizationId: 'org-a', active: true, name: 'Wh', code: 'E3', user: { id: 30, roles: [{ name: 'ldx_warehouse' }] } },
            { id: 4, userId: 40, organizationId: 'org-a', active: true, name: 'Disp', code: 'E4', user: { id: 40, roles: [{ name: 'ldx_dispatcher' }] } },
            { id: 5, userId: 50, organizationId: 'org-a', active: true, name: 'Drv', code: 'E5', user: { id: 50, roles: [{ name: 'ldx_driver' }] } },
          ].filter((e) => !filter?.organizationId || e.organizationId === filter.organizationId),
        };
      }
      if (name === 'workflows') {
        return {
          find: async () => workflows,
          findOne: async ({ filter }) => workflows.find((w) => w.current !== false && w.options?.dxosTemplateKey === filter?.['options.dxosTemplateKey'] && w.options?.dxosOrganizationId === filter?.['options.dxosOrganizationId']) || null,
          create: async ({ values }) => {
            const wf = { id: wfSeq++, current: true, key: `wf_${wfSeq}`, ...values };
            workflows.push(wf);
            return wf;
          },
          count: async () => workflows.length,
        };
      }
      if (name === 'flow_nodes') {
        return {
          create: async ({ values }) => {
            const row = { id: nodeSeq++, ...values, update: async (patch) => Object.assign(row, patch) };
            flowNodes.push(row);
            return row;
          },
        };
      }
      if (name === 'applicationPlugins') {
        return {
          find: async () => [
            { packageName: '@latticedx/plugin-lattice-foundation', version: '0.25.1', enabled: true, options: { portals } },
            { packageName: '@latticedx/plugin-dxos-blocks', version: '0.1.0', enabled: false },
            { packageName: '@latticedx/plugin-dxos-studio', version: '0.1.0', enabled: true },
          ],
          findOne: async () => ({ packageName: '@latticedx/plugin-lattice-foundation', options: { portals } }),
        };
      }
      if (name === 'desktopRoutes') {
        return {
          find: async () => desktopRoutes,
        };
      }
      if (name === 'flowModels') {
        const gridState = {
          rows: { row1: [['seed_1']] },
          sizes: { row1: [24] },
          rowOrder: ['row1'],
        };
        return {
          _gridState: gridState,
          findModelByParentId: async (uid) => ({
            uid: `grid:${uid}`,
            props: structuredClone(gridState),
            stepParams: { gridSettings: { grid: structuredClone(gridState) } },
          }),
          findOne: async ({ filter }) => flowModels.find((m) => m.uid === filter?.uid) || null,
          upsertModel: async (m) => {
            const idx = flowModels.findIndex((x) => x.uid === m.uid);
            if (idx >= 0) flowModels[idx] = m;
            else flowModels.push(m);
            return m.uid;
          },
          updateSingleNode: async (node) => {
            if (node.props?.rows) gridState.rows = node.props.rows;
            if (node.props?.sizes) gridState.sizes = node.props.sizes;
            if (node.props?.rowOrder) gridState.rowOrder = node.props.rowOrder;
            return true;
          },
        };
      }
      if (name === 'uiLayouts') {
        return {
          find: async () => [{ uid: 'ldx-portal-procurement' }, { uid: 'ldx-portal-services' }],
          count: async () => 2,
        };
      }
      return null;
    },
  };

  const blueprintCalls = [];
  const applyBlueprint = async (doc) => {
    blueprintCalls.push(doc);
    assert.ok(Array.isArray(doc.tabs?.[0]?.blocks) && doc.tabs[0].blocks.length >= 1, 'applyBlueprint requires non-empty blocks array');
    const pageUid = `page_${++routeSeq}`;
    const tabUid = `tab_${++routeSeq}`;
    const grpId = ++routeSeq;
    const pgId = ++routeSeq;
    const grp = { id: grpId, type: 'group', title: doc.navigation.group.title, uiLayoutUid: doc.navigation.layoutUid };
    // Simulate BIGINT string vs number id/parentId mismatch across Postgres/Sequelize
    const pg = { id: String(pgId), parentId: grpId, type: 'flowPage', title: doc.navigation.item.title, schemaUid: pageUid, uiLayoutUid: doc.navigation.layoutUid };
    const tb = { id: ++routeSeq, parentId: Number(pgId), type: 'tabs', title: doc.tabs[0].title, schemaUid: tabUid, uiLayoutUid: doc.navigation.layoutUid };
    desktopRoutes.push(grp, pg, tb);
    return { target: { pageSchemaUid: pageUid } };
  };

  const actions = createDxosStudioActions(db, { applyBlueprint });

  // Non-admin receives 403
  await assert.rejects(
    () => actions.listTemplates({ method: 'GET', state: { currentRole: 'ldx_employee', currentUser: { id: 10 } } }, async () => {}),
    (err) => err.status === 403,
  );

  // Root installs logistics-5step
  const installCtx = {
    method: 'POST',
    state: { currentRole: 'root', currentUser: { id: 1 } },
    action: {
      params: {
        values: {
          templateKey: 'logistics-5step',
          organizationId: 'org-a',
          managerEmployeeId: 2,
          warehouseEmployeeId: 3,
          dispatcherEmployeeId: 4,
          driverEmployeeId: 5,
        },
      },
    },
  };
  await actions.installWorkflow(installCtx, async () => {});
  assert.equal(installCtx.body.alreadyExists, false);
  assert.equal(installCtx.body.workflowId, 1);
  assert.ok(installCtx.body.nodeCount >= 14);
  // Upstream downstreamId links populated for non-branch nodes
  assert.ok(flowNodes[0].downstreamId);

  // Repeat call is idempotent
  const repeatCtx = {
    method: 'POST',
    state: { currentRole: 'root', currentUser: { id: 1 } },
    action: { params: { values: { templateKey: 'logistics-5step', organizationId: 'org-a', managerEmployeeId: 2, warehouseEmployeeId: 3, dispatcherEmployeeId: 4, driverEmployeeId: 5 } } },
  };
  await actions.installWorkflow(repeatCtx, async () => {});
  assert.equal(repeatCtx.body.alreadyExists, true);
  assert.equal(repeatCtx.body.workflowId, 1);

  // composePortals handles plugin-dxos-blocks disabled gracefully without throwing
  const composeCtx = {
    method: 'POST',
    state: { currentRole: 'root', currentUser: { id: 1 } },
    action: { params: { values: {} } },
  };
  await actions.composePortals(composeCtx, async () => {});
  assert.equal(composeCtx.body.dxosBlocksAttached, false);
  assert.ok(composeCtx.body.createdPages > 0);

  // Re-running composePortals skips existing pages without duplicates
  const countBefore = desktopRoutes.length;
  await actions.composePortals(composeCtx, async () => {});
  assert.equal(desktopRoutes.length, countBefore);
  assert.equal(composeCtx.body.createdPages, 0);

  // readiness degrades gracefully when latticeParaDocuments / latticeAiProfiles are absent
  const readyCtx = { method: 'GET', state: { currentRole: 'root', currentUser: { id: 1 } }, action: { params: {} } };
  await actions.readiness(readyCtx, async () => {});
  assert.equal(readyCtx.body.paraDocumentCount, 0);
  assert.equal(readyCtx.body.aiProfileCount, 0);
  assert.equal(readyCtx.body.aiAuditCount, 0);
  assert.equal(readyCtx.body.plugins.length, 7);
  assert.ok(readyCtx.body.plugins.some((p) => p.packageName === '@latticedx/plugin-dxos-ai'));

  // listEmployees sorts organizations by headcount DESC and includes organizationCounts
  const multiOrgDb = {
    getRepository(name) {
      if (name !== 'latticeEmployees') return null;
      return {
        find: async () => [
          { id: 1, userId: 11, code: 'A1', name: 'One', organizationId: 'alpha-small', user: { roles: [] } },
          { id: 2, userId: 12, code: 'Z1', name: 'Two', organizationId: 'zeta-large', user: { roles: [] } },
          { id: 3, userId: 13, code: 'Z2', name: 'Three', organizationId: 'zeta-large', user: { roles: [] } },
          { id: 4, userId: 14, code: 'Z3', name: 'Four', organizationId: 'zeta-large', user: { roles: [] } },
        ],
      };
    },
  };
  const multiActions = createDxosStudioActions(multiOrgDb);
  const empCtx = { method: 'GET', state: { currentRole: 'root', currentUser: { id: 1 } }, action: { params: {} } };
  await multiActions.listEmployees(empCtx, async () => {});
  assert.deepEqual(empCtx.body.organizations, ['zeta-large', 'alpha-small']);
  assert.deepEqual(empCtx.body.organizationCounts, { 'zeta-large': 3, 'alpha-small': 1 });
});

test('composePortals attaches blocks, orders grid rows above seed row, and createDefaultApplyBlueprint rejects 4xx bodies', async () => {
  const { createDxosStudioActions, createDefaultApplyBlueprint } = require(path.join(PLUGIN_ROOT, 'src/server/studio-resource.js'));

  const flowModels = [];
  const desktopRoutes = [];
  const updatedGrids = [];
  let seq = 100;

  const db = {
    sequelize: { transaction: async (fn) => fn({}) },
    hasCollection: () => true,
    getRepository(name) {
      if (name === 'applicationPlugins') {
        return {
          find: async () => [
            { packageName: '@latticedx/plugin-lattice-foundation', enabled: true, options: { portals: {} } },
            { packageName: '@latticedx/plugin-dxos-blocks', enabled: true },
          ],
        };
      }
      if (name === 'desktopRoutes') return { find: async () => desktopRoutes };
      if (name === 'flowModels') {
        return {
          findModelByParentId: async (uid) => ({
            uid: `grid:${uid}`,
            props: { rows: { row1: [['seed_block']] }, sizes: { row1: [24] }, rowOrder: ['row1'] },
            stepParams: { gridSettings: { grid: { rows: { row1: [['seed_block']] }, sizes: { row1: [24] }, rowOrder: ['row1'] } } },
          }),
          findOne: async ({ filter }) => flowModels.find((m) => m.uid === filter?.uid) || null,
          upsertModel: async (m) => {
            flowModels.push(m);
            return m.uid;
          },
          updateSingleNode: async (node) => {
            updatedGrids.push(node);
            return true;
          },
        };
      }
      return null;
    },
  };

  const applyBlueprint = async (doc) => {
    assert.ok(Array.isArray(doc.tabs?.[0]?.blocks) && doc.tabs[0].blocks.length >= 1);
    const col = doc.tabs[0].blocks[0].collection;
    if (['latticeIncidentCases', 'latticeOrders', 'latticeServiceTickets', 'latticeParaDocuments'].includes(col)) {
      assert.ok(Array.isArray(doc.defaults?.collections?.[col]?.fieldGroups), `Expected fieldGroups for ${col}`);
    }
    const gid = ++seq;
    const pid = ++seq;
    const pageUid = `page_${pid}`;
    const tabUid = `tab_${pid}`;
    desktopRoutes.push(
      { id: gid, parentId: null, type: 'group', title: doc.navigation.group.title, uiLayoutUid: doc.navigation.layoutUid },
      { id: String(pid), parentId: gid, type: 'flowPage', title: doc.navigation.item.title, schemaUid: pageUid, uiLayoutUid: doc.navigation.layoutUid },
      { id: ++seq, parentId: Number(pid), type: 'tabs', title: doc.tabs[0].title, schemaUid: tabUid, uiLayoutUid: doc.navigation.layoutUid },
    );
    return { target: { pageSchemaUid: pageUid } };
  };

  const actions = createDxosStudioActions(db, { applyBlueprint });
  const ctx = { method: 'POST', state: { currentRole: 'root', currentUser: { id: 1 } }, action: { params: {} } };
  await actions.composePortals(ctx, async () => {});
  assert.equal(ctx.body.dxosBlocksAttached, true);
  assert.equal(ctx.body.createdPages, 6);
  assert.equal(ctx.body.mobilePagesCreated, 4);
  assert.equal(ctx.body.attachedBlocks, 15);
  assert.equal(updatedGrids.length, 4);
  for (const slug of ['procurement', 'logistics', 'services']) {
    const wbModel = flowModels.find((m) => m.uid === `dxos-ov-${slug}-workbench`);
    assert.ok(wbModel, `Expected flowModel dxos-ov-${slug}-workbench`);
    assert.equal(wbModel.use, 'DxosRecordWorkbenchBlockModel');
  }
  const firstGrid = updatedGrids[0];
  assert.equal(firstGrid.props.rowOrder[0], 'dxos_row_0');
  assert.equal(firstGrid.props.rowOrder.at(-1), 'row1');
  assert.deepEqual(firstGrid.stepParams.gridSettings.grid.rowOrder, firstGrid.props.rowOrder);

  // Host applyBlueprint error propagation test
  assert.equal(typeof createDefaultApplyBlueprint, 'function');
  const failingBp = createDefaultApplyBlueprint({
    app: {
      resourceManager: {
        getResource: (resName) => (resName === 'flowSurfaces' ? {
          actions: {
            applyBlueprint: async (subCtx) => {
              subCtx.status = 400;
              subCtx.body = { errors: [{ message: 'flowSurfaces applyBlueprint tabs[0].blocks must be a non-empty array' }] };
            },
          },
        } : null),
      },
    },
    state: { currentUser: { id: 1 }, currentRole: 'root', currentRoles: ['root'] },
  });
  await assert.rejects(() => failingBp({ version: '1' }), (err) => err.code === 'BLUEPRINT_ERROR' && err.status === 400);
});

test('service-scope rejects dotted filters, SQL charts, and clamps oversized pageSize', async () => {
  const { createServiceScopeMiddleware } = require(path.join(PLUGIN_ROOT, 'src/server/service-scope.js'));
  const employees = [{ id: 8, userId: 80, organizationId: 'org-a', departmentId: 2, active: true }];
  const db = {
    getRepository: (name) => (name === 'latticeEmployees' ? { find: async ({ filter }) => employees.filter((e) => Number(e.userId) === Number(filter?.userId)) } : null),
  };
  const mw = createServiceScopeMiddleware(db);

  await assert.rejects(
    () => mw({ state: { currentRole: 'ldx_employee', currentUser: { id: 80 } }, action: { resourceName: 'latticeServiceTickets', actionName: 'list', params: { filter: { $or: [{ 'requester.identitySubject': 'x' }] } } } }, async () => {}),
    (err) => err.status === 403 && err.code === 'NATIVE_RELATION_EXPANSION_UNSUPPORTED',
  );
  await assert.rejects(
    () => mw({ state: { currentRole: 'ldx_employee', currentUser: { id: 80 } }, action: { resourceName: 'charts', actionName: 'queryData', params: { values: { mode: 'sql', collection: 'latticeServiceTickets' } } } }, async () => {}),
    (err) => err.status === 403 && err.code === 'NATIVE_CHART_MODE_UNSUPPORTED',
  );
  const listCtx = { state: { currentRole: 'ldx_employee', currentUser: { id: 80 } }, action: { resourceName: 'latticeServiceTickets', actionName: 'list', params: { pageSize: 99999 } } };
  await mw(listCtx, async () => {});
  assert.equal(listCtx.action.params.pageSize, 200);
});

test('service-scope enforces optimistic version locking on latticeServiceTickets updates', async () => {
  const { createServiceScopeMiddleware } = require(path.join(PLUGIN_ROOT, 'src/server/service-scope.js'));
  const employees = [{ id: 8, userId: 80, organizationId: 'org-a', departmentId: 2, active: true }];
  const ticket = { id: 19, organizationId: 'org-a', requesterId: 8, version: 4 };
  const db = {
    getRepository: (name) => {
      if (name === 'latticeEmployees') return { find: async () => employees };
      if (name === 'latticeServiceTickets') return { findOne: async () => ticket };
      return null;
    },
  };
  const mw = createServiceScopeMiddleware(db);

  await assert.rejects(
    () => mw({
      state: { currentRole: 'ldx_employee', currentUser: { id: 80 } },
      action: { resourceName: 'latticeServiceTickets', actionName: 'update', params: { filterByTk: 19, values: { name: 'Stale', expectedVersion: 2 } } },
    }, async () => {}),
    (err) => err.status === 409 && err.code === 'VERSION_CONFLICT',
  );

  const okCtx = {
    state: { currentRole: 'ldx_employee', currentUser: { id: 80 } },
    action: { resourceName: 'latticeServiceTickets', actionName: 'update', params: { filterByTk: 19, values: { name: 'Updated', expectedVersion: 4 } } },
  };
  await mw(okCtx, async () => {});
  assert.equal(okCtx.action.params.values.version, 5);
  assert.equal(okCtx.action.params.values.expectedVersion, undefined);
});

test('service-schema declares voucher lifecycle fields & index, and service-scope enforces voucher immutability and protected fields', async () => {
  const { serviceTickets } = require(path.join(PLUGIN_ROOT, 'src/server/service-schema.js'));
  const { createServiceScopeMiddleware } = require(path.join(PLUGIN_ROOT, 'src/server/service-scope.js'));

  const fieldMap = new Map(serviceTickets.fields.map((f) => [f.name, f]));
  for (const name of ['submittedAt', 'submittedBy', 'cancelledAt', 'cancelledBy', 'cancelReason', 'amendedFromId', 'amendmentNo']) {
    assert.ok(fieldMap.has(name), `serviceTickets missing voucher field ${name}`);
  }
  assert.equal(fieldMap.get('submittedAt').type, 'date');
  assert.equal(fieldMap.get('cancelledAt').type, 'date');
  assert.equal(fieldMap.get('amendedFromId').type, 'bigInt');
  assert.equal(fieldMap.get('amendmentNo').type, 'integer');
  assert.equal(fieldMap.get('amendmentNo').defaultValue, 0);
  assert.equal(fieldMap.get('amendmentNo').allowNull, false);

  const amendedIdx = serviceTickets.indexes.find((idx) => idx.name === 'idx_lattice_tickets_org_amended');
  assert.ok(amendedIdx, 'serviceTickets missing idx_lattice_tickets_org_amended index');
  assert.deepEqual(amendedIdx.fields, ['organizationId', 'amendedFromId']);
  assert.ok(amendedIdx.name.length <= 63);

  const employees = [{ id: 8, userId: 80, organizationId: 'org-a', departmentId: 2, active: true }];
  let currentTicket = { id: 25, organizationId: 'org-a', requesterId: 8, status: 'draft', version: 2 };
  const db = {
    getRepository: (name) => {
      if (name === 'latticeEmployees') return { find: async () => employees };
      if (name === 'latticeServiceTickets') return { findOne: async () => currentTicket };
      return null;
    },
  };
  const mw = createServiceScopeMiddleware(db);

  // Draft update still succeeds (even without expectedVersion)
  const draftCtx = {
    state: { currentRole: 'ldx_employee', currentUser: { id: 80 } },
    action: { resourceName: 'latticeServiceTickets', actionName: 'update', params: { filterByTk: 25, values: { name: 'Edited draft' } } },
  };
  await mw(draftCtx, async () => {});
  assert.equal(draftCtx.action.params.values.name, 'Edited draft');
  assert.equal(draftCtx.action.params.values.version, 3);

  // Immutable voucher statuses block :update with 409 VOUCHER_IMMUTABLE even when expectedVersion is omitted
  for (const immutableStatus of ['submitted', 'approved', 'completed', 'cancelled']) {
    currentTicket = { id: 25, organizationId: 'org-a', requesterId: 8, status: immutableStatus, version: 2 };
    await assert.rejects(
      () => mw({
        state: { currentRole: 'ldx_employee', currentUser: { id: 80 } },
        action: { resourceName: 'latticeServiceTickets', actionName: 'update', params: { filterByTk: 25, values: { name: 'Tamper' } } },
      }, async () => {}),
      (err) => err.status === 409 && err.code === 'VOUCHER_IMMUTABLE',
      `Expected 409 VOUCHER_IMMUTABLE for status ${immutableStatus}`,
    );
  }

  // Protected voucher metadata fields cannot be spoofed via direct :create or :update
  currentTicket = { id: 25, organizationId: 'org-a', requesterId: 8, status: 'draft', version: 2 };
  for (const [field, val] of [
    ['submittedAt', '2026-11-23T00:00:00Z'],
    ['submittedBy', 'spoof-user'],
    ['cancelledAt', '2026-11-23T00:00:00Z'],
    ['cancelledBy', 'spoof-user'],
    ['cancelReason', 'spoof'],
    ['amendedFromId', 1],
    ['amendmentNo', 3],
  ]) {
    await assert.rejects(
      () => mw({
        state: { currentRole: 'ldx_employee', currentUser: { id: 80 } },
        action: { resourceName: 'latticeServiceTickets', actionName: 'create', params: { values: { code: 'X-1', name: 'Y', [field]: val } } },
      }, async () => {}),
      (err) => err.status === 403 && err.code === 'NATIVE_DOCUMENT_PROTECTED_FIELD',
      `Expected :create to reject protected voucher field ${field}`,
    );
    await assert.rejects(
      () => mw({
        state: { currentRole: 'ldx_employee', currentUser: { id: 80 } },
        action: { resourceName: 'latticeServiceTickets', actionName: 'update', params: { filterByTk: 25, values: { [field]: val } } },
      }, async () => {}),
      (err) => err.status === 403 && err.code === 'NATIVE_DOCUMENT_PROTECTED_FIELD',
      `Expected :update to reject protected voucher field ${field}`,
    );
  }
});

test('dxosStudio actions expose admin-gated outboxDlqList and outboxDlqReplay', async () => {
  const { createDxosStudioActions } = require(path.join(PLUGIN_ROOT, 'src/server/studio-resource.js'));
  const rows = [
    { id: 1, eventId: 'evt-dlq-1', entityId: 'urn:asset:1', organizationId: 'org-a', collectionName: 'latticeAssets', recordId: 11, state: 'failed', attempts: 5, errorCode: 'BROKER_HTTP_500', nextAttemptAt: null, lockedAt: null, updatedAt: '2026-11-22T00:00:00Z', update: async function (v) { Object.assign(this, v); } },
    { id: 2, eventId: 'evt-ok-2', entityId: 'urn:asset:2', organizationId: 'org-a', collectionName: 'latticeAssets', recordId: 12, state: 'delivered', attempts: 1, errorCode: null, update: async function (v) { Object.assign(this, v); } },
  ];
  const db = {
    getRepository(name) {
      if (name === 'roles') {
        return {
          find: async ({ filter } = {}) => {
            const names = filter?.name?.$in;
            return [{ name: 'ldx_admin', allowConfigure: true }].filter((r) => !names || names.includes(r.name));
          },
        };
      }
      if (name === 'latticeContextOutbox') {
        return {
          findAndCount: async ({ filter }) => {
            const matched = rows.filter((r) => (!filter?.state || r.state === filter.state) && (!filter?.organizationId || r.organizationId === filter.organizationId));
            return [matched, matched.length];
          },
          find: async ({ filter }) => rows.filter((r) => (!filter?.state || r.state === filter.state) && (!filter?.eventId?.$in || filter.eventId.$in.includes(r.eventId))),
        };
      }
      return null;
    },
    getModel(name) {
      if (name === 'latticeContextOutbox') {
        return {
          findAll: async ({ where }) => rows.filter((r) => r.state === where.state && (!where.eventId || where.eventId.includes(r.eventId))),
        };
      }
      return null;
    },
  };
  const actions = createDxosStudioActions(db);
  await assert.rejects(() => actions.outboxDlqList({ state: { currentUser: { id: 2 }, currentRoles: ['ldx_employee'] }, action: { params: {} } }, async () => {}), { status: 403 });

  const listCtx = { state: { currentUser: { id: 1 }, currentRoles: ['root'] }, action: { params: {} } };
  await actions.outboxDlqList(listCtx, async () => {});
  assert.equal(listCtx.body.items.length, 1);
  assert.equal(listCtx.body.items[0].eventId, 'evt-dlq-1');
  assert.equal(listCtx.body.summary.failed, 1);

  const replayCtx = { state: { currentUser: { id: 1 }, currentRoles: ['root'] }, action: { params: { values: { eventIds: ['evt-dlq-1'] } } } };
  await actions.outboxDlqReplay(replayCtx, async () => {});
  assert.equal(replayCtx.body.replayedCount, 1);
  assert.equal(rows[0].state, 'pending');
  assert.equal(rows[0].attempts, 0);
});

test('OVERVIEW_SPECS wires DxosRecordWorkbenchBlockModel into procurement, logistics, and services portals', () => {
  const { OVERVIEW_SPECS } = require(path.join(PLUGIN_ROOT, 'src/server/portal-composer.js'));
  const expected = {
    procurement: {
      title: 'Chứng từ, Chatter & Xuất báo cáo Mua sắm [W]',
      collection: 'latticeRequests',
      showExport: true,
      showVoucherActions: true,
      showChatter: true,
    },
    logistics: {
      title: 'Chứng từ, Chatter & Xuất báo cáo Logistics [W]',
      collection: 'latticeOrders',
      showExport: true,
      showVoucherActions: true,
      showChatter: true,
    },
    services: {
      title: 'Chứng từ, Chatter & Xuất báo cáo Dịch vụ [W]',
      collection: 'latticeServiceTickets',
      showExport: true,
      showVoucherActions: true,
      showChatter: true,
    },
  };
  for (const [slug, cfg] of Object.entries(expected)) {
    const spec = OVERVIEW_SPECS.find((s) => s.slug === slug);
    assert.ok(spec, `Expected OVERVIEW_SPECS entry for ${slug}`);
    const wb = spec.blocks.find((b) => b.uidSuffix === 'workbench');
    assert.ok(wb, `Expected workbench block in ${slug}`);
    assert.equal(wb.use, 'DxosRecordWorkbenchBlockModel');
    assert.deepEqual(wb.config, cfg);
  }
});

test('composeMobilePortal idempotently composes 4 mobile pages and grants non-admin ldx_* operational roles while preserving existing grants', async () => {
  const { MOBILE_PORTAL_PAGES, composeMobilePortal, composePortals } = require(path.join(PLUGIN_ROOT, 'src/server/portal-composer.js'));
  assert.equal(typeof composeMobilePortal, 'function');
  assert.deepEqual(
    MOBILE_PORTAL_PAGES.map((p) => p.title),
    ['Việc cần duyệt', 'Đơn Logistics', 'Sự cố Kho lạnh', 'Phiếu Dịch vụ'],
  );

  let seq = 500;
  const desktopRoutes = [
    { id: 900, parentId: null, type: 'group', title: 'Vận hành Di động', uiLayoutUid: 'mobile-layout-model' },
    { id: 901, parentId: 900, type: 'flowPage', title: 'Việc cần duyệt', schemaUid: 'existing_mobile_pg', uiLayoutUid: 'mobile-layout-model' },
  ];
  const desktopRoutesUiLayouts = [
    { desktopRouteId: 900, uiLayoutUid: 'mobile-layout-model' },
    { desktopRouteId: 901, uiLayoutUid: 'mobile-layout-model' },
  ];
  const rolesDesktopRoutes = [
    { desktopRouteId: 901, roleName: 'ldx_employee' },
    { desktopRouteId: 901, roleName: 'custom_mobile_role' },
  ];
  const blueprintCalls = [];

  const db = {
    hasCollection: () => true,
    getRepository(name) {
      if (name === 'desktopRoutes') return { find: async () => desktopRoutes };
      if (name === 'desktopRoutesUiLayouts') {
        return {
          find: async ({ filter } = {}) => desktopRoutesUiLayouts.filter((l) => !filter?.uiLayoutUid || l.uiLayoutUid === filter.uiLayoutUid),
        };
      }
      if (name === 'rolesDesktopRoutes') {
        return {
          find: async ({ filter } = {}) => rolesDesktopRoutes.filter((g) => {
            if (filter?.desktopRouteId?.$in && !filter.desktopRouteId.$in.includes(g.desktopRouteId)) return false;
            if (filter?.roleName?.$in && !filter.roleName.$in.includes(g.roleName)) return false;
            return true;
          }),
          create: async ({ values }) => {
            rolesDesktopRoutes.push({ ...values });
            return values;
          },
          destroy: async () => {
            throw new Error('Must preserve existing grants without destroy');
          },
        };
      }
      if (name === 'roles') {
        return {
          find: async () => [
            { name: 'root', allowConfigure: true, snippets: ['pm'] },
            { name: 'admin', allowConfigure: true, snippets: ['pm'] },
            { name: 'ldx_admin', allowConfigure: false, snippets: [] },
            { name: 'ldx_sysadmin', allowConfigure: true, snippets: ['pm'] },
            { name: 'ldx_connector', allowConfigure: false, snippets: [] },
            { name: 'ldx_employee', allowConfigure: false, snippets: [] },
            { name: 'ldx_manager', allowConfigure: false, snippets: [] },
            { name: 'ldx_warehouse', allowConfigure: false, snippets: [] },
            { name: 'ldx_dispatcher', allowConfigure: false, snippets: [] },
            { name: 'ldx_driver', allowConfigure: false, snippets: [] },
            { name: 'ldx_director', allowConfigure: false, snippets: [] },
          ],
        };
      }
      if (name === 'applicationPlugins') return { find: async () => [] };
      if (name === 'flowModels') return null;
      return null;
    },
  };

  const applyBlueprint = async (doc) => {
    blueprintCalls.push(doc);
    const gid = ++seq;
    const pid = ++seq;
    const tid = ++seq;
    desktopRoutes.push(
      { id: gid, parentId: null, type: 'group', title: doc.navigation.group.title, uiLayoutUid: doc.navigation.layoutUid },
      { id: pid, parentId: gid, type: 'flowPage', title: doc.navigation.item.title, schemaUid: `pg_${pid}`, uiLayoutUid: doc.navigation.layoutUid },
      { id: tid, parentId: pid, type: 'tabs', title: doc.tabs[0].title, schemaUid: `tb_${tid}`, uiLayoutUid: doc.navigation.layoutUid },
    );
    desktopRoutesUiLayouts.push(
      { desktopRouteId: gid, uiLayoutUid: doc.navigation.layoutUid },
      { desktopRouteId: pid, uiLayoutUid: doc.navigation.layoutUid },
      { desktopRouteId: tid, uiLayoutUid: doc.navigation.layoutUid },
    );
    return { target: { pageSchemaUid: `pg_${pid}` } };
  };

  // Pre-existing 'Việc cần duyệt' is skipped -> only 3 mobile pages created on first run
  const first = await composeMobilePortal(db, { applyBlueprint });
  assert.equal(first.mobilePagesCreated, 3);
  assert.equal(blueprintCalls.filter((d) => d.navigation.layoutUid === 'mobile-layout-model').length, 3);
  assert.ok(blueprintCalls.every((d) => d.navigation.layoutUid === 'mobile-layout-model'));

  // Preserved custom grant and non-duplicated existing ldx_employee grant on route 901
  assert.ok(rolesDesktopRoutes.some((g) => g.desktopRouteId === 901 && g.roleName === 'custom_mobile_role'));
  assert.equal(rolesDesktopRoutes.filter((g) => g.desktopRouteId === 901 && g.roleName === 'ldx_employee').length, 1);

  // Operational non-admin ldx_* roles granted, admin/connector roles excluded
  const grantedRoles = new Set(rolesDesktopRoutes.map((g) => g.roleName));
  for (const opRole of ['ldx_employee', 'ldx_manager', 'ldx_warehouse', 'ldx_dispatcher', 'ldx_driver', 'ldx_director']) {
    assert.ok(grantedRoles.has(opRole), `Expected mobile route grant for ${opRole}`);
  }
  for (const deniedRole of ['root', 'admin', 'ldx_admin', 'ldx_sysadmin', 'ldx_connector']) {
    assert.equal(grantedRoles.has(deniedRole), false, `Did not expect mobile route grant for ${deniedRole}`);
  }

  // Re-running composeMobilePortal and composePortals is strictly idempotent for mobile routes & grants
  const grantCountBefore = rolesDesktopRoutes.length;
  const routeCountBefore = desktopRoutes.length;
  const second = await composeMobilePortal(db, { applyBlueprint });
  assert.equal(second.mobilePagesCreated, 0);
  assert.equal(rolesDesktopRoutes.length, grantCountBefore);
  assert.equal(desktopRoutes.length, routeCountBefore);

  const portalRes = await composePortals(db, { applyBlueprint });
  assert.equal(portalRes.mobilePagesCreated, 0);
});

test('readiness resolves host NocoBase version dynamically from NOCOBASE_VERSION or db.app.version with 2.2.50 fallback', async () => {
  const { createDxosStudioActions } = require(path.join(PLUGIN_ROOT, 'src/server/studio-resource.js'));
  const baseDb = (appVersion) => ({
    ...(appVersion ? { app: { version: appVersion } } : {}),
    hasCollection: () => false,
    getRepository: () => ({ find: async () => [] }),
  });
  const origEnv = process.env.NOCOBASE_VERSION;
  try {
    delete process.env.NOCOBASE_VERSION;

    const fallbackCtx = { method: 'GET', state: { currentRole: 'root', currentUser: { id: 1 } }, action: { params: {} } };
    await createDxosStudioActions(baseDb()).readiness(fallbackCtx, async () => {});
    assert.equal(fallbackCtx.body.clause52Attribution, 'Powered by NocoBase (v2.2.50 preserved)');

    const appVerCtx = { method: 'GET', state: { currentRole: 'root', currentUser: { id: 1 } }, action: { params: {} } };
    await createDxosStudioActions(baseDb('2.2.61')).readiness(appVerCtx, async () => {});
    assert.equal(appVerCtx.body.clause52Attribution, 'Powered by NocoBase (v2.2.61 preserved)');

    process.env.NOCOBASE_VERSION = '2.2.88';
    const envCtx = { method: 'GET', state: { currentRole: 'root', currentUser: { id: 1 } }, action: { params: {} } };
    await createDxosStudioActions(baseDb('2.2.61')).readiness(envCtx, async () => {});
    assert.equal(envCtx.body.clause52Attribution, 'Powered by NocoBase (v2.2.88 preserved)');

    // ApplicationVersion object with async .get() and sync .get()
    delete process.env.NOCOBASE_VERSION;
    const asyncVerObjCtx = { method: 'GET', state: { currentRole: 'root', currentUser: { id: 1 } }, action: { params: {} } };
    await createDxosStudioActions(baseDb({ get: async () => 'v2.2.38' })).readiness(asyncVerObjCtx, async () => {});
    assert.equal(asyncVerObjCtx.body.clause52Attribution, 'Powered by NocoBase (v2.2.38 preserved)');

    const syncVerObjCtx = { method: 'GET', state: { currentRole: 'root', currentUser: { id: 1 } }, action: { params: {} } };
    await createDxosStudioActions(baseDb({ get: () => '2.2.39' })).readiness(syncVerObjCtx, async () => {});
    assert.equal(syncVerObjCtx.body.clause52Attribution, 'Powered by NocoBase (v2.2.39 preserved)');

    // Empty object never produces [object Object]
    const emptyObjCtx = { method: 'GET', state: { currentRole: 'root', currentUser: { id: 1 } }, action: { params: {} } };
    await createDxosStudioActions(baseDb({})).readiness(emptyObjCtx, async () => {});
    assert.equal(emptyObjCtx.body.clause52Attribution, 'Powered by NocoBase (v2.2.50 preserved)');

    // Whitespace-only NOCOBASE_VERSION falls back cleanly to db.app.version
    process.env.NOCOBASE_VERSION = '   ';
    const wsEnvCtx = { method: 'GET', state: { currentRole: 'root', currentUser: { id: 1 } }, action: { params: {} } };
    await createDxosStudioActions(baseDb({ get: async () => '2.2.38' })).readiness(wsEnvCtx, async () => {});
    assert.equal(wsEnvCtx.body.clause52Attribution, 'Powered by NocoBase (v2.2.38 preserved)');
  } finally {
    if (origEnv === undefined) delete process.env.NOCOBASE_VERSION;
    else process.env.NOCOBASE_VERSION = origEnv;
  }
});

test('portal-composer COLLECTION_FIELD_GROUPS covers every interface field in domain schemas', () => {
  const { COLLECTION_FIELD_GROUPS } = require(path.join(PLUGIN_ROOT, 'src/server/portal-composer.js'));
  const foundationSchemas = require(path.resolve(PLUGIN_ROOT, '../plugin-lattice-foundation/src/server/schema.js'));
  const paraSchemas = require(path.resolve(PLUGIN_ROOT, '../plugin-dxos-para/src/server/schema.js'));
  const serviceSchemas = require(path.join(PLUGIN_ROOT, 'src/server/service-schema.js'));
  const allSchemas = Object.values({ ...foundationSchemas, ...paraSchemas, ...serviceSchemas });

  for (const colName of ['latticeIncidentCases', 'latticeRequests', 'latticeOrders', 'latticeServiceTickets', 'latticeParaDocuments']) {
    const schema = allSchemas.find((s) => s?.name === colName);
    assert.ok(schema, `Missing schema for ${colName}`);
    const groups = COLLECTION_FIELD_GROUPS[colName];
    assert.ok(Array.isArray(groups) && groups.length > 0, `Missing COLLECTION_FIELD_GROUPS for ${colName}`);
    const covered = new Set(groups.flatMap((g) => g.fields));
    const missing = (schema.fields || [])
      .filter((f) => Boolean(f.interface))
      .map((f) => f.name)
      .filter((name) => !covered.has(name));
    assert.deepEqual(missing, [], `COLLECTION_FIELD_GROUPS[${colName}] missing interface fields: ${missing.join(', ')}`);
  }
});

test('service-scope rewrites self requester.userId and assignee.userId filters, rejects foreign/unsafe filters, and wraps PG RLS context', async () => {
  const Module = require('node:module');
  const { createServiceScopeMiddleware } = require(path.join(PLUGIN_ROOT, 'src/server/service-scope.js'));

  const employees = [{ id: 8, userId: 80, organizationId: 'org-a', departmentId: 2, active: true }];
  const ticket = { id: 19, organizationId: 'org-a', requesterId: 8, status: 'draft', version: 1 };
  const fakeTx = { id: 'tx-svc-rls' };
  const sqlCalls = [];
  const repoTxCalls = [];
  const db = {
    sequelize: {
      getDialect: () => 'postgres',
      transaction: async (cb) => cb(fakeTx),
      query: async (sql, opts) => {
        sqlCalls.push({ sql, opts });
        return [[]];
      },
    },
    getRepository(name) {
      if (name === 'latticeEmployees') {
        return { find: async ({ filter }) => employees.filter((e) => Number(e.userId) === Number(filter?.userId)) };
      }
      if (name === 'latticeServiceTickets') {
        return {
          findOne: async (opts) => {
            repoTxCalls.push({ repo: name, transaction: opts?.transaction || null });
            return ticket;
          },
        };
      }
      if (name === 'latticeDepartments') {
        return {
          findOne: async (opts) => {
            repoTxCalls.push({ repo: name, transaction: opts?.transaction || null });
            return { id: 2, organizationId: 'org-a', active: true };
          },
        };
      }
      return null;
    },
  };

  const mw = createServiceScopeMiddleware(db);
  const prevRls = process.env.DX_PG_RLS_SESSION;
  try {
    process.env.DX_PG_RLS_SESSION = 'false';

    // 1. NocoBase preset $or scope on latticeServiceTickets & charts:queryData
    const presetFilter = { $or: [{ 'requester.userId': { $eq: 80 } }, { 'assignee.userId': { $eq: 80 } }] };
    const snapshot = structuredClone(presetFilter);
    const listCtx = {
      state: { currentRole: 'ldx_employee', currentUser: { id: 80 } },
      action: { resourceName: 'latticeServiceTickets', actionName: 'list', params: { filter: presetFilter } },
    };
    await mw(listCtx, async () => {});
    assert.deepEqual(presetFilter, snapshot);
    assert.deepEqual(listCtx.action.params.filter, {
      $and: [
        { organizationId: 'org-a' },
        { $or: [{ requesterId: { $eq: 8 } }, { assigneeId: { $eq: 8 } }] },
      ],
    });
    assert.equal(listCtx.state.latticeRlsOrg, 'org-a');
    assert.equal(sqlCalls.length, 0);

    // Conflict-safe $and when requesterId/assigneeId also specified
    const conflictCtx = {
      state: { currentRole: 'ldx_employee', currentUser: { id: 80 } },
      action: {
        resourceName: 'latticeServiceTickets',
        actionName: 'list',
        params: { filter: { 'requester.userId': 80, requesterId: 99, 'assignee.userId': { $eq: '80' }, assigneeId: 77 } },
      },
    };
    await mw(conflictCtx, async () => {});
    assert.deepEqual(conflictCtx.action.params.filter, {
      $and: [
        { organizationId: 'org-a' },
        { requesterId: 99, assigneeId: 77, $and: [{ requesterId: { $eq: 8 } }, { assigneeId: { $eq: 8 } }] },
      ],
    });

    const chartSelfCtx = {
      state: { currentRole: 'ldx_employee', currentUser: { id: 80 } },
      action: {
        resourceName: 'charts',
        actionName: 'queryData',
        params: { values: { mode: 'builder', collection: 'latticeServiceTickets', filter: { 'assignee.userId': { $eq: 80 } } } },
      },
    };
    await mw(chartSelfCtx, async () => {});
    assert.deepEqual(chartSelfCtx.action.params.values.filter, {
      $and: [{ organizationId: 'org-a' }, { assigneeId: { $eq: 8 } }],
    });

    // Foreign & unsafe filters still rejected 403
    for (const badFilter of [
      { 'requester.userId': { $eq: 99 } },
      { 'assignee.userId': 99 },
      { 'assignee.userId': { $ne: 80 } },
      { 'requester.userId': { $gt: 1 } },
      { 'assignee.identitySubject': 'sub-x' },
      '{"__proto__":{"polluted":true}}',
      '{"constructor":{"prototype":{"polluted":true}}}',
    ]) {
      await assert.rejects(
        () => mw({
          state: { currentRole: 'ldx_employee', currentUser: { id: 80 } },
          action: { resourceName: 'latticeServiceTickets', actionName: 'list', params: { filter: badFilter } },
        }, async () => {}),
        (err) => err.status === 403 && err.code === 'NATIVE_RELATION_EXPANSION_UNSUPPORTED',
      );
    }

    // 2. DX_PG_RLS_SESSION=true wraps latticeServiceTickets & charts:queryData in withTenantRlsContext
    process.env.DX_PG_RLS_SESSION = 'true';
    sqlCalls.length = 0;
    repoTxCalls.length = 0;
    let seenTx = null;
    const rlsListCtx = {
      state: { currentRole: 'ldx_employee', currentUser: { id: 80 } },
      action: { resourceName: 'latticeServiceTickets', actionName: 'update', params: { filterByTk: 19, values: { name: 'RLS update', departmentId: 2 } } },
    };
    await mw(rlsListCtx, async () => { seenTx = rlsListCtx.state.latticeRlsTransaction; });
    assert.equal(seenTx, fakeTx);
    assert.equal(rlsListCtx.state.latticeRlsOrg, 'org-a');
    assert.equal(sqlCalls.length, 1);
    assert.equal(sqlCalls[0].sql, "SELECT set_config('app.current_org', :orgId, true)");
    assert.deepEqual(sqlCalls[0].opts.replacements, { orgId: 'org-a' });
    assert.ok(repoTxCalls.length >= 2 && repoTxCalls.every((c) => c.transaction === fakeTx));

    sqlCalls.length = 0;
    let chartSeenTx = null;
    const rlsChartCtx = {
      state: { currentRole: 'ldx_employee', currentUser: { id: 80 } },
      action: { resourceName: 'charts', actionName: 'queryData', params: { values: { mode: 'builder', collection: 'latticeServiceTickets', filter: {} } } },
    };
    await mw(rlsChartCtx, async () => { chartSeenTx = rlsChartCtx.state.latticeRlsTransaction; });
    assert.equal(chartSeenTx, fakeTx);
    assert.equal(sqlCalls.length, 1);

    // 3. Standalone fallback when pg-rls module is absent
    const serviceScopePath = require.resolve(path.join(PLUGIN_ROOT, 'src/server/service-scope.js'));
    const origLoad = Module._load;
    delete require.cache[serviceScopePath];
    Module._load = function mockedMissingRls(request, parent, isMain) {
      if (typeof request === 'string' && request.endsWith('pg-rls')) {
        throw Object.assign(new Error(`Cannot find module '${request}'`), { code: 'MODULE_NOT_FOUND' });
      }
      return origLoad.call(this, request, parent, isMain);
    };
    try {
      const standaloneMod = require(serviceScopePath);
      const standaloneMw = standaloneMod.createServiceScopeMiddleware(db);
      const fallbackCtx = {
        state: { currentRole: 'ldx_employee', currentUser: { id: 80 } },
        action: { resourceName: 'latticeServiceTickets', actionName: 'list', params: { filter: { 'assignee.userId': 80 } } },
      };
      let ran = false;
      await standaloneMw(fallbackCtx, async () => { ran = true; });
      assert.equal(ran, true);
      assert.deepEqual(fallbackCtx.action.params.filter, {
        $and: [{ organizationId: 'org-a' }, { assigneeId: { $eq: 8 } }],
      });
    } finally {
      Module._load = origLoad;
      delete require.cache[serviceScopePath];
    }
  } finally {
    if (prevRls === undefined) delete process.env.DX_PG_RLS_SESSION;
    else process.env.DX_PG_RLS_SESSION = prevRls;
  }
});

test('solutionBundleExport restricts organizationId=all to root and scopes non-root isStudioAdmin via latticeEmployees', async () => {
  const { createDxosStudioActions } = require(path.join(PLUGIN_ROOT, 'src/server/studio-resource.js'));

  const employees = [
    { id: 10, userId: 20, organizationId: 'org-a', departmentId: 1, active: true },
    { id: 11, userId: 21, organizationId: 'org-b', departmentId: 2, active: false },
  ];
  const workflows = [
    { id: 1, key: 'wf-a', title: 'WF Org A', current: true, enabled: true, options: { dxosOrganizationId: 'org-a' }, config: {} },
    { id: 2, key: 'wf-b', title: 'WF Org B', current: true, enabled: true, options: { dxosOrganizationId: 'org-b' }, config: {} },
  ];
  const aiProfiles = [
    { id: 1, username: 'ai-a', organizationId: 'org-a', enabled: true },
    { id: 2, username: 'ai-b', organizationId: 'org-b', enabled: true },
  ];

  const db = {
    hasCollection: () => true,
    getRepository(name) {
      if (name === 'roles') {
        return {
          find: async ({ filter }) => (filter?.name?.$in || []).map((n) => ({
            name: n,
            allowConfigure: n === 'ldx_sysadmin',
            snippets: n === 'ldx_sysadmin' ? ['pm'] : [],
          })),
        };
      }
      if (name === 'latticeEmployees') {
        return {
          find: async ({ filter }) => employees.filter((e) => Number(e.userId) === Number(filter?.userId)),
        };
      }
      if (name === 'workflows') {
        return { find: async () => workflows };
      }
      if (name === 'latticeAiProfiles') {
        return {
          find: async ({ filter } = {}) => aiProfiles.filter((p) => !filter?.organizationId || p.organizationId === filter.organizationId),
        };
      }
      return { find: async () => [] };
    },
  };

  const actions = createDxosStudioActions(db, {});

  // 1. Root can export all
  const rootAllCtx = {
    method: 'GET',
    state: { currentUser: { id: 1 }, currentRole: 'root', currentRoles: ['root'] },
    action: { params: { organizationId: 'all' } },
  };
  await actions.solutionBundleExport(rootAllCtx, async () => {});
  assert.equal(rootAllCtx.body.metadata.organizationId, 'all');
  assert.deepEqual(rootAllCtx.body.workflows.map((w) => w.key), ['wf-a', 'wf-b']);

  // 2. Non-root isStudioAdmin omitting organizationId exports ONLY their own org-a (never 'all')
  const sysDefaultCtx = {
    method: 'GET',
    state: { currentUser: { id: 20 }, currentRole: 'ldx_sysadmin', currentRoles: ['ldx_sysadmin'] },
    action: { params: {} },
  };
  await actions.solutionBundleExport(sysDefaultCtx, async () => {});
  assert.equal(sysDefaultCtx.body.metadata.organizationId, 'org-a');
  assert.deepEqual(sysDefaultCtx.body.workflows.map((w) => w.key), ['wf-a']);
  assert.deepEqual(sysDefaultCtx.body.aiProfiles.map((p) => p.username), ['ai-a']);

  // 3. Non-root isStudioAdmin requesting organizationId='all' or foreign org-b is rejected 403
  for (const badOrg of ['all', 'org-b']) {
    await assert.rejects(
      () => actions.solutionBundleExport({
        method: 'GET',
        state: { currentUser: { id: 20 }, currentRole: 'ldx_sysadmin', currentRoles: ['ldx_sysadmin'] },
        action: { params: { organizationId: badOrg } },
      }, async () => {}),
      (err) => err.status === 403 && err.code === 'NATIVE_ORGANIZATION_MISMATCH',
    );
  }

  // 4. Non-root isStudioAdmin without active employee membership is rejected 403
  for (const unmappedUserId of [21, 999]) {
    await assert.rejects(
      () => actions.solutionBundleExport({
        method: 'GET',
        state: { currentUser: { id: unmappedUserId }, currentRole: 'ldx_sysadmin', currentRoles: ['ldx_sysadmin'] },
        action: { params: {} },
      }, async () => {}),
      (err) => err.status === 403 && err.code === 'NATIVE_MEMBERSHIP_REQUIRED',
    );
  }
});

test('DxosStudioPlugin registers dxosServiceScope before latticeNativeScope and composed charts:queryData pipeline preserves preset $or scopes and PG RLS', async () => {
  const Module = require('node:module');
  const { buildServiceGrant } = require(path.join(PLUGIN_ROOT, 'src/server/service-roles.js'));

  const studioIndexPath = require.resolve(path.join(PLUGIN_ROOT, 'src/server/index.js'));
  const foundationIndexPath = require.resolve(path.resolve(PLUGIN_ROOT, '../plugin-lattice-foundation/src/server/index.js'));
  const origLoad = Module._load;
  class MockPlugin {
    constructor(app, options = {}) {
      this.app = app;
      this.db = app?.db;
      this.options = options;
    }
  }
  class MockMigration {
    constructor(context = {}) { this.context = context; }
  }
  delete require.cache[studioIndexPath];
  delete require.cache[foundationIndexPath];
  Module._load = function mockedNocobase(request, parent, isMain) {
    if (request === '@nocobase/server') return { Plugin: MockPlugin, Migration: MockMigration };
    if (request === '@nocobase/database') return { defineCollection: (def) => def };
    return origLoad.call(this, request, parent, isMain);
  };

  const prevRls = process.env.DX_PG_RLS_SESSION;
  try {
    const LatticeFoundationPlugin = require(foundationIndexPath);
    const DxosStudioPlugin = require(studioIndexPath);

    const employees = [{ id: 8, userId: 80, organizationId: 'org-a', departmentId: 2, active: true }];
    const fakeTx = { id: 'tx-composed-svc' };
    const sqlCalls = [];
    const db = {
      on() {},
      sequelize: {
        getDialect: () => 'postgres',
        transaction: async (cb) => cb(fakeTx),
        query: async (sql, opts) => {
          sqlCalls.push({ sql, opts });
          return [[]];
        },
      },
      getRepository(name) {
        if (name === 'latticeEmployees') {
          return { find: async ({ filter }) => employees.filter((e) => Number(e.userId) === Number(filter?.userId)) };
        }
        return null;
      },
    };
    const registered = [];
    const app = {
      db,
      use() {},
      resourceManager: {
        use(fn, opts) { registered.push({ fn, opts }); },
        define() {},
      },
      acl: { allow() {}, registerSnippet() {} },
      cronJobManager: { addJob() {} },
      logger: { info() {}, warn() {}, error() {} },
    };

    // Load plugin-lattice-foundation FIRST (matching install-workspace.mjs), then plugin-dxos-studio
    await new LatticeFoundationPlugin(app).load();
    await new DxosStudioPlugin(app).load();

    const svcEntry = registered.find((m) => m.opts?.tag === 'dxosServiceScope');
    const nativeEntry = registered.find((m) => m.opts?.tag === 'latticeNativeScope');
    assert.ok(svcEntry, 'DxosStudioPlugin must register dxosServiceScope');
    assert.ok(nativeEntry, 'LatticeFoundationPlugin must register latticeNativeScope');
    assert.deepEqual(svcEntry.opts, {
      tag: 'dxosServiceScope',
      after: 'acl',
      before: 'latticeNativeScope',
    });

    // Resolve topological middleware ordering (matching NocoBase Toposort / @hapi/topo)
    const resolveOrder = (entries) => {
      const remaining = [...entries];
      const ordered = [];
      const placed = new Set(['acl']);
      while (remaining.length) {
        const idx = remaining.findIndex((item) => {
          const afterTags = item.opts?.after ? (Array.isArray(item.opts.after) ? item.opts.after : [item.opts.after]) : [];
          const afterOk = afterTags.every((t) => placed.has(t) || !entries.some((e) => e.opts?.tag === t));
          const blockedByBefore = remaining.some((other) => {
            if (other === item) return false;
            const beforeTags = other.opts?.before ? (Array.isArray(other.opts.before) ? other.opts.before : [other.opts.before]) : [];
            return beforeTags.includes(item.opts?.tag);
          });
          return afterOk && !blockedByBefore;
        });
        assert.ok(idx >= 0, 'Cycle detected in middleware topological constraints');
        const [chosen] = remaining.splice(idx, 1);
        ordered.push(chosen);
        if (chosen.opts?.tag) placed.add(chosen.opts.tag);
      }
      return ordered;
    };

    const sortedTags = resolveOrder(registered).map((m) => m.opts?.tag);
    assert.ok(
      sortedTags.indexOf('dxosServiceScope') < sortedTags.indexOf('latticeNativeScope'),
      `Expected dxosServiceScope before latticeNativeScope, got ${sortedTags.join(' -> ')}`,
    );

    const compose = (middlewares, handler) => async (ctx) => {
      let idx = -1;
      const dispatch = async (i) => {
        if (i <= idx) throw new Error('next() called multiple times');
        idx = i;
        const fn = i < middlewares.length ? middlewares[i] : handler;
        if (!fn) return undefined;
        return fn(ctx, () => dispatch(i + 1));
      };
      return dispatch(0);
    };

    // Substitute CURRENT_USER in service-roles.js preset view scope (as NocoBase ACL does)
    const viewAction = buildServiceGrant('ldx_employee').actions.find((a) => a.name === 'view');
    const presetScope = JSON.parse(
      JSON.stringify(viewAction.scope.scope).replaceAll('{{ ctx.state.currentUser.id }}', '80'),
    );

    // Pre-fix order [nativeMw, serviceMw] fails 403 on charts:queryData for latticeServiceTickets
    process.env.DX_PG_RLS_SESSION = 'false';
    await assert.rejects(
      () => compose([nativeEntry.fn, svcEntry.fn], async () => {})({
        state: { currentRole: 'ldx_employee', currentUser: { id: 80 } },
        action: {
          resourceName: 'charts',
          actionName: 'queryData',
          params: { values: { mode: 'builder', collection: 'latticeServiceTickets', filter: structuredClone(presetScope) } },
        },
      }),
      (err) => err.status === 403 && err.code === 'NATIVE_RELATION_EXPANSION_UNSUPPORTED',
    );

    // Post-fix order [serviceMw, nativeMw] succeeds on charts:queryData with preset $or scope and PG RLS
    process.env.DX_PG_RLS_SESSION = 'true';
    sqlCalls.length = 0;
    let handlerRan = false;
    let seenTx = null;
    const okCtx = {
      state: { currentRole: 'ldx_employee', currentUser: { id: 80 } },
      action: {
        resourceName: 'charts',
        actionName: 'queryData',
        params: { values: { mode: 'builder', collection: 'latticeServiceTickets', filter: structuredClone(presetScope) } },
      },
    };
    await compose([svcEntry.fn, nativeEntry.fn], async (ctx) => {
      handlerRan = true;
      seenTx = ctx.state.latticeRlsTransaction;
    })(okCtx);
    assert.equal(handlerRan, true);
    assert.equal(seenTx, fakeTx);
    assert.equal(okCtx.state.latticeRlsOrg, 'org-a');
    assert.equal(sqlCalls.length, 1);
    assert.equal(sqlCalls[0].sql, "SELECT set_config('app.current_org', :orgId, true)");
    assert.deepEqual(okCtx.action.params.values.filter, {
      $and: [
        { organizationId: 'org-a' },
        { $or: [{ requesterId: { $eq: 8 } }, { assigneeId: { $eq: 8 } }] },
      ],
    });

    // Conflict-safe rewriting preserves direct fields and passes downstream latticeNativeScope
    const conflictCtx = {
      state: { currentRole: 'ldx_employee', currentUser: { id: 80 } },
      action: {
        resourceName: 'charts',
        actionName: 'queryData',
        params: {
          values: {
            mode: 'builder',
            collection: 'latticeServiceTickets',
            filter: { 'requester.userId': 80, requesterId: 99, 'assignee.userId': { $eq: '80' }, assigneeId: 77 },
          },
        },
      },
    };
    await compose([svcEntry.fn, nativeEntry.fn], async () => {})(conflictCtx);
    assert.deepEqual(conflictCtx.action.params.values.filter, {
      $and: [
        { organizationId: 'org-a' },
        { requesterId: 99, assigneeId: 77, $and: [{ requesterId: { $eq: 8 } }, { assigneeId: { $eq: 8 } }] },
      ],
    });

    // Foreign userId still fails closed 403 in the composed pipeline
    await assert.rejects(
      () => compose([svcEntry.fn, nativeEntry.fn], async () => {})({
        state: { currentRole: 'ldx_employee', currentUser: { id: 80 } },
        action: {
          resourceName: 'charts',
          actionName: 'queryData',
          params: {
            values: {
              mode: 'builder',
              collection: 'latticeServiceTickets',
              filter: { $or: [{ 'requester.userId': '99' }, { 'assignee.userId': '80' }] },
            },
          },
        },
      }),
      (err) => err.status === 403 && err.code === 'NATIVE_RELATION_EXPANSION_UNSUPPORTED',
    );
  } finally {
    if (prevRls === undefined) delete process.env.DX_PG_RLS_SESSION;
    else process.env.DX_PG_RLS_SESSION = prevRls;
    Module._load = origLoad;
    delete require.cache[studioIndexPath];
    delete require.cache[foundationIndexPath];
  }
});
