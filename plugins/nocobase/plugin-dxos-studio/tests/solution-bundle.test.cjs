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

function makeSolutionBundleDbHarness() {
  let seq = 100;
  const roles = [
    { name: 'root', title: 'Root', allowAll: true },
    { name: 'ldx_employee', title: 'Nhân viên', allowAll: false, snippets: ['lattice.integrations.propose'], allowConfigure: false },
    { name: 'ldx_manager', title: 'Quản lý', allowAll: false, snippets: [], allowConfigure: false },
  ];
  const roleResources = [
    { roleName: 'ldx_employee', name: 'latticeRequests', dataSourceKey: 'main', usingActionsConfig: true, actions: [{ name: 'view' }] },
  ];
  const portals = [
    { id: 1, uid: 'ldx-portal-work', name: 'Cổng Công việc', title: 'Công việc' },
    { id: 2, uid: 'custom-non-ldx', name: 'Ignored', title: 'Ignored' },
  ];
  const workflows = [
    { id: 11, key: 'wf-logistics', title: 'Logistics 5 bước', current: true, enabled: true, options: { dxosOrganizationId: 'org-a' }, config: { apiKey: 'SECRET-SHOULD-STRIP' } },
  ];
  const flowNodes = [
    { id: 51, workflowId: 11, key: 'n1', type: 'condition', config: { bearerToken: 'TOK-123' } },
  ];
  const aiProfiles = [
    { id: 7, username: 'dxos-ops', nickname: 'Trợ lý Ops', organizationId: 'org-a', enabled: true, apiKey: 'sk-leak-999' },
  ];
  const customCollections = [
    { name: 'latticeCustomMaintenance', title: 'Bảo trì', fields: [{ name: 'code', type: 'string' }] },
    { name: 'users', title: 'Users' },
  ];
  const uiSnapshots = [];
  const colSyncCalls = [];

  const attachNodeUpdate = (row) => {
    Object.defineProperty(row, 'update', {
      value: async (patch) => Object.assign(row, patch),
      enumerable: false,
      configurable: true,
    });
    return row;
  };
  const cloneStore = () => ({
    roles: structuredClone(roles),
    roleResources: structuredClone(roleResources),
    portals: structuredClone(portals),
    workflows: structuredClone(workflows),
    flowNodes: flowNodes.map(({ update: _u, ...rest }) => structuredClone(rest)),
    aiProfiles: structuredClone(aiProfiles),
    customCollections: structuredClone(customCollections),
    uiSnapshots: structuredClone(uiSnapshots),
  });
  const restoreStore = (snap) => {
    roles.splice(0, roles.length, ...snap.roles);
    roleResources.splice(0, roleResources.length, ...snap.roleResources);
    portals.splice(0, portals.length, ...snap.portals);
    workflows.splice(0, workflows.length, ...snap.workflows);
    flowNodes.splice(0, flowNodes.length, ...snap.flowNodes.map(attachNodeUpdate));
    aiProfiles.splice(0, aiProfiles.length, ...snap.aiProfiles);
    customCollections.splice(0, customCollections.length, ...snap.customCollections);
    uiSnapshots.splice(0, uiSnapshots.length, ...snap.uiSnapshots);
  };

  let failOnRepo = null;
  const matchFilter = (row, filter = {}) => Object.entries(filter).every(([k, v]) => {
    if (k.startsWith('options.')) {
      const optKey = k.slice('options.'.length);
      return row.options?.[optKey] === v;
    }
    return row[k] === v;
  });

  const db = {
    sequelize: {
      transaction: async (fn) => {
        const checkpoint = cloneStore();
        try {
          return await fn({ id: `tx-${++seq}` });
        } catch (err) {
          restoreStore(checkpoint);
          throw err;
        }
      },
    },
    getCollection(name) {
      const col = customCollections.find((c) => c.name === name);
      if (!col) return null;
      return {
        name: col.name,
        sync: async (opts) => {
          colSyncCalls.push({ name: col.name, opts });
        },
      };
    },
    getRepository(name) {
      if (failOnRepo && failOnRepo.target === name) {
        return {
          find: async () => [],
          findOne: async () => null,
          create: async () => { throw new Error(failOnRepo.message || `Simulated DB error on ${name}`); },
          update: async () => { throw new Error(failOnRepo.message || `Simulated DB error on ${name}`); },
        };
      }
      if (name === 'roles') {
        return {
          find: async ({ filter } = {}) => {
            if (filter?.name) return roles.filter((r) => r.name === filter.name);
            return [...roles];
          },
          findOne: async ({ filter }) => roles.find((r) => r.name === filter?.name) || null,
          create: async ({ values }) => {
            const row = { ...values };
            roles.push(row);
            return row;
          },
          update: async ({ filter, values }) => {
            const r = roles.find((x) => x.name === filter?.name);
            if (r) Object.assign(r, values);
            return r ? [r] : [];
          },
        };
      }
      if (name === 'dataSourcesRolesResources') {
        return {
          find: async ({ filter } = {}) => roleResources.filter((r) => matchFilter(r, filter)),
          findOne: async ({ filter } = {}) => roleResources.find((r) => matchFilter(r, filter)) || null,
          create: async ({ values }) => {
            const row = { id: ++seq, ...values };
            roleResources.push(row);
            return row;
          },
          update: async ({ filter, values }) => {
            const row = roleResources.find((r) => matchFilter(r, filter));
            if (row) Object.assign(row, values);
            return row ? [row] : [];
          },
          destroy: async ({ filter } = {}) => {
            for (let i = roleResources.length - 1; i >= 0; i -= 1) {
              if (matchFilter(roleResources[i], filter)) roleResources.splice(i, 1);
            }
          },
        };
      }
      if (name === 'uiLayouts') {
        return {
          find: async ({ filter } = {}) => portals.filter((p) => matchFilter(p, filter)),
          findOne: async ({ filter } = {}) => portals.find((p) => matchFilter(p, filter)) || null,
          create: async ({ values }) => {
            const row = { id: ++seq, ...values };
            portals.push(row);
            return row;
          },
          update: async ({ filter, values }) => {
            const p = portals.find((x) => matchFilter(x, filter));
            if (p) Object.assign(p, values);
            return p ? [p] : [];
          },
        };
      }
      if (name === 'workflows') {
        return {
          find: async ({ filter } = {}) => workflows.filter((w) => w.current !== false && matchFilter(w, filter)),
          findOne: async ({ filter } = {}) => workflows.find((w) => matchFilter(w, filter)) || null,
          create: async ({ values }) => {
            const row = { id: ++seq, current: true, ...values };
            workflows.push(row);
            return row;
          },
          update: async ({ filterByTk, filter, values }) => {
            const w = workflows.find((x) => (filterByTk != null ? Number(x.id) === Number(filterByTk) : matchFilter(x, filter)));
            if (w) Object.assign(w, values);
            return w ? [w] : [];
          },
        };
      }
      if (name === 'flow_nodes') {
        return {
          find: async ({ filter } = {}) => flowNodes.filter((n) => matchFilter(n, filter)),
          findOne: async ({ filter } = {}) => flowNodes.find((n) => matchFilter(n, filter)) || null,
          create: async ({ values }) => {
            const row = attachNodeUpdate({ id: ++seq, ...values });
            flowNodes.push(row);
            return row;
          },
          update: async ({ filterByTk, filter, values }) => {
            const n = flowNodes.find((x) => (filterByTk != null ? Number(x.id) === Number(filterByTk) : matchFilter(x, filter)));
            if (n) Object.assign(n, values);
            return n ? [n] : [];
          },
          destroy: async ({ filter } = {}) => {
            for (let i = flowNodes.length - 1; i >= 0; i -= 1) {
              if (matchFilter(flowNodes[i], filter)) flowNodes.splice(i, 1);
            }
          },
        };
      }
      if (name === 'latticeAiProfiles') {
        return {
          find: async ({ filter } = {}) => aiProfiles.filter((p) => !filter?.organizationId || p.organizationId === filter.organizationId),
          findOne: async ({ filter }) => aiProfiles.find((p) => p.username === filter?.username && (!filter?.organizationId || p.organizationId === filter.organizationId)) || null,
          create: async ({ values }) => {
            const row = { id: ++seq, ...values };
            aiProfiles.push(row);
            return row;
          },
          update: async ({ filterByTk, values }) => {
            const p = aiProfiles.find((x) => Number(x.id) === Number(filterByTk));
            if (p) Object.assign(p, values);
            return p ? [p] : [];
          },
        };
      }
      if (name === 'collections') {
        return {
          find: async ({ filter } = {}) => customCollections.filter((c) => matchFilter(c, filter)),
          findOne: async ({ filter } = {}) => customCollections.find((c) => matchFilter(c, filter)) || null,
          create: async ({ values }) => {
            const row = { ...values };
            customCollections.push(row);
            return row;
          },
          update: async ({ filter, values }) => {
            const c = customCollections.find((x) => matchFilter(x, filter));
            if (c) Object.assign(c, values);
            return c ? [c] : [];
          },
        };
      }
      if (name === 'latticeUiSnapshots') {
        return {
          find: async ({ filter } = {}) => uiSnapshots.filter((s) => matchFilter(s, filter)),
          findOne: async ({ filter } = {}) => uiSnapshots.find((s) => matchFilter(s, filter)) || null,
          create: async ({ values }) => {
            const row = { id: ++seq, createdAt: new Date().toISOString(), ...values };
            uiSnapshots.push(row);
            return row;
          },
        };
      }
      return null;
    },
    setFailOnRepo(target, message) {
      failOnRepo = target ? { target, message } : null;
    },
  };
  return {
    db,
    roles,
    roleResources,
    portals,
    workflows,
    flowNodes,
    aiProfiles,
    customCollections,
    uiSnapshots,
    colSyncCalls,
  };
}

