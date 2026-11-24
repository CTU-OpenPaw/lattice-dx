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
  assert.equal(desktopRoutes.some((r) => r.schemaUid === 'pg_incidents_gis'), false, 'Rollback must delete newly added route pg_incidents_gis');
  assert.equal(flowModels.some((m) => m.uid === 'dxos-ov-incidents-webgis'), false, 'Rollback must delete newly added flowModel dxos-ov-incidents-webgis');
  assert.equal(incidentRules.some((r) => r.organizationId === 'org-a' && r.code === 'RULE-HUMID-HI'), false, 'Rollback must delete newly added incidentRule RULE-HUMID-HI');
  assert.equal(rolesDesktopRoutes.some((g) => g.desktopRouteId === 11 && g.roleName === 'ldx_manager'), false);
  assert.equal(rolesDesktopRoutes.some((g) => g.desktopRouteId === 11 && g.roleName === 'ldx_employee'), true);
  assert.equal(flowModels.find((m) => m.uid === 'dxos-ov-logistics-kanban').props.pageSize, 40);
  assert.equal(decisionTables.find((d) => d.tableKey === 'dmn-cold-triage').name, 'Phân loại sự cố kho lạnh');
  assert.equal(slaPolicies.find((s) => s.organizationId === 'org-a').breachAfterMinutes, 45);
  assert.equal(incidentRules.find((r) => r.code === 'RULE-COLD-HI').threshold, '8');
  // Foreign org-b & unmanaged admin rows remain untouched
  assert.equal(decisionTables.find((d) => d.organizationId === 'org-b').name, 'Org B Rule');
  assert.equal(slaPolicies.find((s) => s.organizationId === 'org-b').breachAfterMinutes, 120);
  assert.equal(incidentRules.find((r) => r.organizationId === 'org-b').threshold, '10');
  assert.equal(desktopRoutes.some((r) => r.schemaUid === 'pg_admin_only'), true);
  assert.equal(flowModels.some((m) => m.uid === 'admin_only_model'), true);

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
  assert.deepEqual(logistics.blocks.map((b) => b.uidSuffix), ['hero', 'kpi', 'tasks', 'workbench', 'kanban', 'wms-ops']);
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

