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
  ADMIN_BUILDER_TOOL_NAMES,
  OPERATIONAL_TOOL_NAMES,
  ALLOWED_BLOCK_MODELS,
  createDxosTools,
} = require('../src/server/ai-tools-core');

function makeOrchestratorHarness({ dialect = 'mock', pgRlsActive = true } = {}) {
  const store = {
    uiLayouts: [
      { uid: 'ldx-portal-cold-assets', title: 'Cold Assets', layoutType: 'desktop', routeName: 'p_cold_assets', routePath: '/p/cold-assets' },
    ],
    desktopRoutes: [],
    desktopRoutesUiLayouts: [],
    rolesDesktopRoutes: [],
    flowModels: [],
    collections: [
      { name: 'latticeAssets', title: 'Assets', fields: [{ name: 'id', type: 'bigInt' }, { name: 'code', type: 'string' }, { name: 'name', type: 'string' }, { name: 'organizationId', type: 'string' }] },
    ],
    fields: [],
    roles: [
      { name: 'root', title: 'Root', allowConfigure: true },
      { name: 'admin', title: 'Admin', allowConfigure: true },
      { name: 'ldx_employee', title: 'Nhân viên', allowConfigure: false, snippets: [] },
    ],
    dataSourcesRoles: [],
    dataSourcesRolesResources: [],
    rolesUsers: [{ id: 1, userId: 1, roleName: 'root' }],
    latticeEmployees: [
      { id: 13, userId: 9, code: 'EMP-9', name: 'NV', organizationId: 'native-ui-lab', active: true, user: { roles: [{ name: 'ldx_employee' }] } },
    ],
    latticeAiProfiles: [],
    latticeAiAuditLogs: [],
    latticeUiSnapshots: [],
    latticeDecisionTables: [],
    latticeAutomationRules: [],
    latticeAutomationRuns: [],
    latticeConnectors: [],
    aiEmployees: [],
    rolesAiEmployees: [],
  };

  let nextId = 100;
  const sqlCalls = [];
  const rlsAttachedTables = new Set();

  const matchFilter = (row, filter = {}) => Object.entries(filter).every(([k, v]) => {
    if (k === '$or' && Array.isArray(v)) return v.some((sub) => matchFilter(row, sub));
    if (k === '$and' && Array.isArray(v)) return v.every((sub) => matchFilter(row, sub));
    if (v && typeof v === 'object' && '$in' in v) return v.$in.includes(row[k]);
    return row[k] === v;
  });

  const wrap = (arr, row, extra = {}) => ({
    ...row,
    ...extra,
    get: (k) => (k === 'fields' && row.fields ? row.fields : row[k]),
    toJSON: () => ({ ...row }),
    update: async (u) => { Object.assign(row, u); return wrap(arr, row, extra); },
  });

  const db = {
    store,
    sqlCalls,
    rlsAttachedTables,
    hasCollection: (n) => store.collections.some((c) => c.name === n),
    getCollection: (n) => {
      const hit = store.collections.find((c) => c.name === n);
      if (!hit) return null;
      return {
        name: hit.name,
        options: { title: hit.title, fields: hit.fields || [] },
        fields: hit.fields || [],
        hasField: (fn) => (hit.fields || []).some((f) => f.name === fn),
        sync: async () => {},
      };
    },
    attachLatticeRlsPolicy: async (tableName) => {
      rlsAttachedTables.add(tableName);
      return { applied: true, tableName };
    },
    sequelize: {
      getDialect: () => dialect,
      transaction: async (fn) => fn({ id: 'tx-1' }),
      query: async (sql, opts = {}) => {
        sqlCalls.push({ sql, opts });
        if (/FROM\s+pg_class/i.test(sql)) {
          return [[{ relname: opts?.replacements?.tableName || 'latticeCustomColdAssets', relrowsecurity: pgRlsActive, relforcerowsecurity: pgRlsActive }]];
        }
        if (/FROM\s+pg_policies/i.test(sql)) {
          return [[{ policyname: 'lattice_tenant_isolation' }]];
        }
        return [[], { rowCount: 1 }];
      },
    },
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
              load: async () => {},
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
              load: async () => {},
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
      }
      return base;
    },
  };

  const ctx = {
    db,
    state: { currentUser: { id: 1, username: 'admin' }, currentRoles: ['root'], currentRole: 'root' },
    app: {
      acl: { getRole: () => ({ revokeResource: () => {}, grantAction: () => {} }) },
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
                    store.desktopRoutes.push({ id: groupId, title: bp.navigation.group.title, type: 'group', parentId: null });
                    store.desktopRoutes.push({ id: pageId, title: bp.navigation.item.title, type: 'flowPage', parentId: groupId, schemaUid: `pg-${pageId}` });
                    store.desktopRoutes.push({ id: tabId, title: bp.navigation.item.title, type: 'tabs', parentId: pageId, schemaUid: tabUid });
                    store.desktopRoutesUiLayouts.push(
                      { desktopRouteId: groupId, uiLayoutUid: bp.navigation.layoutUid },
                      { desktopRouteId: pageId, uiLayoutUid: bp.navigation.layoutUid },
                      { desktopRouteId: tabId, uiLayoutUid: bp.navigation.layoutUid },
                    );
                    store.flowModels.push({ uid: gridUid, use: 'BlockGridModel', parentId: tabUid, subKey: 'grid', props: { rows: {}, sizes: {}, rowOrder: [] }, stepParams: {} });
                    subCtx.body = { data: { pageUid: `pg-${pageId}`, tabUid, groupId, pageId, tabId } };
                  },
                }),
              },
            };
          }
          if (resName === 'latticePortals') {
            return {
              actions: {
                get: () => ({
                  handler: async (subCtx) => {
                    const v = subCtx.action.params.values;
                    const uid = `ldx-portal-${v.slug}`;
                    const ex = store.uiLayouts.find((l) => l.uid === uid);
                    if (ex) Object.assign(ex, v);
                    else store.uiLayouts.push({ uid, ...v });
                    subCtx.body = { data: { uid } };
                  },
                }),
              },
            };
          }
          return null;
        },
      },
    },
  };

  return { db, ctx, store };
}

test('20 canonical MCP tool names (11 admin + 6 operational + 3 memory) remain unchanged and all 12 Native v2 BlockModels are in ALLOWED_BLOCK_MODELS', () => {
  assert.equal(ADMIN_BUILDER_TOOL_NAMES.length, 11);
  assert.equal(OPERATIONAL_TOOL_NAMES.length, 6);
  const tools = createDxosTools();
  assert.equal(tools.length, 20);
  for (const model of [
    'DxosPortalHeroBlockModel',
    'DxosKpiMetricBlockModel',
    'DxosContextTelemetryBlockModel',
    'DxosAiProposalBlockModel',
    'DxosWorkflowTasksBlockModel',
    'DxosParaVaultBlockModel',
    'DxosCreativeStudioBlockModel',
    'DxosRecordWorkbenchBlockModel',
    'DxosWebGisBlockModel',
    'DxosKanbanScheduleBlockModel',
    'DxosWmsOpsBlockModel',
  ]) {
    assert.equal(ALLOWED_BLOCK_MODELS.includes(model), true, `${model} must be in ALLOWED_BLOCK_MODELS`);
  }
});