test('exportSolutionBundle exports deterministically, omits root, and strips all nested secrets', async () => {
  const { exportSolutionBundle, BUNDLE_SCHEMA_VERSION } = require(path.join(PLUGIN_ROOT, 'src/server/solution-bundle.js'));
  const { db } = makeSolutionBundleDbHarness();
  const bundle = await exportSolutionBundle(db, { organizationId: 'org-a', platformVersion: '0.2.0' });

  assert.equal(bundle.metadata.schemaVersion, BUNDLE_SCHEMA_VERSION);
  assert.equal(bundle.metadata.platformVersion, '0.2.0');
  assert.match(bundle.metadata.contentSha256, /^[a-f0-9]{64}$/);
  assert.equal(bundle.roles.some((r) => r.name === 'root'), false);
  assert.equal(bundle.roles.length, 2);
  assert.deepEqual(bundle.portals.map((p) => p.uid), ['ldx-portal-work']);
  assert.deepEqual(bundle.customCollections.map((c) => c.name), ['latticeCustomMaintenance']);

  const serialized = JSON.stringify(bundle);
  assert.equal(serialized.includes('SECRET-SHOULD-STRIP'), false);
  assert.equal(serialized.includes('TOK-123'), false);
  assert.equal(serialized.includes('sk-leak-999'), false);
});

test('validateSolutionBundle rejects privileged roles and invalid schema/collections; diff and dry-run import protect DB', async () => {
  const {
    exportSolutionBundle,
    validateSolutionBundle,
    diffSolutionBundle,
    importSolutionBundle,
  } = require(path.join(PLUGIN_ROOT, 'src/server/solution-bundle.js'));
  const { db, roles, aiProfiles } = makeSolutionBundleDbHarness();
  const current = await exportSolutionBundle(db, { organizationId: 'org-a', platformVersion: '0.2.0' });

  // Reject escalation roles
  for (const badRole of ['root', 'admin', 'ldx_admin']) {
    const tampered = structuredClone(current);
    tampered.roles.push({ name: badRole, title: 'Hack' });
    const v = validateSolutionBundle(tampered);
    assert.equal(v.valid, false);
    await assert.rejects(
      () => importSolutionBundle(db, tampered, { dryRun: false, organizationId: 'org-a' }),
      (err) => err.status === 400 && err.code === 'INVALID_SOLUTION_BUNDLE',
    );
  }

  // Modified incoming bundle adds 1 role and 1 AI profile
  const incoming = structuredClone(current);
  incoming.roles.push({ name: 'ldx_cold_lead', title: 'Trưởng ca lạnh', snippets: ['lattice.integrations.propose'] });
  incoming.aiProfiles.push({ username: 'dxos-cold-agent', nickname: 'Agent Kho Lạnh', organizationId: 'foreign-org', enabled: true });

  const diff = diffSolutionBundle(current, incoming);
  assert.equal(diff.summary.added, 2);
  assert.equal(diff.sections.roles.added.length, 1);

  // Dry-run makes ZERO DB mutations
  const dryRes = await importSolutionBundle(db, incoming, { dryRun: true, organizationId: 'org-a' });
  assert.equal(dryRes.dryRun, true);
  assert.equal(dryRes.applied, null);
  assert.equal(roles.some((r) => r.name === 'ldx_cold_lead'), false);
  assert.equal(aiProfiles.some((p) => p.username === 'dxos-cold-agent'), false);

  // Apply (dryRun: false) idempotently upserts scoped to caller org without escalation
  const applyRes = await importSolutionBundle(db, incoming, { dryRun: false, organizationId: 'org-a' });
  assert.equal(applyRes.dryRun, false);
  assert.equal(applyRes.applied.rolesUpserted, 3);
  assert.equal(applyRes.applied.aiProfilesUpserted, 2);
  const newRole = roles.find((r) => r.name === 'ldx_cold_lead');
  assert.ok(newRole);
  assert.equal(newRole.allowAll, false);
  assert.equal(newRole.allowConfigure, false);
  const newAi = aiProfiles.find((p) => p.username === 'dxos-cold-agent');
  assert.equal(newAi.organizationId, 'org-a');
});

