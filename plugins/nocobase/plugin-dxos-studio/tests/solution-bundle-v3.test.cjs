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

function makeV3Harness() {
  let seq = 1000;
  const roles = [
    { name: 'root', title: 'Root', allowAll: true },
    { name: 'ldx_admin', title: 'Org Admin', allowAll: false, allowConfigure: true, snippets: ['pm', 'pm.*'] },
    { name: 'ldx_employee', title: 'Nhân viên', allowAll: false, snippets: ['lattice.integrations.propose'], allowConfigure: false },
    { name: 'ldx_manager', title: 'Quản lý', allowAll: false, snippets: [], allowConfigure: false },
  ];
  const roleResources = [
    { roleName: 'ldx_employee', name: 'latticeRequests', dataSourceKey: 'main', usingActionsConfig: true, actions: [{ name: 'view' }] },
  ];
  const employees = [
    { id: 10, userId: 20, organizationId: 'org-a', active: true, code: 'ADM-A', name: 'Org A Admin' },
    { id: 11, userId: 21, organizationId: 'org-b', active: true, code: 'ADM-B', name: 'Org B Admin' },
    { id: 12, userId: 22, organizationId: 'org-a', active: false, code: 'INACTIVE', name: 'Inactive Admin' },
  ];
  const portals = [
    { id: 1, uid: 'ldx-portal-logistics', name: 'Logistics', title: 'Logistics', layoutType: 'desktop', routeName: 'p_logistics', routePath: '/p/logistics', enabled: true, authCheck: true },
    { id: 2, uid: 'admin-layout-model', name: 'Admin', title: 'Admin', layoutType: 'desktop', routeName: 'admin', routePath: '/admin', enabled: true, authCheck: true },
  ];
  const desktopRoutes = [
    { id: 10, parentId: null, type: 'group', title: 'Điều phối Vận chuyển', icon: 'CarOutlined', uiLayoutUid: 'ldx-portal-logistics', sort: 1 },
    { id: 11, parentId: 10, type: 'flowPage', title: 'Điều hành Logistics 5 bước', icon: 'FundProjectionScreenOutlined', schemaUid: 'pg_logistics_ov', uiLayoutUid: 'ldx-portal-logistics', sort: 1 },
    { id: 12, parentId: 11, type: 'tabs', title: 'Tổng quan', schemaUid: 'tab_logistics_ov' },
    { id: 99, parentId: null, type: 'page', title: 'System Admin Route', schemaUid: 'pg_admin_only', uiLayoutUid: 'admin-layout-model' },
  ];
  const desktopRoutesUiLayouts = [
    { id: 201, desktopRouteId: 10, uiLayoutUid: 'ldx-portal-logistics' },
    { id: 202, desktopRouteId: 11, uiLayoutUid: 'ldx-portal-logistics' },
    { id: 203, desktopRouteId: 99, uiLayoutUid: 'admin-layout-model' },
  ];
  const rolesDesktopRoutes = [
    { id: 301, desktopRouteId: 10, roleName: 'ldx_employee' },
    { id: 302, desktopRouteId: 11, roleName: 'ldx_employee' },
    { id: 303, desktopRouteId: 11, roleName: 'root' },
    { id: 304, desktopRouteId: 99, roleName: 'root' },
  ];
  const flowModels = [
    {
      uid: 'grid_logistics_ov',
      use: 'GridModel',
      parentId: 'tab_logistics_ov',
      subKey: 'grid',
      subType: 'object',
      props: { rows: { dxos_row_0: [['dxos-ov-logistics-kanban']] }, sizes: { dxos_row_0: [24] }, rowOrder: ['dxos_row_0'] },
      stepParams: { gridSettings: { grid: { rows: { dxos_row_0: [['dxos-ov-logistics-kanban']] }, sizes: { dxos_row_0: [24] }, rowOrder: ['dxos_row_0'] } } },
    },
    {
      uid: 'dxos-ov-logistics-kanban',
      use: 'DxosKanbanScheduleBlockModel',
      parentId: 'grid_logistics_ov',
      subKey: 'items',
      subType: 'array',
      props: { title: 'Bảng Kanban & Lịch Giao nhận [H]', collection: 'latticeOrders', viewMode: 'kanban', pageSize: 40, apiKey: 'SECRET-BLOCK-KEY' },
      stepParams: { dxosBlockSettings: { config: { title: 'Bảng Kanban & Lịch Giao nhận [H]', collection: 'latticeOrders', viewMode: 'kanban', pageSize: 40 } } },
    },
    {
      uid: 'admin_only_model',
      use: 'TableBlockModel',
      parentId: 'pg_admin_only',
      subKey: 'items',
      subType: 'array',
      props: { title: 'Admin Secret Table' },
    },
  ];
  const workflows = [
    { id: 11, key: 'wf-org-a', title: 'Workflow Org A', current: true, enabled: true, options: { dxosOrganizationId: 'org-a' }, config: {} },
    { id: 12, key: 'wf-org-b', title: 'Workflow Org B', current: true, enabled: true, options: { dxosOrganizationId: 'org-b' }, config: {} },
  ];
  const flowNodes = [];
  const aiProfiles = [
    { id: 7, username: 'dxos-ops-a', nickname: 'Ops A', organizationId: 'org-a', enabled: true },
    { id: 8, username: 'dxos-ops-b', nickname: 'Ops B', organizationId: 'org-b', enabled: true },
  ];
  const customCollections = [];
  const decisionTables = [
    {
      id: 401,
      organizationId: 'org-a',
      tableKey: 'dmn-cold-triage',
      name: 'Phân loại sự cố kho lạnh',
      description: 'Org A rule',
      hitPolicy: 'FIRST',
      inputsJson: [{ name: 'tempC', type: 'number' }],
      outputsJson: [{ name: 'severity', type: 'string' }],
      rulesJson: [{ when: { tempC: { op: 'gt', value: 8 } }, then: { severity: 'critical' } }],
      version: 2,
      published: true,
      active: true,
      webhookSecret: 'DMN-SECRET-A',
      createdAt: '2026-11-20T00:00:00.000Z',
      updatedAt: '2026-11-21T00:00:00.000Z',
    },
    {
      id: 402,
      organizationId: 'org-b',
      tableKey: 'dmn-org-b',
      name: 'Org B Rule',
      hitPolicy: 'FIRST',
      inputsJson: [{ name: 'tempC', type: 'number' }],
      outputsJson: [{ name: 'severity', type: 'string' }],
      rulesJson: [{ when: { tempC: { op: 'gt', value: 12 } }, then: { severity: 'high' } }],
      version: 1,
      published: true,
      active: true,
    },
  ];
  const slaPolicies = [
    {
      id: 501,
      organizationId: 'org-a',
      targetCollection: 'latticeIncidentCases',
      priority: 'critical',
      warnAfterMinutes: 15,
      breachAfterMinutes: 45,
      escalateToRole: 'ldx_manager',
      notifyChannels: ['in_app', 'webhook'],
      active: true,
      apiToken: 'SLA-SECRET-TOKEN',
      createdAt: '2026-11-20T00:00:00.000Z',
    },
    {
      id: 502,
      organizationId: 'org-b',
      targetCollection: 'latticeOrders',
      priority: 'high',
      warnAfterMinutes: 30,
      breachAfterMinutes: 120,
      escalateToRole: 'ldx_manager',
      notifyChannels: ['in_app'],
      active: true,
    },
  ];
  const incidentRules = [
    {
      id: 601,
      organizationId: 'org-a',
      code: 'RULE-COLD-HI',
      name: 'Quá ngưỡng kho lạnh',
      active: true,
      assetId: 999,
      assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:1',
      attribute: 'temperature',
      operator: '>',
      threshold: '8',
      unit: 'CEL',
      severity: 'critical',
      maxObservationAgeSeconds: '300',
      cooldownSeconds: '300',
      workflowDefinitionId: 'incident-response',
      workflowDefinitionVersion: '1',
      handlerId: 'tech-a',
      bearerToken: 'RULE-SECRET-123',
      createdAt: '2026-11-20T00:00:00.000Z',
    },
    {
      id: 602,
      organizationId: 'org-b',
      code: 'RULE-ORG-B',
      name: 'Org B Rule',
      active: true,
      assetEntityId: 'urn:ngsi-ld:Asset:org-b:native:2',
      attribute: 'temperature',
      operator: '>',
      threshold: '10',
      unit: 'CEL',
      severity: 'high',
      handlerId: 'tech-b',
    },
  ];
  const uiSnapshots = [];

  const matchFilter = (row, filter = {}) => Object.entries(filter || {}).every(([k, v]) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if (Object.hasOwn(v, '$in') && Array.isArray(v.$in)) return v.$in.includes(row[k]);
      if (Object.hasOwn(v, '$eq')) return row[k] === v.$eq;
    }
    if (k.startsWith('options.')) {
      const optKey = k.slice('options.'.length);
      return row.options?.[optKey] === v;
    }
    return row[k] === v;
  });

  const makeRepo = (arr, extra = {}) => ({
    find: async ({ filter } = {}) => arr.filter((r) => matchFilter(r, filter)).map((r) => ({ ...r })),
    findOne: async ({ filter } = {}) => {
      const hit = arr.find((r) => matchFilter(r, filter));
      return hit ? { ...hit } : null;
    },
    create: async ({ values }) => {
      const row = { id: ++seq, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...structuredClone(values) };
      arr.push(row);
      return { ...row };
    },
    update: async ({ filterByTk, filter, values }) => {
      const hit = arr.find((r) => (filterByTk != null ? Number(r.id) === Number(filterByTk) : matchFilter(r, filter)));
      if (hit) Object.assign(hit, structuredClone(values), { updatedAt: new Date().toISOString() });
      return hit ? [{ ...hit }] : [];
    },
    destroy: async ({ filter } = {}) => {
      for (let i = arr.length - 1; i >= 0; i -= 1) {
        if (matchFilter(arr[i], filter)) arr.splice(i, 1);
      }
    },
    ...extra,
  });

  const snapshotStore = () => ({
    roles: structuredClone(roles),
    roleResources: structuredClone(roleResources),
    portals: structuredClone(portals),
    desktopRoutes: structuredClone(desktopRoutes),
    desktopRoutesUiLayouts: structuredClone(desktopRoutesUiLayouts),
    rolesDesktopRoutes: structuredClone(rolesDesktopRoutes),
    flowModels: structuredClone(flowModels),
    workflows: structuredClone(workflows),
    flowNodes: structuredClone(flowNodes),
    aiProfiles: structuredClone(aiProfiles),
    customCollections: structuredClone(customCollections),
    decisionTables: structuredClone(decisionTables),
    slaPolicies: structuredClone(slaPolicies),
    incidentRules: structuredClone(incidentRules),
    uiSnapshots: structuredClone(uiSnapshots),
  });
  const restoreStore = (snap) => {
    for (const [arr, src] of [
      [roles, snap.roles], [roleResources, snap.roleResources], [portals, snap.portals],
      [desktopRoutes, snap.desktopRoutes], [desktopRoutesUiLayouts, snap.desktopRoutesUiLayouts],
      [rolesDesktopRoutes, snap.rolesDesktopRoutes], [flowModels, snap.flowModels],
      [workflows, snap.workflows], [flowNodes, snap.flowNodes], [aiProfiles, snap.aiProfiles],
      [customCollections, snap.customCollections], [decisionTables, snap.decisionTables],
      [slaPolicies, snap.slaPolicies], [incidentRules, snap.incidentRules], [uiSnapshots, snap.uiSnapshots],
    ]) {
      arr.splice(0, arr.length, ...src);
    }
  };

  let failRepo = null;
  const repos = {
    roles: makeRepo(roles),
    dataSourcesRolesResources: makeRepo(roleResources),
    latticeEmployees: makeRepo(employees),
    uiLayouts: makeRepo(portals),
    desktopRoutes: makeRepo(desktopRoutes),
    desktopRoutesUiLayouts: makeRepo(desktopRoutesUiLayouts),
    rolesDesktopRoutes: makeRepo(rolesDesktopRoutes),
    flowModels: makeRepo(flowModels),
    workflows: makeRepo(workflows),
    flow_nodes: makeRepo(flowNodes),
    latticeAiProfiles: makeRepo(aiProfiles),
    collections: makeRepo(customCollections),
    latticeDecisionTables: makeRepo(decisionTables),
    latticeSlaPolicies: makeRepo(slaPolicies),
    latticeIncidentRules: makeRepo(incidentRules),
    latticeUiSnapshots: makeRepo(uiSnapshots),
  };

  const db = {
    sequelize: {
      transaction: async (fn) => {
        const snap = snapshotStore();
        try {
          return await fn({ id: `tx-${++seq}` });
        } catch (err) {
          restoreStore(snap);
          throw err;
        }
      },
    },
    hasCollection: (name) => Object.hasOwn(repos, name),
    getRepository: (name) => {
      if (failRepo && failRepo.target === name) {
        return {
          find: async () => [],
          findOne: async () => null,
          create: async () => { throw new Error(failRepo.message); },
          update: async () => { throw new Error(failRepo.message); },
        };
      }
      return repos[name] || null;
    },
    setFailOnRepo(target, message = 'Simulated failure') {
      failRepo = target ? { target, message } : null;
    },
  };

  return {
    db,
    roles,
    employees,
    portals,
    desktopRoutes,
    desktopRoutesUiLayouts,
    rolesDesktopRoutes,
    flowModels,
    decisionTables,
    slaPolicies,
    incidentRules,
    uiSnapshots,
  };
}