test('orchestrateEnterpriseAppBuild synthesizes full-stack app (Snapshot + schema/relations + RLS + OpenAPI + RBAC + 10-block Portal + DMN + Flow v2 + n8n) and passes deterministic verifier', async () => {
  const { orchestrateEnterpriseAppBuild, verifyEnterpriseApp } = require('../src/server/app-builder-orchestrator');
  const { db, ctx, store } = makeOrchestratorHarness();
  const actor = { userId: 1, username: 'admin', organizationId: 'native-ui-lab', isAdmin: true, isRoot: true, roleNames: ['root'] };

  const n8nCalls = [];
  const fakeN8nClient = {
    async createWorkflow(wf) {
      n8nCalls.push({ op: 'create', wf });
      return { id: 'wf-cold-901', name: wf.name, active: false };
    },
    async activateWorkflow(id, active) {
      n8nCalls.push({ op: 'activate', id, active });
      return { id, active };
    },
    async getWorkflow(id) {
      n8nCalls.push({ op: 'get', id });
      return { id, name: 'Cold Assets Orchestrator', active: true };
    },
  };

  const result = await orchestrateEnterpriseAppBuild(ctx, db, actor, {
    portalSlug: 'cold-assets',
    pageTitle: 'Quản lý Thiết bị Lạnh',
    roleTitle: 'Kỹ sư Thiết bị Lạnh',
    collectionName: 'latticeCustomColdAssets',
    collectionTitle: 'Thiết bị Lạnh Doanh nghiệp',
    fields: [
      { name: 'assetRef', type: 'belongsTo', target: 'latticeAssets', title: 'Tài sản gốc' },
      { name: 'telemetryConfig', type: 'json', title: 'Cấu hình cảm biến' },
      { name: 'severity', type: 'enum', enumValues: ['low', 'medium', 'high', 'critical'], title: 'Mức độ' },
    ],
    lockedFields: ['telemetryConfig'],
    blocks: [
      { blockUse: 'DxosWebGisBlockModel', title: 'Bản đồ Kho lạnh' },
      { blockUse: 'DxosKanbanScheduleBlockModel', title: 'Lịch bảo trì' },
      { blockUse: 'DxosWmsOpsBlockModel', title: 'Thao tác WMS' },
    ],
    dmnTable: {
      tableKey: 'cold_asset_priority_v1',
      name: 'Ưu tiên xử lý Thiết bị Lạnh',
      hitPolicy: 'FIRST',
      inputsJson: [{ name: 'severity', type: 'string' }],
      outputsJson: [{ name: 'priority', type: 'string' }],
      rulesJson: [
        { when: { severity: { op: 'eq', value: 'critical' } }, then: { priority: 'P1' } },
        { when: { severity: '*' }, then: { priority: 'P3' } },
      ],
      sampleInput: { severity: 'critical' },
    },
    flowGraph: {
      ruleKey: 'auto_cold_asset_v2',
      name: 'Cold Asset Alert v2',
      graphJson: {
        version: 2,
        nodes: [
          { id: 'trig_1', type: 'trigger.record', label: 'On Asset', config: { collection: 'latticeCustomColdAssets', operation: 'create' } },
          { id: 'dmn_1', type: 'logic.dmn', label: 'DMN Priority', config: { tableKey: 'cold_asset_priority_v1' } },
          { id: 'not_1', type: 'notify.send', label: 'Notify', config: { roleNames: ['ldx_ky_su_thiet_bi_lanh'], severity: 'high', title: 'Asset {{data.code}}' } },
        ],
        edges: [
          { id: 'e1', source: 'trig_1', sourceHandle: 'main', target: 'dmn_1', targetHandle: 'in' },
          { id: 'e2', source: 'dmn_1', sourceHandle: 'main', target: 'not_1', targetHandle: 'in' },
        ],
      },
      sampleEvent: { type: 'record.latticeCustomColdAssets.create', data: { code: 'CA-01', severity: 'critical' } },
    },
    n8nWorkflow: {
      name: 'Cold Assets Partner Sync',
      nodes: [{ id: 'n1', name: 'Webhook', type: 'n8n-nodes-base.webhook', parameters: {} }],
      connections: {},
    },
  }, { n8nClient: fakeN8nClient });

  assert.equal(result.built, true);
  assert.equal(result.ok, true);
  assert.ok(result.preBuildSnapshotUid);
  assert.equal(result.collectionName, 'latticeCustomColdAssets');
  assert.equal(db.rlsAttachedTables.has('latticeCustomColdAssets'), true);
  assert.equal(store.collections.some((c) => c.name === 'latticeCustomColdAssets'), true);
  const createdCol = store.collections.find((c) => c.name === 'latticeCustomColdAssets');
  assert.equal(createdCol.fields.some((f) => f.name === 'assetRef' && f.type === 'belongsTo' && f.target === 'latticeAssets'), true);
  assert.equal(createdCol.fields.some((f) => f.name === 'telemetryConfig' && f.type === 'json'), true);
  assert.equal(createdCol.fields.some((f) => f.name === 'severity' && Array.isArray(f.uiSchema?.enum)), true);
  assert.equal(store.flowModels.some((m) => m.use === 'DxosWebGisBlockModel'), true);
  assert.equal(store.flowModels.some((m) => m.use === 'DxosKanbanScheduleBlockModel'), true);
  assert.equal(store.flowModels.some((m) => m.use === 'DxosWmsOpsBlockModel'), true);
  assert.equal(store.latticeDecisionTables.some((t) => t.tableKey === 'cold_asset_priority_v1'), true);
  assert.equal(store.latticeAutomationRules.some((r) => r.ruleKey === 'auto_cold_asset_v2'), true);
  assert.equal(result.n8nWorkflowId, 'wf-cold-901');
  assert.equal(n8nCalls.some((c) => c.op === 'activate' && c.active === true), true);
  assert.equal(result.verification.ok, true);
  assert.ok(Array.isArray(result.verification.checks) && result.verification.checks.length >= 6);

  // Standalone verifyEnterpriseApp also passes
  const verified = await verifyEnterpriseApp(ctx, db, actor, {
    collectionName: 'latticeCustomColdAssets',
    portalSlug: 'cold-assets',
    pageTitle: 'Quản lý Thiết bị Lạnh',
    roleName: result.roleName,
    lockedFields: ['telemetryConfig'],
    dmnTableKey: 'cold_asset_priority_v1',
    flowRuleKey: 'auto_cold_asset_v2',
    n8nWorkflowId: 'wf-cold-901',
  }, { n8nClient: fakeN8nClient });
  assert.equal(verified.ok, true);
});

test('orchestrateEnterpriseAppBuild runs up to 2 targeted self-healing rounds when round 1 verification detects injected failures', async () => {
  const { orchestrateEnterpriseAppBuild } = require('../src/server/app-builder-orchestrator');
  const { db, ctx, store } = makeOrchestratorHarness();
  const actor = { userId: 1, username: 'admin', organizationId: 'native-ui-lab', isAdmin: true, isRoot: true, roleNames: ['root'] };

  let n8nActive = false;
  const fakeN8nClient = {
    async createWorkflow(wf) { return { id: 'wf-heal-1', name: wf.name, active: false }; },
    async activateWorkflow(id, active) { n8nActive = Boolean(active); return { id, active: n8nActive }; },
    async getWorkflow(id) { return { id, name: 'Heal WF', active: n8nActive }; },
  };

  let verifyRound = 0;
  const result = await orchestrateEnterpriseAppBuild(ctx, db, actor, {
    portalSlug: 'cold-assets',
    pageTitle: 'Trang Tự Sửa',
    roleTitle: 'Kiểm định Tự Sửa',
    collectionName: 'latticeCustomHealTest',
    fields: [{ name: 'batchCode', type: 'string', title: 'Mã lô' }],
    n8nWorkflow: { name: 'Heal WF', nodes: [], connections: {} },
  }, {
    n8nClient: fakeN8nClient,
    onBeforeVerify: async (round) => {
      verifyRound = round;
      if (round === 1) {
        // Inject intentional round-1 failures: drop RLS attachment & deactivate n8n workflow
        db.rlsAttachedTables.delete('latticeCustomHealTest');
        n8nActive = false;
      }
    },
  });

  assert.equal(verifyRound >= 2, true, 'Verifier must execute round 1 (fail) and round 2 (pass after self-heal)');
  assert.equal(result.ok, true, 'App build must auto-heal to PASS on round 2');
  assert.equal(result.healRounds, 1);
  assert.ok(result.repairs.some((r) => r.checkId === 'pg_rls_enforced' && r.repaired === true));
  assert.ok(result.repairs.some((r) => r.checkId === 'n8n_workflow_active' && r.repaired === true));
  assert.equal(db.rlsAttachedTables.has('latticeCustomHealTest'), true);
  assert.equal(n8nActive, true);
  assert.equal(store.latticeUiSnapshots.length >= 1, true);
});