test('dxosStudio solutionBundle actions enforce admin gate and default import to dryRun=true', async () => {
  const { createDxosStudioActions } = require(path.join(PLUGIN_ROOT, 'src/server/studio-resource.js'));
  const { db } = makeSolutionBundleDbHarness();
  const actions = createDxosStudioActions(db, {});

  // Employee blocked 403
  await assert.rejects(
    () => actions.solutionBundleExport({
      method: 'GET',
      state: { currentUser: { id: 2 }, currentRole: 'ldx_employee', currentRoles: ['ldx_employee'] },
      action: { params: {} },
    }, async () => {}),
    (err) => err.status === 403,
  );

  // Root export + diff + import dryRun
  const expCtx = { method: 'GET', state: { currentUser: { id: 1 }, currentRole: 'root' }, action: { params: { organizationId: 'org-a' } } };
  await actions.solutionBundleExport(expCtx, async () => {});
  assert.equal(expCtx.body.metadata.organizationId, 'org-a');

  const diffCtx = { method: 'POST', state: { currentUser: { id: 1 }, currentRole: 'root' }, action: { params: { values: { bundle: expCtx.body } } } };
  await actions.solutionBundleDiff(diffCtx, async () => {});
  assert.equal(diffCtx.body.summary.added, 0);

  const impCtx = { method: 'POST', state: { currentUser: { id: 1 }, currentRole: 'root' }, action: { params: { values: { bundle: expCtx.body } } } };
  await actions.solutionBundleImport(impCtx, async () => {});
  assert.equal(impCtx.body.dryRun, true);
});

test('v2 schema export + backward-compatible v1/v2 validation + privilege escalation, portal UID & customCollection rejection', async () => {
  const {
    BUNDLE_SCHEMA_VERSION,
    ACCEPTED_SCHEMA_VERSIONS,
    exportSolutionBundle,
    validateSolutionBundle,
  } = require(path.join(PLUGIN_ROOT, 'src/server/solution-bundle.js'));

  assert.equal(BUNDLE_SCHEMA_VERSION, 'latticedx.solution-bundle/v3');
  assert.ok(ACCEPTED_SCHEMA_VERSIONS instanceof Set);
  assert.equal(ACCEPTED_SCHEMA_VERSIONS.has('latticedx.solution-bundle/v1'), true);
  assert.equal(ACCEPTED_SCHEMA_VERSIONS.has('latticedx.solution-bundle/v2'), true);
  assert.equal(ACCEPTED_SCHEMA_VERSIONS.has('latticedx.solution-bundle/v3'), true);

  const { db } = makeSolutionBundleDbHarness();
  const v3Bundle = await exportSolutionBundle(db, { organizationId: 'org-a', platformVersion: '1.0.0' });
  assert.equal(v3Bundle.metadata.schemaVersion, 'latticedx.solution-bundle/v3');
  assert.equal(v3Bundle.metadata.platformVersion, '1.0.0');
  assert.equal(validateSolutionBundle(v3Bundle).valid, true);

  // Accepts v1 and v2 bundles cleanly
  const v2Bundle = structuredClone(v3Bundle);
  v2Bundle.metadata.schemaVersion = 'latticedx.solution-bundle/v2';
  delete v2Bundle.routesAndBlocks;
  delete v2Bundle.governance;
  assert.equal(validateSolutionBundle(v2Bundle).valid, true);

  const v1Bundle = structuredClone(v2Bundle);
  v1Bundle.metadata.schemaVersion = 'latticedx.solution-bundle/v1';
  assert.equal(validateSolutionBundle(v1Bundle).valid, true);

  // Rejects unknown schema version
  const badSchema = structuredClone(v2Bundle);
  badSchema.metadata.schemaVersion = 'latticedx.solution-bundle/v99';
  assert.equal(validateSolutionBundle(badSchema).valid, false);

  // Rejects allowAll / allowConfigure / pm.* snippets / system table grants / wildcard actions
  const allowAllBundle = structuredClone(v2Bundle);
  allowAllBundle.roles[0].allowAll = true;
  assert.equal(validateSolutionBundle(allowAllBundle).valid, false);

  const allowCfgBundle = structuredClone(v2Bundle);
  allowCfgBundle.roles[0].allowConfigure = true;
  assert.equal(validateSolutionBundle(allowCfgBundle).valid, false);

  for (const badSnip of ['pm', 'pm.*', 'pm.dxosStudio']) {
    const pmBundle = structuredClone(v2Bundle);
    pmBundle.roles[0].snippets = ['lattice.integrations.propose', badSnip];
    assert.equal(validateSolutionBundle(pmBundle).valid, false, `Expected ${badSnip} snippet rejection`);
  }

  const sysResourceBundle = structuredClone(v2Bundle);
  sysResourceBundle.roles[0].resources.push({ name: 'users', dataSourceKey: 'main', usingActionsConfig: true, actions: [{ name: 'update' }] });
  assert.equal(validateSolutionBundle(sysResourceBundle).valid, false);

  const wildcardActionBundle = structuredClone(v2Bundle);
  wildcardActionBundle.roles[0].resources[0].actions.push({ name: '*' });
  assert.equal(validateSolutionBundle(wildcardActionBundle).valid, false);

  // Rejects invalid portal UIDs
  for (const badUid of ['admin-layout-model', 'custom-portal', 'ldx-portal-BAD_UPPER']) {
    const badPortal = structuredClone(v2Bundle);
    badPortal.portals.push({ uid: badUid, title: 'Bad Portal' });
    assert.equal(validateSolutionBundle(badPortal).valid, false, `Expected portal UID ${badUid} rejection`);
  }

  // Rejects invalid customCollections & invalid field names
  for (const badCol of ['users', 'latticeOrders', 'latticeCustombad']) {
    const badCustom = structuredClone(v2Bundle);
    badCustom.customCollections.push({ name: badCol, title: 'Bad Collection' });
    assert.equal(validateSolutionBundle(badCustom).valid, false, `Expected customCollection ${badCol} rejection`);
  }
  const badFieldCol = structuredClone(v2Bundle);
  badFieldCol.customCollections.push({ name: 'latticeCustomValid', fields: [{ name: '1bad_col', type: 'string' }] });
  assert.equal(validateSolutionBundle(badFieldCol).valid, false);
});

