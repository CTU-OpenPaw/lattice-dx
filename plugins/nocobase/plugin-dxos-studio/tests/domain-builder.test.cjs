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
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');

const {
  attachAndVerifyPgRls,
  createDxosBuilderActions,
  buildSafePgIndexName,
  generateOrEnsureOrgPkiKey,
} = require('../src/server/domain-builder');

const origLoad = Module._load;
Module._load = function mockedNocobaseLoad(request, parent, isMain) {
  if (request === '@nocobase/server') return { Plugin: class {}, Migration: class {} };
  if (request === '@nocobase/database') return { defineCollection: (def) => def };
  return origLoad.call(this, request, parent, isMain);
};
let createOrganizationDirectGuardMiddleware;
try {
  ({ createOrganizationDirectGuardMiddleware } = require('../src/server'));
} finally {
  Module._load = origLoad;
}
const { handleDomainEvent } = require('../src/server/automation-engine');
const connectorVault = require(path.resolve(__dirname, '../../plugin-lattice-foundation/src/server/connector-vault'));
const {
  exportSolutionBundle,
  validateSolutionBundle,
  diffSolutionBundle,
  importSolutionBundle,
} = require('../src/server/solution-bundle');

function matchRow(row, filter) {
  if (!filter || typeof filter !== 'object') return true;
  for (const [k, v] of Object.entries(filter)) {
    const actual = row?.[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
      if ('$in' in v && (!Array.isArray(v.$in) || !v.$in.includes(actual))) return false;
      if ('$ne' in v && actual === v.$ne) return false;
    } else if (actual !== v) {
      return false;
    }
  }
  return true;
}

function makeBuilderDb(seed = {}) {
  const store = {};
  const seq = {};
  for (const [col, rows] of Object.entries(seed)) {
    store[col] = rows.map((r, i) => ({ id: i + 1, ...structuredClone(r) }));
    seq[col] = rows.length + 1;
  }

  function makeRepo(name) {
    if (!store[name]) {
      store[name] = [];
      seq[name] = 1;
    }
    return {
      async find({ filter = {}, sort = [], limit = 500, offset = 0 } = {}) {
        let rows = store[name].filter((r) => matchRow(r, filter));
        if (Array.isArray(sort) && sort.length > 0) {
          const key = String(sort[0]).replace(/^-/, '');
          const desc = String(sort[0]).startsWith('-');
          rows = rows.slice().sort((a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0) * (desc ? -1 : 1));
        }
        return rows.slice(offset, offset + limit).map((r) => ({ ...r }));
      },
      async findOne({ filter = {}, filterByTk } = {}) {
        const eff = filterByTk !== undefined ? { id: filterByTk, ...filter } : filter;
        const rows = await this.find({ filter: eff, limit: 1 });
        return rows[0] || null;
      },
      async count({ filter = {} } = {}) {
        return store[name].filter((r) => matchRow(r, filter)).length;
      },
      async create({ values }) {
        const id = values.id ?? seq[name]++;
        const row = { id, createdAt: new Date(), updatedAt: new Date(), ...structuredClone(values) };
        store[name].push(row);
        return { ...row };
      },
      async update({ filter = {}, filterByTk, values }) {
        const eff = filterByTk !== undefined ? { id: filterByTk, ...filter } : filter;
        let updated = 0;
        for (const row of store[name]) {
          if (matchRow(row, eff)) {
            Object.assign(row, structuredClone(values), { updatedAt: new Date() });
            updated += 1;
          }
        }
        return [updated];
      },
      async destroy({ filter = {}, filterByTk } = {}) {
        const eff = filterByTk !== undefined ? { id: filterByTk, ...filter } : filter;
        const before = store[name].length;
        store[name] = store[name].filter((r) => !matchRow(r, eff));
        return before - store[name].length;
      },
    };
  }

  const collections = new Map();
  const rlsAttached = [];
  const syncCalls = [];
  const queries = [];
  let rlsVerifyReturnsDisabled = false;

  return {
    store,
    collections,
    rlsAttached,
    syncCalls,
    queries,
    setRlsVerifyDisabled(flag) {
      rlsVerifyReturnsDisabled = flag;
    },
    getRepository(name) {
      return makeRepo(name);
    },
    collection(def) {
      collections.set(def.name, def);
      return {
        ...def,
        fields: new Map((def.fields || []).map((f) => [f.name, f])),
        async sync(opts) {
          syncCalls.push({ name: def.name, opts });
        },
      };
    },
    getCollection(name) {
      const def = collections.get(name);
      if (!def) return null;
      return {
        ...def,
        fields: new Map((def.fields || []).map((f) => [f.name, f])),
      };
    },
    async sync() {
      syncCalls.push({ name: '__db__' });
    },
    async attachLatticeRlsPolicy(tableName) {
      rlsAttached.push(tableName);
    },
    sequelize: {
      getDialect: () => 'postgres',
      async transaction(fn) {
        return fn({ id: 'tx-builder' });
      },
      async query(sql, opts) {
        queries.push({ sql: String(sql), opts });
        if (String(sql).includes('FROM pg_class')) {
          return [[{ rls_enabled: !rlsVerifyReturnsDisabled }], []];
        }
        return [[], []];
      },
    },
  };
}

function makeCtx({ userId = 1, role = 'ldx_admin', organizationId = 'org-a', params = {}, isRoot = false } = {}) {
  return {
    method: 'POST',
    state: {
      currentUser: { id: userId, username: `admin_${userId}`, organizationId, isRoot },
      currentRole: role,
      currentRoles: [role],
    },
    action: { params },
    body: null,
  };
}