test('Solution Bundle v3 exports routesAndBlocks and org-scoped governance cleanly without secrets or volatile IDs', async () => {
  const { BUNDLE_SCHEMA_VERSION, ACCEPTED_SCHEMA_VERSIONS, exportSolutionBundle, validateSolutionBundle } = require(
    path.join(PLUGIN_ROOT, 'src/server/solution-bundle.js'),
  );
  assert.equal(BUNDLE_SCHEMA_VERSION, 'latticedx.solution-bundle/v3');
  assert.equal(ACCEPTED_SCHEMA_VERSIONS.has('latticedx.solution-bundle/v1'), true);
  assert.equal(ACCEPTED_SCHEMA_VERSIONS.has('latticedx.solution-bundle/v2'), true);
  assert.equal(ACCEPTED_SCHEMA_VERSIONS.has('latticedx.solution-bundle/v3'), true);

  const { db } = makeV3Harness();
  const bundle = await exportSolutionBundle(db, { organizationId: 'org-a' });
  assert.equal(bundle.metadata.schemaVersion, 'latticedx.solution-bundle/v3');
  assert.equal(bundle.metadata.platformVersion, '1.0.0');
  assert.equal(bundle.metadata.organizationId, 'org-a');
  assert.equal(validateSolutionBundle(bundle).valid, true);

  // routesAndBlocks excludes admin-layout-model & strips root grants
  assert.ok(bundle.routesAndBlocks && typeof bundle.routesAndBlocks === 'object');
  assert.equal(bundle.routesAndBlocks.routes.some((r) => r.layoutUid === 'admin-layout-model'), false);
  assert.equal(bundle.routesAndBlocks.routes.length, 3);
  const pageRoute = bundle.routesAndBlocks.routes.find((r) => r.schemaUid === 'pg_logistics_ov');
  assert.ok(pageRoute);
  assert.deepEqual(pageRoute.roleGrants, ['ldx_employee']);
  assert.equal(pageRoute.id, undefined);
  assert.ok(pageRoute.parentKey);
  const tabRoute = bundle.routesAndBlocks.routes.find((r) => r.schemaUid === 'tab_logistics_ov');
  assert.ok(tabRoute);
  assert.equal(tabRoute.parentKey, 'pg_logistics_ov');

  // flowModels includes managed grid + DxosKanbanScheduleBlockModel and excludes admin_only_model
  assert.equal(bundle.routesAndBlocks.flowModels.some((m) => m.uid === 'admin_only_model'), false);
  const kanbanModel = bundle.routesAndBlocks.flowModels.find((m) => m.uid === 'dxos-ov-logistics-kanban');
  assert.ok(kanbanModel);
  assert.equal(kanbanModel.use, 'DxosKanbanScheduleBlockModel');

  // governance filtered strictly to org-a and strips volatile IDs/timestamps/secrets
  assert.ok(bundle.governance && typeof bundle.governance === 'object');
  assert.deepEqual(bundle.governance.decisionTables.map((d) => d.tableKey), ['dmn-cold-triage']);
  assert.equal(bundle.governance.decisionTables[0].id, undefined);
  assert.equal(bundle.governance.decisionTables[0].createdAt, undefined);
  assert.deepEqual(bundle.governance.slaPolicies.map((s) => `${s.targetCollection}:${s.priority}`), ['latticeIncidentCases:critical']);
  assert.equal(bundle.governance.slaPolicies[0].id, undefined);
  assert.deepEqual(bundle.governance.incidentRules.map((r) => r.code), ['RULE-COLD-HI']);
  assert.equal(bundle.governance.incidentRules[0].id, undefined);
  assert.equal(bundle.governance.incidentRules[0].assetId, undefined);

  const rawText = JSON.stringify(bundle);
  assert.equal(rawText.includes('SECRET-BLOCK-KEY'), false);
  assert.equal(rawText.includes('DMN-SECRET-A'), false);
  assert.equal(rawText.includes('SLA-SECRET-TOKEN'), false);
  assert.equal(rawText.includes('RULE-SECRET-123'), false);
});