test('importSolutionBundle applies all 5 sections atomically, persists snapshot, guards enableWorkflows=false, strips non-admin AI tools, and supports rollbackLastSolutionBundle', async () => {
  const {
    exportSolutionBundle,
    importSolutionBundle,
    rollbackLastSolutionBundle,
  } = require(path.join(PLUGIN_ROOT, 'src/server/solution-bundle.js'));

  const harness = makeSolutionBundleDbHarness();
  const {
    db, roles, roleResources, portals, workflows, flowNodes, aiProfiles, customCollections, uiSnapshots, colSyncCalls,
  } = harness;
  const baseline = await exportSolutionBundle(db, { organizationId: 'org-a', platformVersion: '0.3.0' });

  const incoming = structuredClone(baseline);
  // 1. Roles + dataSourcesRolesResources (replace existing + add new role & resources)
  const empRole = incoming.roles.find((r) => r.name === 'ldx_employee');
  empRole.title = 'Nhân viên v2';
  empRole.resources = [
    { name: 'latticeRequests', dataSourceKey: 'main', usingActionsConfig: true, actions: [{ name: 'view' }, { name: 'create' }] },
    { name: 'latticeCustomColdAudit', dataSourceKey: 'main', usingActionsConfig: true, actions: [{ name: 'view' }] },
  ];
  incoming.roles.push({
    name: 'ldx_auditor',
    title: 'Kiểm toán viên',
    snippets: ['lattice.integrations.propose'],
    resources: [{ name: 'latticeCustomColdAudit', dataSourceKey: 'main', usingActionsConfig: true, actions: [{ name: 'view' }] }],
  });

  // 2. Portals (update existing + add new portal, attempt authCheck=true preservation)
  incoming.portals[0].title = 'Công việc v2';
  incoming.portals.push({
    uid: 'ldx-portal-cold-qa',
    title: 'Kiểm định Kho lạnh',
    layoutType: 'desktop',
    routeName: 'p_cold_qa',
    routePath: '/p/cold-qa',
    enabled: true,
    options: { badge: 'QA' },
  });

  // 3. Workflows + flow_nodes (update existing enabled=true workflow -> must default to enabled=false when enableWorkflows!==true; replace nodes with upstreamKey/branchIndex)
  incoming.workflows[0].title = 'Logistics 5 bước v2';
  incoming.workflows[0].enabled = true;
  incoming.workflows[0].options = { dxosOrganizationId: 'foreign-org', dxosTemplateKey: 'logistics-5step' };
  incoming.workflows[0].nodes = [
    { key: 'n1', type: 'condition', title: 'Check threshold', config: { min: -15 } },
    { key: 'n2', type: 'manual', title: 'QA signoff', upstreamKey: 'n1', config: { mode: 0 } },
    { key: 'n_reject', type: 'end', title: 'Reject end', upstreamKey: 'n1', branchIndex: 0, config: { endStatus: 1 } },
  ];
  incoming.workflows.push({
    key: 'wf-cold-alert',
    title: 'Cảnh báo nhiệt độ',
    type: 'collection',
    enabled: true,
    config: { collection: 'latticeCustomColdAudit', mode: 1 },
    nodes: [{ key: 'step1', type: 'create', title: 'Log event', config: {} }],
  });

  // 4. Custom Collections (without explicit organizationId field -> must preserve/inject mandatory organizationId & sync)
  incoming.customCollections.push({
    name: 'latticeCustomColdAudit',
    title: 'Biên bản Kiểm định Lạnh',
    fields: [{ name: 'tempC', type: 'float', title: 'Nhiệt độ' }],
  });

  // 5. AI Profiles (non-admin profile with smuggled admin tool -> stripped; admin builder profile -> kept & locked)
  incoming.aiProfiles.push({
    username: 'dxos-qa-assistant',
    nickname: 'Trợ lý QA',
    organizationId: 'foreign-org',
    enabled: true,
    isAdminBuilder: false,
    tools: ['dxos_search_enterprise_context', 'dxos_manage_rbac_permissions', 'dxos_extend_collection_schema', 'get_stack_connector_health'],
    toolPermissions: {
      dxos_search_enterprise_context: 'ALLOW',
      dxos_manage_rbac_permissions: 'ALLOW',
      dxos_deploy_workflow: 'ASK',
      get_stack_connector_health: 'ALLOW',
    },
  });
  incoming.aiProfiles.push({
    username: 'dxos-org-architect',
    nickname: 'Kiến trúc sư Tổ chức',
    organizationId: 'foreign-org',
    enabled: true,
    isAdminBuilder: true,
    allowedRoles: ['ldx_employee'],
    tools: ['dxos_manage_rbac_permissions', 'dxos_search_enterprise_context'],
    toolPermissions: { dxos_manage_rbac_permissions: 'ALLOW' },
  });

  // Apply with default enableWorkflows=false
  const res = await importSolutionBundle(db, incoming, { dryRun: false, organizationId: 'org-a' });
  assert.equal(res.dryRun, false);
  assert.equal(res.valid, true);
  assert.match(res.snapshotUid, /^gitops-[a-z0-9]+-[a-f0-9]{4}$/);
  assert.equal(res.applied.rolesUpserted, 3);
  assert.equal(res.applied.roleResourcesUpserted, 3);
  assert.equal(res.applied.portalsUpserted, 2);
  assert.equal(res.applied.workflowsUpserted, 2);
  assert.equal(res.applied.nodesUpserted, 4);
  assert.equal(res.applied.customCollectionsUpserted, 2);
  assert.equal(res.applied.aiProfilesUpserted, 3);

  // Verify snapshot persisted before apply
  assert.equal(uiSnapshots.length, 1);
  assert.equal(uiSnapshots[0].portalSlug, '__gitops_bundle__');
  assert.equal(uiSnapshots[0].snapshotUid, res.snapshotUid);
  assert.equal(uiSnapshots[0].layoutState.roles.find((r) => r.name === 'ldx_employee').title, 'Nhân viên');

  // Verify role resources & portal properties
  assert.equal(roleResources.filter((r) => r.roleName === 'ldx_employee').length, 2);
  const qaPortal = portals.find((p) => p.uid === 'ldx-portal-cold-qa');
  assert.ok(qaPortal);
  assert.equal(qaPortal.authCheck, true);
  assert.equal(qaPortal.routePath, '/p/cold-qa');

  // Verify workflows scoped to org-a and disabled by default (enableWorkflows=false)
  const wf1 = workflows.find((w) => w.key === 'wf-logistics');
  assert.equal(wf1.enabled, false);
  assert.equal(wf1.options.dxosOrganizationId, 'org-a');
  const wf1Nodes = flowNodes.filter((n) => n.workflowId === wf1.id);
  assert.equal(wf1Nodes.length, 3);
  const n1 = wf1Nodes.find((n) => n.key === 'n1');
  const n2 = wf1Nodes.find((n) => n.key === 'n2');
  const nRej = wf1Nodes.find((n) => n.key === 'n_reject');
  assert.equal(n2.upstreamId, n1.id);
  assert.equal(n1.downstreamId, n2.id);
  assert.equal(nRej.upstreamId, n1.id);
  assert.equal(nRej.branchIndex, 0);

  // Verify custom collection has mandatory organizationId field + col.sync({ force: false, alter: { drop: false } })
  const coldCol = customCollections.find((c) => c.name === 'latticeCustomColdAudit');
  assert.ok(coldCol);
  assert.ok(coldCol.fields.some((f) => f.name === 'organizationId'));
  assert.ok(colSyncCalls.some((c) => c.name === 'latticeCustomColdAudit' && c.opts?.force === false && c.opts?.alter?.drop === false));

  // Verify non-admin AI profile had admin tools stripped, while admin builder profile locked allowedRoles
  const qaAi = aiProfiles.find((p) => p.username === 'dxos-qa-assistant');
  assert.equal(qaAi.organizationId, 'org-a');
  assert.deepEqual(qaAi.tools, ['dxos_search_enterprise_context']);
  assert.deepEqual(qaAi.toolPermissions, { dxos_search_enterprise_context: 'ALLOW' });
  const archAi = aiProfiles.find((p) => p.username === 'dxos-org-architect');
  assert.equal(archAi.isAdminBuilder, true);
  assert.deepEqual(archAi.allowedRoles, ['root', 'admin']);

  // Verify enableWorkflows: true actually enables workflows requested as enabled
  const resEnable = await importSolutionBundle(db, incoming, { dryRun: false, organizationId: 'org-a', enableWorkflows: true });
  assert.equal(workflows.find((w) => w.key === 'wf-logistics').enabled, true);
  assert.equal(workflows.find((w) => w.key === 'wf-cold-alert').enabled, true);

  // Rollback explicitly back to the very first pre-import snapshot (res.snapshotUid)
  const rollbackRes = await rollbackLastSolutionBundle(db, { organizationId: 'org-a', snapshotUid: res.snapshotUid });
  assert.equal(rollbackRes.rolledBack, true);
  assert.equal(rollbackRes.snapshotUid, res.snapshotUid);
  assert.equal(roles.find((r) => r.name === 'ldx_employee').title, 'Nhân viên');
  assert.equal(roleResources.filter((r) => r.roleName === 'ldx_employee').length, 1);
  assert.equal(portals.find((p) => p.uid === 'ldx-portal-work').title, 'Công việc');
  assert.equal(workflows.find((w) => w.key === 'wf-logistics').title, 'Logistics 5 bước');
  assert.equal(workflows.find((w) => w.key === 'wf-logistics').enabled, true);
  assert.deepEqual(flowNodes.filter((n) => n.workflowId === 11).map((n) => n.key), ['n1']);

  // Also verify latest-snapshot rollback without explicit snapshotUid uses resEnable.snapshotUid
  const latestRollback = await rollbackLastSolutionBundle(db, { organizationId: 'org-a' });
  assert.equal(latestRollback.rolledBack, true);
  assert.equal(latestRollback.snapshotUid, resEnable.snapshotUid);
});