test('createDomain validates collection & field specs, verifies PG RLS, creates index, grants RBAC, creates /p/<slug>, and listDomains inspects it', async () => {
  const db = makeBuilderDb({
    latticeEmployees: [{ userId: 20, organizationId: 'org-a', active: true }],
    rolesUsers: [
      { userId: 1, roleName: 'root' },
      { userId: 20, roleName: 'ldx_admin' },
    ],
  });
  const builder = createDxosBuilderActions(db);

  // Non-root ldx_admin is blocked 403 ROOT_ADMIN_REQUIRED on createDomain mutation
  await assert.rejects(
    () => builder.createDomain(makeCtx({
      userId: 20,
      role: 'ldx_admin',
      params: { collectionName: 'latticeCustomSensors', fields: [{ name: 'x', type: 'string' }] },
    }), async () => {}),
    (err) => err.status === 403 && err.code === 'ROOT_ADMIN_REQUIRED',
  );

  // Reject invalid names, system collections, and unsafe belongsTo foreignKey
  await assert.rejects(
    () => builder.createDomain(makeCtx({
      userId: 1,
      role: 'root',
      isRoot: true,
      params: { collectionName: 'users', fields: [{ name: 'x', type: 'string' }] },
    }), async () => {}),
    (err) => err.status === 400 && err.code === 'INVALID_COLLECTION_NAME',
  );
  await assert.rejects(
    () => builder.createDomain(makeCtx({
      userId: 1,
      role: 'root',
      isRoot: true,
      params: {
        collectionName: 'latticeCustomSensors',
        fields: [{ name: '__proto__', type: 'string' }],
      },
    }), async () => {}),
    (err) => err.status === 400 && err.code === 'INVALID_FIELD_NAME',
  );
  await assert.rejects(
    () => builder.createDomain(makeCtx({
      userId: 1,
      role: 'root',
      isRoot: true,
      params: {
        collectionName: 'latticeCustomSensors',
        fields: [{ name: 'owner', type: 'belongsTo', target: 'users' }],
      },
    }), async () => {}),
    (err) => err.status === 400 && err.code === 'INVALID_BELONGS_TO_TARGET',
  );
  await assert.rejects(
    () => builder.createDomain(makeCtx({
      userId: 1,
      role: 'root',
      isRoot: true,
      params: {
        collectionName: 'latticeCustomSensors',
        fields: [{ name: 'asset', type: 'belongsTo', target: 'latticeAssets', foreignKey: '__proto__' }],
      },
    }), async () => {}),
    (err) => err.status === 400 && err.code === 'INVALID_FOREIGN_KEY',
  );

  // Verify safe PG index length truncation
  const longIdx = buildSafePgIndexName('latticeCustomVeryLongSupplyChainInspectionEventName', 'org');
  assert.ok(longIdx.length <= 63);

  // Fail closed when PG RLS verification reports disabled
  db.setRlsVerifyDisabled(true);
  await assert.rejects(
    () => builder.createDomain(makeCtx({
      userId: 1,
      role: 'root',
      isRoot: true,
      params: {
        collectionName: 'latticeCustomInspections',
        fields: [{ name: 'code', type: 'string', required: true }],
      },
    }), async () => {}),
    (err) => err.status === 500 && err.code === 'PG_RLS_VERIFICATION_FAILED',
  );
  db.setRlsVerifyDisabled(false);

  // Create valid custom domain with belongsTo + enumValues + NocoBase 2.2.50 Multi-Portal page
  const createCtx = makeCtx({
    userId: 1,
    role: 'root',
    isRoot: true,
    params: {
      collectionName: 'latticeCustomInspections',
      title: 'Cold-Chain Inspections',
      fields: [
        { name: 'inspectionCode', type: 'string', title: 'Code', required: true, indexed: true },
        { name: 'severity', type: 'string', enumValues: ['low', 'high'], required: true },
        { name: 'tempC', type: 'float' },
        { name: 'passed', type: 'boolean' },
        { name: 'asset', type: 'belongsTo', target: 'latticeAssets' },
      ],
      roles: ['ldx_admin', 'ldx_manager', 'ldx_operator'],
      portalSlug: 'inspections',
      portalTitle: 'Quality Inspections',
    },
  });
  await builder.createDomain(createCtx, async () => {});
  const dom = createCtx.body.domain;

  assert.equal(dom.collectionName, 'latticeCustomInspections');
  assert.equal(dom.rls.attached, true);
  assert.equal(dom.rls.verified, true);
  assert.ok(db.rlsAttached.includes('latticeCustomInspections'));
  assert.ok(db.syncCalls.some((s) => s.name === 'latticeCustomInspections'));
  assert.equal(db.collections.get('latticeCustomInspections')?.loadedFromCollectionManager, true);
  assert.equal(db.collections.get('latticeCustomInspections')?.title, 'Cold-Chain Inspections');
  assert.notEqual(db.collections.get('latticeCustomInspections')?.uiManageable, true);
  assert.ok(db.store.fields.some((f) => f.collectionName === 'latticeCustomInspections' && f.name === 'organizationId'));
  assert.equal(db.store.dataSourcesRolesResources.length, 3);
  assert.ok(db.store.dataSourcesRolesResourcesActions.length > 0);
  for (const act of db.store.dataSourcesRolesResourcesActions) {
    assert.ok(act.rolesResourceId != null, 'dataSourcesRolesResourcesActions must reference rolesResourceId');
    assert.equal('roleName' in act, false, 'dataSourcesRolesResourcesActions must NOT carry roleName');
    assert.equal('dataSourceKey' in act, false, 'dataSourcesRolesResourcesActions must NOT carry dataSourceKey');
    assert.equal('resourceName' in act, false, 'dataSourcesRolesResourcesActions must NOT carry resourceName');
    assert.ok(Array.isArray(act.fields) && act.fields.includes('organizationId'));
  }
  assert.equal(dom.portalPage.path, '/p/inspections');
  assert.equal(db.store.rolesDesktopRoutes.length, 6);
  // NocoBase 2.2.50 Multi-Portal layout + junction + GridModel hierarchy
  const portalLayout = db.store.uiLayouts.find((l) => l.uid === 'ldx-portal-inspections' && l.routePath === '/p/inspections');
  assert.ok(portalLayout);
  assert.equal('name' in portalLayout, false, 'uiLayouts in 2.2.50 must not write non-existent name column');
  assert.equal('type' in portalLayout, false, 'uiLayouts in 2.2.50 must not write non-existent type column');
  const pageRouteRow = db.store.desktopRoutes.find((r) => r.type === 'flowPage' && r.schemaUid === dom.portalPage.schemaUid);
  assert.ok(pageRouteRow);
  assert.equal('uiLayoutUid' in pageRouteRow, false, 'desktopRoutes in 2.2.50 must link via desktopRoutesUiLayouts');
  assert.ok(db.store.desktopRoutes.some((r) => r.type === 'tabs' && r.parentId === dom.portalPage.routeId));
  assert.ok(db.store.desktopRoutesUiLayouts.some((link) => link.uiLayoutUid === 'ldx-portal-inspections' && link.desktopRouteId === dom.portalPage.routeId));
  assert.ok(db.store.flowModels.some((m) => m.use === 'PageModel' && m.uid === dom.portalPage.schemaUid));
  assert.ok(db.store.flowModels.some((m) => m.use === 'PageTabModel' && m.parentId === dom.portalPage.schemaUid));
  assert.ok(db.store.flowModels.some((m) => m.use === 'GridModel' && m.parentId === dom.portalPage.tabSchemaUid));
  assert.ok(db.store.flowModels.some((m) => m.use === 'TableBlockModel' && m.parentId === dom.portalPage.gridUid));

  // listDomains allows org-scoped ldx_admin to inspect schema, RLS status, and bound portal page
  const listCtx = makeCtx({ userId: 20, role: 'ldx_admin', params: {} });
  await builder.listDomains(listCtx, async () => {});
  assert.equal(listCtx.body.items.length, 1);
  assert.equal(listCtx.body.items[0].collectionName, 'latticeCustomInspections');
  assert.equal(listCtx.body.items[0].rlsProtected, true);
  assert.equal(listCtx.body.items[0].portalPages[0].path, '/p/inspections');
});