test('Solution Bundle v3 rejects prototype pollution, unsafe block models, XSS/custom code props, and cross-org governance records', async () => {
  const { exportSolutionBundle, validateSolutionBundle, importSolutionBundle } = require(
    path.join(PLUGIN_ROOT, 'src/server/solution-bundle.js'),
  );
  const { db, decisionTables, slaPolicies, incidentRules } = makeV3Harness();
  const base = await exportSolutionBundle(db, { organizationId: 'org-a' });

  // Prototype pollution via JSON.parse __proto__, constructor, prototype
  const protoBundle = JSON.parse(JSON.stringify(base));
  const polluted = JSON.parse('{"__proto__":{"isAdmin":true}}');
  protoBundle.routesAndBlocks.flowModels[0].props = polluted;
  assert.equal(validateSolutionBundle(protoBundle).valid, false);
  await assert.rejects(
    () => importSolutionBundle(db, protoBundle, { dryRun: false, organizationId: 'org-a' }),
    (err) => err.status === 400 && err.code === 'INVALID_SOLUTION_BUNDLE',
  );

  for (const key of ['constructor', 'prototype']) {
    const b = structuredClone(base);
    b.governance.decisionTables[0].rulesJson = [{ when: { [key]: 'x' }, then: { severity: 'high' } }];
    assert.equal(validateSolutionBundle(b).valid, false, `Expected ${key} key rejection`);
  }

  // Unsafe block model `use` (JSBlockModel, ScriptBlockModel, HtmlBlockModel, EvilBlockModel)
  for (const badUse of ['JSBlockModel', 'ScriptBlockModel', 'HtmlBlockModel', 'IframeBlockModel', 'EvilCustomModel', '']) {
    const badModel = structuredClone(base);
    badModel.routesAndBlocks.flowModels.push({ uid: 'bad_m1', use: badUse, props: { title: 'Bad' } });
    assert.equal(validateSolutionBundle(badModel).valid, false, `Expected block use "${badUse}" rejection`);
  }

  // XSS / <script> / javascript: / custom JS code props rejected
  const xssProps = structuredClone(base);
  xssProps.routesAndBlocks.flowModels[1].props.title = '<script>alert(1)</script>';
  assert.equal(validateSolutionBundle(xssProps).valid, false);

  const jsCodeProps = structuredClone(base);
  jsCodeProps.routesAndBlocks.flowModels[1].props.jsCode = 'fetch("https://evil.test")';
  assert.equal(validateSolutionBundle(jsCodeProps).valid, false);

  const jsHrefRoute = structuredClone(base);
  jsHrefRoute.routesAndBlocks.routes[0].options = { href: 'javascript:alert(1)' };
  assert.equal(validateSolutionBundle(jsHrefRoute).valid, false);

  const badLayoutRoute = structuredClone(base);
  badLayoutRoute.routesAndBlocks.routes.push({ key: 'evil_admin', layoutUid: 'admin-layout-model', type: 'page', title: 'Hijack Admin' });
  assert.equal(validateSolutionBundle(badLayoutRoute).valid, false);

  const badGrantRoute = structuredClone(base);
  badGrantRoute.routesAndBlocks.routes[0].roleGrants = ['ldx_employee', 'root'];
  assert.equal(validateSolutionBundle(badGrantRoute).valid, false);

  // Admin/unmanaged route schemaUid & flowModel uid cannot be hijacked by declaring layoutUid='ldx-portal-logistics'
  const hijackAdminRoute = structuredClone(base);
  hijackAdminRoute.routesAndBlocks.routes.push({
    key: 'pg_admin_only',
    schemaUid: 'pg_admin_only',
    layoutUid: 'ldx-portal-logistics',
    type: 'flowPage',
    title: 'Hijacked Admin Page',
    roleGrants: ['ldx_employee'],
  });
  await assert.rejects(
    () => importSolutionBundle(db, hijackAdminRoute, { dryRun: false, organizationId: 'org-a' }),
    (err) => err.status === 400 || err.status === 403,
  );

  const hijackAdminModel = structuredClone(base);
  hijackAdminModel.routesAndBlocks.flowModels.push({
    uid: 'admin_only_model',
    use: 'TableBlockModel',
    parentId: 'tab_logistics_ov',
    props: { title: 'Hijacked Admin Model' },
  });
  await assert.rejects(
    () => importSolutionBundle(db, hijackAdminModel, { dryRun: false, organizationId: 'org-a' }),
    (err) => err.status === 400 || err.status === 403,
  );

  // Cross-org governance record inside org-a import MUST fail closed with 403 DXOS_ORG_MISMATCH and never touch org-b
  const crossOrgGov = structuredClone(base);
  crossOrgGov.governance.decisionTables.push({
    organizationId: 'org-b',
    tableKey: 'dmn-org-b',
    name: 'Tampered Org B',
    hitPolicy: 'FIRST',
    inputsJson: [{ name: 'tempC' }],
    outputsJson: [{ name: 'severity' }],
    rulesJson: [{ when: { tempC: 99 }, then: { severity: 'low' } }],
  });
  await assert.rejects(
    () => importSolutionBundle(db, crossOrgGov, { dryRun: false, organizationId: 'org-a' }),
    (err) => err.status === 403 && err.code === 'DXOS_ORG_MISMATCH',
  );
  assert.equal(decisionTables.find((d) => d.organizationId === 'org-b').name, 'Org B Rule');
  assert.equal(slaPolicies.find((s) => s.organizationId === 'org-b').breachAfterMinutes, 120);
  assert.equal(incidentRules.find((r) => r.organizationId === 'org-b').threshold, '10');
});