test('importSolutionBundle rolls back transaction atomically on error and studio-resource exposes solutionBundleRollback', async () => {
  const { importSolutionBundle, rollbackLastSolutionBundle } = require(path.join(PLUGIN_ROOT, 'src/server/solution-bundle.js'));
  const { createDxosStudioActions } = require(path.join(PLUGIN_ROOT, 'src/server/studio-resource.js'));

  const harness = makeSolutionBundleDbHarness();
  const { db, roles, uiSnapshots, workflows } = harness;
  const baseline = await (require(path.join(PLUGIN_ROOT, 'src/server/solution-bundle.js')).exportSolutionBundle)(db, { organizationId: 'org-a' });

  // Simulate DB error on latticeAiProfiles mid-transaction -> entire import must roll back cleanly
  const mutated = structuredClone(baseline);
  mutated.roles.find((r) => r.name === 'ldx_employee').title = 'Should Rollback';
  mutated.roles.push({ name: 'ldx_temp_fail', title: 'Should Not Persist' });
  db.setFailOnRepo('latticeAiProfiles', 'Simulated mid-apply failure');

  await assert.rejects(
    () => importSolutionBundle(db, mutated, { dryRun: false, organizationId: 'org-a' }),
    /Simulated mid-apply failure/,
  );
  db.setFailOnRepo(null);
  assert.equal(roles.find((r) => r.name === 'ldx_employee').title, 'Nhân viên');
  assert.equal(roles.some((r) => r.name === 'ldx_temp_fail'), false);
  assert.equal(uiSnapshots.length, 0);

  // Studio actions: solutionBundleImport forwards enableWorkflows & solutionBundleRollback requires admin POST
  const actions = createDxosStudioActions(db, {});
  assert.equal(typeof actions.solutionBundleRollback, 'function');

  await assert.rejects(
    () => actions.solutionBundleRollback({
      method: 'POST',
      state: {},
      action: { params: {} },
    }, async () => {}),
    (err) => err.status === 401,
  );

  await assert.rejects(
    () => actions.solutionBundleRollback({
      method: 'POST',
      state: { currentUser: { id: 2 }, currentRole: 'ldx_employee', currentRoles: ['ldx_employee'] },
      action: { params: {} },
    }, async () => {}),
    (err) => err.status === 403,
  );

  await assert.rejects(
    () => actions.solutionBundleImport({
      method: 'POST',
      state: { currentUser: { id: 1 }, currentRole: 'root' },
      action: { params: { values: { bundle: '{bad-json' } } },
    }, async () => {}),
    (err) => err.status === 400 && err.code === 'INVALID_SOLUTION_BUNDLE',
  );

  await assert.rejects(
    () => actions.solutionBundleRollback({
      method: 'GET',
      state: { currentUser: { id: 1 }, currentRole: 'root' },
      action: { params: {} },
    }, async () => {}),
    (err) => err.status === 405,
  );

  // Import with enableWorkflows: false -> workflow disabled; then rollback via HTTP action
  const applyCtx = {
    method: 'POST',
    state: { currentUser: { id: 1 }, currentRole: 'root' },
    action: { params: { values: { bundle: mutated, dryRun: false, enableWorkflows: false, organizationId: 'org-a' } } },
  };
  await actions.solutionBundleImport(applyCtx, async () => {});
  assert.equal(applyCtx.body.dryRun, false);
  assert.equal(workflows[0].enabled, false);

  const rbCtx = {
    method: 'POST',
    state: { currentUser: { id: 1 }, currentRole: 'root' },
    action: { params: { values: { organizationId: 'org-a' } } },
  };
  await actions.solutionBundleRollback(rbCtx, async () => {});
  assert.equal(rbCtx.body.rolledBack, true);
  assert.equal(roles.find((r) => r.name === 'ldx_employee').title, 'Nhân viên');
  assert.equal(workflows[0].enabled, true);

  // Rollback when no snapshot exists throws 404
  uiSnapshots.length = 0;
  await assert.rejects(
    () => rollbackLastSolutionBundle(db, { organizationId: 'org-a' }),
    (err) => err.status === 404 && err.code === 'GITOPS_SNAPSHOT_NOT_FOUND',
  );
});

test('Fix Round 1 (Critical): cross-tenant snapshot rollback isolation rejects missing/foreign/unscoped snapshots', async () => {
  const { exportSolutionBundle, rollbackLastSolutionBundle } = require(path.join(PLUGIN_ROOT, 'src/server/solution-bundle.js'));
  const { db, roles, uiSnapshots } = makeSolutionBundleDbHarness();
  const snapBundleA = await exportSolutionBundle(db, { organizationId: 'org-a' });
  snapBundleA.roles.find((r) => r.name === 'ldx_employee').title = 'Org A Restored';
  const snapBundleGlobal = await exportSolutionBundle(db, { organizationId: null });
  snapBundleGlobal.roles.find((r) => r.name === 'ldx_employee').title = 'Global Leak';

  uiSnapshots.push(
    { id: 1, snapshotUid: 'snap-org-a', portalSlug: '__gitops_bundle__', pageTitle: 'org-a', layoutState: snapBundleA },
    { id: 2, snapshotUid: 'snap-all', portalSlug: '__gitops_bundle__', pageTitle: 'all', layoutState: snapBundleGlobal },
    { id: 3, snapshotUid: 'snap-unscoped-empty', portalSlug: '__gitops_bundle__', pageTitle: '', layoutState: snapBundleGlobal },
    { id: 4, snapshotUid: 'snap-unscoped-null', portalSlug: '__gitops_bundle__', pageTitle: null, layoutState: snapBundleGlobal },
  );

  // org-b has NO snapshots -> must throw 404, never fall back to org-a, 'all', or unscoped
  await assert.rejects(
    () => rollbackLastSolutionBundle(db, { organizationId: 'org-b' }),
    (err) => err.status === 404 && err.code === 'GITOPS_SNAPSHOT_NOT_FOUND',
  );

  // org-b passing explicit snapshotUid owned by org-a or unscoped -> rejected 404/403
  for (const foreignUid of ['snap-org-a', 'snap-all', 'snap-unscoped-empty', 'snap-unscoped-null']) {
    await assert.rejects(
      () => rollbackLastSolutionBundle(db, { organizationId: 'org-b', snapshotUid: foreignUid }),
      (err) => err.status === 404 || err.status === 403,
    );
  }
  assert.equal(roles.find((r) => r.name === 'ldx_employee').title, 'Nhân viên');

  // org-a with whitespace-padded organizationId & matching snapshotUid succeeds
  const ok = await rollbackLastSolutionBundle(db, { organizationId: ' org-a ', snapshotUid: 'snap-org-a' });
  assert.equal(ok.rolledBack, true);
  assert.equal(roles.find((r) => r.name === 'ldx_employee').title, 'Org A Restored');
});