test('createDomain uses NocoBase 2.2.50 flowSurfaces:applyBlueprint idempotently and calls writeRolesToACL when host resource exists', async () => {
  const db = makeBuilderDb({
    roles: [
      { name: 'root' },
      { name: 'ldx_admin' },
      { name: 'ldx_manager' },
      { name: 'ldx_employee' },
    ],
    rolesUsers: [{ userId: 1, roleName: 'root' }],
  });
  const builder = createDxosBuilderActions(db);
  const blueprintCalls = [];
  let aclWrites = 0;

  const hostApp = {
    acl: {
      async writeRolesToACL() {
        aclWrites += 1;
      },
    },
    resourceManager: {
      getResource(name) {
        if (name !== 'flowSurfaces') return null;
        return {
          actions: {
            async applyBlueprint(subCtx) {
              const doc = subCtx.action.params.values;
              blueprintCalls.push(doc);
              const route = await db.getRepository('desktopRoutes').create({
                values: {
                  type: 'flowPage',
                  title: doc.page.title,
                  schemaUid: 'bp-page-uid-1',
                  enableTabs: false,
                  hideInMenu: false,
                  displayTitle: true,
                },
              });
              const tab = await db.getRepository('desktopRoutes').create({
                values: {
                  parentId: route.id,
                  type: 'tabs',
                  title: doc.page.title,
                  schemaUid: 'bp-tab-uid-1',
                  hideInMenu: true,
                },
              });
              await db.getRepository('desktopRoutesUiLayouts').create({
                values: { uiLayoutUid: doc.navigation.layoutUid, desktopRouteId: route.id },
              });
              await db.getRepository('desktopRoutesUiLayouts').create({
                values: { uiLayoutUid: doc.navigation.layoutUid, desktopRouteId: tab.id },
              });
              subCtx.body = {
                data: { target: { routeId: route.id, tabSchemaUid: 'bp-tab-uid-1' } },
              };
            },
          },
        };
      },
    },
  };

  const makeLiveCtx = (params) => ({
    ...makeCtx({ userId: 1, role: 'root', isRoot: true, params }),
    app: hostApp,
    db,
    request: { headers: {} },
    i18n: null,
  });

  const c1 = makeLiveCtx({
    collectionName: 'latticeCustomMeters',
    title: 'Cold Meters',
    fields: [{ name: 'meterCode', type: 'string', title: 'Meter', required: true }],
    roles: ['ldx_admin', 'ldx_manager', 'ldx_operator', 'ldx_employee'],
    portalSlug: 'meters',
    portalTitle: 'Cold Meters Portal',
  });
  await builder.createDomain(c1, async () => {});

  // Non-existent role (ldx_operator) skipped cleanly against live roles table
  assert.deepEqual(c1.body.domain.grantedRoles, ['ldx_admin', 'ldx_manager', 'ldx_employee']);
  assert.equal(blueprintCalls.length, 1);
  assert.equal(aclWrites, 1);
  assert.equal(c1.body.domain.portalPage.schemaUid, 'bp-page-uid-1');
  assert.equal(c1.body.domain.portalPage.tabSchemaUid, 'bp-tab-uid-1');

  const routeRow = db.store.desktopRoutes.find((r) => r.id === c1.body.domain.portalPage.routeId);
  assert.deepEqual(routeRow.options, { path: '/p/meters', collectionName: 'latticeCustomMeters' });
  // Both page route and child tabs route granted to all 3 valid roles
  assert.equal(db.store.rolesDesktopRoutes.length, 6);

  // Repeat call reuses existing FlowPage idempotently without re-invoking applyBlueprint
  const c2 = makeLiveCtx({
    collectionName: 'latticeCustomMeters',
    title: 'Cold Meters',
    fields: [{ name: 'meterCode', type: 'string', title: 'Meter', required: true }],
    roles: ['ldx_admin', 'ldx_manager', 'ldx_employee'],
    portalSlug: 'meters',
    portalTitle: 'Cold Meters Portal',
  });
  await builder.createDomain(c2, async () => {});
  assert.equal(blueprintCalls.length, 1);
});