test('Fix Round 1 (C1): rollback reconciles empty baselines, deletes child-before-parent routes/links, clears added optional fields, and preserves org-b', async () => {
  const { exportSolutionBundle, importSolutionBundle, rollbackLastSolutionBundle } = require(
    path.join(PLUGIN_ROOT, 'src/server/solution-bundle.js'),
  );
  const {
    db, desktopRoutes, desktopRoutesUiLayouts, rolesDesktopRoutes, flowModels, decisionTables, slaPolicies, incidentRules,
  } = makeV3Harness();

  // Clear optional fields before baseline export to test reset to null/false/{}
  delete decisionTables[0].description;
  delete decisionTables[0].updatedBy;
  delete slaPolicies[0].notifyChannels;

  const baseline = await exportSolutionBundle(db, { organizationId: 'org-a' });
  const incoming = structuredClone(baseline);
  // Add optional fields on existing tab route, flowModel, DMN, SLA
  const tabRoute = incoming.routesAndBlocks.routes.find((r) => r.schemaUid === 'tab_logistics_ov');
  tabRoute.icon = 'StarOutlined';
  tabRoute.hidden = true;
  tabRoute.sort = 99;
  tabRoute.options = { badge: 'NEW' };
  const kanban = incoming.routesAndBlocks.flowModels.find((m) => m.uid === 'dxos-ov-logistics-kanban');
  kanban.sortIndex = 42;
  incoming.governance.decisionTables[0].description = 'Added during import';
  incoming.governance.decisionTables[0].updatedBy = 'attacker-import';
  incoming.governance.slaPolicies[0].notifyChannels = ['email', 'webhook'];

  // Also add nested group -> page -> tab hierarchy under a new portal
  incoming.routesAndBlocks.routes.push(
    { key: 'grp_new', layoutUid: 'ldx-portal-incidents', type: 'group', title: 'New Group', roleGrants: ['ldx_manager'] },
    { key: 'pg_incidents_gis', layoutUid: 'ldx-portal-incidents', type: 'flowPage', title: 'New Page', schemaUid: 'pg_incidents_gis', parentKey: 'grp_new', roleGrants: ['ldx_manager'] },
    { key: 'tab_incidents_gis', layoutUid: 'ldx-portal-incidents', type: 'tabs', title: 'New Tab', schemaUid: 'tab_incidents_gis', parentKey: 'pg_incidents_gis' },
  );

  // Track destroy call order to verify child routes deleted before parents and link tables before routes
  const destroyLog = [];
  const origGetRepo = db.getRepository.bind(db);
  db.getRepository = (name) => {
    const repo = origGetRepo(name);
    if (!repo || typeof repo.destroy !== 'function') return repo;
    return {
      ...repo,
      destroy: async (opts) => {
        destroyLog.push({ repo: name, filter: opts?.filter });
        return repo.destroy(opts);
      },
    };
  };

  const applyRes = await importSolutionBundle(db, incoming, { dryRun: false, organizationId: 'org-a' });
  assert.equal(desktopRoutes.find((r) => r.schemaUid === 'tab_logistics_ov').icon, 'StarOutlined');
  assert.equal(decisionTables[0].description, 'Added during import');
  assert.deepEqual(slaPolicies[0].notifyChannels, ['email', 'webhook']);

  const addedGroup = desktopRoutes.find((r) => r.title === 'New Group');
  const addedPage = desktopRoutes.find((r) => r.schemaUid === 'pg_incidents_gis');
  const addedTab = desktopRoutes.find((r) => r.schemaUid === 'tab_incidents_gis');
  assert.ok(addedGroup && addedPage && addedTab);

  destroyLog.length = 0;
  const rbRes = await rollbackLastSolutionBundle(db, { organizationId: 'org-a', snapshotUid: applyRes.snapshotUid });
  assert.equal(rbRes.rolledBack, true);

  // Verify added optional fields are explicitly cleared
  const restoredTab = desktopRoutes.find((r) => r.schemaUid === 'tab_logistics_ov');
  assert.equal(restoredTab.icon, null);
  assert.equal(restoredTab.hidden, false);
  assert.equal(restoredTab.sort, null);
  assert.deepEqual(restoredTab.options, {});
  assert.equal(flowModels.find((m) => m.uid === 'dxos-ov-logistics-kanban').sortIndex, null);
  assert.equal(decisionTables[0].description, null);
  assert.equal(decisionTables[0].updatedBy, null);
  assert.equal(slaPolicies[0].notifyChannels, null);

  // Verify new route tree + its link/grant rows were destroyed (children before parents, links before routes)
  assert.equal(desktopRoutes.some((r) => ['New Group', 'New Page', 'New Tab'].includes(r.title)), false);
  assert.equal(desktopRoutesUiLayouts.some((l) => [addedGroup.id, addedPage.id, addedTab.id].includes(l.desktopRouteId)), false);
  assert.equal(rolesDesktopRoutes.some((g) => [addedGroup.id, addedPage.id, addedTab.id].includes(g.desktopRouteId)), false);
  const routeDestroyOrder = destroyLog.filter((e) => e.repo === 'desktopRoutes').map((e) => e.filter.id);
  assert.deepEqual(routeDestroyOrder, [addedTab.id, addedPage.id, addedGroup.id]);

  // Verify empty-list baseline reconciliation (0 managed routes/models and 0 org-a governance rows before import)
  const h2 = makeV3Harness();
  h2.desktopRoutes.splice(0, h2.desktopRoutes.length, { id: 99, parentId: null, type: 'page', title: 'Admin', schemaUid: 'pg_admin_only', uiLayoutUid: 'admin-layout-model' });
  h2.desktopRoutesUiLayouts.splice(0, h2.desktopRoutesUiLayouts.length, { id: 203, desktopRouteId: 99, uiLayoutUid: 'admin-layout-model' });
  h2.flowModels.splice(0, h2.flowModels.length, { uid: 'admin_only_model', use: 'TableBlockModel', parentId: 'pg_admin_only', props: {} });
  h2.decisionTables.splice(0, h2.decisionTables.length, h2.decisionTables.find((d) => d.organizationId === 'org-b'));
  h2.slaPolicies.splice(0, h2.slaPolicies.length, h2.slaPolicies.find((s) => s.organizationId === 'org-b'));
  h2.incidentRules.splice(0, h2.incidentRules.length, h2.incidentRules.find((r) => r.organizationId === 'org-b'));

  const emptyBase = await exportSolutionBundle(h2.db, { organizationId: 'org-a' });
  assert.deepEqual(emptyBase.routesAndBlocks, { routes: [], flowModels: [] });
  assert.deepEqual(emptyBase.governance, {
    decisionTables: [],
    slaPolicies: [],
    incidentRules: [],
    automationRules: [],
    webhookSubscriptions: [],
  });

  const nonEmptyInc = structuredClone(emptyBase);
  nonEmptyInc.routesAndBlocks.routes.push({
    key: 'pg_tmp', layoutUid: 'ldx-portal-incidents', type: 'flowPage', title: 'Tmp', schemaUid: 'pg_tmp',
  });
  nonEmptyInc.routesAndBlocks.flowModels.push({
    uid: 'dxos-tmp-block', use: 'DxosWebGisBlockModel', parentId: 'pg_tmp', props: {},
  });
  nonEmptyInc.governance.decisionTables.push({
    organizationId: 'org-a', tableKey: 'dmn-tmp', name: 'Tmp', hitPolicy: 'FIRST', inputsJson: [], outputsJson: [], rulesJson: [],
  });
  nonEmptyInc.governance.slaPolicies.push({
    organizationId: 'org-a', targetCollection: 'latticeOrders', priority: 'high', warnAfterMinutes: 10, breachAfterMinutes: 20,
  });
  nonEmptyInc.governance.incidentRules.push({
    organizationId: 'org-a', code: 'RULE-TMP', name: 'Tmp', assetEntityId: 'urn:a', attribute: 't', operator: '>', threshold: '5', unit: 'CEL', handlerId: 'h1',
  });

  const emptyApply = await importSolutionBundle(h2.db, nonEmptyInc, { dryRun: false, organizationId: 'org-a' });
  assert.equal(h2.desktopRoutes.length, 2);
  assert.equal(h2.flowModels.length, 2);
  assert.equal(h2.decisionTables.length, 2);

  await rollbackLastSolutionBundle(h2.db, { organizationId: 'org-a', snapshotUid: emptyApply.snapshotUid });
  assert.deepEqual(h2.desktopRoutes.map((r) => r.schemaUid), ['pg_admin_only']);
  assert.deepEqual(h2.flowModels.map((m) => m.uid), ['admin_only_model']);
  assert.deepEqual(h2.decisionTables.map((d) => d.organizationId), ['org-b']);
  assert.deepEqual(h2.slaPolicies.map((s) => s.organizationId), ['org-b']);
  assert.deepEqual(h2.incidentRules.map((r) => r.organizationId), ['org-b']);
});