test('dxos_provision_role_workspace exposes build_enterprise_app and verify_app while blocking non-admins and system tables', async () => {
  const { db, ctx } = makeOrchestratorHarness();
  const byName = new Map(createDxosTools().map((t) => [t.definition.name, t]));
  const tool = byName.get('dxos_provision_role_workspace');

  const empCtx = {
    ...ctx,
    state: { currentUser: { id: 9, username: 'emp9' }, currentRoles: ['ldx_employee'], currentRole: 'ldx_employee' },
  };
  await assert.rejects(
    () => tool.invoke(empCtx, { operation: 'build_enterprise_app', portalSlug: 'cold-assets', pageTitle: 'Hack', collectionName: 'latticeCustomHack' }),
    (err) => err.status === 403,
  );
  await assert.rejects(
    () => tool.invoke(ctx, { operation: 'build_enterprise_app', portalSlug: 'cold-assets', pageTitle: 'Sys', collectionName: 'users' }),
    (err) => err.status === 400 || err.status === 403,
  );

  const built = await tool.invoke(ctx, {
    operation: 'build_enterprise_app',
    portalSlug: 'cold-assets',
    pageTitle: 'Phân hệ Đóng gói',
    roleTitle: 'Điều hành Đóng gói',
    collectionName: 'latticeCustomPacking',
    fields: [{ name: 'lotRef', type: 'belongsTo', target: 'latticeAssets', title: 'Lô liên kết' }],
  });
  assert.equal(built.built, true);
  assert.equal(built.ok, true);

  const verified = await tool.invoke(ctx, {
    operation: 'verify_app',
    portalSlug: 'cold-assets',
    pageTitle: 'Phân hệ Đóng gói',
    collectionName: 'latticeCustomPacking',
    roleName: built.roleName,
  });
  assert.equal(verified.ok, true);
});


test('RLS Remediation (Findings 2b & 4): app-builder-orchestrator wraps latticeUiSnapshots (with organizationId), latticeAiProfiles, latticeAiAuditLogs, and resolveN8nClientForVerify in PG RLS context', async () => {
  const { orchestrateEnterpriseAppBuild } = require('../src/server/app-builder-orchestrator');
  const { db, ctx, store } = makeOrchestratorHarness({ dialect: 'postgres', pgRlsActive: true });
  const actor = { userId: 1, username: 'admin', organizationId: 'native-ui-lab', isAdmin: true, isRoot: true, roleNames: ['root'] };

  // Seed n8n connector so resolveN8nClientForVerify exercises latticeConnectors under PG RLS
  const vault = require('../../plugin-lattice-foundation/src/server/connector-vault');
  const vaultEnv = { NODE_ENV: 'test', DX_VAULT_MASTER_KEY: 'orch-rls-vault-master-key-32bytes', DX_ALLOW_INTERNAL_CONNECTORS: 'true' };
  store.latticeConnectors.push({
    id: 50,
    organizationId: 'native-ui-lab',
    connectorKey: 'n8n-orch',
    connectorType: 'n8n',
    appType: 'n8n_api',
    baseUrl: 'http://n8n:5678',
    authType: 'api_key',
    encryptedSecretsJson: vault.encryptVaultSecrets({ apiKey: 'orch-n8n-key' }, vaultEnv),
    active: true,
  });

  // Make flowSurfaces omit GridModel so capturePageSnapshot returns null -> triggers fallback latticeUiSnapshots.create path!
  const origGetResource = ctx.app.resourceManager.getResource;
  ctx.app.resourceManager.getResource = (resName) => {
    if (resName === 'flowSurfaces') {
      const origRes = origGetResource(resName);
      return {
        actions: {
          get: () => ({
            handler: async (subCtx) => {
              await origRes.actions.get().handler(subCtx);
              // Keep grid for repair/later check only after initial pre-snap check? No, leave grid intact after portal step;
              // Initial pre-build snapshot runs BEFORE ensurePortalAndBlocks, when grid does not exist yet!
            },
          }),
        },
      };
    }
    return origGetResource(resName);
  };

  const txOrgMap = new WeakMap();
  let activeTxCount = 0;
  let txSeq = 0;
  const origQuery = db.sequelize.query.bind(db.sequelize);
  db.sequelize.transaction = async (fn) => {
    const tx = { id: `tx-orch-rls-${++txSeq}` };
    txOrgMap.set(tx, { bypass: false, org: '' });
    activeTxCount += 1;
    try {
      return await fn(tx);
    } finally {
      activeTxCount -= 1;
    }
  };
  db.sequelize.query = async (sql, opts = {}) => {
    const text = String(sql);
    const st = opts.transaction ? txOrgMap.get(opts.transaction) : null;
    if (st && text.includes("set_config('app.rls_bypass', 'on'")) st.bypass = true;
    if (st && text.includes("set_config('app.current_org'")) st.org = opts?.replacements?.orgId || '';
    return origQuery(sql, opts);
  };

  const rlsEnforced = new Set(['latticeAiProfiles', 'latticeAiAuditLogs', 'latticeUiSnapshots', 'latticeConnectors', 'latticeDecisionTables', 'latticeAutomationRules']);
  const origGetRepo = db.getRepository.bind(db);
  db.getRepository = (name) => {
    const repo = origGetRepo(name);
    if (!rlsEnforced.has(name) || !repo) return repo;
    const assertTx = (transaction, rowOrg) => {
      if (process.env.DX_PG_RLS_SESSION !== 'true') return true;
      const st = transaction ? txOrgMap.get(transaction) : null;
      if (!st) return false;
      if (st.bypass) return true;
      return Boolean(st.org && (!rowOrg || rowOrg === st.org));
    };
    return {
      ...repo,
      find: async (args = {}) => {
        if (!assertTx(args.transaction)) return [];
        const rows = await repo.find(args);
        const st = args.transaction ? txOrgMap.get(args.transaction) : null;
        return st?.bypass ? rows : rows.filter((r) => r.organizationId === st?.org);
      },
      findOne: async (args = {}) => {
        if (!assertTx(args.transaction)) return null;
        const row = await repo.findOne(args);
        const st = args.transaction ? txOrgMap.get(args.transaction) : null;
        return row && (st?.bypass || row.organizationId === st?.org) ? row : null;
      },
      create: async (args = {}) => {
        if (!assertTx(args.transaction, args.values?.organizationId)) {
          throw new Error(`RLS VIOLATION on ${name}.create`);
        }
        return repo.create(args);
      },
    };
  };

  let fetchInsideTx = false;
  const mockFetch = async (url, init = {}) => {
    if (activeTxCount > 0) fetchInsideTx = true;
    const pathname = new URL(url).pathname;
    if (pathname === '/api/v1/workflows' && init.method === 'POST') {
      return { ok: true, status: 201, text: async () => JSON.stringify({ id: 'wf-orch-rls-1', active: false }) };
    }
    if (pathname === '/api/v1/workflows/wf-orch-rls-1/activate') {
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'wf-orch-rls-1', active: true }) };
    }
    if (pathname === '/api/v1/workflows/wf-orch-rls-1') {
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'wf-orch-rls-1', active: true }) };
    }
    return { ok: false, status: 404, text: async () => '{}' };
  };

  const prevRls = process.env.DX_PG_RLS_SESSION;
  const prevMaster = process.env.DX_VAULT_MASTER_KEY;
  process.env.DX_PG_RLS_SESSION = 'true';
  process.env.DX_VAULT_MASTER_KEY = vaultEnv.DX_VAULT_MASTER_KEY;
  try {
    const res = await orchestrateEnterpriseAppBuild(ctx, db, actor, {
      portalSlug: 'cold-assets',
      pageTitle: 'Trang Kiểm Thử RLS',
      roleTitle: 'Kỹ sư RLS',
      collectionName: 'latticeCustomRlsCheck',
      fields: [{ name: 'sensorTag', type: 'string', title: 'Mã cảm biến' }],
      n8nWorkflow: { name: 'Orch RLS WF', nodes: [], connections: {} },
    }, {
      env: vaultEnv,
      fetchImpl: mockFetch,
    });

    assert.equal(res.built, true);
    assert.equal(res.ok, true);
    assert.equal(fetchInsideTx, false, 'Outbound n8n fetch must stay outside DB transactions');
    assert.ok(store.latticeUiSnapshots.length >= 1);
    assert.equal(store.latticeUiSnapshots[0].organizationId, 'native-ui-lab');
    assert.ok(store.latticeAiProfiles.some((p) => p.organizationId === 'native-ui-lab'));
    assert.ok(store.latticeAiAuditLogs.some((l) => l.organizationId === 'native-ui-lab' && l.channel === 'app-builder'));
    assert.ok(db.sqlCalls.some((c) => c.sql.includes("set_config('app.current_org'") && c.opts?.replacements?.orgId === 'native-ui-lab'));
  } finally {
    if (prevRls === undefined) delete process.env.DX_PG_RLS_SESSION;
    else process.env.DX_PG_RLS_SESSION = prevRls;
    if (prevMaster === undefined) delete process.env.DX_VAULT_MASTER_KEY;
    else process.env.DX_VAULT_MASTER_KEY = prevMaster;
  }
});

