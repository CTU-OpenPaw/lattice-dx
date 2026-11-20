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
        return {
          findModelByParentId: async (uid) => ({ uid: `grid:${uid}` }),
          findOne: async ({ filter }) => flowModels.find((m) => m.uid === filter?.uid) || null,
          upsertModel: async (m) => {
            const idx = flowModels.findIndex((x) => x.uid === m.uid);
            if (idx >= 0) flowModels[idx] = m;
            else flowModels.push(m);
            return m.uid;
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

  const applyBlueprint = async (doc) => {
    const pageUid = `page_${++routeSeq}`;
    const tabUid = `tab_${++routeSeq}`;
    const grp = { id: ++routeSeq, type: 'group', title: doc.navigation.group.title, uiLayoutUid: doc.navigation.layoutUid };
    const pg = { id: ++routeSeq, parentId: grp.id, type: 'flowPage', title: doc.navigation.item.title, schemaUid: pageUid, uiLayoutUid: doc.navigation.layoutUid };
    const tb = { id: ++routeSeq, parentId: pg.id, type: 'tabs', title: doc.tabs[0].title, schemaUid: tabUid, uiLayoutUid: doc.navigation.layoutUid };
    desktopRoutes.push(grp, pg, tb);
    return { target: { pageSchemaUid: pageUid, tabSchemaUid: tabUid } };
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

  // readiness degrades gracefully when latticeParaDocuments is absent
  const readyCtx = { method: 'GET', state: { currentRole: 'root', currentUser: { id: 1 } }, action: { params: {} } };
  await actions.readiness(readyCtx, async () => {});
  assert.equal(readyCtx.body.paraDocumentCount, 0);
  assert.equal(readyCtx.body.plugins.length, 6);
});