test('Solution Bundle v3 diff, dryRun, idempotent apply, v1/v2 backward-compatibility, and transactional rollback work end-to-end', async () => {
  const { exportSolutionBundle, diffSolutionBundle, importSolutionBundle, rollbackLastSolutionBundle } = require(
    path.join(PLUGIN_ROOT, 'src/server/solution-bundle.js'),
  );
  const { db, desktopRoutes, rolesDesktopRoutes, flowModels, decisionTables, slaPolicies, incidentRules } = makeV3Harness();
  const baseline = await exportSolutionBundle(db, { organizationId: 'org-a' });

  // v1/v2 bundle without routesAndBlocks/governance imports cleanly without deleting v3 rows
  const v2Only = {
    metadata: { schemaVersion: 'latticedx.solution-bundle/v2', platformVersion: '0.3.0', organizationId: 'org-a' },
    roles: baseline.roles,
  };
  const v2Apply = await importSolutionBundle(db, v2Only, { dryRun: false, organizationId: 'org-a' });
  assert.equal(v2Apply.dryRun, false);
  assert.equal(desktopRoutes.length, 4);
  assert.equal(decisionTables.length, 2);

  // Prepare v3 delta updating & adding routesAndBlocks + governance
  const incoming = structuredClone(baseline);
  const pageRoute = incoming.routesAndBlocks.routes.find((r) => r.schemaUid === 'pg_logistics_ov');
  pageRoute.title = 'Logistics v3 Updated';
  pageRoute.roleGrants = ['ldx_employee', 'ldx_manager'];
  incoming.routesAndBlocks.routes.push({
    key: 'pg_incidents_gis',
    layoutUid: 'ldx-portal-incidents',
    type: 'flowPage',
    title: 'WebGIS Giám sát',
    icon: 'EnvironmentOutlined',
    schemaUid: 'pg_incidents_gis',
    parentKey: null,
    roleGrants: ['ldx_manager'],
  });
  incoming.routesAndBlocks.flowModels.find((m) => m.uid === 'dxos-ov-logistics-kanban').props.pageSize = 60;
  incoming.routesAndBlocks.flowModels.push({
    uid: 'dxos-ov-incidents-webgis',
    use: 'DxosWebGisBlockModel',
    parentId: 'pg_incidents_gis',
    subKey: 'items',
    subType: 'array',
    props: { title: 'WebGIS [D]', centerLat: 15.8, centerLng: 106.5, showTwinOverlay: true },
    stepParams: { dxosBlockSettings: { config: { title: 'WebGIS [D]', centerLat: 15.8, centerLng: 106.5, showTwinOverlay: true } } },
  });
  incoming.governance.decisionTables[0].name = 'DMN v3 Updated';
  incoming.governance.slaPolicies[0].breachAfterMinutes = 30;
  incoming.governance.incidentRules[0].threshold = '5';
  incoming.governance.incidentRules.push({
    organizationId: 'org-a',
    code: 'RULE-HUMID-HI',
    name: 'Độ ẩm cao',
    active: true,
    assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:1',
    attribute: 'humidity',
    operator: '>',
    threshold: '85',
    unit: 'PCT',
    severity: 'high',
    handlerId: 'tech-a',
  });

  // Diff accurately tracks v3 changes
  const diff = diffSolutionBundle(baseline, incoming);
  assert.equal(diff.sections.routes.changed.length, 1);
  assert.equal(diff.sections.routes.added.length, 1);
  assert.equal(diff.sections.flowModels.changed.length, 1);
  assert.equal(diff.sections.flowModels.added.length, 1);
  assert.equal(diff.sections.decisionTables.changed.length, 1);
  assert.equal(diff.sections.slaPolicies.changed.length, 1);
  assert.equal(diff.sections.incidentRules.changed.length, 1);
  assert.equal(diff.sections.incidentRules.added.length, 1);

  // Dry-run does not mutate DB
  const dryRes = await importSolutionBundle(db, incoming, { dryRun: true, organizationId: 'org-a' });
  assert.equal(dryRes.dryRun, true);
  assert.equal(decisionTables.find((d) => d.tableKey === 'dmn-cold-triage').name, 'Phân loại sự cố kho lạnh');
  assert.equal(flowModels.find((m) => m.uid === 'dxos-ov-logistics-kanban').props.pageSize, 40);

  // Apply (dryRun: false) idempotently updates & inserts v3 sections
  const applyRes = await importSolutionBundle(db, incoming, { dryRun: false, organizationId: 'org-a' });
  assert.equal(applyRes.dryRun, false);
  assert.equal(applyRes.applied.routesUpserted, 4);
  assert.equal(applyRes.applied.flowModelsUpserted, 3);
  assert.equal(applyRes.applied.decisionTablesUpserted, 1);
  assert.equal(applyRes.applied.slaPoliciesUpserted, 1);
  assert.equal(applyRes.applied.incidentRulesUpserted, 2);

  assert.equal(desktopRoutes.find((r) => r.schemaUid === 'pg_logistics_ov').title, 'Logistics v3 Updated');
  assert.equal(rolesDesktopRoutes.some((g) => g.desktopRouteId === 11 && g.roleName === 'ldx_manager'), true);
  assert.equal(flowModels.find((m) => m.uid === 'dxos-ov-logistics-kanban').props.pageSize, 60);
  assert.equal(decisionTables.find((d) => d.tableKey === 'dmn-cold-triage').name, 'DMN v3 Updated');
  assert.equal(slaPolicies.find((s) => s.organizationId === 'org-a').breachAfterMinutes, 30);
  assert.equal(incidentRules.find((r) => r.code === 'RULE-COLD-HI').threshold, '5');

  // Re-applying identical bundle creates zero duplicate rows
  const routeCountAfterFirst = desktopRoutes.length;
  const modelCountAfterFirst = flowModels.length;
  const dmnCountAfterFirst = decisionTables.length;
  await importSolutionBundle(db, incoming, { dryRun: false, organizationId: 'org-a' });
  assert.equal(desktopRoutes.length, routeCountAfterFirst);
  assert.equal(flowModels.length, modelCountAfterFirst);
  assert.equal(decisionTables.length, dmnCountAfterFirst);

  // Rollback restores prior routesAndBlocks + governance cleanly inside transaction
  const rbRes = await rollbackLastSolutionBundle(db, { organizationId: 'org-a', snapshotUid: applyRes.snapshotUid });
  assert.equal(rbRes.rolledBack, true);
  assert.equal(desktopRoutes.find((r) => r.schemaUid === 'pg_logistics_ov').title, 'Điều hành Logistics 5 bước');
  assert.equal(rolesDesktopRoutes.some((g) => g.desktopRouteId === 11 && g.roleName === 'ldx_manager'), false);
  assert.equal(rolesDesktopRoutes.some((g) => g.desktopRouteId === 11 && g.roleName === 'ldx_employee'), true);
  assert.equal(flowModels.find((m) => m.uid === 'dxos-ov-logistics-kanban').props.pageSize, 40);
  assert.equal(decisionTables.find((d) => d.tableKey === 'dmn-cold-triage').name, 'Phân loại sự cố kho lạnh');
  assert.equal(slaPolicies.find((s) => s.organizationId === 'org-a').breachAfterMinutes, 45);
  assert.equal(incidentRules.find((r) => r.code === 'RULE-COLD-HI').threshold, '8');

  // Rollback transaction aborts atomically on mid-apply failure
  db.setFailOnRepo('latticeIncidentRules', 'Simulated governance DB error');
  await assert.rejects(
    () => importSolutionBundle(db, incoming, { dryRun: false, organizationId: 'org-a' }),
    /Simulated governance DB error/,
  );
  db.setFailOnRepo(null);
  assert.equal(decisionTables.find((d) => d.tableKey === 'dmn-cold-triage').name, 'Phân loại sự cố kho lạnh');
});