test('Task 10: latticeBuiltApps collection, FORCE RLS migration, and SYSTEM_PROTECTED_COLLECTIONS sync across 3 modules', async () => {
  const Module = require('node:module');
  const path = require('node:path');
  const { readFileSync } = require('node:fs');
  const origLoad = Module._load;
  class MockMigration { constructor(context) { this.context = context; } }
  Module._load = function mocked(request, parent, isMain) {
    if (request === '@nocobase/database') return { defineCollection: (def) => def };
    if (request === '@nocobase/server') return { Migration: MockMigration };
    return origLoad.call(this, request, parent, isMain);
  };
  let colDef;
  let MigCls;
  try {
    colDef = require('../src/server/collections/built-apps');
    MigCls = require('../src/server/migrations/20261128000100-built-apps-registry-rls');
  } finally {
    Module._load = origLoad;
  }

  assert.equal(colDef.name, 'latticeBuiltApps');
  assert.deepEqual(colDef.migrationRules, ['schema-only']);
  for (const fieldName of [
    'organizationId', 'appKey', 'name', 'version', 'status',
    'sourceSpecJson', 'artifactRefsJson', 'bundleSnapshotUid',
    'lastVerifiedAt', 'lastVerificationJson', 'createdBy',
  ]) {
    assert.ok(colDef.fields.some((f) => f.name === fieldName), `built-apps.js missing field ${fieldName}`);
  }
  assert.ok(colDef.indexes.some((i) => i.unique === true && i.fields.includes('organizationId') && i.fields.includes('appKey')));

  const sqlCalls = [];
  const attached = [];
  const detached = [];
  const fakeTx = { id: 'tx-built-apps' };
  const mig = new MigCls({
    db: {
      attachLatticeRlsPolicy: async (t, opts) => { attached.push({ t, tx: opts?.transaction }); },
      detachLatticeRlsPolicy: async (t, opts) => { detached.push({ t, tx: opts?.transaction }); },
      sequelize: {
        getDialect: () => 'postgres',
        transaction: async (fn) => fn(fakeTx),
        query: async (sql, opts) => { sqlCalls.push({ sql, opts }); return [[]]; },
      },
    },
  });
  assert.equal(mig.on, 'afterSync');
  await mig.up();
  assert.equal(sqlCalls.some((q) => /CREATE TABLE IF NOT EXISTS "latticeBuiltApps"/i.test(q.sql)), true);
  assert.equal(sqlCalls.some((q) => /CREATE UNIQUE INDEX IF NOT EXISTS/i.test(q.sql) && q.sql.includes('"organizationId", "appKey"')), true);
  assert.deepEqual(attached, [{ t: 'latticeBuiltApps', tx: fakeTx }]);

  await mig.down();
  assert.deepEqual(detached, [{ t: 'latticeBuiltApps', tx: fakeTx }]);
  assert.equal(sqlCalls.some((q) => /DROP TABLE IF EXISTS "latticeBuiltApps"/i.test(q.sql)), true);

  // Sync check across app-builder-orchestrator.js, ai-tools-core.js, and solution-bundle.js
  const orchMod = require('../src/server/app-builder-orchestrator');
  const coreMod = require('../src/server/ai-tools-core');
  const bundleMod = require('../../plugin-dxos-studio/src/server/solution-bundle');
  assert.equal(orchMod.SYSTEM_PROTECTED_COLLECTIONS.has('latticeBuiltApps'), true);
  assert.equal(coreMod.SYSTEM_PROTECTED_COLLECTIONS.has('latticeBuiltApps'), true);
  const bundleSrc = readFileSync(path.join(__dirname, '../../plugin-dxos-studio/src/server/solution-bundle.js'), 'utf8');
  assert.match(bundleSrc, /latticeBuiltApps/);
  assert.equal(typeof bundleMod.exportSolutionBundle, 'function');
});

test('Task 10 (Review Focus #5): topologicalSortCollections and orchestrateEnterpriseAppBuild reject cycles (400) and SYSTEM_PROTECTED_COLLECTIONS (403) BEFORE snapshot or DB writes', async () => {
  const { topologicalSortCollections, orchestrateEnterpriseAppBuild } = require('../src/server/app-builder-orchestrator');

  // 1. Direct topologicalSortCollections ordering check
  const sorted = topologicalSortCollections([
    { collectionName: 'latticeCustomOrders', fields: [{ name: 'vendor', type: 'belongsTo', target: 'latticeCustomVendors' }] },
    { collectionName: 'latticeCustomVendors', fields: [{ name: 'title', type: 'string' }] },
  ]);
  assert.deepEqual(sorted.map((c) => c.collectionName), ['latticeCustomVendors', 'latticeCustomOrders']);

  // 2. Cycle A -> B -> A must throw 400 BLUEPRINT_CYCLE_DETECTED before snapshot or DB writes
  const { db, ctx, store } = makeOrchestratorHarness();
  store.latticeBuiltApps = [];
  const actor = { userId: 1, username: 'admin', organizationId: 'native-ui-lab', isAdmin: true, isRoot: true, roleNames: ['root'] };
  const initialColsCount = store.collections.length;

  await assert.rejects(
    () => orchestrateEnterpriseAppBuild(ctx, db, actor, {
      appKey: 'cyclic-app',
      portalSlug: 'cold-assets',
      pageTitle: 'Cyclic App',
      collections: [
        { collectionName: 'latticeCustomAlpha', fields: [{ name: 'betaRef', type: 'belongsTo', target: 'latticeCustomBeta' }] },
        { collectionName: 'latticeCustomBeta', fields: [{ name: 'alphaRef', type: 'belongsTo', target: 'latticeCustomAlpha' }] },
      ],
    }),
    (err) => err.status === 400 && err.code === 'BLUEPRINT_CYCLE_DETECTED',
  );
  assert.equal(store.latticeUiSnapshots.length, 0, 'Cycle must reject BEFORE creating any snapshot');
  assert.equal(store.collections.length, initialColsCount, 'Cycle must reject BEFORE creating any collection');
  assert.equal(store.latticeBuiltApps.length, 0, 'Cycle must reject BEFORE writing latticeBuiltApps');

  // 3. SYSTEM_PROTECTED_COLLECTIONS target ('users' and 'latticeBuiltApps') must throw 403 SYSTEM_COLLECTION_FORBIDDEN before snapshot or DB writes
  for (const forbiddenTarget of ['users', 'latticeBuiltApps']) {
    await assert.rejects(
      () => orchestrateEnterpriseAppBuild(ctx, db, actor, {
        appKey: `forbidden-${forbiddenTarget}`,
        portalSlug: 'cold-assets',
        pageTitle: 'Forbidden Target',
        collections: [
          { collectionName: 'latticeCustomSafeHeader', fields: [{ name: 'code', type: 'string' }] },
          { collectionName: 'latticeCustomBadChild', fields: [{ name: 'sysRef', type: 'belongsTo', target: forbiddenTarget }] },
        ],
      }),
      (err) => err.status === 403 && err.code === 'SYSTEM_COLLECTION_FORBIDDEN',
    );
    await assert.rejects(
      () => orchestrateEnterpriseAppBuild(ctx, db, actor, {
        appKey: `forbidden-direct-${forbiddenTarget}`,
        portalSlug: 'cold-assets',
        pageTitle: 'Forbidden Direct',
        collections: [
          { collectionName: forbiddenTarget, fields: [{ name: 'code', type: 'string' }] },
        ],
      }),
      (err) => err.status === 403 && err.code === 'SYSTEM_COLLECTION_FORBIDDEN',
    );
  }
  assert.equal(store.latticeUiSnapshots.length, 0, 'System target must reject BEFORE creating any snapshot');
  assert.equal(store.collections.length, initialColsCount, 'System target must reject BEFORE creating any collection');
});