test('installBusinessPack cmms-maintenance is idempotent and wires end-to-end 5-step branching alarm -> DMN -> CMMS + Twin + Triage + n8n', async () => {
  const prevMaster = process.env.DX_VAULT_MASTER_KEY;
  process.env.DX_VAULT_MASTER_KEY = 'unit-test-vault-master-key-32bytes!!';

  try {
    const db = makeBuilderDb({
      latticeEmployees: [
        { userId: 20, organizationId: 'org-a', active: true },
        { userId: 21, organizationId: 'org-a', active: true },
      ],
      rolesUsers: [
        { userId: 1, roleName: 'root' },
        { userId: 20, roleName: 'ldx_admin' },
        { userId: 21, roleName: 'ldx_manager' },
      ],
      latticeAssets: [
        { id: 88, organizationId: 'org-a', code: 'FREEZER-VN-02', name: 'Freezer VN 02', status: 'active' },
      ],
      latticeTwinShadows: [
        {
          id: 1,
          organizationId: 'org-a',
          assetId: 88,
          assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:88',
          desiredJson: { targetTempC: 8.0 },
          reportedJson: { targetTempC: 8.0 },
          version: 1,
        },
      ],
      latticeConnectors: [
        {
          organizationId: 'org-a',
          connectorKey: 'n8n-coldchain-orchestrator',
          name: 'n8n Cold-Chain Orchestrator',
          connectorType: 'n8n',
          baseUrl: 'https://n8n.example.com/webhook/coldchain',
          authType: 'hmac',
          encryptedSecretsJson: connectorVault.encryptVaultSecrets({ secret: 'n8n-hmac-secret-unit' }, process.env),
          active: true,
        },
      ],
    });
    const builder = createDxosBuilderActions(db);

    // Before install (org-scoped ldx_admin can read catalog)
    const beforeCtx = makeCtx({ userId: 20, role: 'ldx_admin', params: {} });
    await builder.listBusinessPacks(beforeCtx, async () => {});
    assert.equal(beforeCtx.body.items[0].packKey, 'cmms-maintenance');
    assert.equal(beforeCtx.body.items[0].installed, false);

    // Non-root ldx_admin cannot mutate platform packs/schemas
    await assert.rejects(
      () => builder.installBusinessPack(makeCtx({ userId: 20, role: 'ldx_admin', params: { packKey: 'cmms-maintenance' } }), async () => {}),
      (err) => err.status === 403 && err.code === 'ROOT_ADMIN_REQUIRED',
    );

    // First install + repeat install by verified root (idempotency)
    const install1 = makeCtx({ userId: 1, role: 'root', isRoot: true, params: { packKey: 'cmms-maintenance', organizationId: 'org-a' } });
    await builder.installBusinessPack(install1, async () => {});
    assert.equal(install1.body.installed, true);
    assert.equal(install1.body.domain.collectionName, 'latticeCustomWorkOrders');
    assert.equal(install1.body.dmnTable.tableKey, 'cmms_priority_routing_v1');
    assert.equal(install1.body.automationRule.ruleKey, 'auto_cmms_on_coldchain_fault');
    assert.equal(install1.body.automationRule.triggerEventType, 'alarm.triggered,device.offline');
    assert.equal(install1.body.automationRule.cooldownSec, 60);
    assert.equal(install1.body.automationRule.actionsJson.length, 5);
    assert.deepEqual(install1.body.automationRule.actionsJson[2].when, { 'dmn.workOrderPriority': 'critical' });

    const install2 = makeCtx({ userId: 1, role: 'root', isRoot: true, params: { packKey: 'cmms-maintenance', organizationId: 'org-a' } });
    await builder.installBusinessPack(install2, async () => {});
    assert.equal(db.store.latticeDecisionTables.length, 1);
    assert.equal(db.store.latticeAutomationRules.length, 1);
    assert.equal(db.store.desktopRoutes.filter((r) => r.type === 'flowPage').length, 1);
    assert.ok(db.store.uiLayouts.some((l) => l.uid === 'ldx-portal-cmms' && l.routePath === '/p/cmms'));
    assert.ok(db.store.desktopRoutesUiLayouts.some((link) => link.uiLayoutUid === 'ldx-portal-cmms'));
    assert.ok(db.store.flowModels.some((m) => m.use === 'GridModel'));
    assert.ok(db.store.flowModels.some((m) => m.use === 'TableBlockModel'));

    const afterCtx = makeCtx({ userId: 20, role: 'ldx_admin', params: {} });
    await builder.listBusinessPacks(afterCtx, async () => {});
    assert.equal(afterCtx.body.items[0].installed, true);

    const n8nCalls = [];
    const runOpts = {
      fetchImpl: async (url, init) => {
        n8nCalls.push({ url, body: JSON.parse(init.body) });
        return { ok: true, status: 200, async text() { return '{"ok":true}'; } };
      },
      env: { ...process.env, NODE_ENV: 'production' },
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
    };

    // Critical alarm.triggered executes all 5 steps (CMMS WO, notify, Twin HITL, AI Triage, n8n)
    const runs = await handleDomainEvent(db, {
      id: 'evt-alarm-901',
      type: 'alarm.triggered',
      organizationId: 'org-a',
      data: { severity: 'critical', deviceKey: 'freezer-vn-02', assetId: 88, message: 'Compressor overload' },
    }, runOpts);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, 'completed');
    assert.equal(runs[0].dmnResultJson.outputs.workOrderPriority, 'critical');
    assert.equal(runs[0].stepTracesJson.length, 5);
    assert.ok(runs[0].stepTracesJson.every((s) => s.status === 'completed'));
    assert.equal(db.store.latticeCustomWorkOrders.length, 1);
    const woId = db.store.latticeCustomWorkOrders[0].id;
    assert.equal(db.store.latticeCustomWorkOrders[0].priority, 'critical');
    assert.equal(db.store.latticeCustomWorkOrders[0].assignedRole, 'ldx_manager');
    assert.equal(db.store.latticeCustomWorkOrders[0].organizationId, 'org-a');
    assert.equal(db.store.latticeAgentProposals[0].targetRecordId, woId);
    assert.equal(n8nCalls.length, 1);
    assert.equal(n8nCalls[0].body.workOrderId, woId);

    // Medium severity skips steps 2-4 while completing CMMS WO + role notify
    const medRuns = await handleDomainEvent(db, {
      id: 'evt-alarm-902',
      type: 'alarm.triggered',
      organizationId: 'org-a',
      data: { severity: 'medium', deviceKey: 'freezer-vn-02', assetId: 88, message: 'Mild temp drift' },
    }, { ...runOpts, ignoreCooldown: true });
    assert.equal(medRuns.length, 1);
    assert.equal(medRuns[0].status, 'completed');
    assert.equal(medRuns[0].stepTracesJson[0].status, 'completed');
    assert.equal(medRuns[0].stepTracesJson[1].status, 'completed');
    for (const idx of [2, 3, 4]) {
      assert.equal(medRuns[0].stepTracesJson[idx].status, 'skipped');
      assert.equal(medRuns[0].stepTracesJson[idx].skipReason, 'BRANCH_CONDITION_NOT_MATCHED');
    }
    assert.equal(n8nCalls.length, 1);
  } finally {
    if (prevMaster === undefined) delete process.env.DX_VAULT_MASTER_KEY;
    else process.env.DX_VAULT_MASTER_KEY = prevMaster;
  }
});

