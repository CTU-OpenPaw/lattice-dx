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
    { name: 'ldx_employee', title: 'Nhân viên', allowAll: false, snippets: ['ui.*'], allowConfigure: false },
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
    { id: 11, key: 'wf-logistics', title: 'Logistics 5 bước', current: true, enabled: true, config: { apiKey: 'SECRET-SHOULD-STRIP' } },
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

  const db = {
    sequelize: {
      transaction: async (fn) => fn({ id: 'tx-sb' }),
    },
    getRepository(name) {
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
          find: async () => [...roleResources],
        };
      }
      if (name === 'uiLayouts') {
        return { find: async () => [...portals] };
      }
      if (name === 'workflows') {
        return { find: async () => workflows.filter((w) => w.current) };
      }
      if (name === 'flow_nodes') {
        return { find: async () => [...flowNodes] };
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
        return { find: async () => [...customCollections] };
      }
      return null;
    },
  };
  return { db, roles, aiProfiles };
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
  incoming.roles.push({ name: 'ldx_cold_lead', title: 'Trưởng ca lạnh', snippets: ['ui.*'] });
  incoming.aiProfiles.push({ username: 'dxos-cold-copilot', nickname: 'Copilot Lạnh', organizationId: 'foreign-org', enabled: true });

  const diff = diffSolutionBundle(current, incoming);
  assert.equal(diff.summary.added, 2);
  assert.equal(diff.sections.roles.added.length, 1);

  // Dry-run makes ZERO DB mutations
  const dryRes = await importSolutionBundle(db, incoming, { dryRun: true, organizationId: 'org-a' });
  assert.equal(dryRes.dryRun, true);
  assert.equal(dryRes.applied, null);
  assert.equal(roles.some((r) => r.name === 'ldx_cold_lead'), false);
  assert.equal(aiProfiles.some((p) => p.username === 'dxos-cold-copilot'), false);

  // Apply (dryRun: false) idempotently upserts scoped to caller org without escalation
  const applyRes = await importSolutionBundle(db, incoming, { dryRun: false, organizationId: 'org-a' });
  assert.equal(applyRes.dryRun, false);
  assert.equal(applyRes.applied.rolesUpserted, 3);
  assert.equal(applyRes.applied.aiProfilesUpserted, 2);
  const newRole = roles.find((r) => r.name === 'ldx_cold_lead');
  assert.ok(newRole);
  assert.equal(newRole.allowAll, false);
  assert.equal(newRole.allowConfigure, false);
  const newAi = aiProfiles.find((p) => p.username === 'dxos-cold-copilot');
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