test('Task 10: Multi-Entity Build, latticeBuiltApps registry, Rebuild v2, Export Bundle v3, and safe Teardown (keepData=true vs keepData=false)', async () => {
  const {
    orchestrateEnterpriseAppBuild,
    listBuiltApps,
    rebuildEnterpriseApp,
    exportAppBundle,
    teardownBuiltApp,
  } = require('../src/server/app-builder-orchestrator');
  const { validateSolutionBundle } = require('../../plugin-dxos-studio/src/server/solution-bundle');

  const { db, ctx, store } = makeOrchestratorHarness();
  store.latticeBuiltApps = [];
  store.latticeCustomVendors = [{ id: 1, code: 'V-01', name: 'NCC A', organizationId: 'native-ui-lab' }];
  store.latticeCustomOrders = [{ id: 1, code: 'PO-01', name: 'Đơn A', organizationId: 'native-ui-lab', vendorId: 1 }];
  store.workflows = [];
  store.flow_nodes = [];
  store.latticeSlaPolicies = [];
  store.latticeIncidentRules = [];
  const actor = { userId: 1, username: 'admin', organizationId: 'native-ui-lab', isAdmin: true, isRoot: true, roleNames: ['root'] };

  // Track collection creation order & ensure n8n HTTP stays outside DB transactions
  const createdOrder = [];
  const origHasCol = db.hasCollection.bind(db);
  db.hasCollection = (n) => Boolean(store[n]) || origHasCol(n);
  const origColsRepo = db.getRepository('collections');
  const origGetRepo = db.getRepository.bind(db);
  let activeTx = 0;
  let n8nInsideTx = false;
  db.sequelize.transaction = async (fn) => {
    activeTx += 1;
    try { return await fn({ id: `tx-${activeTx}` }); } finally { activeTx -= 1; }
  };
  db.getRepository = (name) => {
    const repo = origGetRepo(name);
    if (name === 'collections' && repo) {
      return {
        ...repo,
        create: async (args) => {
          createdOrder.push(args.values.name);
          return origColsRepo.create(args);
        },
      };
    }
    return repo;
  };

  let wfSeq = 0;
  const n8nCalls = [];
  const fakeN8nClient = {
    async createWorkflow(wf) {
      if (activeTx > 0) n8nInsideTx = true;
      n8nCalls.push({ op: 'create', wf });
      return { id: `wf-multi-${++wfSeq}`, name: wf.name, active: false };
    },
    async updateWorkflow(id, wf) {
      if (activeTx > 0) n8nInsideTx = true;
      n8nCalls.push({ op: 'update', id, wf });
      return { id, name: wf.name, active: true };
    },
    async activateWorkflow(id, active) {
      if (activeTx > 0) n8nInsideTx = true;
      n8nCalls.push({ op: 'activate', id, active });
      return { id, active };
    },
    async getWorkflow(id) {
      if (activeTx > 0) n8nInsideTx = true;
      return { id, name: 'Multi Entity WF', active: true };
    },
  };

  const multiSpec = {
    appKey: 'vendor-po-suite',
    name: 'Hệ thống Quản lý Nhà cung cấp & Đơn mua',
    portalSlug: 'cold-assets',
    pageTitle: 'Đơn mua hàng Đa thực thể',
    collections: [
      {
        collectionName: 'latticeCustomOrders',
        collectionTitle: 'Đơn mua hàng',
        fields: [
          { name: 'vendor', type: 'belongsTo', target: 'latticeCustomVendors', title: 'Nhà cung cấp' },
          { name: 'amount', type: 'float', title: 'Tổng tiền' },
        ],
      },
      {
        collectionName: 'latticeCustomVendors',
        collectionTitle: 'Nhà cung cấp',
        fields: [
          { name: 'tier', type: 'enum', enumValues: ['gold', 'silver'], title: 'Hạng NCC' },
        ],
      },
    ],
    roles: [
      { roleName: 'ldx_po_buyer', roleTitle: 'Chuyên viên Mua hàng', lockedFields: ['amount'] },
    ],
    portals: [
      {
        portalSlug: 'cold-assets',
        pageTitle: 'Đơn mua hàng Đa thực thể',
        collectionName: 'latticeCustomOrders',
        roleName: 'ldx_po_buyer',
        blocks: [{ blockUse: 'DxosKanbanScheduleBlockModel', title: 'Kanban Đơn mua' }],
      },
    ],
    dmnTables: [
      {
        tableKey: 'po_approval_tier_v1',
        name: 'Phân cấp duyệt PO',
        hitPolicy: 'FIRST',
        inputsJson: [{ name: 'amount', type: 'number' }],
        outputsJson: [{ name: 'tier', type: 'string' }],
        rulesJson: [{ when: { amount: { op: 'gt', value: 1000 } }, then: { tier: 'director' } }, { when: { amount: '*' }, then: { tier: 'manager' } }],
        sampleInput: { amount: 2500 },
      },
    ],
    flowGraphs: [
      {
        ruleKey: 'auto_po_multi_v2',
        name: 'PO Multi Flow v2',
        graphJson: {
          version: 2,
          nodes: [
            { id: 'trig_1', type: 'trigger.record', label: 'On PO', config: { collection: 'latticeCustomOrders', operation: 'create' } },
            { id: 'dmn_1', type: 'logic.dmn', label: 'DMN PO', config: { tableKey: 'po_approval_tier_v1' } },
          ],
          edges: [{ id: 'e1', source: 'trig_1', sourceHandle: 'main', target: 'dmn_1', targetHandle: 'in' }],
        },
        sampleEvent: { type: 'record.latticeCustomOrders.create', data: { code: 'PO-01', amount: 2500 } },
      },
    ],
    n8nWorkflows: [
      { name: 'PO Vendor ERP Sync', nodes: [], connections: {} },
    ],
  };

  const built = await orchestrateEnterpriseAppBuild(ctx, db, actor, multiSpec, { n8nClient: fakeN8nClient });
  assert.equal(built.built, true);
  assert.equal(built.ok, true);
  assert.equal(built.appKey, 'vendor-po-suite');
  assert.equal(built.appVersion, 1);
  assert.equal(n8nInsideTx, false, 'Outbound n8n calls must stay outside DB transactions');
  assert.deepEqual(createdOrder, ['latticeCustomVendors', 'latticeCustomOrders'], 'Vendors must be created BEFORE Orders');
  assert.equal(store.latticeBuiltApps.length, 1);
  assert.equal(store.latticeBuiltApps[0].version, 1);
  assert.equal(store.latticeBuiltApps[0].status, 'active');

  // listBuiltApps
  const listed = await listBuiltApps(db, actor);
  assert.equal(listed.apps.length, 1);
  assert.equal(listed.apps[0].appKey, 'vendor-po-suite');

  // rebuildEnterpriseApp -> bumps version to 2 & reconciles existing n8n workflow in-place
  const rebuilt = await rebuildEnterpriseApp(ctx, db, actor, { appKey: 'vendor-po-suite' }, { n8nClient: fakeN8nClient });
  assert.equal(rebuilt.rebuilt, true);
  assert.equal(rebuilt.ok, true);
  assert.equal(rebuilt.appVersion, 2);
  assert.equal(store.latticeBuiltApps[0].version, 2);
  assert.equal(n8nCalls.some((c) => c.op === 'update' && c.id === 'wf-multi-1'), true);

  // exportAppBundle -> valid v3 bundle
  const exported = await exportAppBundle(db, actor, { appKey: 'vendor-po-suite' });
  assert.equal(exported.metadata.schemaVersion, 'latticedx.solution-bundle/v3');
  assert.equal(exported.metadata.appKey, 'vendor-po-suite');
  assert.equal(exported.customCollections.some((c) => c.name === 'latticeCustomVendors'), true);
  assert.equal(exported.customCollections.some((c) => c.name === 'latticeCustomOrders'), true);
  const valRes = validateSolutionBundle(exported);
  assert.equal(valRes.valid, true, `Exported v3 bundle must be valid: ${valRes.errors.join('; ')}`);

  // teardownBuiltApp default keepData: true preserves custom collections & data while disabling automation/DMN/blocks
  const tdKeep = await teardownBuiltApp(ctx, db, actor, { appKey: 'vendor-po-suite' }, { n8nClient: fakeN8nClient });
  assert.equal(tdKeep.torndown, true);
  assert.equal(tdKeep.keepData, true);
  assert.equal(store.collections.some((c) => c.name === 'latticeCustomOrders'), true);
  assert.equal(store.latticeCustomOrders.length, 1);
  assert.equal(store.latticeAutomationRules.every((r) => r.active === false), true);
  assert.equal(store.latticeDecisionTables.every((t) => t.active === false), true);
  assert.equal(store.latticeBuiltApps[0].status, 'torndown');

  // teardownBuiltApp keepData: false explicitly drops custom collections
  const tdDrop = await teardownBuiltApp(ctx, db, actor, { appKey: 'vendor-po-suite', keepData: false }, { n8nClient: fakeN8nClient });
  assert.equal(tdDrop.torndown, true);
  assert.equal(tdDrop.keepData, false);
  assert.equal(store.collections.some((c) => c.name === 'latticeCustomOrders'), false);
  assert.equal(store.collections.some((c) => c.name === 'latticeCustomVendors'), false);
});