test('Fix Round 1 (C2): blocks reserved layout models, unlinked system routes/models, r.uiLayouts trees, and grid-row children', async () => {
  const { exportSolutionBundle, validateSolutionBundle, importSolutionBundle } = require(
    path.join(PLUGIN_ROOT, 'src/server/solution-bundle.js'),
  );
  const { db, portals, desktopRoutes, flowModels } = makeV3Harness();

  // Add non-managed uiLayout, unlinked system route, r.uiLayouts-only admin tree with dxos-* child, and grid-rows-only child
  portals.push({ id: 3, uid: 'custom-non-ldx', name: 'Custom', title: 'Custom' });
  desktopRoutes.push(
    { id: 199, parentId: null, type: 'page', title: 'Unlinked Sys Route', schemaUid: 'pg_unlinked_sys', uiLayoutUid: null },
    { id: 200, parentId: null, type: 'page', title: 'Appended Admin', schemaUid: 'pg_appended_admin', uiLayoutUid: null, uiLayouts: [{ uid: 'admin-layout-model' }] },
    { id: 201, parentId: 200, type: 'tabs', title: 'Sneaky Tab', schemaUid: 'dxos-sneaky-tab' },
  );
  flowModels.push(
    { uid: 'admin-layout-model', use: 'RootPageModel', parentId: null, props: {} },
    { uid: 'admin_grid_1', use: 'GridModel', parentId: 'pg_admin_only', props: { rows: { r1: [['admin_leaf_grid_only', 'dxos-sneaky-grid-child']] } } },
    { uid: 'admin_leaf_grid_only', use: 'TableBlockModel', parentId: null, props: { title: 'Hidden' } },
    { uid: 'dxos-sneaky-grid-child', use: 'DxosWebGisBlockModel', parentId: null, props: { title: 'Sneaky' } },
    { uid: 'dxos-sneaky-tab-block', use: 'DxosWebGisBlockModel', parentId: 'dxos-sneaky-tab', props: { title: 'Sneaky Tab Block' } },
    { uid: 'sys_orphan_model', use: 'TableBlockModel', parentId: null, props: { title: 'Orphan Sys Model' } },
  );

  // Export must exclude ALL unmanaged routes and ALL unmanaged models (including dxos-* under admin/uiLayouts/grid)
  const exported = await exportSolutionBundle(db, { organizationId: 'org-a' });
  const expRouteSchemas = new Set(exported.routesAndBlocks.routes.map((r) => r.schemaUid).filter(Boolean));
  const expModelUids = new Set(exported.routesAndBlocks.flowModels.map((m) => m.uid));
  for (const forbiddenRoute of ['pg_unlinked_sys', 'pg_appended_admin', 'dxos-sneaky-tab']) {
    assert.equal(expRouteSchemas.has(forbiddenRoute), false, `Export leaked unmanaged route ${forbiddenRoute}`);
  }
  for (const forbiddenModel of [
    'admin-layout-model', 'admin_grid_1', 'admin_leaf_grid_only',
    'dxos-sneaky-grid-child', 'dxos-sneaky-tab', 'dxos-sneaky-tab-block', 'sys_orphan_model',
  ]) {
    assert.equal(expModelUids.has(forbiddenModel), false, `Export leaked unmanaged model ${forbiddenModel}`);
  }

  // Reject admin-layout-model / mobile-layout-model as uid or parentId in validation and import
  for (const reservedUid of ['admin-layout-model', 'mobile-layout-model']) {
    const badUid = structuredClone(exported);
    badUid.routesAndBlocks.flowModels.push({ uid: reservedUid, use: 'PageModel', props: {} });
    assert.equal(validateSolutionBundle(badUid).valid, false, `Expected validation failure for uid ${reservedUid}`);
    await assert.rejects(
      () => importSolutionBundle(db, badUid, { dryRun: false, organizationId: 'org-a' }),
      (err) => err.status === 400 && err.code === 'INVALID_SOLUTION_BUNDLE',
    );

    const badParent = structuredClone(exported);
    badParent.routesAndBlocks.flowModels.push({ uid: 'dxos-evil-attach', use: 'TableBlockModel', parentId: reservedUid, props: {} });
    assert.equal(validateSolutionBundle(badParent).valid, false, `Expected validation failure for parentId ${reservedUid}`);
    await assert.rejects(
      () => importSolutionBundle(db, badParent, { dryRun: false, organizationId: 'org-a' }),
      (err) => err.status === 400 && err.code === 'INVALID_SOLUTION_BUNDLE',
    );
  }

  // Reject non-managed uiLayouts uid, unlinked system route, r.uiLayouts admin route, orphan model, and grid-child model overwrites
  for (const [label, mutator] of [
    ['non-managed uiLayout uid', (b) => b.routesAndBlocks.flowModels.push({ uid: 'custom-non-ldx', use: 'PageModel', props: {} })],
    ['non-managed uiLayout parentId', (b) => b.routesAndBlocks.flowModels.push({ uid: 'dxos-attach-custom', use: 'TableBlockModel', parentId: 'custom-non-ldx', props: {} })],
    ['unlinked system route', (b) => b.routesAndBlocks.routes.push({ key: 'pg_unlinked_sys', schemaUid: 'pg_unlinked_sys', layoutUid: 'ldx-portal-logistics', type: 'page', title: 'Hijack' })],
    ['r.uiLayouts admin child route', (b) => b.routesAndBlocks.routes.push({ key: 'dxos-sneaky-tab', schemaUid: 'dxos-sneaky-tab', layoutUid: 'ldx-portal-logistics', type: 'tabs', title: 'Hijack' })],
    ['orphan system flowModel', (b) => b.routesAndBlocks.flowModels.push({ uid: 'sys_orphan_model', use: 'TableBlockModel', props: { pwned: true } })],
    ['attach under orphan system model', (b) => b.routesAndBlocks.flowModels.push({ uid: 'dxos-under-orphan', use: 'TableBlockModel', parentId: 'sys_orphan_model', props: {} })],
    ['admin grid-row leaf model', (b) => b.routesAndBlocks.flowModels.push({ uid: 'admin_leaf_grid_only', use: 'TableBlockModel', props: { pwned: true } })],
    ['admin grid-row dxos child model', (b) => b.routesAndBlocks.flowModels.push({ uid: 'dxos-sneaky-grid-child', use: 'DxosWebGisBlockModel', props: { pwned: true } })],
  ]) {
    const b = structuredClone(exported);
    mutator(b);
    await assert.rejects(
      () => importSolutionBundle(db, b, { dryRun: false, organizationId: 'org-a' }),
      (err) => err.status === 400 && err.code === 'INVALID_SOLUTION_BUNDLE',
      `Expected rejection for ${label}`,
    );
  }
});