test('provisionTenant and listTenants provision isolated org, departments, locations, Ed25519 PKI key, VN SLAs, and ldx_admin user idempotently', async () => {
  const db = makeBuilderDb({
    rolesUsers: [{ userId: 1, roleName: 'root' }],
    users: [{ id: 1, username: 'superroot' }],
  });
  const builder = createDxosBuilderActions(db);

  const prov1 = makeCtx({
    userId: 1,
    role: 'root',
    isRoot: true,
    params: {
      organizationId: 'pharma-vn-01',
      name: 'Saigon Cold-Chain Pharma',
      region: 'VN',
      adminUsername: 'saigon_admin',
      adminEmail: 'admin@saigonpharma.vn',
      adminPassword: 'StrongTempPassword123!',
    },
  });
  await builder.provisionTenant(prov1, async () => {});
  assert.equal(prov1.body.provisioned, true);
  assert.equal(prov1.body.departmentsCount, 2);
  assert.equal(prov1.body.locationsCount, 1);
  assert.equal(prov1.body.pkiKey.algorithm, 'Ed25519');
  assert.equal(prov1.body.pkiKey.status, 'active');
  assert.equal(prov1.body.slaCount, 4);
  assert.equal(prov1.body.adminAccount.username, 'saigon_admin');
  assert.equal(prov1.body.adminAccount.role, 'ldx_admin');
  assert.equal(prov1.body.adminAccount.tempPassword, undefined);

  // Raw password is passed to NocoBase PasswordField (no double-hash scrypt$) and user carries roles without synthetic organizationId
  const createdUser = db.store.users.find((u) => u.username === 'saigon_admin');
  assert.equal(createdUser.password, 'StrongTempPassword123!');
  assert.equal(createdUser.organizationId, undefined);
  assert.deepEqual(createdUser.roles, ['ldx_admin']);
  assert.ok(db.store.rolesUsers.some((ru) => Number(ru.userId) === createdUser.id && ru.roleName === 'ldx_admin'));

  // Auto-generated password reveals one-time tempPassword when adminPassword omitted
  const prov2 = makeCtx({
    userId: 1,
    role: 'root',
    isRoot: true,
    params: { organizationId: 'pharma-vn-02', name: 'Hanoi Med', adminUsername: 'hanoi_admin' },
  });
  await builder.provisionTenant(prov2, async () => {});
  assert.equal(typeof prov2.body.adminAccount.tempPassword, 'string');
  assert.ok(prov2.body.adminAccount.tempPassword.length >= 12);

  // Cross-org existing user conflict blocked
  await assert.rejects(
    () => builder.provisionTenant(makeCtx({
      userId: 1,
      role: 'root',
      isRoot: true,
      params: { organizationId: 'pharma-vn-02', name: 'Hanoi Med', adminUsername: 'saigon_admin' },
    }), async () => {}),
    (err) => err.status === 403 && err.code === 'USER_ORG_CONFLICT',
  );

  // Idempotent re-run on pharma-vn-01 does not duplicate records or reset password
  const originalPassword = createdUser.password;
  await builder.provisionTenant(makeCtx({
    userId: 1,
    role: 'root',
    isRoot: true,
    params: {
      organizationId: 'pharma-vn-01',
      name: 'Saigon Cold-Chain Pharma',
      adminUsername: 'saigon_admin',
      adminPassword: 'DifferentPasswordAttempt!',
    },
  }), async () => {});
  assert.equal(db.store.latticeOrganizations.filter((o) => o.organizationId === 'pharma-vn-01').length, 1);
  assert.equal(db.store.latticePkiKeys.filter((k) => k.organizationId === 'pharma-vn-01').length, 1);
  assert.equal(db.store.users.find((u) => u.username === 'saigon_admin').password, originalPassword);

  // Root lists all tenants; non-root org admin only sees own tenant
  const rootList = makeCtx({ userId: 1, role: 'root', isRoot: true, params: {} });
  await builder.listTenants(rootList, async () => {});
  assert.equal(rootList.body.items.length, 2);

  const admin1 = db.store.users.find((u) => u.username === 'saigon_admin');
  const orgAdminList = makeCtx({
    userId: admin1.id,
    role: 'ldx_admin',
    organizationId: 'pharma-vn-01',
    params: {},
  });
  await builder.listTenants(orgAdminList, async () => {});
  assert.equal(orgAdminList.body.items.length, 1);
  assert.equal(orgAdminList.body.items[0].organizationId, 'pharma-vn-01');
});

