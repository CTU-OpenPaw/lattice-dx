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
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(PLUGIN_ROOT, '../../..');

function makeDbHarness({ dialect = 'postgres', queryHandler } = {}) {
  const store = {
    uiLayouts: [
      { uid: 'ldx-portal-services', title: 'Services', layoutType: 'desktop', enabled: true },
      { uid: 'ldx-portal-cold-assets', title: 'Cold Assets', layoutType: 'desktop', enabled: true },
    ],
    desktopRoutes: [],
    desktopRoutesUiLayouts: [],
    rolesDesktopRoutes: [],
    rolesCollections: [],
    flowModels: [],
    collections: [],
    fields: [],
    roles: [
      { name: 'root', title: 'Root', allowConfigure: true },
      { name: 'admin', title: 'Admin', allowConfigure: true },
      { name: 'ldx_admin', title: 'Lattice Admin', allowConfigure: true, snippets: ['pm'] },
      { name: 'ldx_employee', title: 'Employee', allowConfigure: false, snippets: [] },
      { name: 'ldx_driver', title: 'Driver', allowConfigure: false, snippets: [] },
    ],
    dataSourcesRoles: [],
    dataSourcesRolesResources: [],
    rolesUsers: [
      { id: 1, userId: 1, roleName: 'ldx_admin' },
      { id: 2, userId: 2, roleName: 'ldx_employee' },
      { id: 3, userId: 3, roleName: 'ldx_driver' },
      { id: 4, userId: 99, roleName: 'root' },
      { id: 5, userId: 11, roleName: 'ldx_admin' },
    ],
    latticeEmployees: [
      { id: 101, userId: 1, organizationId: 'org-a', active: true },
      { id: 102, userId: 2, organizationId: 'org-a', active: true },
      { id: 103, userId: 3, organizationId: 'org-a', active: true },
      { id: 111, userId: 11, organizationId: 'org-b', active: true },
    ],
    latticeOrganizations: [
      { id: 1, organizationId: 'org-a', active: true, status: 'active' },
      { id: 2, organizationId: 'org-b', active: true, status: 'active' },
    ],
    latticeBuiltApps: [],
    latticeAiProfiles: [],
    latticeAiAuditLogs: [],
    latticeAiQuotaUsage: [],
    latticeAiQuotaPolicies: [],
    latticeAiApprovalQueue: [],
    latticeUiSnapshots: [],
    latticeDecisionTables: [],
    latticeAutomationRules: [],
    latticeAutomationRuns: [],
    latticeConnectors: [],
    latticeNotifications: [],
    latticeParaDocuments: [],
    latticeParaChunks: [],
    latticeStockLots: [],
    latticeIncidentCases: [],
    latticeTwinShadows: [],
    latticeDataQuarantine: [],
    aiEmployees: [],
    rolesAiEmployees: [],
    llmServices: [],
  };

  let seq = 500;
  const sqlCalls = [];
  const removedCollections = [];
  const rlsAttachedTables = new Set();

  const matches = (row, filter = {}) => Object.entries(filter || {}).every(([k, cond]) => {
    if (k === '$or' && Array.isArray(cond)) return cond.some((sub) => matches(row, sub));
    if (k === '$and' && Array.isArray(cond)) return cond.every((sub) => matches(row, sub));
    if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
      if ('$in' in cond) return cond.$in.includes(row[k]);
      if ('$ne' in cond) return row[k] !== cond.$ne;
    }
    return String(row[k]) === String(cond);
  });

  const wrap = (arr, row) => ({
    ...row,
    get: (k) => row[k],
    set: (k, v) => { row[k] = v; },
    toJSON: () => ({ ...row }),
    update: async (patch = {}) => { Object.assign(row, patch); return wrap(arr, row); },
    destroy: async () => {
      const idx = arr.indexOf(row);
      if (idx >= 0) arr.splice(idx, 1);
    },
  });

  const db = {
    store,
    sqlCalls,
    removedCollections,
    rlsAttachedTables,
    hasCollection: (n) => Object.prototype.hasOwnProperty.call(store, n) || store.collections.some((c) => c.name === n),
    getCollection: (n) => {
      const c = store.collections.find((x) => x.name === n);
      if (!c) return null;
      return {
        name: c.name,
        options: { title: c.title, ...(c.options || {}) },
        fields: c.fields || [],
        hasField: (fn) => (c.fields || []).some((f) => f.name === fn),
        sync: async () => {},
      };
    },
    removeCollection: async (n) => {
      removedCollections.push(n);
      const idx = store.collections.findIndex((c) => c.name === n);
      if (idx >= 0) store.collections.splice(idx, 1);
    },
    attachLatticeRlsPolicy: async (tableName) => {
      rlsAttachedTables.add(tableName);
      return { applied: true, tableName };
    },
    sequelize: {
      getDialect: () => dialect,
      transaction: async (fn) => fn({ id: 'tx-mock' }),
      query: async (sql, opts = {}) => {
        sqlCalls.push({ sql: String(sql), opts });
        if (typeof queryHandler === 'function') {
          return queryHandler(String(sql), opts);
        }
        return [[], 0];
      },
    },
    getRepository(name) {
      const arr = store[name];
      if (!arr) return null;
      return {
        find: async ({ filter = {}, sort, limit = 500 } = {}) => {
          let rows = arr.filter((r) => matches(r, filter));
          if (Array.isArray(sort) && sort.includes('-id')) {
            rows = [...rows].sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
          }
          return rows.slice(0, limit).map((r) => wrap(arr, r));
        },
        findOne: async ({ filter = {}, filterByTk } = {}) => {
          const hit = filterByTk != null
            ? arr.find((r) => String(r.id ?? r.uid ?? r.name) === String(filterByTk))
            : arr.find((r) => matches(r, filter));
          return hit ? wrap(arr, hit) : null;
        },
        count: async ({ filter = {} } = {}) => arr.filter((r) => matches(r, filter)).length,
        create: async ({ values = {} } = {}) => {
          const item = { id: ++seq, createdAt: new Date().toISOString(), ...values };
          arr.push(item);
          if (name === 'collections' && !store[item.name]) {
            // Do not mutate top-level store unless needed
          }
          return wrap(arr, item);
        },
        update: async ({ filter = {}, filterByTk, values = {} } = {}) => {
          let updated = 0;
          for (const r of arr) {
            const hit = filterByTk != null ? String(r.id) === String(filterByTk) : matches(r, filter);
            if (hit) {
              Object.assign(r, values);
              updated += 1;
            }
          }
          return [updated];
        },
        destroy: async ({ filter = {} } = {}) => {
          const before = arr.length;
          for (let i = arr.length - 1; i >= 0; i -= 1) {
            if (matches(arr[i], filter)) arr.splice(i, 1);
          }
          return before - arr.length;
        },
        findModelById: async (uid) => {
          const hit = store.flowModels.find((m) => m.uid === uid);
          return hit ? { ...hit } : null;
        },
        findModelByParentId: async (parentId, { subKey } = {}) => {
          const hit = store.flowModels.find((m) => m.parentId === parentId && (!subKey || m.subKey === subKey));
          return hit ? { ...hit } : null;
        },
        upsertModel: async (model) => {
          const idx = store.flowModels.findIndex((m) => m.uid === model.uid);
          if (idx >= 0) store.flowModels[idx] = { ...store.flowModels[idx], ...model };
          else store.flowModels.push({ ...model });
          return model;
        },
        updateSingleNode: async (patch) => {
          const idx = store.flowModels.findIndex((m) => m.uid === patch.uid);
          if (idx >= 0) store.flowModels[idx] = { ...store.flowModels[idx], ...patch };
          return store.flowModels[idx];
        },
        remove: async (uid) => {
          const idx = store.flowModels.findIndex((m) => m.uid === uid);
          if (idx >= 0) store.flowModels.splice(idx, 1);
        },
      };
    },
  };
  return { db, store, sqlCalls, removedCollections };
}

function makeStatefulReact() {
  let slots = [];
  let cursor = 0;
  let effectSlots = [];
  let effectCursor = 0;
  let refSlots = [];
  let refCursor = 0;
  let memoSlots = [];
  let memoCursor = 0;
  const depsChanged = (a, b) => !a || !b || a.length !== b.length || b.some((x, i) => x !== a[i]);
  const React = {
    Fragment: 'Fragment',
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (init) => {
      const idx = cursor++;
      if (!(idx in slots)) slots[idx] = typeof init === 'function' ? init() : init;
      return [slots[idx], (val) => {
        slots[idx] = typeof val === 'function' ? val(slots[idx]) : val;
      }];
    },
    useRef: (init) => {
      const idx = refCursor++;
      if (!(idx in refSlots)) refSlots[idx] = { current: init };
      return refSlots[idx];
    },
    useMemo: (fn, deps) => {
      const idx = memoCursor++;
      if (!memoSlots[idx] || depsChanged(memoSlots[idx].deps, deps)) {
        memoSlots[idx] = { value: fn(), deps };
      }
      return memoSlots[idx].value;
    },
    useCallback: (fn) => fn,
    useEffect: (fn, deps) => {
      const idx = effectCursor++;
      const prev = effectSlots[idx];
      if (!prev || depsChanged(prev.deps, deps)) {
        prev?.cleanup?.();
        const cleanup = fn();
        effectSlots[idx] = { deps, cleanup: typeof cleanup === 'function' ? cleanup : null };
      }
    },
  };
  return {
    React,
    render: (Comp, props = {}) => {
      cursor = 0;
      effectCursor = 0;
      refCursor = 0;
      memoCursor = 0;
      return Comp(props);
    },
    getStates: () => slots,
    cleanup: () => {
      for (const e of effectSlots) e?.cleanup?.();
    },
  };
}