test('Fix Round 1 (I2 & M2): fails closed on deep XSS/proto nesting, throws on excessive stripSecretsDeep depth, and blocks expanded XSS vectors', async () => {
  const { exportSolutionBundle, validateSolutionBundle, importSolutionBundle, stripSecretsDeep } = require(
    path.join(PLUGIN_ROOT, 'src/server/solution-bundle.js'),
  );
  const { db } = makeV3Harness();
  const base = await exportSolutionBundle(db, { organizationId: 'org-a' });

  const nestObject = (depth, leaf) => {
    let cur = leaf;
    for (let i = 0; i < depth; i += 1) cur = { nested: cur };
    return cur;
  };

  // Depth > 35 XSS fails closed
  const deepXss = structuredClone(base);
  deepXss.routesAndBlocks.flowModels[0].props = nestObject(36, '<script>alert(1)</script>');
  assert.equal(validateSolutionBundle(deepXss).valid, false);
  await assert.rejects(
    () => importSolutionBundle(db, deepXss, { dryRun: false, organizationId: 'org-a' }),
    (err) => err.status === 400 && err.code === 'INVALID_SOLUTION_BUNDLE',
  );

  // Depth > 35 __proto__ fails closed
  const deepProto = structuredClone(base);
  deepProto.routesAndBlocks.flowModels[0].props = nestObject(36, JSON.parse('{"__proto__":{"polluted":true}}'));
  assert.equal(validateSolutionBundle(deepProto).valid, false);

  // stripSecretsDeep strips secrets at depth 35 and throws instead of leaking unstripped above cap (depth 50)
  const stripped35 = stripSecretsDeep(nestObject(35, { apiKey: 'LEAK', safe: 'ok' }));
  let cursor = stripped35;
  for (let i = 0; i < 35; i += 1) cursor = cursor.nested;
  assert.equal(cursor.safe, 'ok');
  assert.equal(cursor.apiKey, undefined);
  assert.throws(
    () => stripSecretsDeep(nestObject(50, { apiKey: 'LEAK' })),
    (err) => err.status === 400 && err.code === 'INVALID_SOLUTION_BUNDLE',
  );

  // Expanded XSS & control-character/whitespace normalized schemes blocked
  for (const xssPayload of [
    '<object data="https://evil.test/x.swf">',
    '<embed src="https://evil.test/x">',
    '<svg onload=alert(1)>',
    '<details open ontoggle=alert(1)>',
    '<div onmouseenter=alert(1)>',
    '<div onpointerenter=alert(1)>',
    '<input onfocusin=alert(1)>',
    '<div onauxclick=alert(1)>',
    '<div ondblclick=alert(1)>',
    '<input oninput=alert(1)>',
    '<select onchange=alert(1)>',
    'java\tscript:alert(1)',
    'vb\u0000script:msgbox(1)',
    'data : text/html,<script>alert(1)</script>',
  ]) {
    const b = structuredClone(base);
    b.routesAndBlocks.flowModels[0].props = { title: xssPayload };
    assert.equal(validateSolutionBundle(b).valid, false, `Expected XSS rejection for ${JSON.stringify(xssPayload)}`);
  }
});