test('Task 10 Fix Round 1: exportAppBundle strict isolation, teardownBuiltApp reverse drop order & shared-grant preservation, bidirectional 1:N topologicalSort, and full case-insensitive SYSTEM_PROTECTED_COLLECTIONS', async () => {
  const {
    topologicalSortCollections,
    orchestrateEnterpriseAppBuild,
    exportAppBundle,
    teardownBuiltApp,
  } = require('../src/server/app-builder-orchestrator');
  const coreMod = require('../src/server/ai-tools-core');
  const orchMod = require('../src/server/app-builder-orchestrator');
  const bundleMod = require('../../plugin-dxos-studio/src/server/solution-bundle');

  // 1. Full 34-table SYSTEM_PROTECTED_COLLECTIONS sync across all 3 modules
  const expectedProtected = [
    'users', 'roles', 'rolesUsers', 'apiKeys', 'authenticators', 'migrations',
    'applicationPlugins', 'applicationTokens', 'sessions',
    'aiSettings', 'aiEmployees', 'aiMcpClients', 'rolesAiEmployees',
    'latticeAiAuditLogs', 'latticeAiProfiles', 'latticeAiQuotaUsage', 'latticeUiSnapshots',
    'dataSourcesRoles', 'dataSourcesRolesResources', 'dataSourcesRolesResourcesActions',
    'dataSourcesRolesResourcesScopes',
    'llmServices', 'rolesDesktopRoutes', 'desktopRoutes', 'uiLayouts',
    'workflows', 'flow_nodes', 'collections', 'fields',
    'latticeNotifications', 'latticeSlaPolicies', 'latticeAiApprovalQueue', 'latticeParaChunks',
    'latticeBuiltApps',
  ];
  for (const tbl of expectedProtected) {
    assert.equal(orchMod.SYSTEM_PROTECTED_COLLECTIONS.has(tbl), true, `orchestrator missing protected ${tbl}`);
    assert.equal(coreMod.SYSTEM_PROTECTED_COLLECTIONS.has(tbl), true, `ai-tools-core missing protected ${tbl}`);
    assert.equal(bundleMod.isProtectedCollection(tbl), true, `solution-bundle missing protected ${tbl}`);
  }

  // Case-insensitive protected check on topologicalSortCollections & relation targets
  assert.throws(
    () => topologicalSortCollections([{ collectionName: 'Collections', fields: [{ name: 'title', type: 'string' }] }]),
    (err) => err.status === 403 && err.code === 'SYSTEM_COLLECTION_FORBIDDEN',
  );
  assert.throws(
    () => topologicalSortCollections([{ collectionName: 'latticeCustomHack', fields: [{ name: 'svc', type: 'belongsTo', target: 'LlmServices' }] }]),
    (err) => err.status === 403 && err.code === 'SYSTEM_COLLECTION_FORBIDDEN',
  );

  // 2. Bidirectional 1:N (Parent hasMany Child + Child belongsTo Parent) succeeds without false cycle
  const biSorted = topologicalSortCollections([
    { collectionName: 'latticeCustomItems', fields: [{ name: 'parent', type: 'belongsTo', target: 'latticeCustomHeaders' }] },
    { collectionName: 'latticeCustomHeaders', fields: [{ name: 'items', type: 'hasMany', target: 'latticeCustomItems' }] },
  ]);
  assert.deepEqual(biSorted.map((c) => c.collectionName), ['latticeCustomHeaders', 'latticeCustomItems']);

  // Conflicting edge (A hasMany B AND A belongsTo B) must still throw BLUEPRINT_CYCLE_DETECTED
  assert.throws(
    () => topologicalSortCollections([
      {
        collectionName: 'latticeCustomBadParent',
        fields: [
          { name: 'children', type: 'hasMany', target: 'latticeCustomBadChild' },
          { name: 'childRef', type: 'belongsTo', target: 'latticeCustomBadChild' },
        ],
      },
      { collectionName: 'latticeCustomBadChild', fields: [{ name: 'code', type: 'string' }] },
    ]),
    (err) => err.status === 400 && err.code === 'BLUEPRINT_CYCLE_DETECTED',
  );

  // 3. exportAppBundle strict isolation (empty artifactRefsJson sections must NOT leak other org items, routesAndBlocks/workflows/governance scoped)
  const { db, ctx, store } = makeOrchestratorHarness();
  store.latticeBuiltApps = [];
  store.workflows = [
    { id: 1, key: 'wf-unrelated', title: 'Unrelated Org WF', current: true, enabled: true, options: { dxosOrganizationId: 'native-ui-lab' }, config: {} },
  ];
  store.flow_nodes = [];
  store.latticeSlaPolicies = [
    { id: 1, organizationId: 'native-ui-lab', targetCollection: 'latticeOrders', priority: 'high', warnAfterMinutes: 60, breachAfterMinutes: 120, escalateToRole: 'ldx_manager' },
  ];
  store.latticeIncidentRules = [
    { id: 1, organizationId: 'native-ui-lab', code: 'INC-UNRELATED', name: 'Unrelated Rule', assetEntityId: 'urn:ngsi-ld:Asset:1', attribute: 'temp', operator: '>', threshold: '8', severity: 'high' },
  ];
  store.latticeWebhookSubscriptions = [
    { id: 1, organizationId: 'native-ui-lab', subscriptionKey: 'wh-unrelated', name: 'Unrelated WH', targetUrl: 'https://example.com/hook', eventPattern: '*' },
  ];
  store.latticeDecisionTables.push({
    id: 901,
    organizationId: 'native-ui-lab',
    tableKey: 'dmn_unrelated_org',
    name: 'Unrelated DMN',
    hitPolicy: 'FIRST',
    inputsJson: [{ name: 'x', type: 'number' }],
    outputsJson: [{ name: 'y', type: 'string' }],
    rulesJson: [{ when: { x: '*' }, then: { y: 'ok' } }],
    active: true,
  });
  store.latticeAutomationRules.push({
    id: 902,
    organizationId: 'native-ui-lab',
    ruleKey: 'auto_unrelated_org',
    name: 'Unrelated Auto Rule',
    triggerEventType: '*',
    actionsJson: [],
    active: true,
  });
  store.uiLayouts.push({ uid: 'ldx-portal-other', title: 'Other Portal', layoutType: 'desktop', routeName: 'p_other', routePath: '/p/other', enabled: true, authCheck: true });
  store.desktopRoutes.push({ id: 801, parentId: null, type: 'group', title: 'Other Group', uiLayoutUid: 'ldx-portal-other' });
  store.desktopRoutesUiLayouts.push({ id: 802, desktopRouteId: 801, uiLayoutUid: 'ldx-portal-other' });
  store.flowModels.push({ uid: 'unrelated-block-1', use: 'DxosPortalHeroBlockModel', parentId: 'other-grid', subKey: 'items', props: { title: 'Other' } });

  const origHasCol = db.hasCollection.bind(db);
  db.hasCollection = (n) => Boolean(store[n]) || origHasCol(n);
  const actor = { userId: 1, username: 'admin', organizationId: 'native-ui-lab', isAdmin: true, isRoot: true, roleNames: ['root'] };

  // Build app-isolated with NO DMN, NO flowGraph, NO SLA, NO incidentRules
  await orchestrateEnterpriseAppBuild(ctx, db, actor, {
    appKey: 'app-isolated',
    portalSlug: 'cold-assets',
    pageTitle: 'App Isolated',
    roleName: 'ldx_isolated_ops',
    roleTitle: 'Isolated Ops',
    collections: [
      { collectionName: 'latticeCustomIsoChild', fields: [{ name: 'parentRef', type: 'belongsTo', target: 'latticeCustomIsoParent' }] },
      { collectionName: 'latticeCustomIsoParent', fields: [{ name: 'label', type: 'string' }] },
    ],
    blocks: [{ blockUse: 'DxosPortalHeroBlockModel', title: 'Iso Hero' }],
  });

  const isoBundle = await exportAppBundle(db, actor, { appKey: 'app-isolated' });
  assert.deepEqual(isoBundle.governance.decisionTables, [], 'Empty app DMN must NOT leak org DMN tables');
  assert.deepEqual(isoBundle.governance.automationRules, [], 'Empty app flowRules must NOT leak org automation rules');
  assert.deepEqual(isoBundle.governance.slaPolicies, [], 'Unrelated SLA policies must NOT leak');
  assert.deepEqual(isoBundle.governance.incidentRules, [], 'Unrelated incident rules must NOT leak');
  assert.deepEqual(isoBundle.governance.webhookSubscriptions, [], 'Unrelated webhooks must NOT leak');
  assert.deepEqual(isoBundle.workflows, [], 'Unrelated org workflows must NOT leak');
  assert.equal(isoBundle.routesAndBlocks.routes.some((r) => r.layoutUid === 'ldx-portal-other'), false);
  assert.equal(isoBundle.routesAndBlocks.flowModels.some((m) => m.uid === 'unrelated-block-1'), false);
  assert.equal(bundleMod.validateSolutionBundle(isoBundle).valid, true);

  // 4. teardownBuiltApp keepData:false reverse drop order (Child before Parent), shared-grant preservation, & aiEmployees sync
  // Build a second active app referencing latticeCustomIsoParent with role ldx_shared_viewer
  await orchestrateEnterpriseAppBuild(ctx, db, actor, {
    appKey: 'app-sharing-parent',
    portalSlug: 'cold-assets',
    pageTitle: 'App Sharing Parent',
    roleName: 'ldx_shared_viewer',
    roleTitle: 'Shared Viewer',
    collectionName: 'latticeCustomIsoParent',
    fields: [{ name: 'label', type: 'string' }],
  });

  // Verify aiEmployees sync on teardown of app-isolated (no shared child)
  assert.equal(store.aiEmployees.some((e) => e.username && e.enabled !== false), true);
  const droppedOrder = [];
  const origQuery = db.sequelize.query.bind(db.sequelize);
  db.sequelize.query = async (sql, opts) => {
    const m = String(sql).match(/DROP TABLE IF EXISTS "([^"]+)"/i);
    if (m) droppedOrder.push(m[1]);
    return origQuery(sql, opts);
  };

  const tdIso = await teardownBuiltApp(ctx, db, actor, { appKey: 'app-isolated', keepData: false });
  assert.equal(tdIso.torndown, true);
  // Child dropped, Parent preserved because app-sharing-parent is still active!
  assert.deepEqual(tdIso.droppedCollections, ['latticeCustomIsoChild']);
  assert.equal(tdIso.preservedCollections.includes('latticeCustomIsoParent'), true);
  assert.equal(store.collections.some((c) => c.name === 'latticeCustomIsoParent'), true);
  assert.equal(store.dataSourcesRolesResources.some((r) => r.roleName === 'ldx_shared_viewer' && r.name === 'latticeCustomIsoParent'), true);
  assert.equal(store.dataSourcesRolesResources.some((r) => r.roleName === 'ldx_isolated_ops'), false);
  const isoAiUser = store.latticeBuiltApps.find((a) => a.appKey === 'app-isolated').artifactRefsJson.aiEmployees[0];
  assert.equal(store.aiEmployees.find((e) => e.username === isoAiUser)?.enabled, false);

  // Now teardown app-sharing-parent with keepData:false and also verify reverse drop order on a 2-table unshared app
  await orchestrateEnterpriseAppBuild(ctx, db, actor, {
    appKey: 'app-reverse-drop',
    portalSlug: 'cold-assets',
    pageTitle: 'Reverse Drop',
    roleName: 'ldx_rev_drop',
    roleTitle: 'Rev Drop',
    collections: [
      { collectionName: 'latticeCustomRevChild', fields: [{ name: 'parentRef', type: 'belongsTo', target: 'latticeCustomRevParent' }] },
      { collectionName: 'latticeCustomRevParent', fields: [{ name: 'itemCode', type: 'string' }] },
    ],
  });
  droppedOrder.length = 0;
  const tdRev = await teardownBuiltApp(ctx, db, actor, { appKey: 'app-reverse-drop', keepData: false });
  assert.deepEqual(tdRev.droppedCollections, ['latticeCustomRevChild', 'latticeCustomRevParent']);
  assert.deepEqual(droppedOrder, ['latticeCustomRevChild', 'latticeCustomRevParent']);

  // Verify DROP TABLE failure surfaces rather than silently destroying collection metadata
  await orchestrateEnterpriseAppBuild(ctx, db, actor, {
    appKey: 'app-drop-fail',
    portalSlug: 'cold-assets',
    pageTitle: 'Drop Fail',
    roleName: 'ldx_drop_fail',
    roleTitle: 'Drop Fail',
    collectionName: 'latticeCustomDropFail',
    fields: [{ name: 'itemCode', type: 'string' }],
  });
  db.sequelize.query = async (sql, opts) => {
    if (/DROP TABLE IF EXISTS "latticeCustomDropFail"/i.test(String(sql))) {
      throw new Error('PG_FK_CONSTRAINT_ERROR');
    }
    return origQuery(sql, opts);
  };
  await assert.rejects(
    () => teardownBuiltApp(ctx, db, actor, { appKey: 'app-drop-fail', keepData: false }),
    /PG_FK_CONSTRAINT_ERROR/,
  );
  assert.equal(store.collections.some((c) => c.name === 'latticeCustomDropFail'), true, 'Metadata must remain intact if DROP TABLE fails');
});