function findNode(tree, predicate) {
  if (!tree || typeof tree !== 'object') return null;
  if (predicate(tree)) return tree;
  const kids = Array.isArray(tree.children) ? tree.children.flat(Infinity) : [];
  for (const k of kids) {
    const hit = findNode(k, predicate);
    if (hit) return hit;
  }
  return null;
}

// =========================================================================
// P0-01: teardownBuiltApp cross-tenant DROP TABLE protection & full cleanup
// =========================================================================
test('P0-01: teardownBuiltApp(keepData=false) never drops collections shared with another org (via registry OR physical rows) and deletes only calling org rows', async () => {
  const { teardownBuiltApp } = require(path.join(PLUGIN_ROOT, 'src/server/app-builder-orchestrator.js'));

  let foreignRowsCheck = false;
  const { db, store, sqlCalls, removedCollections } = makeDbHarness({
    queryHandler: async (sql) => {
      if (/SELECT EXISTS/i.test(sql) && /latticeCustomPhysicalOnly/i.test(sql)) {
        return [[{ hasForeignRows: foreignRowsCheck }], 1];
      }
      return [[], 0];
    },
  });

  // Seed collections & fields
  for (const col of ['latticeCustomSharedRegistry', 'latticeCustomPhysicalOnly', 'latticeCustomUnshared']) {
    store.collections.push({ name: col, title: col, options: { uiManageable: true }, fields: [{ name: 'organizationId', type: 'string' }] });
    store.fields.push({ collectionName: col, name: 'code' });
    store.dataSourcesRolesResources.push({ name: col, roleName: 'ldx_org_a_custom', dataSourceKey: 'main' });
    store.rolesCollections.push({ collectionName: col, roleName: 'ldx_org_a_custom' });
  }
  store.roles.push({ name: 'ldx_org_a_custom', title: 'Org A Custom' });
  store.dataSourcesRoles.push({ roleName: 'ldx_org_a_custom', dataSourceKey: 'main' });

  // Exclusive desktopRoutes + links for app-a
  store.desktopRoutes.push(
    { id: 701, title: 'Group A', type: 'group', parentId: null },
    { id: 702, title: 'Page A', type: 'flowPage', parentId: 701, schemaUid: 'pg-a' },
    { id: 703, title: 'Tab A', type: 'tabs', parentId: 702, schemaUid: 'tab-a' },
  );
  store.desktopRoutesUiLayouts.push(
    { desktopRouteId: 701, uiLayoutUid: 'ldx-portal-services' },
    { desktopRouteId: 702, uiLayoutUid: 'ldx-portal-services' },
    { desktopRouteId: 703, uiLayoutUid: 'ldx-portal-services' },
  );
  store.rolesDesktopRoutes.push({ desktopRouteId: 702, roleName: 'ldx_org_a_custom' });

  // Org B owns an active app referencing latticeCustomSharedRegistry
  store.latticeBuiltApps.push(
    {
      id: 1,
      organizationId: 'org-a',
      appKey: 'app-a',
      status: 'active',
      artifactRefsJson: {
        collections: ['latticeCustomSharedRegistry', 'latticeCustomPhysicalOnly', 'latticeCustomUnshared'],
        joinCollections: [],
        roles: ['ldx_org_a_custom'],
        portals: [{ portalSlug: 'services', layoutUid: 'ldx-portal-services', pageTitle: 'Page A', blockUids: [] }],
        aiEmployees: [],
        dmnTableKeys: [],
        flowRuleKeys: [],
        n8nWorkflowIds: [],
      },
    },
    {
      id: 2,
      organizationId: 'org-b',
      appKey: 'app-b',
      status: 'active',
      artifactRefsJson: {
        collections: ['latticeCustomSharedRegistry'],
        joinCollections: [],
        roles: ['ldx_employee'],
        portals: [{ portalSlug: 'services', layoutUid: 'ldx-portal-services', pageTitle: 'Page B', blockUids: [] }],
      },
    },
  );

  // Trigger physical foreign rows on latticeCustomPhysicalOnly
  foreignRowsCheck = true;

  const actorA = { userId: 1, username: 'admin-a', organizationId: 'org-a', isAdmin: true, isRoot: false, roleNames: ['ldx_admin'] };
  const res = await teardownBuiltApp({}, db, actorA, { appKey: 'app-a', keepData: false });

  assert.equal(res.torndown, true);
  assert.deepEqual(res.droppedCollections, ['latticeCustomUnshared']);
  assert.deepEqual(res.partialCleanedCollections.sort(), ['latticeCustomPhysicalOnly', 'latticeCustomSharedRegistry']);

  // Verify DROP TABLE only ran for latticeCustomUnshared
  const dropSqls = sqlCalls.map((c) => c.sql).filter((s) => /DROP TABLE/i.test(s));
  assert.equal(dropSqls.length, 1);
  assert.match(dropSqls[0], /latticeCustomUnshared/);

  // Verify DELETE WHERE "organizationId" = :organizationId ran for both shared collections
  const deleteSqls = sqlCalls.filter((c) => /DELETE FROM/i.test(c.sql));
  assert.equal(deleteSqls.some((c) => c.sql.includes('"latticeCustomSharedRegistry"') && c.opts?.replacements?.organizationId === 'org-a'), true);
  assert.equal(deleteSqls.some((c) => c.sql.includes('"latticeCustomPhysicalOnly"') && c.opts?.replacements?.organizationId === 'org-a'), true);

  // Shared metadata preserved; unshared removed via db.removeCollection
  assert.equal(store.collections.some((c) => c.name === 'latticeCustomSharedRegistry'), true);
  assert.equal(store.collections.some((c) => c.name === 'latticeCustomPhysicalOnly'), true);
  assert.equal(store.collections.some((c) => c.name === 'latticeCustomUnshared'), false);
  assert.deepEqual(removedCollections, ['latticeCustomUnshared']);

  // Exclusive route + custom role cleaned; builtin roles preserved
  assert.equal(store.desktopRoutes.some((r) => r.id === 702), false);
  assert.equal(store.desktopRoutesUiLayouts.some((l) => l.desktopRouteId === 702), false);
  assert.equal(store.roles.some((r) => r.name === 'ldx_org_a_custom'), false);
  assert.equal(store.roles.some((r) => r.name === 'ldx_employee'), true);
});

// =========================================================================
// P0-08: saveQuotaPolicy error surfacing & checkAndConsumeAiQuotaPersistent
// =========================================================================
test('P0-08: saveQuotaPolicy surfaces DB write errors cleanly without mutating memory, and checkAndConsumeAiQuotaPersistent enforces atomic DB quota', async () => {
  const {
    saveQuotaPolicy,
    recordQuotaUsagePersistent,
    checkAndConsumeAiQuotaPersistent,
    getQuotaLimits,
    resetQuotaBuckets,
  } = require(path.join(PLUGIN_ROOT, 'src/server/ai-governance.js'));
  const { createDxosAiActions } = require(path.join(PLUGIN_ROOT, 'src/server/ai-resource.js'));

  resetQuotaBuckets();

  // 1. SQL failure on saveQuotaPolicy throws DXOS_QUOTA_POLICY_PERSIST_FAILED (503/500) & preserves memory
  const failingDb = {
    getRepository: () => null,
    sequelize: {
      getDialect: () => 'postgres',
      query: async () => {
        const err = new Error('connection refused');
        err.code = 'ECONNREFUSED';
        throw err;
      },
    },
  };
  await assert.rejects(
    () => saveQuotaPolicy(failingDb, 'org-a', { orgDailyCalls: 99, userDailyCalls: 9 }, { username: 'admin' }),
    (err) => err.code === 'DXOS_QUOTA_POLICY_PERSIST_FAILED' && err.status === 503,
  );
  // Default limit unchanged
  assert.notEqual(getQuotaLimits(process.env).orgDailyCalls, 99);

  // HTTP action saveQuotaPolicy also surfaces 503 instead of returning 200 fake success
  const actions = createDxosAiActions(failingDb);
  await assert.rejects(
    () => actions.saveQuotaPolicy({
      method: 'POST',
      state: { currentUser: { id: 99, username: 'root' }, currentRoles: ['root'] },
      request: { body: { organizationId: 'org-a', orgDailyCalls: 77 } },
      action: { params: {} },
    }, async () => {}),
    (err) => err.code === 'DXOS_QUOTA_POLICY_PERSIST_FAILED' && err.status >= 500,
  );

  // 2. recordQuotaUsagePersistent surfaces non-42P01 DB errors instead of swallowing them
  await assert.rejects(
    () => recordQuotaUsagePersistent(failingDb, { userId: 1, organizationId: 'org-a' }, { promptTokens: 10 }),
    (err) => err.code === 'DXOS_QUOTA_USAGE_PERSIST_FAILED' && err.status === 503,
  );

  // 3. checkAndConsumeAiQuotaPersistent reads locked PG rows & enforces limit across worker reset
  resetQuotaBuckets();
  const pgUsageRows = [];
  const pgPolicyRows = [{ organizationId: 'org-pg', orgDailyCalls: 2, userDailyCalls: 1, orgDailyTokens: 100000, orgDailyUsd: 10 }];
  const pgDb = {
    getRepository: () => null,
    sequelize: {
      getDialect: () => 'postgres',
      transaction: async (fn) => fn({ id: 'tx-pg' }),
      query: async (sql, { replacements } = {}) => {
        if (/FROM "latticeAiQuotaPolicies"/i.test(sql)) {
          return [pgPolicyRows.filter((r) => r.organizationId === replacements.organizationId), 1];
        }
        if (/SELECT "userId", calls[\s\S]*FROM "latticeAiQuotaUsage"/i.test(sql)) {
          return [pgUsageRows.filter((r) => r.organizationId === replacements.organizationId && r.dayKey === replacements.dayKey), pgUsageRows.length];
        }
        if (/INSERT INTO "latticeAiQuotaUsage"/i.test(sql)) {
          const hit = pgUsageRows.find((r) => r.organizationId === replacements.organizationId && r.dayKey === replacements.dayKey && r.userId === replacements.userId);
          if (hit) hit.calls += 1;
          else pgUsageRows.push({ ...replacements, calls: 1, promptTokens: 0, completionTokens: 0, costUsd: 0, piiRedacted: 0 });
          return [[], 1];
        }
        return [[], 0];
      },
    },
  };
  await checkAndConsumeAiQuotaPersistent(pgDb, { userId: 10, organizationId: 'org-pg' }, { consume: true });
  assert.equal(pgUsageRows[0].calls, 1);

  // Simulate worker restart
  resetQuotaBuckets();
  await assert.rejects(
    () => checkAndConsumeAiQuotaPersistent(pgDb, { userId: 10, organizationId: 'org-pg' }, { consume: true }),
    (err) => err.status === 429 && err.code === 'AI_QUOTA_EXCEEDED',
  );
  resetQuotaBuckets();
});