test('Fix Round 1 (I3 & M1): isolates same route key across two portals, preserves title-only routes, and hardens governance validation', async () => {
  const { exportSolutionBundle, validateSolutionBundle, importSolutionBundle, sortRoutesTopologically } = require(
    path.join(PLUGIN_ROOT, 'src/server/solution-bundle.js'),
  );
  const { db, desktopRoutes } = makeV3Harness();
  const base = await exportSolutionBundle(db, { organizationId: 'org-a' });

  // sortRoutesTopologically & applyRoutesAndBlocksSection preserve two portals sharing key="overview" plus title-only route
  const multiPortalRoutes = [
    { key: 'overview_child', layoutUid: 'ldx-portal-alpha', type: 'page', title: 'Alpha Child', parentKey: 'overview' },
    { key: 'overview', layoutUid: 'ldx-portal-alpha', type: 'group', title: 'Alpha Overview' },
    { key: 'overview_child', layoutUid: 'ldx-portal-beta', type: 'page', title: 'Beta Child', parentKey: 'overview' },
    { key: 'overview', layoutUid: 'ldx-portal-beta', type: 'group', title: 'Beta Overview' },
    { layoutUid: 'ldx-portal-alpha', type: 'page', title: 'Title Only Alpha Route' },
  ];
  const sorted = sortRoutesTopologically(multiPortalRoutes);
  assert.equal(sorted.length, 5);
  assert.ok(sorted.findIndex((r) => r.layoutUid === 'ldx-portal-alpha' && r.key === 'overview') < sorted.findIndex((r) => r.layoutUid === 'ldx-portal-alpha' && r.key === 'overview_child'));
  assert.ok(sorted.findIndex((r) => r.layoutUid === 'ldx-portal-beta' && r.key === 'overview') < sorted.findIndex((r) => r.layoutUid === 'ldx-portal-beta' && r.key === 'overview_child'));
  assert.equal(sorted.some((r) => r.title === 'Title Only Alpha Route'), true);

  const multiBundle = structuredClone(base);
  multiBundle.routesAndBlocks.routes.push(...multiPortalRoutes);
  const res = await importSolutionBundle(db, multiBundle, { dryRun: false, organizationId: 'org-a' });
  assert.equal(res.dryRun, false);

  const alphaOv = desktopRoutes.find((r) => r.uiLayoutUid === 'ldx-portal-alpha' && r.title === 'Alpha Overview');
  const alphaChild = desktopRoutes.find((r) => r.uiLayoutUid === 'ldx-portal-alpha' && r.title === 'Alpha Child');
  const betaOv = desktopRoutes.find((r) => r.uiLayoutUid === 'ldx-portal-beta' && r.title === 'Beta Overview');
  const betaChild = desktopRoutes.find((r) => r.uiLayoutUid === 'ldx-portal-beta' && r.title === 'Beta Child');
  const titleOnly = desktopRoutes.find((r) => r.uiLayoutUid === 'ldx-portal-alpha' && r.title === 'Title Only Alpha Route');
  assert.ok(alphaOv && alphaChild && betaOv && betaChild && titleOnly);
  assert.equal(alphaChild.parentId, alphaOv.id);
  assert.equal(betaChild.parentId, betaOv.id);
  assert.notEqual(alphaOv.id, betaOv.id);

  // Re-importing is idempotent (no duplicate title-only or overview routes)
  const countBefore = desktopRoutes.length;
  await importSolutionBundle(db, multiBundle, { dryRun: false, organizationId: 'org-a' });
  assert.equal(desktopRoutes.length, countBefore);

  // M1: Governance validation rejects organizationId='all', omitted org on global bundle, invalid version/severity/bounds
  const badOrgAll = structuredClone(base);
  badOrgAll.governance.decisionTables[0].organizationId = 'all';
  assert.equal(validateSolutionBundle(badOrgAll).valid, false);

  const badGlobalOmittedOrg = structuredClone(base);
  badGlobalOmittedOrg.metadata.organizationId = 'all';
  delete badGlobalOmittedOrg.governance.slaPolicies[0].organizationId;
  assert.equal(validateSolutionBundle(badGlobalOmittedOrg).valid, false);

  const badNoMetaOmittedOrg = structuredClone(base);
  delete badNoMetaOmittedOrg.metadata.organizationId;
  delete badNoMetaOmittedOrg.governance.incidentRules[0].organizationId;
  assert.equal(validateSolutionBundle(badNoMetaOmittedOrg).valid, false);

  for (const badVer of [0, -5, 1.5, 'abc', null]) {
    const b = structuredClone(base);
    b.governance.decisionTables[0].version = badVer;
    assert.equal(validateSolutionBundle(b).valid, false, `Expected DMN version ${String(badVer)} rejection`);
  }
  for (const badSev of ['urgent', 'info', '', 123]) {
    const b = structuredClone(base);
    b.governance.incidentRules[0].severity = badSev;
    assert.equal(validateSolutionBundle(b).valid, false, `Expected severity ${String(badSev)} rejection`);
  }
  for (const badAge of [0, -10, 'abc', '999999999']) {
    const b = structuredClone(base);
    b.governance.incidentRules[0].maxObservationAgeSeconds = badAge;
    assert.equal(validateSolutionBundle(b).valid, false, `Expected maxObservationAgeSeconds ${String(badAge)} rejection`);
  }
  for (const badCd of [-1, 'abc', '999999999']) {
    const b = structuredClone(base);
    b.governance.incidentRules[0].cooldownSeconds = badCd;
    assert.equal(validateSolutionBundle(b).valid, false, `Expected cooldownSeconds ${String(badCd)} rejection`);
  }
  const zeroCooldownOk = structuredClone(base);
  zeroCooldownOk.governance.incidentRules[0].cooldownSeconds = '0';
  assert.equal(validateSolutionBundle(zeroCooldownOk).valid, true);
});