test('Fix Round 1 (Critical): wildcard snippets, expanded protected collections, and resource/strategy validation', async () => {
  const { exportSolutionBundle, validateSolutionBundle } = require(path.join(PLUGIN_ROOT, 'src/server/solution-bundle.js'));
  const { db, roles } = makeSolutionBundleDbHarness();
  roles.find((r) => r.name === 'ldx_employee').snippets = ['*', 'ui.*', 'PM.*', 'acl', 'lattice.integrations.propose'];

  const exported = await exportSolutionBundle(db, { organizationId: 'org-a' });
  const empExp = exported.roles.find((r) => r.name === 'ldx_employee');
  assert.deepEqual(empExp.snippets, ['lattice.integrations.propose']);

  // Wildcard / negation / admin snippets rejected
  for (const badSnip of ['*', '!', '!ui.*', '!pm', 'acl', 'acl.*', 'ACL.users', 'pm', 'PM.*', 'pm*', 'app', 'app.*', 'app.settings', 'ui.*', 'custom*']) {
    const b = structuredClone(exported);
    b.roles[0].snippets = ['lattice.integrations.propose', badSnip];
    assert.equal(validateSolutionBundle(b).valid, false, `Expected snippet "${badSnip}" rejection`);
  }
  const nonArrSnip = structuredClone(exported);
  nonArrSnip.roles[0].snippets = '*';
  assert.equal(validateSolutionBundle(nonArrSnip).valid, false);

  // Expanded SYSTEM_PROTECTED_COLLECTIONS + case variants rejected
  const protectedCols = [
    'llmServices', 'rolesDesktopRoutes', 'desktopRoutes', 'uiLayouts', 'workflows', 'flow_nodes',
    'collections', 'fields', 'latticeUiSnapshots', 'latticeNotifications', 'latticeSlaPolicies',
    'latticeAiApprovalQueue', 'latticeAiQuotaUsage', 'latticeParaChunks', 'Users', 'Workflows',
  ];
  for (const col of protectedCols) {
    const b = structuredClone(exported);
    b.roles[0].resources = [{ name: col, dataSourceKey: 'main', usingActionsConfig: true, actions: [{ name: 'view' }] }];
    assert.equal(validateSolutionBundle(b).valid, false, `Expected protected collection "${col}" rejection`);
  }

  // Wildcard / invalid resource names rejected
  for (const badRes of ['*', 'lattice*', 'a', '123col', 'bad-name']) {
    const b = structuredClone(exported);
    b.roles[0].resources = [{ name: badRes, dataSourceKey: 'main', usingActionsConfig: true, actions: [{ name: 'view' }] }];
    assert.equal(validateSolutionBundle(b).valid, false, `Expected resource name "${badRes}" rejection`);
  }

  // Non-array res.actions and wildcard resource/strategy actions rejected
  for (const badActions of [undefined, null, 'view', {}, [{ name: '*:view' }], [{ name: 'view:*' }], ['*']]) {
    const b = structuredClone(exported);
    b.roles[0].resources = [{ name: 'latticeRequests', dataSourceKey: 'main', usingActionsConfig: true, actions: badActions }];
    assert.equal(validateSolutionBundle(b).valid, false, `Expected actions ${JSON.stringify(badActions)} rejection`);
  }
  for (const badStrat of ['*', ['*:view'], ['view:*'], ['*:*'], ['pm']]) {
    const b = structuredClone(exported);
    b.roles[0].strategy = { actions: badStrat };
    assert.equal(validateSolutionBundle(b).valid, false, `Expected strategy.actions ${JSON.stringify(badStrat)} rejection`);
  }
});

test('Fix Round 1 (Critical): cross-tenant workflow overwrite protection, filterByTk-only updates, and scoped export', async () => {
  const { exportSolutionBundle, importSolutionBundle } = require(path.join(PLUGIN_ROOT, 'src/server/solution-bundle.js'));
  const { db, workflows } = makeSolutionBundleDbHarness();
  workflows.unshift({
    id: 10,
    key: 'wf-logistics',
    title: 'Historical v1',
    current: false,
    enabled: false,
    options: { dxosOrganizationId: 'org-a' },
  });
  workflows.push(
    { id: 12, key: 'wf-global-unscoped', title: 'Global Unscoped', current: true, enabled: true, config: {} },
    { id: 13, key: 'wf-tenant-b', title: 'Tenant B Workflow', current: true, enabled: true, options: { dxosOrganizationId: 'org-b' }, config: {} },
  );

  // Scoped export for org-a must NOT sweep unscoped or org-b workflows
  const orgABundle = await exportSolutionBundle(db, { organizationId: 'org-a' });
  assert.deepEqual(orgABundle.workflows.map((w) => w.key), ['wf-logistics']);

  // Importing a workflow key owned by org-b into org-a must reject 409/400 without mutating org-b
  const hijack = structuredClone(orgABundle);
  hijack.workflows.push({ key: 'wf-tenant-b', title: 'Hijacked into Org A', type: 'collection', enabled: false });
  await assert.rejects(
    () => importSolutionBundle(db, hijack, { dryRun: false, organizationId: 'org-a' }),
    (err) => err.status === 409 || err.status === 400,
  );
  assert.equal(workflows.find((w) => w.id === 13).options.dxosOrganizationId, 'org-b');
  assert.equal(workflows.find((w) => w.id === 13).title, 'Tenant B Workflow');

  // Updating org-a workflow updates ONLY current:true id:11 via filterByTk, leaving historical id:10 untouched
  const wfRepoOrig = db.getRepository('workflows');
  const wfUpdateCalls = [];
  const origGetRepo = db.getRepository.bind(db);
  db.getRepository = (name) => {
    if (name !== 'workflows') return origGetRepo(name);
    return {
      ...wfRepoOrig,
      update: async (opts) => {
        wfUpdateCalls.push(opts);
        return wfRepoOrig.update(opts);
      },
    };
  };
  const validUpdate = structuredClone(orgABundle);
  validUpdate.workflows[0].title = 'Logistics v2 Scoped';
  await importSolutionBundle(db, validUpdate, { dryRun: false, organizationId: 'org-a' });
  assert.equal(wfUpdateCalls.length, 1);
  assert.equal(wfUpdateCalls[0].filterByTk, 11);
  assert.equal(wfUpdateCalls[0].filter, undefined);
  assert.equal(workflows.find((w) => w.id === 10).title, 'Historical v1');
  assert.equal(workflows.find((w) => w.id === 10).current, false);
  assert.equal(workflows.find((w) => w.id === 11).title, 'Logistics v2 Scoped');
});