// =========================================================================
// P1-11: status='active' filter, zero-token deterministic empty result, flexible dim
// =========================================================================
test('P1-11: AI Hybrid Search excludes draft/archived docs, rejects zero-token fallback matches, and unlocks 768/1024-dim pgvector', async () => {
  const { executePgVectorParaQuery, rankHybridRecords } = require(path.join(PLUGIN_ROOT, 'src/server/ai-hybrid-search.js'));
  const { createDxosTools } = require(path.join(PLUGIN_ROOT, 'src/server/ai-tools-core.js'));
  const { db, store, sqlCalls } = makeDbHarness({
    dialect: 'postgres',
    queryHandler: async (sql, opts) => {
      if (/FROM "latticeParaChunks"/i.test(sql)) {
        assert.equal(opts.replacements.embeddingDim, 768);
        assert.match(sql, /"embeddingDim"\s*=\s*:embeddingDim/);
        return [[{
          id: 901,
          documentId: 20,
          organizationId: 'org-a',
          code: 'SOP-ACT',
          title: 'SOP Active',
          paraSpace: 'resources',
          chunkIndex: 0,
          sectionTitle: 'Sec 1',
          pageNumber: 1,
          content: 'Quy trình xử lý sự cố kho lạnh chuẩn WHO',
          pgVectorSim: 0.88,
          active: true,
        }], 1];
      }
      return [[], 0];
    },
  });

  store.dataSourcesRolesResources.push({
    id: 1,
    roleName: 'ldx_employee',
    dataSourceKey: 'main',
    name: 'latticeParaDocuments',
    usingActionsConfig: true,
    actions: [{ name: 'view' }],
  });
  store.latticeParaDocuments.push(
    { id: 10, organizationId: 'org-a', code: 'SOP-DRF', title: 'SOP Kho lạnh Nháp', contentMarkdown: 'xyz_secret_draft_999', status: 'draft', active: true, paraSpace: 'resources' },
    { id: 11, organizationId: 'org-a', code: 'SOP-ARC', title: 'SOP Kho lạnh Lưu trữ', contentMarkdown: 'xyz_secret_archived_999', status: 'archived', active: true, paraSpace: 'resources' },
    { id: 20, organizationId: 'org-a', code: 'SOP-ACT', title: 'SOP Kho lạnh Chuẩn', contentMarkdown: 'Quy trình xử lý kho lạnh chuẩn WHO', status: 'active', active: true, paraSpace: 'resources' },
  );
  store.latticeParaChunks.push(
    { id: 900, documentId: 10, organizationId: 'org-a', code: 'SOP-DRF', title: 'SOP Kho lạnh Nháp', content: 'xyz_secret_draft_999 kho lạnh', active: true },
    { id: 901, documentId: 20, organizationId: 'org-a', code: 'SOP-ACT', title: 'SOP Kho lạnh Chuẩn', content: 'Quy trình xử lý sự cố kho lạnh chuẩn WHO', active: true },
  );

  // 1. rankHybridRecords returns [] when zero tokens match in deterministic fallback
  const junkRes = rankHybridRecords('xyz_khong_ton_tai_999', [
    { item: { id: 20, code: 'SOP-ACT' }, titleText: 'SOP Kho lạnh Chuẩn', hayText: 'Quy trình xử lý sự cố kho lạnh chuẩn WHO', rawSummary: 'WHO' },
  ]);
  assert.deepEqual(junkRes, []);

  // 2. executePgVectorParaQuery unlocks 768-dim and 1024-dim neural vectors
  const vec768 = new Array(768).fill(0.04);
  const vec1024 = new Array(1024).fill(0.03);
  const hits768 = await executePgVectorParaQuery(db, { organizationId: 'org-a', queryEmbedding: vec768, table: 'latticeParaChunks', embeddingDim: 768 });
  assert.equal(hits768.length, 1);
  assert.equal(hits768[0].id, 901);

  // 3. dxos_search_enterprise_context excludes draft/archived docs + passes 768-dim neural embedding
  const searchTool = createDxosTools().find((t) => t.definition.name === 'dxos_search_enterprise_context');
  const ctx = {
    db,
    state: {
      currentUser: { id: 2, username: 'emp' },
      currentRoles: ['ldx_employee'],
      dxosEmbeddingEnv: { DXOS_EMBEDDING_URL: 'https://embedding.example.test/v1/embeddings' },
      dxosFetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ model: 'nomic-embed-text', data: [{ embedding: vec768 }] }),
      }),
    },
  };
  const res = await searchTool.invoke(ctx, { query: 'kho lạnh', collections: ['latticeParaDocuments'] });
  assert.equal(res.items.some((i) => i.code === 'SOP-DRF' || i.code === 'SOP-ARC'), false);
  assert.equal(res.items.some((i) => i.code === 'SOP-ACT'), true);
  assert.equal(sqlCalls.some((c) => c.sql.includes('FROM "latticeParaChunks"') && c.opts.replacements.embeddingDim === 768), true);
  assert.ok(vec1024.length === 1024);
});

// =========================================================================
// P1-12: PortalAgentLauncher passive 503 suppression, fallback drawer, retry, switcher
// =========================================================================
test('P1-12: PortalAgentLauncher suppresses passive /p/* 503 warning, opens fallback drawer on {opened:false}, renders error+retry, and switches agents', async () => {
  const { createPortalAgentLauncher } = require(path.join(PLUGIN_ROOT, 'src/client/portal-agent-launcher.js'));
  const origWin = global.window;
  const origDoc = global.document;
  const origFetch = global.fetch;

  try {
    global.window = { location: { pathname: '/p/procurement' }, addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };
    global.document = { visibilityState: 'visible', title: 'Procurement', querySelector: () => null, activeElement: null, addEventListener() {}, removeEventListener() {} };

    let healthCalls = 0;
    const h = makeStatefulReact();
    const Launcher = createPortalAgentLauncher({
      useAPIClient: () => ({
        auth: { getToken: () => 'tok-emp' },
        getBaseURL: () => '/api/',
        request: async (req) => {
          if (req.url === 'dxosAi:portalAgents') {
            return {
              data: {
                data: {
                  isAdmin: false,
                  employees: [
                    { username: 'dxos-procurement', nickname: 'Trợ lý Mua sắm' },
                    { username: 'dxos-analyst', nickname: 'Chuyên viên Phân tích' },
                  ],
                },
              },
            };
          }
          if (req.url === 'dxosAi:checkLlmHealth') {
            healthCalls += 1;
            return { data: { data: { ok: false, status: 503, code: 'LLM_UNAVAILABLE', message: '9router chưa bật.' } } };
          }
          return { data: { data: {} } };
        },
      }),
    }, h.React, {}, {}); // app has no triggerTask -> openNativePortalChat returns { opened: false }

    // Mount on /p/procurement -> must NOT probe health passively or show warning banner
    h.render(Launcher);
    await new Promise((r) => setTimeout(r, 15));
    let tree = h.render(Launcher);
    assert.equal(healthCalls, 0, 'Must NOT call checkLlmHealth passively on /p/* mount');
    assert.equal(findNode(tree, (n) => n.props?.['data-testid'] === 'dxos-ai-health-warning'), null);

    // Bug #9: Agent switcher must NOT float over page content/BiChartBlock when drawer is closed
    assert.equal(
      findNode(tree, (n) => n.props?.['data-testid'] === 'dxos-portal-ai-agent-switcher'),
      null,
      'Must NOT render floating agent switcher over page charts when AI drawer is closed',
    );

    // Click float button -> opens fallback drawer with non-truncated agent switcher in header & inline error + Thử lại button
    const floatBtn = findNode(tree, (n) => n.props?.['data-testid'] === 'dxos-portal-ai-float-btn');
    assert.ok(floatBtn);
    await floatBtn.props.onClick({ stopPropagation() {} });
    tree = h.render(Launcher);

    assert.equal(healthCalls, 1, 'checkLlmHealth runs when user clicks chat');
    const drawer = findNode(tree, (n) => n.props?.['data-testid'] === 'dxos-portal-ai-fallback-drawer');
    assert.ok(drawer, 'Fallback drawer must open when triggerTask is unavailable');
    const switcher = findNode(drawer, (n) => n.props?.['data-testid'] === 'dxos-portal-ai-agent-switcher');
    assert.ok(switcher, 'Expected multi-agent switcher inside open AI drawer header');
    assert.notEqual(switcher.props?.style?.position, 'fixed');
    assert.equal(switcher.props?.style?.width, '100%');
    assert.equal(switcher.props?.style?.maxWidth, undefined);
    switcher.props.onChange({ target: { value: 'dxos-analyst' } });
    tree = h.render(Launcher);
    assert.ok(JSON.stringify(findNode(tree, (n) => n.props?.['data-testid'] === 'dxos-portal-ai-fallback-drawer')).includes('Chuyên viên Phân tích'));
    const errCard = findNode(tree, (n) => n.props?.['data-testid'] === 'dxos-portal-ai-error-card');
    assert.ok(errCard, 'Inline error card must appear on 503');
    const retryBtn = findNode(tree, (n) => n.props?.['data-testid'] === 'dxos-portal-ai-retry-btn');
    assert.ok(retryBtn && JSON.stringify(retryBtn).includes('Thử lại'));

    // Clicking Thử lại re-probes health
    await retryBtn.props.onClick();
    assert.equal(healthCalls, 2, 'Clicking Thử lại must re-check LLM health');
    h.cleanup();
  } finally {
    global.window = origWin;
    global.document = origDoc;
    global.fetch = origFetch;
  }
});