test('Fix Round 1 (I1): studio-resource verifies rolesUsers, prioritizes active currentRole, checks allowAll, and blocks forged X-Role: root', async () => {
  const { createDxosStudioActions, isStudioAdmin } = require(path.join(PLUGIN_ROOT, 'src/server/studio-resource.js'));
  const { db, roles, employees } = makeV3Harness();
  roles.push({ name: 'ldx_superuser', title: 'Superuser', allowAll: true, allowConfigure: false, snippets: [] });
  employees.push({ id: 13, userId: 30, organizationId: 'org-a', active: true, code: 'SUP-A', name: 'Superuser A' });

  const rolesUsers = [
    { userId: 1, roleName: 'root' },
    { userId: 1, roleName: 'ldx_employee' },
    { userId: 20, roleName: 'ldx_admin' },
    { userId: 30, roleName: 'ldx_superuser' },
  ];
  const origGetRepo = db.getRepository.bind(db);
  let ignoreInFilter = false;
  db.getRepository = (name) => {
    if (name === 'rolesUsers') {
      return {
        find: async ({ filter } = {}) => rolesUsers.filter((ru) => filter?.userId == null || Number(ru.userId) === Number(filter.userId)),
      };
    }
    if (name === 'roles' && ignoreInFilter) {
      return { find: async () => [{ name: 'root', allowAll: true, allowConfigure: true, snippets: ['pm'] }] };
    }
    return origGetRepo(name);
  };

  const actions = createDxosStudioActions(db, {});

  // 1. User 20 (holds ldx_admin, NOT root) forging X-Role: root via currentRole or header is rejected 403
  for (const forgedCtx of [
    { method: 'GET', state: { currentUser: { id: 20 }, currentRole: 'root' }, action: { params: { organizationId: 'all' } } },
    { method: 'GET', headers: { 'x-role': 'root' }, state: { currentUser: { id: 20 } }, action: { params: { organizationId: 'all' } } },
  ]) {
    await assert.rejects(
      () => actions.solutionBundleExport(forgedCtx, async () => {}),
      (err) => err.status === 403 && err.code === 'DXOS_ADMIN_REQUIRED',
    );
  }

  // 2. User 20 claiming currentRoles: ['ldx_admin', 'root'] (without currentRole) cannot bypass tenant lock as root
  await assert.rejects(
    () => actions.solutionBundleExport({
      method: 'GET',
      state: { currentUser: { id: 20 }, currentRoles: ['ldx_admin', 'root'] },
      action: { params: { organizationId: 'all' } },
    }, async () => {}),
    (err) => err.status === 403 && err.code === 'DXOS_ORG_MISMATCH',
  );

  // 3. User 1 holding BOTH root and ldx_employee with active currentRole='ldx_employee' is denied admin access
  await assert.rejects(
    () => actions.solutionBundleExport({
      method: 'GET',
      state: { currentUser: { id: 1 }, currentRole: 'ldx_employee', currentRoles: ['ldx_employee', 'root'] },
      action: { params: {} },
    }, async () => {}),
    (err) => err.status === 403 && err.code === 'DXOS_ADMIN_REQUIRED',
  );

  // 4. User 40 with 0 rolesUsers rows claiming root is denied 403
  await assert.rejects(
    () => actions.solutionBundleExport({
      method: 'GET',
      state: { currentUser: { id: 40 }, currentRole: 'root' },
      action: { params: {} },
    }, async () => {}),
    (err) => err.status === 403 && err.code === 'DXOS_ADMIN_REQUIRED',
  );

  // 5. Role with allowAll: true (without allowConfigure/pm) passes isStudioAdmin
  const superCtx = { method: 'GET', state: { currentUser: { id: 30 }, currentRole: 'ldx_superuser' }, action: { params: {} } };
  await actions.solutionBundleExport(superCtx, async () => {});
  assert.equal(superCtx.body.metadata.organizationId, 'org-a');

  // 6. Permissive rolesRepo.find ignoring $in filter cannot escalate ldx_employee user
  rolesUsers.push({ userId: 50, roleName: 'ldx_employee' });
  ignoreInFilter = true;
  assert.equal(await isStudioAdmin({ state: { currentUser: { id: 50 }, currentRole: 'ldx_employee' } }, db), false);
});