test('Fix Round 1 (Important): AI profile toolPermissions validation & stale admin key wipe on non-admin update', async () => {
  const { exportSolutionBundle, validateSolutionBundle, importSolutionBundle } = require(path.join(PLUGIN_ROOT, 'src/server/solution-bundle.js'));
  const { db, aiProfiles } = makeSolutionBundleDbHarness();
  aiProfiles[0].isAdminBuilder = true;
  aiProfiles[0].toolPermissions = {
    dxos_manage_rbac_permissions: 'ALLOW',
    dxos_search_enterprise_context: 'ALLOW',
  };

  const base = await exportSolutionBundle(db, { organizationId: 'org-a' });
  const badPermMode = structuredClone(base);
  badPermMode.aiProfiles[0].toolPermissions = { dxos_search_enterprise_context: 'ADMIN_BYPASS' };
  assert.equal(validateSolutionBundle(badPermMode).valid, false);

  const badPermShape = structuredClone(base);
  badPermShape.aiProfiles[0].toolPermissions = ['ALLOW'];
  assert.equal(validateSolutionBundle(badPermShape).valid, false);

  // Downgrade existing admin profile to isAdminBuilder=false with OMITTED toolPermissions -> must wipe stale admin keys to {}
  const downgrade = structuredClone(base);
  downgrade.aiProfiles[0].isAdminBuilder = false;
  downgrade.aiProfiles[0].tools = ['dxos_search_enterprise_context'];
  delete downgrade.aiProfiles[0].toolPermissions;
  await importSolutionBundle(db, downgrade, { dryRun: false, organizationId: 'org-a' });
  assert.equal(aiProfiles[0].isAdminBuilder, false);
  assert.deepEqual(aiProfiles[0].toolPermissions, {});

  // Non-admin update with mixed valid modes strips admin tools & normalizes modes
  const mixed = structuredClone(base);
  mixed.aiProfiles[0].isAdminBuilder = false;
  mixed.aiProfiles[0].toolPermissions = {
    dxos_manage_rbac_permissions: 'ALLOW',
    dxos_search_enterprise_context: 'ask',
    dxos_my_workflow_tasks: 'OFF',
  };
  await importSolutionBundle(db, mixed, { dryRun: false, organizationId: 'org-a' });
  assert.deepEqual(aiProfiles[0].toolPermissions, {
    dxos_my_workflow_tasks: 'OFF',
    dxos_search_enterprise_context: 'ASK',
  });
});

test('Fix Round 1 (Important): DDL sync/load receive transaction, organizationId field clamped, custom collection options preserved', async () => {
  const { exportSolutionBundle, importSolutionBundle } = require(path.join(PLUGIN_ROOT, 'src/server/solution-bundle.js'));
  const { db, customCollections, colSyncCalls } = makeSolutionBundleDbHarness();
  customCollections[0].options = { titleField: 'code', uiManageable: true };

  const loadCalls = [];
  const origGetRepo = db.getRepository.bind(db);
  const fieldsRows = [];
  db.getRepository = (name) => {
    if (name === 'fields') {
      return {
        create: async ({ values }) => {
          fieldsRows.push(values);
          return {
            ...values,
            load: async (opts) => loadCalls.push({ kind: 'field.load', name: values.name, opts }),
          };
        },
      };
    }
    if (name === 'collections') {
      const baseRepo = origGetRepo('collections');
      return {
        ...baseRepo,
        findOne: async (arg) => {
          const found = await baseRepo.findOne(arg);
          if (!found) return null;
          return {
            ...found,
            get: (k) => found[k],
            toJSON: () => ({ ...found }),
            load: async (opts) => loadCalls.push({ kind: 'existing.load', name: found.name, opts }),
          };
        },
        create: async (arg) => {
          const created = await baseRepo.create(arg);
          return {
            ...created,
            get: (k) => created[k],
            toJSON: () => ({ ...created }),
            load: async (opts) => loadCalls.push({ kind: 'created.load', name: created.name, opts }),
          };
        },
      };
    }
    return origGetRepo(name);
  };

  const exported = await exportSolutionBundle(db, { organizationId: 'org-a' });
  assert.deepEqual(exported.customCollections[0].options, { titleField: 'code', uiManageable: true });

  const incoming = structuredClone(exported);
  incoming.customCollections.push({
    name: 'latticeCustomSensorLog',
    title: 'Nhật ký Cảm biến',
    options: { titleField: 'sensorCode', uiManageable: true },
    fields: [
      { name: 'organizationId', type: 'integer', allowNull: true },
      { name: 'sensorCode', type: 'string' },
    ],
  });

  await importSolutionBundle(db, incoming, { dryRun: false, organizationId: 'org-a' });

  // organizationId clamped to string + allowNull: false
  const createdCol = customCollections.find((c) => c.name === 'latticeCustomSensorLog');
  const orgField = createdCol.fields.find((f) => f.name === 'organizationId');
  assert.equal(orgField.type, 'string');
  assert.equal(orgField.allowNull, false);

  // All load() and sync() calls received transaction
  assert.ok(loadCalls.length >= 3);
  for (const call of loadCalls) {
    assert.ok(call.opts?.transaction?.id, `Expected transaction on ${call.kind}:${call.name}`);
  }
  assert.ok(colSyncCalls.some((c) => c.name === 'latticeCustomSensorLog' && Boolean(c.opts?.transaction?.id)));
});