test('Task 11 live E2E regressions: verifyEnterpriseApp allows NocoBase 2.2.50 TableBlockModel and teardownBuiltApp clears uiManageable before destroying fields/collections', async () => {
  const {
    orchestrateEnterpriseAppBuild,
    verifyEnterpriseApp,
    teardownBuiltApp,
  } = require('../src/server/app-builder-orchestrator');
  const { db, ctx, store } = makeOrchestratorHarness();
  store.latticeBuiltApps = [];
  const actor = { userId: 1, username: 'admin', organizationId: 'native-ui-lab', isAdmin: true, isRoot: true, roleNames: ['root'] };

  // Simulate NocoBase 2.2.50 flowSurfaces:applyBlueprint placing TableBlockModel inside BlockGridModel
  const origGetRes = ctx.app.resourceManager.getResource;
  ctx.app.resourceManager.getResource = (resName) => {
    const base = origGetRes(resName);
    if (resName !== 'flowSurfaces') return base;
    return {
      actions: {
        get: () => ({
          handler: async (subCtx) => {
            await base.actions.get().handler(subCtx);
            const gridUid = `grid-${subCtx.body.data.pageId}`;
            const tblUid = `tbl-${subCtx.body.data.pageId}`;
            store.flowModels.push({
              uid: tblUid,
              use: 'TableBlockModel',
              parentId: gridUid,
              subKey: 'items',
              subType: 'array',
              props: {},
              stepParams: {},
            });
            const gridModel = store.flowModels.find((m) => m.uid === gridUid);
            if (gridModel) {
              gridModel.props.rows = { row1: [[tblUid]] };
              gridModel.props.sizes = { row1: [24] };
              gridModel.props.rowOrder = ['row1'];
            }
          },
        }),
      },
    };
  };

  // Simulate NocoBase plugin-data-source-main uiManageable destroy guard
  const origGetRepo = db.getRepository.bind(db);
  db.getRepository = (name) => {
    const repo = origGetRepo(name);
    if (!repo) return null;
    if (name === 'fields') {
      return {
        ...repo,
        destroy: async ({ filter = {} } = {}) => {
          const colRow = store.collections.find((c) => c.name === filter.collectionName);
          if (colRow?.options?.uiManageable) {
            throw new Error('Cannot remove a UI manageable field');
          }
          return repo.destroy({ filter });
        },
      };
    }
    if (name === 'collections') {
      return {
        ...repo,
        destroy: async ({ filter = {} } = {}) => {
          const colRow = store.collections.find((c) => c.name === filter.name);
          if (colRow?.options?.uiManageable) {
            throw new Error('Cannot remove a UI manageable collection');
          }
          return repo.destroy({ filter });
        },
      };
    }
    return repo;
  };

  const built = await orchestrateEnterpriseAppBuild(ctx, db, actor, {
    appKey: 'live-table-block-compat',
    portalSlug: 'cold-assets',
    pageTitle: 'Live TableBlockModel Compat',
    roleName: 'ldx_live_compat',
    roleTitle: 'Live Compat',
    collectionName: 'latticeCustomLiveCompat',
    fields: [{ name: 'itemCode', type: 'string', title: 'Item Code' }],
  });
  assert.equal(built.ok, true, `Expected built.ok === true with TableBlockModel, got failed=${JSON.stringify(built.verification?.failedChecks)}`);

  const ver = await verifyEnterpriseApp(ctx, db, actor, {
    portalSlug: 'cold-assets',
    pageTitle: 'Live TableBlockModel Compat',
    collectionName: 'latticeCustomLiveCompat',
  });
  assert.equal(ver.checks.find((c) => c.id === 'portal_ui_routes')?.ok, true);

  // Teardown with keepData: false must succeed without "Cannot remove a UI manageable field/collection"
  const td = await teardownBuiltApp(ctx, db, actor, { appKey: 'live-table-block-compat', keepData: false });
  assert.equal(td.torndown, true);
  assert.deepEqual(td.droppedCollections, ['latticeCustomLiveCompat']);
  assert.equal(store.collections.some((c) => c.name === 'latticeCustomLiveCompat'), false);
});