test('studio-resource enforces non-root organizationId isolation (403 DXOS_ORG_MISMATCH) across export, diff, import, and rollback', async () => {
  const { createDxosStudioActions } = require(path.join(PLUGIN_ROOT, 'src/server/studio-resource.js'));
  const { db, decisionTables } = makeV3Harness();
  const actions = createDxosStudioActions(db, {});

  const orgAAdminState = { currentUser: { id: 20 }, currentRole: 'ldx_admin', currentRoles: ['ldx_admin'] };
  const inactiveAdminState = { currentUser: { id: 22 }, currentRole: 'ldx_admin', currentRoles: ['ldx_admin'] };
  const missingAdminState = { currentUser: { id: 999 }, currentRole: 'ldx_admin', currentRoles: ['ldx_admin'] };
  const rootState = { currentUser: { id: 1 }, currentRole: 'root', currentRoles: ['root'] };

  // Non-root without active latticeEmployees membership fails closed 403 on all 4 actions
  for (const state of [inactiveAdminState, missingAdminState]) {
    await assert.rejects(
      () => actions.solutionBundleExport({ method: 'GET', state, action: { params: {} } }, async () => {}),
      (err) => err.status === 403,
    );
    await assert.rejects(
      () => actions.solutionBundleRollback({ method: 'POST', state, action: { params: {} } }, async () => {}),
      (err) => err.status === 403,
    );
  }

  // Export as root for all + org-b to build foreign bundles
  const rootAllCtx = { method: 'GET', state: rootState, action: { params: { organizationId: 'all' } } };
  await actions.solutionBundleExport(rootAllCtx, async () => {});
  assert.equal(rootAllCtx.body.metadata.organizationId, 'all');
  assert.equal(rootAllCtx.body.metadata.platformVersion, '1.0.0');

  const rootOrgBCtx = { method: 'GET', state: rootState, action: { params: { organizationId: 'org-b' } } };
  await actions.solutionBundleExport(rootOrgBCtx, async () => {});
  const foreignBundle = rootOrgBCtx.body;

  // Non-root org-a admin exporting without org locks to org-a
  const orgAExportCtx = { method: 'GET', state: orgAAdminState, action: { params: {} } };
  await actions.solutionBundleExport(orgAExportCtx, async () => {});
  assert.equal(orgAExportCtx.body.metadata.organizationId, 'org-a');
  assert.deepEqual(orgAExportCtx.body.governance.decisionTables.map((d) => d.tableKey), ['dmn-cold-triage']);

  // Non-root org-a admin requesting foreign or 'all' organizationId gets 403 DXOS_ORG_MISMATCH across all 4 actions
  for (const badOrg of ['org-b', 'all']) {
    await assert.rejects(
      () => actions.solutionBundleExport({ method: 'GET', state: orgAAdminState, action: { params: { organizationId: badOrg } } }, async () => {}),
      (err) => err.status === 403 && err.code === 'DXOS_ORG_MISMATCH',
    );
    await assert.rejects(
      () => actions.solutionBundleDiff({ method: 'POST', state: orgAAdminState, action: { params: { values: { organizationId: badOrg, bundle: orgAExportCtx.body } } } }, async () => {}),
      (err) => err.status === 403 && err.code === 'DXOS_ORG_MISMATCH',
    );
    await assert.rejects(
      () => actions.solutionBundleImport({ method: 'POST', state: orgAAdminState, action: { params: { values: { organizationId: badOrg, bundle: orgAExportCtx.body, dryRun: false } } } }, async () => {}),
      (err) => err.status === 403 && err.code === 'DXOS_ORG_MISMATCH',
    );
    await assert.rejects(
      () => actions.solutionBundleRollback({ method: 'POST', state: orgAAdminState, action: { params: { values: { organizationId: badOrg } } } }, async () => {}),
      (err) => err.status === 403 && err.code === 'DXOS_ORG_MISMATCH',
    );
  }

  // Non-root org-a admin importing/diffing incoming bundle targeting foreign org-b or 'all' gets 403 DXOS_ORG_MISMATCH
  for (const badBundle of [foreignBundle, rootAllCtx.body]) {
    await assert.rejects(
      () => actions.solutionBundleDiff({ method: 'POST', state: orgAAdminState, action: { params: { values: { bundle: badBundle } } } }, async () => {}),
      (err) => err.status === 403 && err.code === 'DXOS_ORG_MISMATCH',
    );
    await assert.rejects(
      () => actions.solutionBundleImport({ method: 'POST', state: orgAAdminState, action: { params: { values: { bundle: badBundle, dryRun: false } } } }, async () => {}),
      (err) => err.status === 403 && err.code === 'DXOS_ORG_MISMATCH',
    );
  }

  // Non-root org-a admin CAN diff, import, and rollback their own org-a bundle
  const validInc = structuredClone(orgAExportCtx.body);
  validInc.governance.decisionTables[0].name = 'Org A Admin Updated';
  const diffCtx = { method: 'POST', state: orgAAdminState, action: { params: { values: { bundle: validInc } } } };
  await actions.solutionBundleDiff(diffCtx, async () => {});
  assert.equal(diffCtx.body.sections.decisionTables.changed.length, 1);

  const importCtx = { method: 'POST', state: orgAAdminState, action: { params: { values: { bundle: validInc, dryRun: false } } } };
  await actions.solutionBundleImport(importCtx, async () => {});
  assert.equal(importCtx.body.dryRun, false);
  assert.equal(decisionTables.find((d) => d.organizationId === 'org-a').name, 'Org A Admin Updated');

  const rbCtx = { method: 'POST', state: orgAAdminState, action: { params: { values: {} } } };
  await actions.solutionBundleRollback(rbCtx, async () => {});
  assert.equal(rbCtx.body.rolledBack, true);
  assert.equal(decisionTables.find((d) => d.organizationId === 'org-a').name, 'Phân loại sự cố kho lạnh');
});