test('Builder RBAC/PAT scope enforcement, latticeOrganizations direct CRUD guard, user hijack block, fallback RLS GUC, and prod PKI fail-closed', async () => {
  const db = makeBuilderDb({
    latticeOrganizations: [
      { id: 1, organizationId: 'org-a', name: 'Org A' },
      { id: 2, organizationId: 'org-b', name: 'Org B' },
    ],
    latticeEmployees: [
      { userId: 20, organizationId: 'org-a', active: true },
      { userId: 21, organizationId: 'org-a', active: true },
      { userId: 22, organizationId: 'org-b', active: true },
    ],
    rolesUsers: [
      { userId: 1, roleName: 'root' },
      { userId: 20, roleName: 'ldx_admin' },
      { userId: 21, roleName: 'ldx_manager' },
      { userId: 22, roleName: 'ldx_admin' },
    ],
    users: [
      { id: 1, username: 'superroot' },
      { id: 30, username: 'orphan_user', email: 'orphan@example.com' },
      { id: 31, username: 'multi_org_user', email: 'multi@example.com' },
    ],
  });
  db.store.latticeEmployees.push(
    { id: 90, userId: 31, organizationId: 'org-a', active: true },
    { id: 91, userId: 31, organizationId: 'org-b', active: true },
  );

  const builder = createDxosBuilderActions(db);
  const orgGuard = createOrganizationDirectGuardMiddleware(db);

  // 1. Forged isRoot=true without rolesUsers root binding, plus ldx_manager/ldx_admin, are blocked on mutations
  for (const ctx of [
    makeCtx({ userId: 20, role: 'root', isRoot: true, params: { organizationId: 'org-new', name: 'New' } }),
    makeCtx({ userId: 21, role: 'ldx_manager', isRoot: false, params: { organizationId: 'org-new', name: 'New' } }),
  ]) {
    await assert.rejects(
      () => builder.provisionTenant(ctx, async () => {}),
      (err) => err.status === 403 && err.code === 'ROOT_ADMIN_REQUIRED',
    );
  }

  // Non-admin ldx_manager is blocked on builder reads
  await assert.rejects(
    () => builder.listDomains(makeCtx({ userId: 21, role: 'ldx_manager' }), async () => {}),
    (err) => err.status === 403 && err.code === 'FORBIDDEN',
  );
  await assert.rejects(
    () => builder.listTenants(makeCtx({ userId: 21, role: 'ldx_manager' }), async () => {}),
    (err) => err.status === 403 && err.code === 'FORBIDDEN',
  );

  // 2. Real ctx.state.latticeApiKey PAT scopes enforced on builder mutations and reads
  const readOnlyRootPat = {
    ...makeCtx({ userId: 1, role: 'root', isRoot: true, params: { packKey: 'cmms-maintenance', organizationId: 'org-a' } }),
    state: {
      currentUser: { id: 1, username: 'root', isRoot: true },
      currentRole: 'root',
      currentRoles: ['root'],
      latticeApiKey: { id: 90, scopes: ['read'] },
    },
  };
  await assert.rejects(
    () => builder.installBusinessPack(readOnlyRootPat, async () => {}),
    (err) => err.status === 403 && err.code === 'API_KEY_SCOPE_INSUFFICIENT',
  );
  await builder.listDomains(readOnlyRootPat, async () => {});

  const dmnOnlyPat = {
    ...readOnlyRootPat,
    state: { ...readOnlyRootPat.state, latticeApiKey: { id: 91, scopes: ['dmn'] } },
  };
  await assert.rejects(
    () => builder.listTenants(dmnOnlyPat, async () => {}),
    (err) => err.status === 403 && err.code === 'API_KEY_SCOPE_INSUFFICIENT',
  );

  // 3. Direct REST & association & chart guard on latticeOrganizations blocks non-root (incl. forged isRoot), preserves dxosBuilder:listTenants
  for (const blockedReq of [
    { state: { currentUser: { id: 20 }, currentRole: 'ldx_admin' }, action: { resourceName: 'latticeOrganizations', actionName: 'list', params: {} } },
    { state: { currentUser: { id: 20 }, currentRole: 'ldx_admin' }, action: { resourceName: 'latticeOrganizations', actionName: 'create', params: {} } },
    { state: { currentUser: { id: 20, isRoot: true }, currentRole: 'root' }, action: { resourceName: 'latticeOrganizations.employees', actionName: 'list', params: {} } },
    { state: { currentUser: { id: 20 }, currentRole: 'ldx_admin' }, action: { resourceName: 'charts', actionName: 'queryData', params: { collection: 'latticeOrganizations' } } },
  ]) {
    await assert.rejects(
      () => orgGuard(blockedReq, async () => {}),
      (err) => err.status === 403 && err.code === 'ORGANIZATION_DIRECT_CRUD_FORBIDDEN',
    );
  }
  let rootOrgGuardPassed = false;
  await orgGuard({
    state: { currentUser: { id: 1, isRoot: true }, currentRole: 'root', currentRoles: ['root'] },
    action: { resourceName: 'latticeOrganizations', actionName: 'list', params: {} },
  }, async () => { rootOrgGuardPassed = true; });
  assert.equal(rootOrgGuardPassed, true);

  const scopedTenantCtx = makeCtx({ userId: 20, role: 'ldx_admin', organizationId: 'org-a', params: {} });
  await builder.listTenants(scopedTenantCtx, async () => {});
  assert.deepEqual(scopedTenantCtx.body.items.map((o) => o.organizationId), ['org-a']);

  // 4. provisionTenant refuses existing root user, orphan user without membership, and multi-org user
  for (const conflictUsername of ['superroot', 'orphan_user', 'multi_org_user']) {
    await assert.rejects(
      () => builder.provisionTenant(makeCtx({
        userId: 1,
        role: 'root',
        isRoot: true,
        params: { organizationId: 'org-a', name: 'Org A', adminUsername: conflictUsername },
      }), async () => {}),
      (err) => err.status === 403 && err.code === 'USER_ORG_CONFLICT',
    );
  }

  // 5. Fallback PG RLS policy in domain-builder uses exact app.current_org GUC predicate
  const fallbackDb = makeBuilderDb();
  fallbackDb.attachLatticeRlsPolicy = undefined;
  const rlsResult = await attachAndVerifyPgRls(fallbackDb, 'latticeCustomCheck', { pgRls: null });
  assert.equal(rlsResult.attached, true);
  assert.equal(rlsResult.verified, true);
  const policySql = fallbackDb.queries.map((q) => q.sql).join('\n');
  assert.match(policySql, /current_setting\('app\.current_org', true\)/);
  assert.doesNotMatch(policySql, /app\.organization_id/);
  assert.match(policySql, /IS NULL OR .* = '' OR .* = '\*'/);

  // 6. Production PKI master key fails closed when no key material configured
  await assert.rejects(
    () => generateOrEnsureOrgPkiKey(fallbackDb, 'org-prod', { env: { NODE_ENV: 'production' } }),
    (err) => err.status === 500 && err.code === 'PKI_MASTER_KEY_MISSING',
  );
});