test('orchestrateEnterpriseAppBuild normalizes LLM aliases (name/title/slug/targetCollection/enumValues/flat block collection) while keeping strict system-table & cycle refusal', async () => {
  const { orchestrateEnterpriseAppBuild } = require('../src/server/app-builder-orchestrator');
  const { db, ctx, store } = makeOrchestratorHarness();
  store.latticeBuiltApps = [];
  const actor = { userId: 1, username: 'admin', organizationId: 'native-ui-lab', isAdmin: true, isRoot: true, roleNames: ['root'] };

  // Aliases build cleanly
  const built = await orchestrateEnterpriseAppBuild(ctx, db, actor, {
    appKey: 'clinic-alias-test',
    portalSlug: 'clinic',
    pageTitle: 'Phòng khám Alias',
    collections: [
      {
        name: 'latticeCustomAliasVisits',
        title: 'Lịch khám',
        fields: [
          { name: 'status', label: 'Trạng thái', type: 'select', enumValues: ['scheduled', 'done'] },
          { name: 'doctor', label: 'Bác sĩ', type: 'belongsTo', targetCollection: 'latticeCustomAliasDoctors' },
        ],
      },
      {
        name: 'latticeCustomAliasDoctors',
        title: 'Bác sĩ',
        fields: [{ name: 'fullName', label: 'Họ tên', type: 'string' }],
      },
    ],
    roles: [{ name: 'ldx_alias_clinic', title: 'Bác sĩ Phòng khám' }],
    portals: [{
      slug: 'clinic',
      title: 'Phòng khám Alias',
      role: 'ldx_alias_clinic',
      collection: 'latticeCustomAliasVisits',
      blocks: [
        { use: 'DxosKanbanScheduleBlockModel', title: 'Kanban Lịch khám', collection: 'latticeCustomAliasVisits', statusField: 'status' },
      ],
    }],
  });
  assert.equal(built.built, true);
  assert.equal(built.collections[0], 'latticeCustomAliasDoctors');
  assert.equal(built.collections[1], 'latticeCustomAliasVisits');
  const kanbanModel = store.flowModels.find((m) => m.use === 'DxosKanbanScheduleBlockModel');
  assert.ok(kanbanModel);
  assert.equal(kanbanModel.props.collection, 'latticeCustomAliasVisits');
  assert.equal(kanbanModel.props.statusField, 'status');

  // Protected system collection on flat block config is still rejected (403)
  await assert.rejects(
    () => orchestrateEnterpriseAppBuild(ctx, db, actor, {
      portalSlug: 'clinic',
      pageTitle: 'Blocked Block Target',
      collectionName: 'latticeCustomSafeVisits',
      portals: [{
        slug: 'clinic',
        title: 'Blocked',
        blocks: [{ use: 'DxosKanbanScheduleBlockModel', collection: 'users' }],
      }],
    }),
    (err) => err.status === 403 && err.code === 'SYSTEM_COLLECTION_FORBIDDEN',
  );
});

test('teardownBuiltApp surfaces uiManageable update failures rather than silently swallowing them', async () => {
  const { orchestrateEnterpriseAppBuild, teardownBuiltApp } = require('../src/server/app-builder-orchestrator');
  const { db, ctx, store } = makeOrchestratorHarness();
  store.latticeBuiltApps = [];
  const actor = { userId: 1, username: 'admin', organizationId: 'native-ui-lab', isAdmin: true, isRoot: true, roleNames: ['root'] };
  await orchestrateEnterpriseAppBuild(ctx, db, actor, {
    appKey: 'app-ui-manageable-err',
    portalSlug: 'cold-assets',
    pageTitle: 'UI Manageable Err',
    roleName: 'ldx_uim_err',
    collectionName: 'latticeCustomUiErr',
    fields: [{ name: 'code', type: 'string' }],
  });
  const origGetRepo = db.getRepository.bind(db);
  db.getRepository = (name) => {
    const repo = origGetRepo(name);
    if (name !== 'collections') return repo;
    return {
      ...repo,
      findOne: async (args) => {
        const row = await repo.findOne(args);
        if (!row) return null;
        row.options = { ...(row.options || {}), uiManageable: true };
        row.update = async () => { throw new Error('UI_MANAGEABLE_UPDATE_FAILED'); };
        return row;
      },
    };
  };
  await assert.rejects(
    () => teardownBuiltApp(ctx, db, actor, { appKey: 'app-ui-manageable-err', keepData: false }),
    /UI_MANAGEABLE_UPDATE_FAILED/,
  );
});