test('Fix Round 1 (Important): workflow DAG cycle/dangling validation, scopeId stripping, usingActionsConfig normalization, circular JSON guard', async () => {
  const { exportSolutionBundle, validateSolutionBundle, importSolutionBundle, rollbackLastSolutionBundle } = require(path.join(PLUGIN_ROOT, 'src/server/solution-bundle.js'));
  const { db, roleResources, flowNodes } = makeSolutionBundleDbHarness();
  roleResources[0].usingActionsConfig = false;
  roleResources[0].actions = [{ name: 'view', fields: ['id', 'code'], scopeId: 99, scope: { id: 99, title: 'Own', scope: { createdById: '1' } } }];

  const exported = await exportSolutionBundle(db, { organizationId: 'org-a' });
  const expRes = exported.roles.find((r) => r.name === 'ldx_employee').resources[0];
  assert.equal(expRes.usingActionsConfig, true);
  assert.equal(expRes.actions[0].scopeId, undefined);
  assert.equal(expRes.actions[0].scope.id, undefined);
  assert.equal(expRes.actions[0].scope.title, 'Own');

  // Round-trip import + rollback succeeds even though source DB row had usingActionsConfig: false
  const outOfOrder = structuredClone(exported);
  outOfOrder.workflows[0].nodes = [
    { key: 'n2', type: 'end', title: 'End', upstreamKey: 'n1', config: {} },
    { key: 'n1', type: 'condition', title: 'Start', config: {} },
  ];
  await importSolutionBundle(db, outOfOrder, { dryRun: false, organizationId: 'org-a' });
  const wfNodes = flowNodes.filter((n) => n.workflowId === 11);
  assert.equal(wfNodes.find((n) => n.key === 'n2').upstreamId, wfNodes.find((n) => n.key === 'n1').id);
  const rb = await rollbackLastSolutionBundle(db, { organizationId: 'org-a' });
  assert.equal(rb.rolledBack, true);

  // Invalid workflow DAG cases fail 400
  const invalidNodesCases = [
    'not-an-array',
    [{ type: 'condition' }],
    [{ key: 'n1', type: 'condition' }, { key: 'n1', type: 'end' }],
    [{ key: 'n1', type: 'condition', upstreamKey: 'n1' }],
    [{ key: 'n1', type: 'condition', upstreamKey: 'missing' }],
    [{ key: 'n1', type: 'condition', upstreamKey: 'n2' }, { key: 'n2', type: 'end', upstreamKey: 'n1' }],
    [
      { key: 'n1', type: 'condition', upstreamKey: 'n3' },
      { key: 'n2', type: 'condition', upstreamKey: 'n1' },
      { key: 'n3', type: 'end', upstreamKey: 'n2' },
    ],
  ];
  for (const nodesCase of invalidNodesCases) {
    const bad = structuredClone(exported);
    bad.workflows[0].nodes = nodesCase;
    assert.equal(validateSolutionBundle(bad).valid, false, `Expected invalid DAG rejection for ${JSON.stringify(nodesCase)}`);
    await assert.rejects(
      () => importSolutionBundle(db, bad, { dryRun: false, organizationId: 'org-a' }),
      (err) => err.status === 400 && err.code === 'INVALID_SOLUTION_BUNDLE',
    );
  }

  // Circular bundle returns valid:false and 400 instead of crashing
  const circular = { metadata: { schemaVersion: 'latticedx.solution-bundle/v2' } };
  circular.self = circular;
  const circVal = validateSolutionBundle(circular);
  assert.equal(circVal.valid, false);
  await assert.rejects(
    () => importSolutionBundle(db, circular, { dryRun: true, organizationId: 'org-a' }),
    (err) => err.status === 400 && err.code === 'INVALID_SOLUTION_BUNDLE',
  );
});

test('applyCustomCollectionsSection invokes db.attachLatticeRlsPolicy after collection sync', async () => {
  const { importSolutionBundle } = require(path.join(PLUGIN_ROOT, 'src/server/solution-bundle.js'));
  const { db } = makeSolutionBundleDbHarness();
  const rlsAttached = [];
  db.attachLatticeRlsPolicy = async (tableName, transaction) => {
    rlsAttached.push({ tableName, hasTx: Boolean(transaction) });
  };
  const bundle = {
    metadata: { schemaVersion: 'latticedx.solution-bundle/v2', organizationId: 'org-a' },
    customCollections: [
      { name: 'latticeCustomColdChainLog', title: 'Nhật ký kho lạnh', fields: [{ name: 'batchCode', type: 'string' }] },
    ],
  };
  const res = await importSolutionBundle(db, bundle, { dryRun: false, organizationId: 'org-a' });
  assert.equal(res.dryRun, false);
  assert.equal(res.applied.customCollectionsUpserted, 1);
  assert.deepEqual(rlsAttached, [{ tableName: 'latticeCustomColdChainLog', hasTx: true }]);
});

test('Task 16: solution-bundle resolves organizationId dynamically from active latticeOrganizations and fails cleanly when none exists', async () => {
  const { importSolutionBundle } = require(path.join(PLUGIN_ROOT, 'src/server/solution-bundle.js'));
  const { db, customCollections, aiProfiles } = makeSolutionBundleDbHarness();
  const orgRows = [
    { id: 1, organizationId: 'inactive-org', active: false, status: 'inactive' },
    { id: 2, organizationId: 'acme-pharma', active: true, status: 'active' },
  ];
  const origGetRepo = db.getRepository.bind(db);
  db.getRepository = (name) => {
    if (name === 'latticeOrganizations') {
      return { find: async () => [...orgRows] };
    }
    return origGetRepo(name);
  };

  const bundleNoOrg = {
    metadata: { schemaVersion: 'latticedx.solution-bundle/v2' },
    customCollections: [
      { name: 'latticeCustomPharmaBatch', title: 'Pharma Batch', fields: [{ name: 'batchNo', type: 'string' }] },
    ],
    aiProfiles: [
      { username: 'pharma-bot', nickname: 'Pharma Bot', enabled: true, isAdminBuilder: false, allowedRoles: ['ops_manager'] },
    ],
  };

  const res = await importSolutionBundle(db, bundleNoOrg, { dryRun: false });
  assert.equal(res.applied.customCollectionsUpserted, 1);
  assert.equal(res.applied.aiProfilesUpserted, 1);
  const createdCol = customCollections.find((c) => c.name === 'latticeCustomPharmaBatch');
  assert.equal(createdCol.fields.find((f) => f.name === 'organizationId').defaultValue, 'acme-pharma');
  const createdAi = aiProfiles.find((p) => p.username === 'pharma-bot');
  assert.equal(createdAi.organizationId, 'acme-pharma');

  // Empty latticeOrganizations with no targetOrg/clean.organizationId fails cleanly
  orgRows.length = 0;
  await assert.rejects(
    () => importSolutionBundle(db, bundleNoOrg, { dryRun: false }),
    (err) => err.status === 400 && err.code === 'ORGANIZATION_REQUIRED',
  );
});

test('exportSolutionBundle unwraps Sequelize Model instances inside desktopRoutes.dataValues.uiLayouts without crashing on toJSON cloneDeep', async () => {
  const { exportSolutionBundle } = require(path.join(PLUGIN_ROOT, 'src/server/solution-bundle.js'));
  const { db } = makeSolutionBundleDbHarness();

  // Simulate Sequelize Model instance inside uiLayouts association where super.toJSON() throws on nested Model._options/delegates
  const nestedLayoutModel = {
    dataValues: {
      uid: 'ldx-portal-work',
      title: 'Công việc',
      desktopRoutesUiLayouts: { dataValues: { desktopRouteId: 10, uiLayoutUid: 'ldx-portal-work' } },
    },
    toJSON() {
      return { uid: 'ldx-portal-work', title: 'Công việc' };
    },
  };
  const routeModelWithThrowingToJson = {
    dataValues: {
      id: 10,
      title: 'Ops Page',
      type: 'flowPage',
      schemaUid: 'ops_schema_1',
      uiLayouts: [nestedLayoutModel],
    },
    toJSON() {
      throw new TypeError("Cannot read properties of undefined (reading 'length')");
    },
  };

  const origGetRepo = db.getRepository.bind(db);
  db.getRepository = (name) => {
    if (name === 'desktopRoutes') {
      return { find: async () => [routeModelWithThrowingToJson] };
    }
    if (name === 'desktopRoutesUiLayouts') {
      return { find: async () => [{ desktopRouteId: 10, uiLayoutUid: 'ldx-portal-work' }] };
    }
    if (name === 'rolesDesktopRoutes' || name === 'flowModels') {
      return { find: async () => [] };
    }
    return origGetRepo(name);
  };

  const exported = await exportSolutionBundle(db, { organizationId: 'org-a', platformVersion: '1.0.0' });
  assert.equal(Array.isArray(exported.routesAndBlocks?.routes), true);
  assert.equal(exported.routesAndBlocks.routes.some((r) => r.title === 'Ops Page' && r.layoutUid === 'ldx-portal-work'), true);
});