test('Solution Bundle v3 governance supports automationRules & secret-free webhookSubscriptions export, diff, apply, and validation', async () => {
  const db = makeBuilderDb({
    latticeAutomationRules: [
      {
        organizationId: 'org-a',
        ruleKey: 'notify_on_hold',
        name: 'Notify On Hold',
        triggerEventType: 'lot.held_mkt',
        actionsJson: [{ type: 'notify_role', role: 'ldx_manager', title: 'Lot held' }],
        maxDepth: 8,
        cooldownSec: 0,
        active: true,
      },
    ],
    latticeWebhookSubscriptions: [
      {
        organizationId: 'org-a',
        subscriptionKey: 'erp_sync',
        name: 'ERP Sync Hook',
        targetUrl: 'https://erp.example.com/webhooks',
        eventPattern: 'epod.signed',
        encryptedSigningSecret: 'aesgcm:super-secret-iv-tag-cipher',
        signingSecret: 'whsec_plain_should_never_leak',
        active: true,
      },
    ],
  });

  const exported = await exportSolutionBundle(db, { organizationId: 'org-a' });
  assert.equal(exported.governance.automationRules.length, 1);
  assert.equal(exported.governance.automationRules[0].ruleKey, 'notify_on_hold');
  assert.equal(exported.governance.webhookSubscriptions.length, 1);
  assert.deepEqual(Object.keys(exported.governance.webhookSubscriptions[0]).sort(), [
    'active',
    'eventPattern',
    'name',
    'organizationId',
    'subscriptionKey',
    'targetUrl',
  ]);
  assert.equal('encryptedSigningSecret' in exported.governance.webhookSubscriptions[0], false);
  assert.equal('signingSecret' in exported.governance.webhookSubscriptions[0], false);

  // Validation accepts exported bundle and rejects bundles with embedded signing secret
  assert.equal(validateSolutionBundle(exported).valid, true);
  const leaky = structuredClone(exported);
  leaky.governance.webhookSubscriptions[0].signingSecret = 'whsec_leak';
  assert.equal(validateSolutionBundle(leaky).valid, false);

  // Apply diff / import into clean DB preserves existing webhook secret when updating metadata
  const targetDb = makeBuilderDb({
    latticeWebhookSubscriptions: [
      {
        organizationId: 'org-a',
        subscriptionKey: 'erp_sync',
        name: 'Old Name',
        targetUrl: 'https://erp.example.com/old',
        eventPattern: 'epod.signed',
        encryptedSigningSecret: 'preserve-me-encrypted',
        active: true,
      },
    ],
  });
  const diff = diffSolutionBundle(await exportSolutionBundle(targetDb, { organizationId: 'org-a' }), exported);
  assert.equal(diff.governance.automationRules.added.length, 1);
  assert.equal(diff.governance.webhookSubscriptions.changed.length, 1);

  const importRes = await importSolutionBundle(targetDb, exported, { dryRun: false, organizationId: 'org-a' });
  assert.equal(importRes.applied.automationRulesUpserted, 1);
  assert.equal(importRes.applied.webhookSubscriptionsUpserted, 1);
  assert.equal(targetDb.store.latticeAutomationRules.length, 1);
  assert.equal(targetDb.store.latticeWebhookSubscriptions[0].name, 'ERP Sync Hook');
  assert.equal(targetDb.store.latticeWebhookSubscriptions[0].encryptedSigningSecret, 'preserve-me-encrypted');
});