// =========================================================================
// P1-13: Eval 163 parity, Audit dropdowns, HITL UI, Scoped Rollback, LLM CRUD
// =========================================================================
test('P1-13: Eval Lab bundles exact 163 cases matching scripts/eval-vietnamese-nl-agent.mjs with 100% pass', async () => {
  const { listEvalSuites, runEvalBenchmark } = require(path.join(PLUGIN_ROOT, 'src/server/ai-eval-lab.js'));
  const bundled = require(path.join(PLUGIN_ROOT, 'src/server/eval-vietnamese-cases.js'));
  const scriptMod = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts/eval-vietnamese-nl-agent.mjs')).href);

  assert.equal(bundled.VIETNAMESE_NL_EVAL_CASES.length, 163);
  assert.equal(scriptMod.VIETNAMESE_NL_EVAL_CASES.length, 163);
  for (let i = 0; i < 163; i += 1) {
    const a = bundled.VIETNAMESE_NL_EVAL_CASES[i];
    const b = scriptMod.VIETNAMESE_NL_EVAL_CASES[i];
    assert.equal(a.id, b.id);
    assert.equal(a.category, b.category);
    assert.equal(a.prompt, b.prompt);
    assert.equal(a.expectedTool, b.expectedTool);
    assert.equal(Boolean(a.refused), Boolean(b.refused));
  }

  const suites = listEvalSuites();
  const fullSuite = suites.find((s) => s.id === 'vietnamese-nl-agent');
  assert.equal(fullSuite.caseCount, 163);
  assert.equal(fullSuite.estimatedCaseCount, 163);

  const report = await runEvalBenchmark(null, { organizationId: 'org-a', suiteId: 'vietnamese-nl-agent', limit: 163 });
  assert.equal(report.total, 163);
  assert.equal(report.passed, 163);
  assert.equal(report.passRate, 100);
});

test('P1-13: App Builder rollbackEnterpriseApp preserves foreign app blocks on shared portal', async () => {
  const { orchestrateEnterpriseAppBuild, patchEnterpriseApp, rollbackEnterpriseApp } = require(path.join(PLUGIN_ROOT, 'src/server/app-builder-orchestrator.js'));
  const { db, store } = makeDbHarness({ dialect: 'mock' });
  const ctx = { db, app: { resourceManager: { getResource: () => null } }, state: { currentUser: { id: 99, username: 'root' } } };
  const actor = { userId: 99, username: 'root', organizationId: 'org-a', isAdmin: true, isRoot: true, roleNames: ['root'] };
  const okVerifier = async () => ({ ok: true, passedCount: 1, totalCount: 1, checks: [], failedChecks: [] });

  // App A builds v1 on /p/services page "Shared Cockpit"
  await orchestrateEnterpriseAppBuild(ctx, db, actor, {
    appKey: 'app-a',
    portalSlug: 'services',
    pageTitle: 'Shared Cockpit',
    roleName: 'ldx_app_a',
    collectionName: 'latticeCustomAppA',
    fields: [{ name: 'title', type: 'string' }],
    blocks: [{ blockUse: 'DxosPortalHeroBlockModel', title: 'App A Hero' }],
  }, { verifierOverride: okVerifier });

  // App B builds on the SAME portal + pageTitle, adding its own block
  const appBRes = await orchestrateEnterpriseAppBuild(ctx, db, actor, {
    appKey: 'app-b',
    portalSlug: 'services',
    pageTitle: 'Shared Cockpit',
    roleName: 'ldx_app_b',
    collectionName: 'latticeCustomAppB',
    fields: [{ name: 'title', type: 'string' }],
    blocks: [{ blockUse: 'DxosKpiMetricBlockModel', title: 'App B KPI' }],
  }, { verifierOverride: okVerifier });
  const appBBlockUid = appBRes.blocks[0].uid;

  // App A patches v2 (adding a BI block), then rolls back to v1
  await patchEnterpriseApp(ctx, db, actor, {
    appKey: 'app-a',
    patch: { addBlocks: [{ blockUse: 'DxosBiChartBlockModel', title: 'App A BI', collection: 'latticeCustomAppA', chartType: 'bar' }] },
  }, { verifierOverride: okVerifier });
  assert.equal(store.flowModels.some((m) => m.use === 'DxosBiChartBlockModel'), true);

  const rb = await rollbackEnterpriseApp(ctx, db, actor, { appKey: 'app-a', targetVersion: 1 }, { verifierOverride: okVerifier });
  assert.equal(rb.rolledBack, true);
  assert.equal(store.flowModels.some((m) => m.use === 'DxosBiChartBlockModel'), false, 'App A v2 block must be removed');
  assert.equal(store.flowModels.some((m) => m.uid === appBBlockUid), true, 'App B block on shared portal MUST remain intact');
});

test('P1-13: listLlmServices masks apiKey, enforces admin-only, and studio UI wires Audit filters, HITL fields & LLM management', async () => {
  const { createDxosAiActions } = require(path.join(PLUGIN_ROOT, 'src/server/ai-resource.js'));
  const { createDxosAiStudioPage } = require(path.join(PLUGIN_ROOT, 'src/client/ai-studio-page.js'));
  const { db, store } = makeDbHarness();
  store.llmServices.push({
    id: 1,
    name: 'quick-openai',
    title: 'OpenAI',
    provider: 'openai',
    enabled: true,
    options: { baseURL: 'https://api.openai.com/v1', apiKey: 'sk-super-secret-9876' },
    enabledModels: { mode: 'custom', models: [{ label: 'gpt-4o-mini', value: 'gpt-4o-mini' }, { label: 'gpt-4o', value: 'gpt-4o' }] },
  });
  store.latticeAiProfiles.push({ id: 1, username: 'dxos-architect', llmService: 'quick-openai', modelName: 'gpt-4o-mini', organizationId: 'org-a', isAdminBuilder: true });

  const actions = createDxosAiActions(db);
  await assert.rejects(
    () => actions.listLlmServices({ method: 'GET', state: { currentUser: { id: 2 }, currentRoles: ['ldx_employee'] }, headers: {}, action: { params: {} } }, async () => {}),
    (err) => err.status === 403,
  );

  const listCtx = { method: 'GET', state: { currentUser: { id: 1, username: 'adm' }, currentRoles: ['ldx_admin'] }, headers: {}, action: { params: {} } };
  await actions.listLlmServices(listCtx, async () => {});
  assert.equal(listCtx.body.services.length, 1);
  assert.equal(listCtx.body.services[0].maskedApiKey, '****9876');
  assert.equal(JSON.stringify(listCtx.body).includes('sk-super-secret'), false);

  const switchCtx = { method: 'POST', state: { currentUser: { id: 1, username: 'adm' }, currentRoles: ['ldx_admin'] }, request: { body: { name: 'quick-openai', modelName: 'gpt-4o' } }, action: { params: {} } };
  await actions.switchLlmServiceModel(switchCtx, async () => {});
  assert.equal(switchCtx.body.switched, true);
  assert.equal(switchCtx.body.modelName, 'gpt-4o');

  const delCtx = { method: 'POST', state: { currentUser: { id: 1, username: 'adm' }, currentRoles: ['ldx_admin'] }, request: { body: { name: 'quick-openai' } }, action: { params: {} } };
  await actions.deleteLlmService(delCtx, async () => {});
  assert.equal(delCtx.body.deleted, true);
  assert.equal(store.llmServices.length, 0);

  // Client UI checks: Audit dropdowns call loadAuditLogsPage onChange, HITL renders expiresAt + executionResult, LLM services list renders
  const apiCalls = [];
  const h = makeStatefulReact();
  const Page = createDxosAiStudioPage({
    useAPIClient: () => ({
      auth: { getToken: () => 'tok' },
      request: async (req) => {
        apiCalls.push(req);
        if (req.url === 'dxosAi:listProfiles') return { data: { data: { profiles: [], organizations: ['org-a'], defaultOrganizationId: 'org-a', catalog: { availableTools: [], roleOptions: [] } } } };
        if (req.url === 'dxosAi:enterpriseTopology') return { data: { data: { defaultOrganizationId: 'org-a', planes: [] } } };
        if (req.url === 'dxosAi:auditLogs') return { data: { data: { items: [{ id: 1, toolName: 't1', channel: 'mcp', aiEmployee: 'dxos-ops', status: 'allowed', createdAt: '2026-11-26T00:00:00Z' }], total: 1 } } };
        if (req.url === 'dxosAi:listLlmServices') return { data: { data: { services: [{ name: 'quick-openai', provider: 'openai', hasApiKey: true, maskedApiKey: '****9876', isArchitectDefault: true, defaultModel: 'gpt-4o-mini', models: [{ label: 'gpt-4o-mini', value: 'gpt-4o-mini' }] }] } } };
        if (req.url === 'dxosAi:listApprovals') return { data: { data: { items: [{ id: 42, targetCollection: 'latticeStockLots', operation: 'update', toolName: 'dxos_wms_hold_lot', riskLevel: 'high', status: 'failed', organizationId: 'org-a', requesterUsername: 'emp', expiresAt: new Date(Date.now() + 3600000).toISOString(), executionResult: { errorCode: 'WMS_ERR', message: 'Lot locked' } }] } } };
        return { data: { data: {} } };
      },
    }),
  }, h.React, {}, {});

  h.render(Page);
  await new Promise((r) => setTimeout(r, 20));
  let tree = h.render(Page);
  assert.ok(findNode(tree, (n) => n.props?.['data-testid'] === 'dxos-llm-services-list'));

  // Switch to Audit tab -> change status & agent dropdowns -> fires dxosAi:auditLogs immediately
  findNode(tree, (n) => n.props?.['data-testid'] === 'dxos-tab-audit').props.onClick();
  tree = h.render(Page);
  const beforeAuditCalls = apiCalls.filter((c) => c.url === 'dxosAi:auditLogs').length;
  findNode(tree, (n) => n.props?.['data-testid'] === 'dxos-audit-status-filter').props.onChange({ target: { value: 'denied' } });
  findNode(tree, (n) => n.props?.['data-testid'] === 'dxos-audit-agent-filter').props.onChange({ target: { value: 'dxos-ops' } });
  await new Promise((r) => setTimeout(r, 10));
  const afterAuditCalls = apiCalls.filter((c) => c.url === 'dxosAi:auditLogs');
  assert.ok(afterAuditCalls.length >= beforeAuditCalls + 2);
  assert.equal(afterAuditCalls.some((c) => c.params?.status === 'denied'), true);
  assert.equal(afterAuditCalls.some((c) => c.params?.aiEmployee === 'dxos-ops'), true);

  // Switch to HITL tab -> verify executing/failed options + expiresAt + executionResult
  findNode(tree, (n) => n.props?.['data-testid'] === 'dxos-tab-hitl').props.onClick();
  tree = h.render(Page);
  await new Promise((r) => setTimeout(r, 20));
  tree = h.render(Page);
  const hitlFilterDump = JSON.stringify(findNode(tree, (n) => n.props?.['data-testid'] === 'dxos-hitl-status-filter'));
  assert.ok(hitlFilterDump.includes('executing') && hitlFilterDump.includes('failed'));
  assert.ok(findNode(tree, (n) => n.props?.['data-testid'] === 'dxos-hitl-expires-at-42'));
  assert.ok(findNode(tree, (n) => n.props?.['data-testid'] === 'dxos-hitl-execution-result-42'));
  h.cleanup();
});