test('Whole-delta security: solution-bundle blocks SSRF webhook targetUrls and unsafe automationRules actions in validate & apply', async () => {
  const { exportSolutionBundle, validateSolutionBundle, importSolutionBundle, applyGovernanceSection } = require(
    path.join(PLUGIN_ROOT, 'src/server/solution-bundle.js'),
  );
  const { db } = makeV3Harness();
  const base = await exportSolutionBundle(db, { organizationId: 'org-a' });

  // Valid external HTTPS + internal compose allowlisted n8n HTTP pass validation
  const okBundle = structuredClone(base);
  okBundle.governance.webhookSubscriptions.push(
    { organizationId: 'org-a', subscriptionKey: 'ext_https', name: 'ERP', targetUrl: 'https://erp.example.com/hook', eventPattern: '*', active: true },
    { organizationId: 'org-a', subscriptionKey: 'n8n_local', name: 'n8n', targetUrl: 'http://n8n:5678/webhook', eventPattern: '*', active: true },
  );
  assert.equal(validateSolutionBundle(okBundle).valid, true);

  // SSRF targetUrls rejected in validateSolutionBundle, importSolutionBundle, and direct applyGovernanceSection
  for (const badUrl of [
    'http://public.example.com/hook',
    'http://169.254.169.254/latest/meta-data',
    'https://10.0.0.1/hook',
    'https://internal-redis/hook',
  ]) {
    const ssrfBundle = structuredClone(base);
    ssrfBundle.governance.webhookSubscriptions.push({
      organizationId: 'org-a',
      subscriptionKey: 'bad_hook',
      name: 'Bad',
      targetUrl: badUrl,
      eventPattern: '*',
      active: true,
    });
    assert.equal(validateSolutionBundle(ssrfBundle).valid, false, `Expected SSRF rejection for ${badUrl}`);
    await assert.rejects(
      () => importSolutionBundle(db, ssrfBundle, { dryRun: false, organizationId: 'org-a' }),
      (err) => err.status === 400 && err.code === 'INVALID_SOLUTION_BUNDLE',
    );
    await assert.rejects(
      () => applyGovernanceSection(db, ssrfBundle.governance, 'org-a', {}),
      (err) => err.status === 400 && err.code === 'INVALID_SOLUTION_BUNDLE',
    );
  }

  // Unsafe automationRules actions & templates rejected in validateSolutionBundle & importSolutionBundle
  for (const [label, badActions] of [
    ['create_record users', [{ type: 'create_record', collection: 'users', values: { username: 'pwn' } }]],
    ['create_record latticePkiKeys', [{ type: 'create_record', collection: 'latticePkiKeys', values: { keyId: 'forged' } }]],
    ['update_record users', [{ type: 'update_record', collection: 'users', filter: { id: 1 }, values: { role: 'root' } }]],
    ['unknown action', [{ type: 'eval_js', code: 'process.exit(1)' }]],
    ['unsafe template', [{ type: 'notify_role', role: 'ldx_manager', title: '{{1+1}}' }]],
    ['call_connector origin override', [{ type: 'call_connector', connectorKey: 'erp', url: 'https://evil.com/steal' }]],
  ]) {
    const badAuto = structuredClone(base);
    badAuto.governance.automationRules.push({
      organizationId: 'org-a',
      ruleKey: 'unsafe_rule',
      name: 'Unsafe Rule',
      triggerEventType: '*',
      actionsJson: badActions,
      maxDepth: 8,
      cooldownSec: 0,
      active: true,
    });
    assert.equal(validateSolutionBundle(badAuto).valid, false, `Expected automation validation rejection for ${label}`);
    await assert.rejects(
      () => importSolutionBundle(db, badAuto, { dryRun: false, organizationId: 'org-a' }),
      (err) => err.status === 400 && err.code === 'INVALID_SOLUTION_BUNDLE',
    );
  }
});