test('portal-composer OVERVIEW_SPECS includes WebGIS in incidents, Kanban in logistics, and PKI/Lineage/Print in workbenches', () => {
  const { OVERVIEW_SPECS } = require(path.join(PLUGIN_ROOT, 'src/server/portal-composer.js'));

  const incidents = OVERVIEW_SPECS.find((s) => s.slug === 'incidents');
  assert.ok(incidents);
  assert.deepEqual(incidents.blocks.map((b) => b.uidSuffix), ['hero', 'context', 'proposals', 'webgis']);
  const webgis = incidents.blocks.find((b) => b.uidSuffix === 'webgis');
  assert.equal(webgis.use, 'DxosWebGisBlockModel');
  assert.deepEqual(webgis.config, {
    title: 'Bản đồ Giám sát Chuỗi lạnh WebGIS [D]',
    defaultOrganizationId: '',
    centerLat: 15.8,
    centerLng: 106.5,
    showTwinOverlay: true,
  });

  const logistics = OVERVIEW_SPECS.find((s) => s.slug === 'logistics');
  assert.ok(logistics);
  assert.deepEqual(logistics.blocks.map((b) => b.uidSuffix), ['hero', 'kpi', 'tasks', 'workbench', 'kanban']);
  const kanban = logistics.blocks.find((b) => b.uidSuffix === 'kanban');
  assert.equal(kanban.use, 'DxosKanbanScheduleBlockModel');
  assert.deepEqual(kanban.config, {
    title: 'Bảng Kanban & Lịch Giao nhận [H]',
    collection: 'latticeOrders',
    viewMode: 'kanban',
    pageSize: 40,
  });

  for (const slug of ['logistics', 'services']) {
    const spec = OVERVIEW_SPECS.find((s) => s.slug === slug);
    const wb = spec.blocks.find((b) => b.uidSuffix === 'workbench');
    assert.equal(wb.use, 'DxosRecordWorkbenchBlockModel');
    assert.equal(wb.config.showExport, true);
    assert.equal(wb.config.showVoucherActions, true);
    assert.equal(wb.config.showChatter, true);
    assert.equal(wb.config.showPkiBadge, true);
    assert.equal(wb.config.showLineage, true);
    assert.equal(wb.config.showPrintVoucher, true);
  }
});