// =========================================================================
// P1-17: RLS tx fixes, latticeUiSnapshots FORCE RLS & snapOrg guard, SSRF
// =========================================================================
test('P1-17: proactive-triage & ai-hitl-executors wrap transactions in PG RLS; 20261206000100 enforces FORCE RLS; snapOrg null rejected; probeLlmHealth blocks redirects & DNS rebinding', async () => {
  const { enqueueAiApproval } = require(path.join(PLUGIN_ROOT, 'src/server/ai-hitl.js'));
  const { executeWmsHoldLotApproval } = require(path.join(PLUGIN_ROOT, 'src/server/ai-hitl-executors.js'));
  const { runProactiveIncidentTriage } = require(path.join(PLUGIN_ROOT, 'src/server/proactive-triage.js'));
  const { restorePageSnapshot } = require(path.join(PLUGIN_ROOT, 'src/server/ai-surface-creative-tools.js'));
  const { probeLlmHealth } = require(path.join(PLUGIN_ROOT, 'src/server/ai-llm-health.js'));
  const pgRls = require(path.join(REPO_ROOT, 'plugins/nocobase/plugin-lattice-foundation/src/server/pg-rls.js'));

  const observedOrgs = [];
  const rlsGucCalls = [];
  const { db, store } = makeDbHarness({
    dialect: 'postgres',
    queryHandler: async (sql, opts) => {
      if (/set_config\('app\.current_org'/i.test(sql) && opts?.replacements?.orgId) {
        observedOrgs.push(opts.replacements.orgId);
        rlsGucCalls.push({ orgId: opts.replacements.orgId, transaction: opts.transaction || null });
      }
      return [[], 0];
    },
  });
  db.sequelize.QueryTypes = { SELECT: 'SELECT' };

  const prevRlsFlag = process.env.DX_PG_RLS_SESSION;
  process.env.DX_PG_RLS_SESSION = 'true';
  try {
    // 1. enqueueAiApproval shares explicit transaction + ai-hitl-executors & proactive-triage enter PG RLS context

    const sharedTx = { id: 'tx-shared-1' };
    let createTxSeen = null;
    const origGetRepo = db.getRepository.bind(db);
    db.getRepository = (n) => {
      const r = origGetRepo(n);
      if (n !== 'latticeAiApprovalQueue' || !r) return r;
      return {
        ...r,
        create: async (arg) => { createTxSeen = arg.transaction; return r.create(arg); },
      };
    };
    await enqueueAiApproval(db, {
      actor: { userId: 1, username: 'adm', organizationId: 'org-a' },
      toolName: 'dxos_wms_hold_lot',
      targetCollection: 'latticeStockLots',
      targetRecordId: 5,
      transaction: sharedTx,
    });
    assert.equal(createTxSeen, sharedTx);

    // 1b. proactive-triage runs enqueueTx inside withTenantRlsContext and passes active transaction to enqueueAiApproval
    createTxSeen = null;
    store.latticeStockLots.push({ id: 50, organizationId: 'org-a', lotCode: 'LOT-50', status: 'available' });
    store.latticeIncidentCases.push({
      id: 77,
      organizationId: 'org-a',
      code: 'INC-77',
      title: 'Cold room temp spike on LOT-50',
      severity: 'critical',
      status: 'open',
      lotCode: 'LOT-50',
    });
    const triageRes = await runProactiveIncidentTriage(db, {
      actor: { userId: 1, username: 'adm', organizationId: 'org-a', isAdmin: true, roleNames: ['ldx_admin'] },
      organizationId: 'org-a',
      alarmIds: [77],
    });
    assert.equal(triageRes.proposalsCreated, 1);
    assert.ok(createTxSeen, 'proactive-triage must forward transaction from runWithOptionalTenantRls to enqueueAiApproval');
    assert.equal(
      rlsGucCalls.some((c) => c.orgId === 'org-a' && c.transaction === createTxSeen),
      true,
      'proactive-triage enqueueTx must share exact RLS transaction with set_config(app.current_org)',
    );

    db.getRepository = origGetRepo;
    observedOrgs.length = 0;
    await executeWmsHoldLotApproval(
      db,
      { state: { currentUser: { id: 1 }, currentRoles: ['ldx_admin'] } },
      { userId: 1, username: 'adm', organizationId: 'org-a', isAdmin: true, roleNames: ['ldx_admin'] },
      { id: 1, organizationId: 'org-a', targetCollection: 'latticeStockLots', targetRecordId: 50 },
      { lotId: 50, lotCode: 'LOT-50', forceHold: true },
    );
    assert.equal(observedOrgs.includes('org-a'), true, 'ai-hitl-executors must run inside tenant RLS context for row.organizationId');
    assert.equal(typeof pgRls.getActiveRlsContext, 'function');
  } finally {
    if (prevRlsFlag === undefined) delete process.env.DX_PG_RLS_SESSION;
    else process.env.DX_PG_RLS_SESSION = prevRlsFlag;
  }

  // 2. Migration 20261206000100 attaches/detaches FORCE RLS on latticeUiSnapshots
  const origLoad = Module._load;
  class MockMig { constructor(c) { this.context = c; } }
  Module._load = function (req, p, m) {
    if (req === '@nocobase/server') return { Migration: MockMig };
    return origLoad.call(this, req, p, m);
  };
  let Mig20261206;
  try {
    const migPath = path.join(PLUGIN_ROOT, 'src/server/migrations/20261206000100-ui-snapshots-force-rls.js');
    delete require.cache[require.resolve(migPath)];
    Mig20261206 = require(migPath);
  } finally {
    Module._load = origLoad;
  }
  const attached = [];
  const detached = [];
  const mig = new Mig20261206({
    db: {
      sequelize: { getDialect: () => 'postgres', transaction: async (fn) => fn({}), query: async () => [[]] },
      attachLatticeRlsPolicy: async (t) => attached.push(t),
      detachLatticeRlsPolicy: async (t) => detached.push(t),
    },
  });
  await mig.up();
  assert.deepEqual(attached, ['latticeUiSnapshots']);
  await mig.down();
  assert.deepEqual(detached, ['latticeUiSnapshots']);

  // 3. restorePageSnapshot rejects null/empty snapOrg for non-root
  store.latticeUiSnapshots.push({ id: 1, snapshotUid: 'snap-null-org', organizationId: null, portalSlug: 'services', blocks: [] });
  const rbNull = await restorePageSnapshot(db, {
    portalSlug: 'services',
    snapshotUid: 'snap-null-org',
    organizationId: 'org-a',
    allowCrossOrg: false,
  }, (r, k) => r?.[k]);
  assert.equal(rbNull.rolledBack, false);
  assert.equal(rbNull.code, 'DXOS_ORG_MISMATCH');

  // 4. SSRF: redirect: 'error' & DNS rebinding blocked; explicit 127.0.0.1 Ollama allowed
  store.llmServices.push(
    { id: 10, name: 'rebind-llm', provider: 'openai', enabled: true, options: { baseURL: 'https://evil-rebind.example.com/v1', apiKey: 'sk-1' } },
    { id: 11, name: 'redirect-llm', provider: 'openai', enabled: true, options: { baseURL: 'https://api.example.com/v1', apiKey: 'sk-2' } },
    { id: 12, name: 'local-ollama', provider: 'ollama', enabled: true, options: { baseURL: 'http://127.0.0.1:11434' } },
  );
  for (const badIp of ['127.0.0.1', '169.254.169.254', '10.0.0.1', '::1', 'fe80::1', '::ffff:169.254.169.254', '::ffff:7f00:1']) {
    let fetched = false;
    const res = await probeLlmHealth(db, {
      isAdmin: true,
      llmServiceName: 'rebind-llm',
      lookupImpl: async () => [{ address: badIp }],
      fetchImpl: async () => { fetched = true; return { ok: true, status: 200 }; },
    });
    assert.equal(fetched, false, `Must block DNS rebinding to ${badIp}`);
    assert.equal(res.code, 'LLM_URL_UNSAFE');
  }

  const redirRes = await probeLlmHealth(db, {
    isAdmin: true,
    llmServiceName: 'redirect-llm',
    lookupImpl: async () => [{ address: '93.184.216.34' }],
    fetchImpl: async (_url, init) => {
      assert.equal(init.redirect, 'error');
      throw Object.assign(new TypeError('fetch failed'), { cause: new Error('unexpected redirect') });
    },
  });
  assert.equal(redirRes.ok, false);
  assert.equal(redirRes.code, 'LLM_URL_UNSAFE');

  const ollamaRes = await probeLlmHealth(db, {
    isAdmin: true,
    llmServiceName: 'local-ollama',
    fetchImpl: async () => ({ ok: true, status: 200 }),
  });
  assert.equal(ollamaRes.ok, true);
});

// =========================================================================
// P3-02: surfaceEvents org scoping, portal ACL & recipientUserId filtering
// =========================================================================
test('P3-02: surfaceEvents isolates SSE by organizationId, enforces portal ACL, and filters recipientUserId', async () => {
  const { createSurfaceEventsHandler, publishSurfaceUpdate } = require(path.join(PLUGIN_ROOT, 'src/server/surface-events.js'));
  const { db, store } = makeDbHarness();
  store.desktopRoutes.push({ id: 801, title: 'Services Page', type: 'flowPage' });
  store.desktopRoutesUiLayouts.push({ desktopRouteId: 801, uiLayoutUid: 'ldx-portal-services' });
  store.rolesDesktopRoutes.push({ desktopRouteId: 801, roleName: 'ldx_employee' });

  const handler = createSurfaceEventsHandler({
    db,
    getInitialState: async (_ctx, portalSlug, pageTitle, organizationId) => ({
      organizationId,
      portalSlug,
      pageTitle: pageTitle || null,
      revision: 1,
    }),
  });

  // 1. Non-admin blocked from flow-studio & unpermitted portal (driver blocked from services)
  await assert.rejects(
    () => handler({ state: { currentUser: { id: 2 }, currentRoles: ['ldx_employee'] }, action: { params: { portalSlug: 'flow-studio' } }, query: {} }),
    (err) => err.status === 403 && err.code === 'PORTAL_ACL_FORBIDDEN',
  );
  await assert.rejects(
    () => handler({ state: { currentUser: { id: 3 }, currentRoles: ['ldx_driver'] }, action: { params: { portalSlug: 'services' } }, query: {} }),
    (err) => err.status === 403 && err.code === 'PORTAL_ACL_FORBIDDEN',
  );

  // 2. Cross-org query param rejected 403
  await assert.rejects(
    () => handler({ state: { currentUser: { id: 2 }, currentRoles: ['ldx_employee'] }, action: { params: { portalSlug: 'services', organizationId: 'org-b' } }, query: {} }),
    (err) => err.status === 403 && err.code === 'DXOS_ORG_MISMATCH',
  );

  // 3. Org A and Org B SSE streams isolate updates & recipientUserId
  const openStream = async (userId, roles) => {
    const writes = [];
    const req = new EventEmitter();
    const res = new EventEmitter();
    res.writeHead = () => {};
    res.write = (c) => { writes.push(String(c)); return true; };
    await handler({
      state: { currentUser: { id: userId }, currentRoles: roles },
      action: { params: { portalSlug: 'services' } },
      query: {},
      req,
      res,
      respond: true,
    });
    return { writes, close: () => req.emit('close') };
  };

  const streamA = await openStream(2, ['ldx_employee']); // org-a
  const streamB = await openStream(11, ['ldx_admin']); // org-b

  publishSurfaceUpdate('services', { organizationId: 'org-a', revision: 5, message: 'Org A update' });
  publishSurfaceUpdate('services', { revision: 99, message: 'Unscoped test update' }); // must NOT leak to org-scoped SSE
  publishSurfaceUpdate('services', { organizationId: 'org-a', revision: 6, recipientUserId: 999, message: 'Private user 999' });

  assert.equal(streamA.writes.some((w) => w.includes('"revision":5')), true);
  assert.equal(streamA.writes.some((w) => w.includes('"revision":99')), false);
  assert.equal(streamA.writes.some((w) => w.includes('"revision":6')), false);
  assert.equal(streamB.writes.some((w) => w.includes('"revision":5')), false);

  streamA.close();
  streamB.close();
});

// =========================================================================
// M3 R2 Regressions: Expanded IPv6/multicast SSRF, active:false PARA leak, STK prose PII
// =========================================================================
test('M3-R2 P1-17: assertSafeLlmProbeUrl and probeLlmHealth block expanded IPv6, NAT64/6to4/reserved IPv6, and multicast/reserved literal IPs', async () => {
  const {
    assertSafeLlmProbeUrl,
    isPrivateOrReservedIp,
    probeLlmHealth,
  } = require(path.join(PLUGIN_ROOT, 'src/server/ai-llm-health.js'));
  const { db, store } = makeDbHarness();
  store.llmServices.push(
    { id: 201, name: 'rebind-r2', provider: 'openai', enabled: true, options: { baseURL: 'https://rebind-r2.example.com/v1', apiKey: 'sk-r2' } },
    { id: 202, name: 'multicast-r2', provider: 'openai', enabled: true, options: { baseURL: 'https://224.0.0.1/v1', apiKey: 'sk-r2' } },
    { id: 203, name: 'ollama-r2', provider: 'ollama', enabled: true, options: { baseURL: 'http://127.0.0.1:11434' } },
  );

  const blockedDnsIps = [
    '0:0:0:0:0:0:0:0',
    '0:0:0:0:0:0:0:1',
    '0:0:0:0:0:ffff:169.254.169.254',
    '0:0:0:0:0:ffff:a9fe:a9fe',
    '0:0:0:0:0:0:169.254.169.254',
    '::127.0.0.1',
    '64:ff9b::169.254.169.254',
    '64:ff9b::0a00:0001',
    '100::1',
    'fc00::1',
    'fd12:3456:789a::1',
    'fe80::1',
    'febf::1',
    'fec0::1',
    'ff02::1',
    '2001:db8::1',
    '2002:a9fe:a9fe::1',
  ];
  for (const ip of blockedDnsIps) {
    assert.equal(isPrivateOrReservedIp(ip), true, `isPrivateOrReservedIp(${ip}) must be true`);
    await assert.rejects(
      () => assertSafeLlmProbeUrl('https://rebind-r2.example.com/v1', { lookupImpl: async () => [{ address: ip }] }),
      (err) => err.code === 'LLM_URL_UNSAFE',
      `assertSafeLlmProbeUrl must reject DNS rebinding to ${ip}`,
    );
    let fetched = false;
    const probeRes = await probeLlmHealth(db, {
      isAdmin: true,
      llmServiceName: 'rebind-r2',
      lookupImpl: async () => [{ address: ip }],
      fetchImpl: async () => { fetched = true; return { ok: true, status: 200 }; },
    });
    assert.equal(fetched, false);
    assert.equal(probeRes.code, 'LLM_URL_UNSAFE', `probeLlmHealth must return LLM_URL_UNSAFE for ${ip}`);
  }

  // Public IPv6 and public IPv4 must still be allowed
  assert.equal(isPrivateOrReservedIp('2606:4700:4700::1111'), false);
  assert.equal(isPrivateOrReservedIp('93.184.216.34'), false);
  await assert.doesNotReject(() => assertSafeLlmProbeUrl('https://rebind-r2.example.com/v1', { lookupImpl: async () => [{ address: '2606:4700:4700::1111' }] }));

  // Multicast and reserved non-local literal IPs must be rejected with LLM_URL_UNSAFE
  for (const literalUrl of ['https://224.0.0.1/v1', 'https://0.0.0.0/v1', 'https://169.254.169.254/v1']) {
    await assert.rejects(
      () => assertSafeLlmProbeUrl(literalUrl),
      (err) => err.code === 'LLM_URL_UNSAFE',
      `Must reject unsafe literal URL ${literalUrl}`,
    );
  }
  let multicastFetched = false;
  const multicastRes = await probeLlmHealth(db, {
    isAdmin: true,
    llmServiceName: 'multicast-r2',
    fetchImpl: async () => { multicastFetched = true; return { ok: true, status: 200 }; },
  });
  assert.equal(multicastFetched, false);
  assert.equal(multicastRes.code, 'LLM_URL_UNSAFE');

  // Explicit 127.0.0.1 Ollama preset continues to pass
  const ollamaRes = await probeLlmHealth(db, {
    isAdmin: true,
    llmServiceName: 'ollama-r2',
    fetchImpl: async () => ({ ok: true, status: 200 }),
  });
  assert.equal(ollamaRes.ok, true);
});

test('M3-R2 P1-11: dxos_search_enterprise_context & correlateCase exclude active:false PARA documents and their chunks', async () => {
  const { createDxosTools } = require(path.join(PLUGIN_ROOT, 'src/server/ai-tools-core.js'));
  const { db, store } = makeDbHarness();
  store.dataSourcesRolesResources.push({
    id: 1,
    roleName: 'ldx_employee',
    dataSourceKey: 'main',
    name: 'latticeParaDocuments',
    usingActionsConfig: true,
    actions: [{ name: 'view' }],
  });
  store.latticeParaDocuments.push(
    { id: 1, organizationId: 'org-a', code: 'SOP-1', title: 'SOP Kho lạnh Chuẩn', contentMarkdown: 'Quy trình xử lý sự cố kho lạnh', status: 'active', active: true, paraSpace: 'resources' },
    { id: 4, organizationId: 'org-a', code: 'SOP-4', title: 'SOP Kho lạnh Đã xóa mềm', contentMarkdown: 'Quy trình sự cố kho lạnh bí mật đã xóa', status: 'active', active: false, paraSpace: 'resources' },
  );
  store.latticeParaChunks.push(
    { id: 101, documentId: 1, organizationId: 'org-a', code: 'SOP-1', title: 'SOP Kho lạnh Chuẩn', content: 'Quy trình xử lý sự cố kho lạnh đang hiệu lực', active: true },
    { id: 104, documentId: 4, organizationId: 'org-a', code: 'SOP-4', title: 'SOP Kho lạnh Đã xóa mềm', content: 'Quy trình sự cố kho lạnh bị soft-delete', active: true },
  );

  const tools = createDxosTools();
  const searchTool = tools.find((t) => t.definition.name === 'dxos_search_enterprise_context');
  const orchTool = tools.find((t) => t.definition.name === 'dxos_orchestrate_enterprise_case');
  const ctx = {
    db,
    state: { currentUser: { id: 2, username: 'emp' }, currentRoles: ['ldx_employee'] },
  };

  const searchRes = await searchTool.invoke(ctx, { query: 'kho lạnh', collections: ['latticeParaDocuments', 'latticeParaChunks'] });
  assert.equal(searchRes.items.some((i) => i.code === 'SOP-1'), true);
  assert.equal(searchRes.items.some((i) => i.code === 'SOP-4'), false, 'active:false doc and its chunks must be excluded');

  const corrRes = await orchTool.invoke(ctx, { mode: 'correlateCase', query: 'kho lạnh' });
  assert.equal(corrRes.sops.some((s) => s.code === 'SOP-1'), true);
  assert.equal(corrRes.sops.some((s) => s.code === 'SOP-4'), false, 'correlateCase must exclude active:false doc');
});

test('M3-R2 P1-11: redactPiiText redacts STK bank numbers in continuous unpunctuated Vietnamese prose without swallowing prose', () => {
  const { redactPiiText } = require(path.join(PLUGIN_ROOT, 'src/server/ai-governance.js'));

  const proseInput = 'STK: 19035123456789 tại ngân hàng Techcombank chi nhánh Sài Gòn hôm nay';
  const proseRes = redactPiiText(proseInput);
  assert.equal(proseRes.text.includes('19035123456789'), false);
  assert.equal(proseRes.text, 'STK: [REDACTED_BANK] tại ngân hàng Techcombank chi nhánh Sài Gòn hôm nay');
  assert.equal(proseRes.count, 1);

  const ibanInput = 'Chuyển khoản IBAN: DE89 3704 0044 0532 0130 00 tại ngân hàng';
  const ibanRes = redactPiiText(ibanInput);
  assert.equal(ibanRes.text.includes('3704'), false);
  assert.equal(ibanRes.text, 'Chuyển khoản IBAN: [REDACTED_BANK] tại ngân hàng');

  const safeText = 'Tài khoản ngân hàng Techcombank đang bảo trì định kỳ';
  assert.equal(redactPiiText(safeText).text, safeText);
});

// =========================================================================
// Final Milestone Phase 1 Regressions: T2-AI-01/T4-RW-06, T1-AISTUDIO-05, T2-AI-02
// =========================================================================
test('T2-AI-01 & T4-RW-06: ensureCollectionAndFields treats organizationId as immutable, avoids tenant defaultValue, and skips DDL updates when type is unchanged', async () => {
  const { ensureCollectionAndFields } = require(path.join(PLUGIN_ROOT, 'src/server/app-builder-orchestrator.js'));
  const { db, store } = makeDbHarness({ dialect: 'postgres' });

  const fieldUpdateCalls = [];
  const colSyncCalls = [];
  const origGetCollection = db.getCollection.bind(db);
  db.getCollection = (name) => {
    const col = origGetCollection(name);
    if (!col) return null;
    return {
      ...col,
      sync: async (opts) => {
        colSyncCalls.push({ name, opts });
      },
    };
  };
  const origGetRepo = db.getRepository.bind(db);
  db.getRepository = (name) => {
    const repo = origGetRepo(name);
    if (!repo) return null;
    if (name === 'collections') {
      return {
        ...repo,
        findOne: async (args) => {
          const hit = await repo.findOne(args);
          if (!hit) return null;
          const colFields = store.fields.filter((f) => f.collectionName === hit.name);
          const wrappedFields = colFields.map((f) => ({
            ...f,
            get: (k) => f[k],
            update: async (patch) => {
              fieldUpdateCalls.push({ name: f.name, patch: { ...patch } });
              if (f.name === 'organizationId') {
                throw new Error('PG16 policy violation: organizationId must never be updated');
              }
              if (Object.prototype.hasOwnProperty.call(patch, 'type') || Object.prototype.hasOwnProperty.call(patch, 'defaultValue')) {
                throw new Error('cannot alter type of a column used in a policy definition');
              }
              Object.assign(f, patch);
            },
          }));
          return {
            ...hit,
            get: (k) => (k === 'fields' ? wrappedFields : hit[k]),
            load: async () => {},
          };
        },
        create: async ({ values }) => {
          const created = await repo.create({ values });
          for (const fld of (values.fields || [])) {
            store.fields.push({ collectionName: values.name, ...fld });
          }
          return { ...created, load: async () => {} };
        },
      };
    }
    if (name === 'fields') {
      return {
        ...repo,
        update: async ({ filter, values }) => {
          fieldUpdateCalls.push({ name: filter?.name, patch: { ...values } });
          if (filter?.name === 'organizationId' || Object.prototype.hasOwnProperty.call(values, 'type') || Object.prototype.hasOwnProperty.call(values, 'defaultValue')) {
            throw new Error('cannot alter type of a column used in a policy definition');
          }
          return repo.update({ filter, values });
        },
      };
    }
    return repo;
  };

  // Org A creates shared collection
  await ensureCollectionAndFields(db, 'org-a', {
    collectionName: 'latticeCustomSharedOrders',
    collectionTitle: 'Shared Orders',
    fields: [{ name: 'amount', type: 'float', title: 'Amount' }],
  });

  const orgIdField = store.fields.find((f) => f.collectionName === 'latticeCustomSharedOrders' && f.name === 'organizationId');
  assert.ok(orgIdField, 'organizationId field must be provisioned');
  assert.equal(Object.prototype.hasOwnProperty.call(orgIdField, 'defaultValue'), false, 'organizationId must NOT bind a tenant-specific defaultValue');
  assert.equal(colSyncCalls.length, 1, 'Initial creation calls colInst.sync once');

  // Org B builds on the SAME shared collection with unchanged field types -> must NOT touch organizationId or trigger DDL updates
  fieldUpdateCalls.length = 0;
  colSyncCalls.length = 0;
  await ensureCollectionAndFields(db, 'org-b', {
    collectionName: 'latticeCustomSharedOrders',
    collectionTitle: 'Shared Orders',
    fields: [{ name: 'amount', type: 'float', title: 'Amount' }],
  });

  assert.equal(fieldUpdateCalls.some((c) => c.name === 'organizationId'), false, 'organizationId must NEVER be updated after creation');
  assert.equal(fieldUpdateCalls.length, 0, 'Unchanged fields must not call exField.update');
  assert.equal(colSyncCalls.length, 0, 'Unchanged schema must not call colInst.sync');

  // Updating only non-DDL uiSchema title on existing non-organizationId field succeeds without passing type/defaultValue
  await ensureCollectionAndFields(db, 'org-b', {
    collectionName: 'latticeCustomSharedOrders',
    collectionTitle: 'Shared Orders',
    fields: [{ name: 'amount', type: 'float', title: 'Updated Amount' }],
  });
  assert.equal(fieldUpdateCalls.length, 1);
  assert.equal(fieldUpdateCalls[0].name, 'amount');
  assert.equal(fieldUpdateCalls[0].patch.uiSchema?.title, 'Updated Amount');
  assert.equal(Object.prototype.hasOwnProperty.call(fieldUpdateCalls[0].patch, 'type'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(fieldUpdateCalls[0].patch, 'defaultValue'), false);
});

test('T1-AISTUDIO-05: ensurePortalAndBlocks & orchestrateEnterpriseAppBuild deduplicate by (blockUse, collectionName) so multiple apps on same portal page get non-empty blockUids', async () => {
  const { orchestrateEnterpriseAppBuild } = require(path.join(PLUGIN_ROOT, 'src/server/app-builder-orchestrator.js'));
  const { db, store } = makeDbHarness({ dialect: 'mock' });
  const ctx = { db, app: { resourceManager: { getResource: () => null } }, state: { currentUser: { id: 99, username: 'root' } } };
  const actor = { userId: 99, username: 'root', organizationId: 'org-a', isAdmin: true, isRoot: true, roleNames: ['root'] };
  const okVerifier = async () => ({ ok: true, passedCount: 1, totalCount: 1, checks: [], failedChecks: [] });

  const app1 = await orchestrateEnterpriseAppBuild(ctx, db, actor, {
    appKey: 'shared-app-1',
    portalSlug: 'services',
    pageTitle: 'Shared Multi-App Page',
    roleName: 'ldx_shared_one',
    collectionName: 'latticeCustomSharedOne',
    fields: [{ name: 'title', type: 'string' }],
  }, { verifierOverride: okVerifier });
  const app1Uids = app1.builtApp?.artifactRefsJson?.portals?.[0]?.blockUids || [];
  assert.equal(app1Uids.length, 3, 'app1 must attach all 3 default blocks');
  assert.equal((app1.blocks || []).length, 3);

  // app2 targets the exact same (portalSlug, pageTitle) and uses the exact same default blockUse set, for a different collection
  const app2 = await orchestrateEnterpriseAppBuild(ctx, db, actor, {
    appKey: 'shared-app-2',
    portalSlug: 'services',
    pageTitle: 'Shared Multi-App Page',
    roleName: 'ldx_shared_two',
    collectionName: 'latticeCustomSharedTwo',
    fields: [{ name: 'title', type: 'string' }],
  }, { verifierOverride: okVerifier });
  const app2Uids = app2.builtApp?.artifactRefsJson?.portals?.[0]?.blockUids || [];
  assert.equal(app2Uids.length, 3, 'app2 with distinct collection must receive non-empty blockUids on shared page');
  assert.equal((app2.blocks || []).length, 3);
  assert.equal(app2Uids.some((u) => app1Uids.includes(u)), false, 'app2 block UIDs must not collide with app1');

  // Re-building app1 with the same collection must remain idempotent (no duplicate blocks)
  const app1Rebuild = await orchestrateEnterpriseAppBuild(ctx, db, actor, {
    appKey: 'shared-app-1',
    portalSlug: 'services',
    pageTitle: 'Shared Multi-App Page',
    roleName: 'ldx_shared_one',
    collectionName: 'latticeCustomSharedOne',
    fields: [{ name: 'title', type: 'string' }],
  }, { verifierOverride: okVerifier });
  assert.equal((app1Rebuild.blocks || []).length, 0, 'Idempotent rebuild for same (blockUse, collection) skips duplicates');
  assert.equal(store.flowModels.filter((m) => m.use !== 'BlockGridModel').length, 6);
});

test('T2-AI-02: validateQuickConnectBaseUrl & quickConnectLlm restrict local-host SSRF bypass by local-capable provider and LLM inference port', async () => {
  const { createDxosAiActions } = require(path.join(PLUGIN_ROOT, 'src/server/ai-resource.js'));
  const { validateQuickConnectBaseUrl, probeLlmHealth } = require(path.join(PLUGIN_ROOT, 'src/server/ai-llm-health.js'));
  const { db, store } = makeDbHarness();
  const actions = createDxosAiActions(db, {
    env: {},
    fetchImpl: async () => ({ ok: true, status: 200 }),
  });
  const postAdmin = (values) => ({
    method: 'POST',
    state: { currentUser: { id: 1, username: 'root' }, currentRoles: ['root'] },
    action: { params: { values } },
  });

  // 1. DB & internal service ports on loopback/bridge hosts MUST be rejected 400 SSRF_TARGET_FORBIDDEN even for local-capable providers
  for (const badUrl of [
    'http://127.0.0.1:5432/',
    'http://[::1]:8080/v1',
    'http://localhost:6379/',
    'http://127.0.0.1:27017/',
    'http://host.docker.internal:5678/',
    'http://127.0.0.1:1026/',
    'http://127.0.0.1:1883/',
  ]) {
    assert.throws(
      () => validateQuickConnectBaseUrl(badUrl, { provider: 'openai-completions' }),
      (err) => err.status === 400 && err.code === 'SSRF_TARGET_FORBIDDEN',
      `validateQuickConnectBaseUrl must reject ${badUrl} with 400 SSRF_TARGET_FORBIDDEN`,
    );
    await assert.rejects(
      () => actions.quickConnectLlm(postAdmin({
        provider: 'openai-completions',
        apiKey: 'sk-local-test',
        baseURL: badUrl,
        modelName: 'test-model',
      }), async () => {}),
      (err) => err.status === 400 && err.code === 'SSRF_TARGET_FORBIDDEN',
      `quickConnectLlm must reject ${badUrl} with 400 SSRF_TARGET_FORBIDDEN`,
    );
  }

  // 2. Cloud-only providers MUST NOT bypass loopback/bridge hosts even on local LLM ports
  for (const cloudProvider of ['openai', 'anthropic', 'google-genai', 'deepseek']) {
    await assert.rejects(
      () => actions.quickConnectLlm(postAdmin({
        provider: cloudProvider,
        apiKey: 'sk-cloud-test',
        baseURL: 'http://127.0.0.1:11434',
        modelName: 'test-model',
      }), async () => {}),
      (err) => err.status === 400 && err.code === 'SSRF_TARGET_FORBIDDEN',
      `Cloud-only provider ${cloudProvider} must not reach loopback`,
    );
  }

  // 3. Local-capable providers on allowlisted LLM inference ports (and DXOS_LOCAL_LLM_PORTS) succeed
  assert.equal(validateQuickConnectBaseUrl('http://127.0.0.1:20128/v1', { provider: '9router' }), 'http://127.0.0.1:20128/v1');
  assert.equal(validateQuickConnectBaseUrl('http://host.docker.internal:11434', { provider: 'ollama' }), 'http://host.docker.internal:11434');
  assert.equal(validateQuickConnectBaseUrl('http://127.0.0.1:1234/v1', { provider: 'openai-completions' }), 'http://127.0.0.1:1234/v1');
  assert.equal(validateQuickConnectBaseUrl('http://127.0.0.1:8000/v1', { provider: 'openai-completions' }), 'http://127.0.0.1:8000/v1');
  assert.equal(
    validateQuickConnectBaseUrl('http://127.0.0.1:9099/v1', { provider: 'openai-completions', env: { DXOS_LOCAL_LLM_PORTS: '9099' } }),
    'http://127.0.0.1:9099/v1',
  );

  // 4. probeLlmHealth also enforces port restriction on persisted llmServices rows
  store.llmServices.push({
    id: 99,
    name: 'ssrf-pg',
    provider: 'openai-completions',
    enabled: true,
    options: { baseURL: 'http://127.0.0.1:5432/', apiKey: 'sk-1' },
  });
  const probeBlocked = await probeLlmHealth(db, {
    isAdmin: true,
    llmServiceName: 'ssrf-pg',
    fetchImpl: async () => { throw new Error('must not fetch blocked port'); },
  });
  assert.equal(probeBlocked.ok, false);
  assert.equal(probeBlocked.code, 'SSRF_TARGET_FORBIDDEN');
});

test('T2-PARA-01 parity: rankHybridRecords enforces token-boundary and boundary-delimited phrase matching', () => {
  const { rankHybridRecords } = require(path.join(PLUGIN_ROOT, 'src/server/ai-hybrid-search.js'));
  const candidates = [
    {
      item: { id: 19, code: 'ACT-RW04-5F7B5A65-AD0E' },
      titleText: 'ACT-RW04-5F7B5A65-AD0E Active RW04',
      hayText: 'SOP RW04KB5F7B5A65EA3A SĐT: 0987654321 Email: privacy.rw04@example.com CCCD: 079091009999',
      rawSummary: 'SOP RW04KB5F7B5A65EA3A CCCD: 079091009999',
    },
    {
      item: { id: 20, code: 'SOP-COLD-999' },
      titleText: 'SOP-COLD-999 Quy trình kho lạnh',
      hayText: 'SOP-COLD-999 Quy trình kho lạnh chuẩn WHO mã số 999',
      rawSummary: 'Quy trình kho lạnh chuẩn WHO mã số 999',
    },
    {
      item: { id: 21, code: 'SOP-NO-MATCH' },
      titleText: 'Khonglanh 123',
      hayText: 'Khonglanh 123456',
      rawSummary: 'Khonglanh 123456',
    },
  ];

  // Zero-token / non-matching suffix '999' must NOT substring-match '079091009999'
  assert.deepEqual(rankHybridRecords('xyz_khong_ton_tai_999', [candidates[0]]), []);
  assert.deepEqual(rankHybridRecords('999', [candidates[0]]), []);

  // Whole token '999' matches SOP-COLD-999 only, never ACT-RW04 (079091009999)
  const tokenHits = rankHybridRecords('999', candidates);
  assert.deepEqual(tokenHits.map((r) => r.code), ['SOP-COLD-999']);

  // Multi-word boundary-delimited phrase 'kho lanh' matches 'kho lanh' but NOT 'khonglanh'
  const phraseHits = rankHybridRecords('kho lạnh', candidates);
  assert.deepEqual(phraseHits.map((r) => r.code), ['SOP-COLD-999']);
});