test('createOrUpdateDomainCollection avoids PG RLS alter conflict on idempotent sync and restores RLS around column evolution', async () => {
  const db = makeBuilderDb({
    rolesUsers: [{ userId: 1, roleName: 'root' }],
  });
  let existingColumnRows = [
    { column_name: 'id' },
    { column_name: 'createdAt' },
    { column_name: 'updatedAt' },
    { column_name: 'organizationId' },
    { column_name: 'sensorCode' },
  ];
  let failNextAlter = false;
  const origQuery = db.sequelize.query.bind(db.sequelize);
  db.sequelize.query = async (sql, opts) => {
    const text = String(sql);
    await origQuery(sql, opts);
    if (text.includes('FROM information_schema.columns')) {
      return [existingColumnRows, []];
    }
    if (text.includes('FROM pg_class')) {
      return [[{ rls_enabled: true }], []];
    }
    return [[], []];
  };
  const origCollection = db.collection.bind(db);
  db.collection = (def) => {
    const col = origCollection(def);
    return {
      ...col,
      async sync(opts) {
        await col.sync(opts);
        if (opts?.alter && failNextAlter) {
          throw new Error('simulated sync failure');
        }
      },
    };
  };

  const builder = createDxosBuilderActions(db);
  await builder.createDomain(makeCtx({
    userId: 1,
    role: 'root',
    isRoot: true,
    params: {
      collectionName: 'latticeCustomIdempSensors',
      fields: [{ name: 'sensorCode', type: 'string', required: true }],
    },
  }), async () => {});

  const firstColSync = db.syncCalls.find((s) => s.name === 'latticeCustomIdempSensors');
  assert.equal(firstColSync.opts, undefined, 'Existing matching PG table must sync without alter: true');
  assert.equal(
    db.queries.some((q) => q.sql.includes('DROP POLICY')),
    false,
    'Idempotent domain re-run must not drop existing RLS policy',
  );

  // Add a new field while simulating sync failure -> DROP POLICY precedes alter and finally restores RLS
  db.syncCalls.length = 0;
  db.queries.length = 0;
  db.rlsAttached.length = 0;
  existingColumnRows = [{ column_name: 'id' }, { column_name: 'organizationId' }, { column_name: 'sensorCode' }];
  failNextAlter = true;

  await assert.rejects(
    () => builder.createDomain(makeCtx({
      userId: 1,
      role: 'root',
      isRoot: true,
      params: {
        collectionName: 'latticeCustomIdempSensors',
        fields: [
          { name: 'sensorCode', type: 'string', required: true },
          { name: 'tempC', type: 'float' },
        ],
      },
    }), async () => {}),
    /simulated sync failure/,
  );

  const dropIdx = db.queries.findIndex((q) => q.sql.includes('DROP POLICY IF EXISTS "lattice_tenant_isolation" ON "latticeCustomIdempSensors"'));
  assert.ok(dropIdx >= 0, 'Missing column evolution must drop policy before alter sync');
  assert.ok(db.syncCalls.some((s) => s.name === 'latticeCustomIdempSensors' && s.opts?.alter === true));
  assert.ok(db.rlsAttached.includes('latticeCustomIdempSensors'), 'finally guard must re-attach RLS even when sync throws');
});

test('all new builder server & test files satisfy CTU-OpenPaw SPDX header check', async () => {
  const { addSourceHeader } = await import('../../../../scripts/source-headers.mjs');
  const files = [
    'plugins/nocobase/plugin-dxos-studio/src/server/domain-builder.js',
    'plugins/nocobase/plugin-dxos-studio/tests/domain-builder.test.cjs',
  ];
  const rootDir = path.resolve(__dirname, '../../../..');
  for (const rel of files) {
    const src = fs.readFileSync(path.join(rootDir, rel), 'utf8');
    const res = addSourceHeader(src, rel);
    assert.equal(res.status, 'present', `Missing or malformed SPDX header in ${rel}`);
  }
});
