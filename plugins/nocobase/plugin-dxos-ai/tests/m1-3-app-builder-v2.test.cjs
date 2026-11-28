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
const EventEmitter = require('node:events');
const { readFileSync } = require('node:fs');
const Module = require('node:module');
const path = require('node:path');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(__dirname, '../../../..');

function makeM13Harness({ dialect = 'postgres', pgRlsActive = true } = {}) {
  const emitter = new EventEmitter();
  const store = {
    uiLayouts: [
      { uid: 'ldx-portal-cold-assets', title: 'Cold Assets', layoutType: 'desktop', routeName: 'p_cold_assets', routePath: '/p/cold-assets' },
      { uid: 'ldx-portal-services', title: 'Services', layoutType: 'desktop', routeName: 'p_services', routePath: '/p/services' },
    ],
    desktopRoutes: [],
    desktopRoutesUiLayouts: [],
    rolesDesktopRoutes: [],
    flowModels: [],
    collections: [
      { name: 'latticeAssets', title: 'Assets', fields: [{ name: 'id', type: 'bigInt' }, { name: 'code', type: 'string' }, { name: 'name', type: 'string' }, { name: 'organizationId', type: 'string' }] },
      { name: 'latticeOrders', title: 'Orders', fields: [{ name: 'id', type: 'bigInt' }, { name: 'code', type: 'string' }, { name: 'status', type: 'string' }, { name: 'organizationId', type: 'string' }] },
    ],
    fields: [],
    roles: [
      { name: 'root', title: 'Root', allowConfigure: true, snippets: ['*'] },
      { name: 'admin', title: 'Admin', allowConfigure: true, snippets: ['pm', 'pm.*'] },
      { name: 'ldx_employee', title: 'Employee', allowConfigure: false, snippets: [] },
    ],
    dataSourcesRoles: [],
    dataSourcesRolesResources: [],
    rolesUsers: [
      { id: 1, userId: 1, roleName: 'root' },
      { id: 2, userId: 2, roleName: 'ldx_employee' },
    ],
    latticeEmployees: [
      { id: 1, userId: 1, code: 'EMP-1', name: 'Admin', organizationId: 'org-a', active: true, user: { roles: [{ name: 'root' }] } },
      { id: 13, userId: 2, code: 'EMP-2', name: 'NV', organizationId: 'org-a', active: true, user: { roles: [{ name: 'ldx_employee' }] } },
    ],
    latticeAiProfiles: [],
    latticeAiAuditLogs: [],
    latticeUiSnapshots: [],
    latticeDecisionTables: [],
    latticeAutomationRules: [],
    latticeAutomationRuns: [],
    latticeConnectors: [],
    latticeBuiltApps: [],
    aiEmployees: [],
    rolesAiEmployees: [],
  };

  let nextId = 100;
  const sqlCalls = [];
  const rlsAttachedTables = new Set();
  const rlsAttachOrder = [];

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
    set: (k, v) => { row[k] = v; },
    toJSON: () => ({ ...row }),
    update: async (u) => { Object.assign(row, u); return wrap(arr, row, extra); },
  });

  const db = {
    store,
    sqlCalls,
    rlsAttachedTables,
    rlsAttachOrder,
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    removeListener: emitter.removeListener.bind(emitter),
    emitAsync: async (eventName, ...args) => {
      for (const fn of emitter.listeners(eventName)) {
        await fn(...args);
      }
    },
    hasCollection: (n) => Boolean(store[n]) || store.collections.some((c) => c.name === n),
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
      rlsAttachOrder.push(tableName);
      return { applied: true, tableName };
    },
    sequelize: {
      getDialect: () => dialect,
      transaction: async (fn) => fn({ id: 'tx-1' }),
      query: async (sql, opts = {}) => {
        sqlCalls.push({ sql, opts });
        if (/FROM\s+pg_class/i.test(sql)) {
          const tbl = opts?.replacements?.tableName || 'latticeCustomUnknown';
          return [[{ relname: tbl, relrowsecurity: pgRlsActive && rlsAttachedTables.has(tbl), relforcerowsecurity: pgRlsActive && rlsAttachedTables.has(tbl) }]];
        }
        if (/FROM\s+pg_policies/i.test(sql)) {
          const tbl = opts?.replacements?.tableName || '';
          return rlsAttachedTables.has(tbl) ? [[{ policyname: 'lattice_tenant_isolation' }]] : [[]];
        }
        return [[], { rowCount: 1 }];
      },
    },
    sync: async () => {},
    getRepository(name) {
      if (!store[name]) store[name] = [];
      const arr = store[name];
      const base = {
        find: async ({ filter = {}, sort, limit = 200 } = {}) => {
          let rows = arr.filter((r) => matchFilter(r, filter));
          if (Array.isArray(sort) && sort.includes('-id')) {
            rows = [...rows].sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
          }
          return rows.slice(0, limit).map((r) => {
            if (name === 'collections') {
              r.fields = store.fields.filter((f) => f.collectionName === r.name);
            }
            return wrap(arr, r);
          });
        },
        findOne: async ({ filter = {}, filterByTk } = {}) => {
          const hit = filterByTk != null
            ? arr.find((r) => String(r.id ?? r.uid ?? r.name) === String(filterByTk))
            : arr.find((r) => matchFilter(r, filter));
          if (!hit) return null;
          if (name === 'collections') {
            hit.fields = store.fields.filter((f) => f.collectionName === hit.name);
            return wrap(arr, hit, {
              load: async () => {
                hit.fields = store.fields.filter((f) => f.collectionName === hit.name);
              },
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
            if (Array.isArray(values.fields)) {
              for (const f of values.fields) {
                store.fields.push({ id: ++nextId, collectionName: row.name, ...f });
              }
            }
            row.fields = store.fields.filter((f) => f.collectionName === row.name);
            return wrap(arr, row, {
              load: async () => {
                row.fields = store.fields.filter((f) => f.collectionName === row.name);
              },
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
          for (let i = arr.length - 1; i >= 0; i -= 1) {
            if (matchFilter(arr[i], filter)) {
              arr.splice(i, 1);
              removed += 1;
            }
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
          Object.assign(hit, {
            ...node,
            props: { ...(hit.props || {}), ...(node.props || {}) },
            stepParams: { ...(hit.stepParams || {}), ...(node.stepParams || {}) },
          });
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

test('M1.3 BlockModel wiring: 12 Native v2 BlockModels incl. DxosBiChartBlockModel, flat BI props, dxos_compose_page_blocks, and dxos-architect prompt', async () => {
  const {
    ALL_NATIVE_V2_BLOCK_MODELS,
    orchestrateEnterpriseAppBuild,
  } = require('../src/server/app-builder-orchestrator');
  const { ALLOWED_BLOCK_MODELS, ADMIN_BUILDER_TOOL_NAMES, OPERATIONAL_TOOL_NAMES, createDxosTools } = require('../src/server/ai-tools-core');
  const { STARTER_AI_BLUEPRINTS } = require('../src/server/ai-schemas');

  assert.equal(ALL_NATIVE_V2_BLOCK_MODELS.length, 12);
  assert.equal(ALL_NATIVE_V2_BLOCK_MODELS.includes('DxosBiChartBlockModel'), true);
  assert.equal(ALLOWED_BLOCK_MODELS.includes('DxosBiChartBlockModel'), true);
  assert.equal(ADMIN_BUILDER_TOOL_NAMES.length, 11);
  assert.equal(OPERATIONAL_TOOL_NAMES.length, 6);

  const tools = createDxosTools();
  assert.equal(tools.length, 20, '20-tool MCP registry invariant (11 admin + 6 operational + 3 memory) must be preserved');

  const architect = STARTER_AI_BLUEPRINTS.find((b) => b.username === 'dxos-architect');
  assert.ok(architect);
  assert.match(architect.bio, /12 Native v2 BlockModels/);
  assert.match(architect.greeting, /12 BlockModels/);
  assert.match(architect.systemPrompt, /12 Native v2 BlockModels/);
  assert.match(architect.systemPrompt, /DxosBiChartBlockModel/);
  assert.match(architect.systemPrompt, /hasOne/);
  assert.match(architect.systemPrompt, /belongsToMany/);
  assert.match(architect.systemPrompt, /formula/);
  assert.match(architect.systemPrompt, /validation/);
  assert.match(architect.systemPrompt, /plan_enterprise_app/);
  assert.match(architect.systemPrompt, /patch_enterprise_app/);
  assert.match(architect.systemPrompt, /rollback_enterprise_app/);

  const { db, ctx, store } = makeM13Harness();
  const actor = { userId: 1, username: 'admin', organizationId: 'org-a', isAdmin: true, isRoot: true, roleNames: ['root'] };
  const built = await orchestrateEnterpriseAppBuild(ctx, db, actor, {
    appKey: 'bi-chart-app',
    portalSlug: 'services',
    pageTitle: 'BI Analytics',
    roleName: 'ldx_bi_analyst',
    collectionName: 'latticeCustomBiMetrics',
    fields: [
      { name: 'region', type: 'string', title: 'Region' },
      { name: 'revenue', type: 'float', title: 'Revenue' },
    ],
    blocks: [
      {
        blockUse: 'DxosBiChartBlockModel',
        title: 'Revenue by Region',
        collection: 'latticeCustomBiMetrics',
        chartType: 'bar',
        groupBy: 'region',
        metricOp: 'sum',
        metricField: 'revenue',
        limit: 15,
      },
    ],
  });
  assert.equal(built.ok, true);
  const biModel = store.flowModels.find((m) => m.use === 'DxosBiChartBlockModel');
  assert.ok(biModel);
  assert.equal(biModel.props.chartType, 'bar');
  assert.equal(biModel.props.groupBy, 'region');
  assert.equal(biModel.props.metricOp, 'sum');
  assert.equal(biModel.props.metricField, 'revenue');
  assert.equal(biModel.props.limit, 15);
  assert.equal(biModel.stepParams?.dxosBlockSettings?.config?.chartType, 'bar');

  // dxos_compose_page_blocks forwards args.collection when config.collection omitted
  const composeTool = tools.find((t) => t.definition.name === 'dxos_compose_page_blocks');
  const compRes = await composeTool.invoke({ ...ctx, db }, {
    action: 'addBlock',
    portalSlug: 'services',
    pageTitle: 'BI Analytics',
    blockUse: 'DxosBiChartBlockModel',
    title: 'Composed BI Chart',
    collection: 'latticeCustomBiMetrics',
    config: { chartType: 'pie', groupBy: 'status', metricOp: 'count' },
  });
  assert.equal(compRes.applied, true);
  const composedModel = store.flowModels.find((m) => m.uid === compRes.blockUid);
  assert.equal(composedModel.props.collection, 'latticeCustomBiMetrics');
  assert.equal(composedModel.props.chartType, 'pie');
});

test('M1.3 Rich Schema Engine alignment: 12 types, belongsToMany join table + FORCE RLS + RBAC + export/teardown, formula AST & validation hooks', async () => {
  const {
    orchestrateEnterpriseAppBuild,
    verifyEnterpriseApp,
    exportAppBundle,
    teardownBuiltApp,
  } = require('../src/server/app-builder-orchestrator');
  const { createDxosTools } = require('../src/server/ai-tools-core');
  const bundleMod = require('../../plugin-dxos-studio/src/server/solution-bundle');
  const { db, ctx, store } = makeM13Harness();
  const actor = { userId: 1, username: 'admin', organizationId: 'org-a', isAdmin: true, isRoot: true, roleNames: ['root'] };

  // Reject protected targets on hasOne / belongsToMany (403)
  await assert.rejects(
    () => orchestrateEnterpriseAppBuild(ctx, db, actor, {
      portalSlug: 'services',
      collectionName: 'latticeCustomBadOne',
      fields: [{ name: 'userProfile', type: 'hasOne', target: 'users' }],
    }),
    (err) => err.status === 403 && err.code === 'SYSTEM_COLLECTION_FORBIDDEN',
  );
  await assert.rejects(
    () => orchestrateEnterpriseAppBuild(ctx, db, actor, {
      portalSlug: 'services',
      collectionName: 'latticeCustomBadM2m',
      fields: [{ name: 'roleTags', type: 'belongsToMany', target: 'roles' }],
    }),
    (err) => err.status === 403 && err.code === 'SYSTEM_COLLECTION_FORBIDDEN',
  );

  // Reject ReDoS regex & unsafe formula
  await assert.rejects(
    () => orchestrateEnterpriseAppBuild(ctx, db, actor, {
      portalSlug: 'services',
      collectionName: 'latticeCustomBadRegex',
      fields: [{ name: 'serialCode', type: 'string', validation: { pattern: '(a+)+$' } }],
    }),
    (err) => err.status === 400 && err.code === 'INVALID_VALIDATION_PATTERN',
  );
  await assert.rejects(
    () => orchestrateEnterpriseAppBuild(ctx, db, actor, {
      portalSlug: 'services',
      collectionName: 'latticeCustomBadFormula',
      fields: [{ name: 'total', type: 'formula', formulaExpression: 'process.exit(1)', formulaReturnType: 'float' }],
    }),
    (err) => err.status === 400,
  );

  const built = await orchestrateEnterpriseAppBuild(ctx, db, actor, {
    appKey: 'rich-erp-app',
    portalSlug: 'services',
    pageTitle: 'Rich ERP',
    roleName: 'ldx_rich_erp',
    collections: [
      {
        collectionName: 'latticeCustomRichTags',
        collectionTitle: 'Tags',
        fields: [{ name: 'tagName', type: 'string', validation: { required: true, min: 2 } }],
      },
      {
        collectionName: 'latticeCustomRichSpecs',
        collectionTitle: 'Item Specs',
        fields: [{ name: 'weightKg', type: 'float', validation: { min: 0 } }],
      },
      {
        collectionName: 'latticeCustomRichItems',
        collectionTitle: 'Rich Items',
        fields: [
          { name: 'sku', type: 'string', validation: { required: true, unique: true, pattern: '^SKU-[0-9]{4}$' } },
          { name: 'unitPrice', type: 'float', validation: { min: 0, max: 1000000 } },
          { name: 'qty', type: 'integer', validation: { min: 1 } },
          { name: 'lineTotal', type: 'formula', formulaExpression: 'ROUND(unitPrice * qty, 2)', formulaReturnType: 'float' },
          { name: 'inspectAt', type: 'datetime' },
          { name: 'metaJson', type: 'json' },
          { name: 'specProfile', type: 'hasOne', target: 'latticeCustomRichSpecs', foreignKey: 'itemId' },
          { name: 'tags', type: 'belongsToMany', target: 'latticeCustomRichTags' },
        ],
      },
    ],
  });

  assert.equal(built.ok, true);
  assert.ok(Array.isArray(built.artifactRefs.joinCollections) && built.artifactRefs.joinCollections.length === 1);
  const joinCol = built.artifactRefs.joinCollections[0];
  assert.match(joinCol, /^latticeCustom[A-Za-z0-9_]*$/);

  // Join collection MUST be RLS-attached BEFORE main collection
  const joinRlsIdx = db.rlsAttachOrder.indexOf(joinCol);
  const mainRlsIdx = db.rlsAttachOrder.indexOf('latticeCustomRichItems');
  assert.ok(joinRlsIdx >= 0 && mainRlsIdx > joinRlsIdx, 'Join collection RLS must be attached before main collection');
  assert.equal(store.dataSourcesRolesResources.some((r) => r.roleName === 'ldx_rich_erp' && r.name === joinCol), true);

  // json type preserved for NocoBase compatibility
  const itemFields = store.fields.filter((f) => f.collectionName === 'latticeCustomRichItems');
  assert.equal(itemFields.find((f) => f.name === 'metaJson')?.type, 'json');
  assert.equal(itemFields.find((f) => f.name === 'inspectAt')?.type, 'datetime');
  assert.equal(itemFields.find((f) => f.name === 'specProfile')?.type, 'hasOne');
  assert.equal(itemFields.find((f) => f.name === 'tags')?.type, 'belongsToMany');

  // Formula field excluded from writableFields in RBAC
  const itemRbac = store.dataSourcesRolesResources.find((r) => r.roleName === 'ldx_rich_erp' && r.name === 'latticeCustomRichItems');
  const createAct = itemRbac.actions.find((a) => a.name === 'create');
  assert.equal(createAct.fields.includes('lineTotal'), false, 'Read-only formula field must be excluded from writableFields');

  // Runtime hooks attached via attachRichSchemaHooksForCollection enforce validation & formula!
  const invalidModel = { organizationId: 'org-a', sku: 'BAD', unitPrice: 10, qty: 2, isNewRecord: true };
  await assert.rejects(
    () => db.emitAsync('latticeCustomRichItems.beforeValidate', invalidModel, {}),
    (err) => err.code === 'VALIDATION_PATTERN',
  );
  const validModel = { organizationId: 'org-a', sku: 'SKU-1234', unitPrice: 12.5, qty: 4, isNewRecord: true };
  await db.emitAsync('latticeCustomRichItems.beforeValidate', validModel, {});
  await db.emitAsync('latticeCustomRichItems.beforeSave', validModel, {});
  assert.equal(validModel.lineTotal, 50);

  // verifyEnterpriseApp checks join collection RLS
  const ver = await verifyEnterpriseApp(ctx, db, actor, {
    collectionName: 'latticeCustomRichItems',
    joinCollections: [joinCol],
    portalSlug: 'services',
    pageTitle: 'Rich ERP',
    roleName: 'ldx_rich_erp',
  });
  assert.equal(ver.ok, true);
  assert.equal(ver.checks.some((c) => c.id.includes('pg_rls_enforced') && c.detail.includes(joinCol)), true);

  // exportAppBundle includes joinCollection & passes validateSolutionBundle
  const bundle = await exportAppBundle(db, actor, { appKey: 'rich-erp-app' });
  assert.equal(bundle.customCollections.some((c) => c.name === joinCol), true);
  const valRes = bundleMod.validateSolutionBundle(bundle);
  assert.equal(valRes.valid, true, `Exported bundle invalid: ${valRes.errors?.join('; ')}`);

  // dxos_extend_collection_schema supports rich field types + join table + hooks
  const tools = createDxosTools();
  const extendTool = tools.find((t) => t.definition.name === 'dxos_extend_collection_schema');
  const extRes = await extendTool.invoke({ ...ctx, db }, {
    operation: 'addFields',
    collectionName: 'latticeCustomRichItems',
    fields: [
      { name: 'discountRate', type: 'float', validation: { min: 0, max: 1 } },
      { name: 'netTotal', type: 'formula', formulaExpression: 'ROUND(lineTotal * (1 - discountRate), 2)', formulaReturnType: 'float' },
    ],
  });
  assert.equal(extRes.updated, true);

  // teardownBuiltApp keepData: false drops join collection BEFORE entity collections
  const dropped = [];
  const origQuery = db.sequelize.query.bind(db.sequelize);
  db.sequelize.query = async (sql, opts) => {
    const m = String(sql).match(/DROP TABLE IF EXISTS "([^"]+)"/i);
    if (m) dropped.push(m[1]);
    return origQuery(sql, opts);
  };
  const td = await teardownBuiltApp(ctx, db, actor, { appKey: 'rich-erp-app', keepData: false });
  assert.equal(td.torndown, true);
  assert.equal(dropped[0], joinCol, 'Join collection must be dropped before entity collections');
});

test('M1.3 Plan-Diff-Approve, patch_enterprise_app, rollback_enterprise_app & listBuiltAppVersions lifecycle', async () => {
  const {
    orchestrateEnterpriseAppBuild,
    planEnterpriseApp,
    patchEnterpriseApp,
    rollbackEnterpriseApp,
    listBuiltAppVersions,
  } = require('../src/server/app-builder-orchestrator');
  const { db, ctx, store } = makeM13Harness();
  const actor = { userId: 1, username: 'admin', organizationId: 'org-a', isAdmin: true, isRoot: true, roleNames: ['root'] };

  // 1. Pure dry-run planEnterpriseApp on greenfield spec -> ZERO DB mutations
  const snapCountBefore = store.latticeUiSnapshots.length;
  const colCountBefore = store.collections.length;
  const sqlCallsBefore = db.sqlCalls.length;
  const planRes = await planEnterpriseApp(ctx, db, actor, {
    appKey: 'planned-crm',
    portalSlug: 'services',
    pageTitle: 'CRM 2.0',
    roleName: 'ldx_crm_agent',
    collections: [
      {
        collectionName: 'latticeCustomAccounts',
        collectionTitle: 'Accounts',
        fields: [{ name: 'accountName', type: 'string', validation: { required: true } }],
      },
      {
        collectionName: 'latticeCustomContacts',
        collectionTitle: 'Contacts',
        fields: [
          { name: 'fullName', type: 'string' },
          { name: 'account', type: 'belongsTo', target: 'latticeCustomAccounts' },
        ],
      },
    ],
    blocks: [
      { blockUse: 'DxosBiChartBlockModel', title: 'Accounts Chart', collection: 'latticeCustomAccounts', chartType: 'bar', groupBy: 'status', metricOp: 'count' },
    ],
  });
  assert.equal(planRes.ok, true);
  assert.equal(planRes.dryRun, true);
  assert.equal(planRes.built, false);
  assert.equal(planRes.isUpdate, false);
  assert.equal(store.latticeUiSnapshots.length, snapCountBefore, 'planEnterpriseApp must NOT create snapshots');
  assert.equal(store.collections.length, colCountBefore, 'planEnterpriseApp must NOT create collections');
  assert.equal(db.sqlCalls.length, sqlCallsBefore, 'planEnterpriseApp must NOT run SQL queries');
  assert.ok(planRes.erGraph.nodes.length >= 2);
  assert.equal(planRes.erGraph.edges.some((e) => e.type === 'belongsTo' && e.source === 'latticeCustomContacts' && e.target === 'latticeCustomAccounts'), true);
  assert.ok(planRes.diff.collections.added.includes('latticeCustomAccounts'));
  assert.ok(planRes.diff.blocks.added.length >= 1);

  // 2. Build v1
  const v1 = await orchestrateEnterpriseAppBuild(ctx, db, actor, {
    appKey: 'crm-v1',
    portalSlug: 'services',
    pageTitle: 'CRM V1',
    roleName: 'ldx_crm_v1',
    collectionName: 'latticeCustomCrmDeals',
    fields: [
      { name: 'amount', type: 'float', title: 'Amount' },
      { name: 'stage', type: 'enum', enumValues: ['open', 'won', 'lost'], title: 'Stage' },
    ],
    blocks: [
      { blockUse: 'DxosPortalHeroBlockModel', title: 'CRM Hero' },
    ],
  });
  assert.equal(v1.appVersion, 1);

  // 3. Dry-run patchEnterpriseApp -> zero DB mutation, computes diff
  const dryPatch = await patchEnterpriseApp(ctx, db, actor, {
    appKey: 'crm-v1',
    dryRun: true,
    patch: {
      addFields: [{ collectionName: 'latticeCustomCrmDeals', name: 'discount', type: 'float' }],
      addBlocks: [{ blockUse: 'DxosBiChartBlockModel', title: 'Deals BI', collection: 'latticeCustomCrmDeals', chartType: 'bar', groupBy: 'stage', metricOp: 'sum', metricField: 'amount' }],
    },
  });
  assert.equal(dryPatch.dryRun, true);
  assert.equal(store.latticeBuiltApps[0].version, 1);
  assert.equal(dryPatch.diff.fields.added.some((x) => x.includes('discount')), true);

  // 4. Apply real patch (structured + NL) -> bumps version to 2, stores v1 snapshot in versionHistoryJson
  const v2 = await patchEnterpriseApp(ctx, db, actor, {
    appKey: 'crm-v1',
    summary: 'Add discount field and BI chart block',
    patch: {
      addFields: [{ collectionName: 'latticeCustomCrmDeals', name: 'discount', type: 'float', validation: { min: 0 } }],
      addBlocks: [{ blockUse: 'DxosBiChartBlockModel', title: 'Deals BI', collection: 'latticeCustomCrmDeals', chartType: 'bar', groupBy: 'stage', metricOp: 'sum', metricField: 'amount' }],
    },
  });
  assert.equal(v2.patched, true);
  assert.equal(v2.ok, true);
  assert.equal(v2.previousVersion, 1);
  assert.equal(v2.appVersion, 2);
  assert.equal(store.flowModels.some((m) => m.use === 'DxosBiChartBlockModel'), true);

  const versionsRes = await listBuiltAppVersions(db, actor, { appKey: 'crm-v1' });
  assert.equal(versionsRes.ok, true);
  assert.equal(versionsRes.currentVersion, 2);
  assert.ok(versionsRes.versions.some((v) => v.version === 1 && v.action === 'patch'));

  // 5. Rollback to v1 -> deprecates post-target field non-destructively, removes v2 BI block, bumps version to 3
  const rb = await rollbackEnterpriseApp(ctx, db, actor, { appKey: 'crm-v1', targetVersion: 1 });
  assert.equal(rb.rolledBack, true);
  assert.equal(rb.ok, true);
  assert.equal(rb.restoredFromVersion, 1);
  assert.equal(rb.appVersion, 3);
  const discountField = store.fields.find((f) => f.collectionName === 'latticeCustomCrmDeals' && f.name === 'discount');
  assert.ok(discountField, 'Post-target field must NOT be dropped');
  assert.equal(discountField.uiSchema?.deprecated, true, 'Post-target field must be non-destructively deprecated');
  assert.equal(store.flowModels.some((m) => m.use === 'DxosBiChartBlockModel'), false, 'v2 block must be removed after rollback to v1');
});

test('M1.3 Schema, Migration (20261130000100), MCP tools & REST endpoints (plan/patch/rollback/versions) with security guards', async () => {
  const origLoad = Module._load;
  class MockMigration { constructor(c) { this.context = c; } }
  Module._load = function (req, p, m) {
    if (req === '@nocobase/server') return { Migration: MockMigration };
    if (req === '@nocobase/database') return { defineCollection: (d) => d };
    return origLoad.call(this, req, p, m);
  };
  const builtAppsPath = path.join(PLUGIN_ROOT, 'src/server/collections/built-apps.js');
  const migPath = path.join(PLUGIN_ROOT, 'src/server/migrations/20261130000100-built-apps-version-history.js');
  let builtAppsDef;
  let MigCls;
  try {
    delete require.cache[require.resolve(builtAppsPath)];
    builtAppsDef = require(builtAppsPath);
  } finally {
    Module._load = origLoad;
  }
  assert.equal(builtAppsDef.fields.some((f) => f.name === 'versionHistoryJson'), true);

  const pgRls = require(path.join(REPO_ROOT, 'plugins/nocobase/plugin-lattice-foundation/src/server/pg-rls.js'));
  assert.ok(pgRls.TENANT_RLS_TABLES.length >= 47, `Expected >=47 TENANT_RLS_TABLES, got ${pgRls.TENANT_RLS_TABLES.length}`);
  assert.equal(pgRls.TENANT_RLS_TABLES.includes('latticeBuiltApps'), true);

  const migSrc = readFileSync(migPath, 'utf8');
  assert.match(migSrc, /SPDX-License-Identifier:\s*Apache-2\.0/);

  Module._load = function (req, p, m) {
    if (req === '@nocobase/server') return { Migration: MockMigration };
    return origLoad.call(this, req, p, m);
  };
  try {
    delete require.cache[require.resolve(migPath)];
    MigCls = require(migPath);
  } finally {
    Module._load = origLoad;
  }

  const sqlLog = [];
  const rlsCalls = [];
  const mig = new MigCls({
    db: {
      attachLatticeRlsPolicy: async (tbl) => { rlsCalls.push(tbl); },
      sequelize: {
        getDialect: () => 'postgres',
        transaction: async (fn) => fn({ id: 'tx-mig' }),
        query: async (sql) => {
          sqlLog.push(sql);
          if (sql.includes('information_schema.tables')) return [[{ table_name: 'latticeBuiltApps' }]];
          return [[]];
        },
      },
    },
  });
  assert.equal(mig.on, 'afterSync');
  await mig.up();
  assert.equal(sqlLog.some((s) => /ADD COLUMN IF NOT EXISTS "versionHistoryJson"/i.test(s)), true);
  assert.equal(rlsCalls.includes('latticeBuiltApps'), true);
  await mig.down();
  assert.equal(sqlLog.some((s) => /DROP COLUMN IF EXISTS "versionHistoryJson"/i.test(s)), true);

  // REST actions & ACL invariants
  const indexSrc = readFileSync(path.join(PLUGIN_ROOT, 'src/server/index.js'), 'utf8');
  for (const act of ['planBuiltApp', 'patchBuiltApp', 'rollbackBuiltApp', 'listBuiltAppVersions']) {
    assert.equal(indexSrc.includes(`'${act}'`), false, `${act} must stay admin-only (never acl.allow loggedIn)`);
  }

  const { createDxosAiActions } = require('../src/server/ai-resource');
  const { orchestrateEnterpriseAppBuild } = require('../src/server/app-builder-orchestrator');
  const { db, ctx } = makeM13Harness();
  const actor = { userId: 1, username: 'admin', organizationId: 'org-a', isAdmin: true, isRoot: true, roleNames: ['root'] };
  await orchestrateEnterpriseAppBuild(ctx, db, actor, {
    appKey: 'rest-app',
    portalSlug: 'services',
    pageTitle: 'REST App',
    roleName: 'ldx_rest_app',
    collectionName: 'latticeCustomRestApp',
    fields: [{ name: 'title', type: 'string' }],
  });

  const actions = createDxosAiActions(db);
  const adminReq = { method: 'POST', state: { currentUser: { id: 1, username: 'admin' }, currentRoles: ['root'] }, action: { params: {} }, body: null };
  const empReq = { method: 'POST', state: { currentUser: { id: 2, username: 'emp' }, currentRoles: ['ldx_employee'] }, action: { params: { values: { appKey: 'rest-app' } } }, body: null };

  // Non-admin refused (403)
  await assert.rejects(() => actions.planBuiltApp({ ...empReq }), (e) => e.status === 403);
  await assert.rejects(() => actions.patchBuiltApp({ ...empReq }), (e) => e.status === 403);
  await assert.rejects(() => actions.rollbackBuiltApp({ ...empReq }), (e) => e.status === 403);
  await assert.rejects(() => actions.listBuiltAppVersions({ ...empReq, method: 'GET' }), (e) => e.status === 403);

  // Wrong HTTP method refused (405)
  await assert.rejects(() => actions.listBuiltAppVersions({ ...adminReq, method: 'POST', action: { params: { appKey: 'rest-app' } } }), (e) => e.status === 405);
  await assert.rejects(() => actions.patchBuiltApp({ ...adminReq, method: 'GET' }), (e) => e.status === 405);

  // Prototype pollution rejected (400)
  const pollutedBody = JSON.parse('{"appKey":"rest-app","patch":{"__proto__":{"polluted":true}}}');
  await assert.rejects(
    () => actions.patchBuiltApp({ ...adminReq, request: { body: pollutedBody }, action: { params: {} } }),
    (e) => e.status === 400,
  );

  // Cross-org mismatch rejected (403 DXOS_ORG_MISMATCH) for non-root org admin
  db.store.roles.push({ name: 'ldx_org_admin', allowConfigure: true, snippets: ['pm.dxosAi'] });
  db.store.rolesUsers.push({ id: 3, userId: 3, roleName: 'ldx_org_admin' });
  db.store.latticeEmployees.push({ id: 14, userId: 3, organizationId: 'org-a', active: true });
  const orgAdminCtx = { method: 'GET', state: { currentUser: { id: 3, username: 'orgadmin' }, currentRoles: ['ldx_org_admin'] }, action: { params: { appKey: 'rest-app', organizationId: 'org-other' } }, body: null };
  await assert.rejects(() => actions.listBuiltAppVersions(orgAdminCtx), (e) => e.status === 403 && e.code === 'DXOS_ORG_MISMATCH');

  // Valid REST calls succeed
  const planCtx = { ...adminReq, action: { params: { values: { appKey: 'rest-app', prompt: 'Thêm trường priority' } } }, body: null };
  await actions.planBuiltApp(planCtx);
  assert.equal(planCtx.body.dryRun, true);
  assert.equal(planCtx.body.ok, true);

  const patchCtx = { ...adminReq, action: { params: { values: { appKey: 'rest-app', patch: { addFields: [{ collectionName: 'latticeCustomRestApp', name: 'priority', type: 'string' }] } } } }, body: null };
  await actions.patchBuiltApp(patchCtx);
  assert.equal(patchCtx.body.patched, true);

  const verCtx = { ...adminReq, method: 'GET', action: { params: { appKey: 'rest-app' } }, body: null };
  await actions.listBuiltAppVersions(verCtx);
  assert.equal(verCtx.body.currentVersion, 2);

  const rbCtx = { ...adminReq, action: { params: { values: { appKey: 'rest-app', targetVersion: 1 } } }, body: null };
  await actions.rollbackBuiltApp(rbCtx);
  assert.equal(rbCtx.body.rolledBack, true);
  assert.equal(rbCtx.body.appVersion, 3);

  // MCP dxos_provision_role_workspace operations (20-tool invariant preserved)
  const { createDxosTools } = require('../src/server/ai-tools-core');
  const tools = createDxosTools();
  assert.equal(tools.length, 20);
  const provTool = tools.find((t) => t.definition.name === 'dxos_provision_role_workspace');
  const mcpPlan = await provTool.invoke({ ...ctx, db }, {
    operation: 'plan_enterprise_app',
    appKey: 'rest-app',
    patch: { addFields: [{ collectionName: 'latticeCustomRestApp', name: 'notes', type: 'text' }] },
  });
  assert.equal(mcpPlan.dryRun, true);
  assert.equal(mcpPlan.ok, true);
  const mcpPatch = await provTool.invoke({ ...ctx, db }, {
    operation: 'patch_enterprise_app',
    appKey: 'rest-app',
    patch: { addFields: [{ collectionName: 'latticeCustomRestApp', name: 'notes', type: 'text' }] },
  });
  assert.equal(mcpPatch.patched, true);
  assert.equal(mcpPatch.appVersion, 4);
  const mcpRb = await provTool.invoke({ ...ctx, db }, {
    operation: 'rollback_enterprise_app',
    appKey: 'rest-app',
    targetVersion: 3,
  });
  assert.equal(mcpRb.rolledBack, true);
  assert.equal(mcpRb.appVersion, 5);
});

test('M1.3 Tab 7 Visual ER Graph (er-graph-panel.js), Plan-Diff Preview & Version Rollback UI in ai-studio-page.js', async () => {
  const { createDxosAiStudioPage } = require(path.join(PLUGIN_ROOT, 'src/client/ai-studio-page.js'));
  const { computeErGraphLayout, renderErGraphPanel } = require(path.join(PLUGIN_ROOT, 'src/client/er-graph-panel.js'));

  const apiCalls = [];
  const stateSlots = [];
  const refSlots = [];
  const effectSlots = [];
  const memoSlots = [];
  let stateIdx = 0; let refIdx = 0; let effectIdx = 0; let memoIdx = 0;
  const depsChanged = (prev, next) => !prev || !next || prev.length !== next.length || next.some((d, i) => d !== prev[i]);

  const React = {
    Fragment: 'Fragment',
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (init) => {
      const i = stateIdx++;
      if (!(i in stateSlots)) stateSlots[i] = typeof init === 'function' ? init() : init;
      return [stateSlots[i], (v) => { stateSlots[i] = typeof v === 'function' ? v(stateSlots[i]) : v; }];
    },
    useRef: (init) => {
      const i = refIdx++;
      if (!(i in refSlots)) refSlots[i] = { current: init };
      return refSlots[i];
    },
    useEffect: (fn, deps) => {
      const i = effectIdx++;
      effectSlots[i] = { fn, deps, changed: depsChanged(effectSlots[i]?.deps, deps) };
    },
    useMemo: (fn, deps) => {
      const i = memoIdx++;
      if (!memoSlots[i] || depsChanged(memoSlots[i].deps, deps)) memoSlots[i] = { value: fn(), deps };
      return memoSlots[i].value;
    },
    useCallback: (fn, deps) => {
      const i = memoIdx++;
      if (!memoSlots[i] || depsChanged(memoSlots[i].deps, deps)) memoSlots[i] = { value: fn, deps };
      return memoSlots[i].value;
    },
  };

  // Pure ER layout & SVG helper test
  const sampleGraph = {
    nodes: [
      { id: 'latticeCustomVendors', kind: 'entity', fields: [{ name: 'code', type: 'string', validation: { required: true } }] },
      { id: 'latticeCustomOrders', kind: 'entity', fields: [{ name: 'total', type: 'formula', formulaExpression: 'price * qty' }] },
    ],
    edges: [{ id: 'e1', source: 'latticeCustomOrders', target: 'latticeCustomVendors', type: 'belongsTo', fieldName: 'vendor' }],
  };
  const layout = computeErGraphLayout(sampleGraph);
  assert.equal(layout.nodes.length, 2);
  assert.equal(layout.edges.length, 1);
  const erTree = renderErGraphPanel(React, { erGraph: sampleGraph });
  assert.ok(JSON.stringify(erTree).includes('dxos-er-graph-svg'));

  const api = {
    request: async (req) => {
      apiCalls.push(req);
      if (req.url === 'dxosAi:listBuiltApps') {
        return {
          data: {
            data: {
              apps: [{
                id: 1,
                organizationId: 'org-a',
                appKey: 'er-app',
                name: 'ER App',
                version: 2,
                status: 'active',
                sourceSpecJson: {
                  collections: [
                    { collectionName: 'latticeCustomVendors', fields: [{ name: 'name', type: 'string', validation: { required: true } }] },
                    { collectionName: 'latticeCustomOrders', fields: [{ name: 'vendor', type: 'belongsTo', target: 'latticeCustomVendors' }] },
                  ],
                },
                artifactRefsJson: { collections: ['latticeCustomVendors', 'latticeCustomOrders'], roles: ['ldx_er'], portals: [] },
              }],
            },
          },
        };
      }
      if (req.url === 'dxosAi:planBuiltApp') {
        return {
          data: {
            data: {
              ok: true,
              dryRun: true,
              appKey: 'er-app',
              erGraph: sampleGraph,
              diff: { collections: { added: [], modified: ['latticeCustomOrders'], removed: [] }, fields: { added: ['latticeCustomOrders.note'], modified: [], removed: [] }, relations: { added: [], modified: [], removed: [] }, roles: { added: [], modified: [], removed: [] }, pages: { added: [], modified: [], removed: [] }, blocks: { added: [], modified: [], removed: [] }, flows: { added: [], modified: [], removed: [] }, dmnTables: { added: [], modified: [], removed: [] }, hasChanges: true },
            },
          },
        };
      }
      if (req.url === 'dxosAi:patchBuiltApp') {
        return { data: { data: { patched: true, ok: true, appKey: 'er-app', appVersion: 3 } } };
      }
      if (req.url === 'dxosAi:listBuiltAppVersions') {
        return {
          data: {
            data: {
              ok: true,
              appKey: 'er-app',
              currentVersion: 2,
              versions: [{ version: 1, action: 'patch', patchedAt: '2026-11-25T10:00:00Z', summary: 'Initial v1' }],
            },
          },
        };
      }
      if (req.url === 'dxosAi:rollbackBuiltApp') {
        return { data: { data: { rolledBack: true, ok: true, appKey: 'er-app', restoredFromVersion: 1, appVersion: 4 } } };
      }
      return { data: { data: { profiles: [], catalog: { availableTools: [] } } } };
    },
  };

  const Page = createDxosAiStudioPage({ useAPIClient: () => api }, React, {}, { defaultOrganizationId: 'org-a' });
  const render = () => {
    stateIdx = 0; refIdx = 0; effectIdx = 0; memoIdx = 0;
    const tree = Page();
    for (const eff of effectSlots) if (eff.changed) { eff.changed = false; eff.fn(); }
    return tree;
  };
  const findByTestId = (node, tid) => {
    if (!node || typeof node !== 'object') return null;
    if (node.props?.['data-testid'] === tid) return node;
    for (const k of (Array.isArray(node.children) ? node.children.flat(Infinity) : [])) {
      const hit = findByTestId(k, tid);
      if (hit) return hit;
    }
    return null;
  };

  let tree = render();
  findByTestId(tree, 'dxos-tab-built-apps').props.onClick();
  tree = render();
  await new Promise((r) => setTimeout(r, 20));
  tree = render();

  // Detail view shows ER SVG
  findByTestId(tree, 'dxos-built-app-view-er-app').props.onClick();
  tree = render();
  assert.ok(findByTestId(tree, 'dxos-er-graph-svg'), 'Detail view must render dxos-er-graph-svg');

  // Plan-Diff preview -> confirm patch
  findByTestId(tree, 'dxos-built-app-plan-toggle-er-app').props.onClick();
  tree = render();
  findByTestId(tree, 'dxos-plan-prompt-er-app').props.onChange({ target: { value: 'Thêm trường note' } });
  tree = render();
  await findByTestId(tree, 'dxos-plan-preview-btn-er-app').props.onClick();
  tree = render();
  assert.equal(apiCalls.some((c) => c.url === 'dxosAi:planBuiltApp'), true);
  assert.ok(findByTestId(tree, 'dxos-plan-diff-preview-er-app'));
  await findByTestId(tree, 'dxos-patch-apply-btn-er-app').props.onClick();
  tree = render();
  assert.equal(apiCalls.some((c) => c.url === 'dxosAi:patchBuiltApp'), true);

  // Version History & Rollback
  await findByTestId(tree, 'dxos-built-app-versions-btn-er-app').props.onClick();
  tree = render();
  assert.equal(apiCalls.some((c) => c.url === 'dxosAi:listBuiltAppVersions'), true);
  findByTestId(tree, 'dxos-rollback-btn-er-app-v1').props.onClick();
  tree = render();
  await findByTestId(tree, 'dxos-confirm-modal-ok').props.onClick();
  tree = render();
  assert.equal(apiCalls.some((c) => c.url === 'dxosAi:rollbackBuiltApp' && c.data.targetVersion === 1), true);
});

test('M1.3 NL router recognizes DxosBiChartBlockModel and plan/patch/rollback intents with admin enforcement', () => {
  const { parseVietnameseNaturalIntent } = require('../src/server/ai-nl-router');

  const biNl = parseVietnameseNaturalIntent('Gắn khối biểu đồ BI DxosBiChartBlockModel cho bảng latticeCustomOrders lên trang logistics', { isAdmin: true, portalSlug: 'logistics' });
  assert.equal(biNl.refused, false);
  assert.equal(biNl.toolName, 'dxos_compose_page_blocks');
  assert.equal(biNl.args.blockUse, 'DxosBiChartBlockModel');

  const planNl = parseVietnameseNaturalIntent('Lập kế hoạch dry-run cho ứng dụng appKey=cold-fleet-suite thêm trường ghi chú', { isAdmin: true });
  assert.equal(planNl.refused, false);
  assert.equal(planNl.toolName, 'dxos_provision_role_workspace');
  assert.equal(planNl.args.operation, 'plan_enterprise_app');

  const patchNl = parseVietnameseNaturalIntent('Cập nhật bổ sung ứng dụng appKey=cold-fleet-suite thêm trường priority', { isAdmin: true });
  assert.equal(patchNl.refused, false);
  assert.equal(patchNl.toolName, 'dxos_provision_role_workspace');
  assert.equal(patchNl.args.operation, 'patch_enterprise_app');

  const rbNl = parseVietnameseNaturalIntent('Hoàn tác ứng dụng appKey=cold-fleet-suite về phiên bản v1', { isAdmin: true });
  assert.equal(rbNl.refused, false);
  assert.equal(rbNl.toolName, 'dxos_provision_role_workspace');
  assert.equal(rbNl.args.operation, 'rollback_enterprise_app');
  assert.equal(rbNl.args.targetVersion, 1);

  assert.equal(parseVietnameseNaturalIntent('Hoàn tác ứng dụng appKey=cold-fleet-suite về phiên bản v1', { isAdmin: false }).refused, true);
});

test('M1.3 R2 Fix 1: patchEnterpriseApp deprecateFields persists uiSchema/options, excludes from RBAC writableFields, and addFields clears deprecated', async () => {
  const {
    orchestrateEnterpriseAppBuild,
    patchEnterpriseApp,
  } = require('../src/server/app-builder-orchestrator');
  const { db, ctx, store } = makeM13Harness();
  const actor = { userId: 1, username: 'admin', organizationId: 'org-a', isAdmin: true, isRoot: true, roleNames: ['root'] };

  await orchestrateEnterpriseAppBuild(ctx, db, actor, {
    appKey: 'dep-app',
    portalSlug: 'services',
    pageTitle: 'Dep App',
    roleName: 'ldx_dep_role',
    collectionName: 'latticeCustomDepOrders',
    fields: [
      { name: 'amount', type: 'float', title: 'Amount' },
      { name: 'note', type: 'string', title: 'Note' },
    ],
  });

  const patched = await patchEnterpriseApp(ctx, db, actor, {
    appKey: 'dep-app',
    patch: { deprecateFields: ['amount'] },
  });
  assert.equal(patched.ok, true);
  assert.equal(patched.appVersion, 2);

  const depField = store.fields.find((f) => f.collectionName === 'latticeCustomDepOrders' && f.name === 'amount');
  assert.ok(depField);
  assert.equal(depField.uiSchema?.deprecated, true, 'uiSchema.deprecated must persist after patchEnterpriseApp');
  assert.equal(depField.uiSchema?.['x-hidden'], true, 'uiSchema.x-hidden must persist after patchEnterpriseApp');
  assert.equal(depField.uiSchema?.readOnly, true, 'uiSchema.readOnly must persist after patchEnterpriseApp');
  assert.equal(depField.options?.deprecated, true, 'options.deprecated must persist after patchEnterpriseApp');

  const rbacRow = store.dataSourcesRolesResources.find((r) => r.roleName === 'ldx_dep_role' && r.name === 'latticeCustomDepOrders');
  assert.ok(rbacRow);
  const viewAct = rbacRow.actions.find((a) => a.name === 'view');
  const createAct = rbacRow.actions.find((a) => a.name === 'create');
  const updateAct = rbacRow.actions.find((a) => a.name === 'update');
  assert.equal(viewAct.fields.includes('amount'), true, 'deprecated field remains readable');
  assert.equal(createAct.fields.includes('amount'), false, 'deprecated field must be excluded from create writableFields');
  assert.equal(updateAct.fields.includes('amount'), false, 'deprecated field must be excluded from update writableFields');

  const reEnabled = await patchEnterpriseApp(ctx, db, actor, {
    appKey: 'dep-app',
    patch: { addFields: [{ collectionName: 'latticeCustomDepOrders', name: 'amount', type: 'float', title: 'Amount' }] },
  });
  assert.equal(reEnabled.ok, true);
  assert.equal(reEnabled.appVersion, 3);
  const restoredField = store.fields.find((f) => f.collectionName === 'latticeCustomDepOrders' && f.name === 'amount');
  assert.equal(restoredField.uiSchema?.deprecated, undefined, 're-adding via addFields must clear uiSchema.deprecated');
  assert.equal(restoredField.uiSchema?.['x-hidden'], undefined, 're-adding via addFields must clear uiSchema.x-hidden');
  assert.equal(restoredField.uiSchema?.readOnly, undefined, 're-adding via addFields must clear uiSchema.readOnly');
  assert.equal(restoredField.options?.deprecated, undefined, 're-adding via addFields must clear options.deprecated');
  const restoredCreate = store.dataSourcesRolesResources.find((r) => r.roleName === 'ldx_dep_role' && r.name === 'latticeCustomDepOrders').actions.find((a) => a.name === 'create');
  assert.equal(restoredCreate.fields.includes('amount'), true, 're-enabled field must be writable again');
});

test('M1.3 R2 Fix 2: applySpecPatch merges NL prompt and structured patch array buckets without dropping NL items', () => {
  const { applySpecPatch } = require('../src/server/app-builder-planner');
  const base = {
    appKey: 'merge-app',
    portalSlug: 'services',
    pageTitle: 'Merge App',
    roleName: 'ldx_merge',
    collectionName: 'latticeCustomTickets',
    fields: [{ name: 'title', type: 'string' }],
    blocks: [{ blockUse: 'DxosPortalHeroBlockModel', title: 'Hero' }],
  };
  const next = applySpecPatch(
    base,
    {
      addFields: [{ name: 'priority', type: 'string' }],
      addBlocks: [{ blockUse: 'DxosKanbanScheduleBlockModel', title: 'Kanban Board', collection: 'latticeCustomTickets' }],
    },
    'thêm trường notes kiểu text và gắn khối biểu đồ BI DxosBiChartBlockModel',
  );
  const fieldNames = next.fields.map((f) => f.name);
  assert.equal(fieldNames.includes('notes'), true, 'NL-derived field notes must be preserved');
  assert.equal(fieldNames.includes('priority'), true, 'structured patch field priority must be preserved');
  const blockUses = next.blocks.map((b) => b.blockUse);
  assert.equal(blockUses.includes('DxosBiChartBlockModel'), true, 'NL-derived BI block must be preserved');
  assert.equal(blockUses.includes('DxosKanbanScheduleBlockModel'), true, 'structured Kanban block must be preserved');
});

test('M1.3 R2 Fix 3: er-graph-panel.js guards null/undefined items in collections, fields, nodes, and edges', () => {
  const { deriveErGraphFromSpec, computeErGraphLayout, renderErGraphPanel } = require('../src/client/er-graph-panel');
  const React = { createElement: (type, props, ...children) => ({ type, props: props || {}, children }) };

  const g1 = deriveErGraphFromSpec({ collectionName: 'latticeCustomA', fields: [null, undefined, { name: 'ok', type: 'string' }] });
  assert.equal(g1.nodes.length, 1);
  assert.equal(g1.nodes[0].fields.length, 1);
  assert.equal(g1.nodes[0].fields[0].name, 'ok');

  const g2 = deriveErGraphFromSpec({ collections: [null, { collectionName: 'latticeCustomA', fields: [null] }] });
  assert.equal(g2.nodes.length, 1);

  const l1 = computeErGraphLayout({ nodes: [null, undefined], edges: [null, undefined] });
  assert.equal(l1.nodes.length, 0);
  assert.equal(l1.edges.length, 0);

  const emptyTree = renderErGraphPanel(React, { erGraph: { nodes: [null], edges: [null] } });
  assert.ok(JSON.stringify(emptyTree).includes('dxos-er-empty'));

  const validTree = renderErGraphPanel(React, {
    erGraph: {
      nodes: [null, { id: 'latticeCustomA', kind: 'entity', fields: [null, { name: 'code', type: 'string' }] }],
      edges: [null],
    },
    selectedNode: { id: 'latticeCustomA', kind: 'entity', fields: [null, { name: 'code', type: 'string' }] },
  });
  assert.ok(JSON.stringify(validTree).includes('dxos-er-graph-svg'));
});

test('M1.3 R2 Fix 4: schema-helper and MCP dxos_provision_role_workspace reject top-level prototype pollution with 400 PROTOTYPE_POLLUTION_FORBIDDEN', async () => {
  const { defineToolSchema } = require('../src/server/schema-helper');
  const { createDxosTools } = require('../src/server/ai-tools-core');
  const { db, ctx } = makeM13Harness();

  const strictSchema = defineToolSchema({ properties: { appKey: { type: 'string' } } });
  const r1 = strictSchema.validate(JSON.parse('{"appKey":"x","__proto__":{"polluted":true}}'));
  assert.equal(r1.ok, false);
  assert.equal(r1.code, 'PROTOTYPE_POLLUTION_FORBIDDEN');

  const openSchema = defineToolSchema({ additionalProperties: true, properties: {} });
  const r2 = openSchema.validate(JSON.parse('{"__proto__":{"polluted":true}}'));
  assert.equal(r2.ok, false);
  assert.equal(r2.code, 'PROTOTYPE_POLLUTION_FORBIDDEN');
  assert.equal(Object.prototype.polluted, undefined);

  const provTool = createDxosTools().find((t) => t.definition.name === 'dxos_provision_role_workspace');
  await assert.rejects(
    () => provTool.invoke({ ...ctx, db }, JSON.parse('{"operation":"plan_enterprise_app","appKey":"x","__proto__":{"polluted":true}}')),
    (err) => err.status === 400 && err.code === 'PROTOTYPE_POLLUTION_FORBIDDEN',
  );
  await assert.rejects(
    () => provTool.invoke({ ...ctx, db }, { operation: 'plan_enterprise_app', appKey: 'x', constructor: { prototype: { polluted: true } } }),
    (err) => err.status === 400 && err.code === 'PROTOTYPE_POLLUTION_FORBIDDEN',
  );
  assert.equal(Object.prototype.polluted, undefined);
});

test('M1.3 R2 Fix 5a: patchEnterpriseApp removeBlocks prunes removed block UIDs from artifactRefsJson.portals[].blockUids', async () => {
  const {
    orchestrateEnterpriseAppBuild,
    patchEnterpriseApp,
  } = require('../src/server/app-builder-orchestrator');
  const { db, ctx } = makeM13Harness();
  const actor = { userId: 1, username: 'admin', organizationId: 'org-a', isAdmin: true, isRoot: true, roleNames: ['root'] };
  const built = await orchestrateEnterpriseAppBuild(ctx, db, actor, {
    appKey: 'r2-rmblock-app',
    portalSlug: 'services',
    pageTitle: 'Remove Block App',
    roleName: 'ldx_rmblock',
    collectionName: 'latticeCustomRmBlock',
    fields: [{ name: 'title', type: 'string' }],
    blocks: [
      { blockUse: 'DxosPortalHeroBlockModel', title: 'RM Hero' },
      { blockUse: 'DxosBiChartBlockModel', title: 'RM BI', collection: 'latticeCustomRmBlock', chartType: 'bar', groupBy: 'status', metricOp: 'count' },
    ],
  });
  const biBlockUid = built.blocks.find((b) => b.use === 'DxosBiChartBlockModel')?.uid;
  assert.ok(biBlockUid);
  const patched = await patchEnterpriseApp(ctx, db, actor, {
    appKey: 'r2-rmblock-app',
    patch: { removeBlocks: ['RM BI'] },
  });
  const portalRef = patched.builtApp.artifactRefsJson.portals.find((p) => p.portalSlug === 'services');
  assert.equal(portalRef.blockUids.includes(biBlockUid), false, 'Removed block UID must be pruned from artifactRefsJson.portals[].blockUids');
});

test('M1.3 R2 Fix 5b: applyTargetedRepair attach_rls re-attaches RLS on belongsToMany joinCollections', async () => {
  const { orchestrateEnterpriseAppBuild } = require('../src/server/app-builder-orchestrator');
  const { db, ctx } = makeM13Harness();
  const actor = { userId: 1, username: 'admin', organizationId: 'org-a', isAdmin: true, isRoot: true, roleNames: ['root'] };
  const built = await orchestrateEnterpriseAppBuild(ctx, db, actor, {
    appKey: 'r2-rls-repair-app',
    portalSlug: 'services',
    pageTitle: 'RLS Repair App',
    roleName: 'ldx_rls_repair',
    collections: [
      { collectionName: 'latticeCustomRepairTags', fields: [{ name: 'tag', type: 'string' }] },
      {
        collectionName: 'latticeCustomRepairMain',
        fields: [
          { name: 'title', type: 'string' },
          { name: 'tags', type: 'belongsToMany', target: 'latticeCustomRepairTags' },
        ],
      },
    ],
  }, {
    onBeforeVerify: (round) => {
      if (round === 1) {
        for (const tbl of [...db.rlsAttachedTables]) {
          if (tbl.startsWith('latticeCustomRepairMain') && tbl !== 'latticeCustomRepairMain') {
            db.rlsAttachedTables.delete(tbl);
          }
        }
      }
    },
  });
  assert.equal(built.healRounds, 1, 'Self-heal must run 1 round when joinCollection RLS was missing');
  assert.equal(built.ok, true, 'App verification must pass after targeted attach_rls repair on joinCollection');
  assert.equal(built.repairs.some((r) => r.repairAction === 'attach_rls' && r.repaired === true), true);
  assert.equal(db.rlsAttachedTables.has(built.joinCollections[0]), true);
});

test('M1.3 R2 Fix 5c: Tab 7 UI refreshes builtAppSelected immediately when handleApplyPatchBuiltApp succeeds', async () => {
  const { createDxosAiStudioPage } = require('../src/client/ai-studio-page');
  const stateSlots = [];
  const refSlots = [];
  const effectSlots = [];
  const memoSlots = [];
  let stateIdx = 0; let refIdx = 0; let effectIdx = 0; let memoIdx = 0;
  const depsChanged = (prev, next) => !prev || !next || prev.length !== next.length || next.some((d, i) => d !== prev[i]);
  const React = {
    Fragment: 'Fragment',
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (init) => {
      const i = stateIdx++;
      if (!(i in stateSlots)) stateSlots[i] = typeof init === 'function' ? init() : init;
      return [stateSlots[i], (v) => { stateSlots[i] = typeof v === 'function' ? v(stateSlots[i]) : v; }];
    },
    useRef: (init) => {
      const i = refIdx++;
      if (!(i in refSlots)) refSlots[i] = { current: init };
      return refSlots[i];
    },
    useEffect: (fn, deps) => {
      const i = effectIdx++;
      effectSlots[i] = { fn, deps, changed: depsChanged(effectSlots[i]?.deps, deps) };
    },
    useMemo: (fn, deps) => {
      const i = memoIdx++;
      if (!memoSlots[i] || depsChanged(memoSlots[i].deps, deps)) memoSlots[i] = { value: fn(), deps };
      return memoSlots[i].value;
    },
    useCallback: (fn, deps) => {
      const i = memoIdx++;
      if (!memoSlots[i] || depsChanged(memoSlots[i].deps, deps)) memoSlots[i] = { value: fn, deps };
      return memoSlots[i].value;
    },
  };
  const currentAppRow = {
    id: 1,
    organizationId: 'org-a',
    appKey: 'ui-refresh-app',
    name: 'UI Refresh App',
    version: 1,
    bundleSnapshotUid: 'snap-v1',
    status: 'active',
    sourceSpecJson: { collectionName: 'latticeCustomUi', fields: [{ name: 'title', type: 'string' }] },
    artifactRefsJson: { collections: ['latticeCustomUi'], roles: ['ldx_ui'], portals: [] },
  };
  const api = {
    request: async (req) => {
      if (req.url === 'dxosAi:listBuiltApps') return { data: { data: { apps: [currentAppRow] } } };
      if (req.url === 'dxosAi:planBuiltApp') {
        return { data: { data: { ok: true, dryRun: true, appKey: 'ui-refresh-app', erGraph: { nodes: [], edges: [] }, diff: { hasChanges: true } } } };
      }
      if (req.url === 'dxosAi:patchBuiltApp') {
        const updated = { ...currentAppRow, version: 2, bundleSnapshotUid: 'snap-v2' };
        return { data: { data: { patched: true, ok: true, appKey: 'ui-refresh-app', appVersion: 2, builtApp: updated } } };
      }
      return { data: { data: { profiles: [], catalog: { availableTools: [] } } } };
    },
  };
  const Page = createDxosAiStudioPage({ useAPIClient: () => api }, React, {}, { defaultOrganizationId: 'org-a' });
  const render = () => {
    stateIdx = 0; refIdx = 0; effectIdx = 0; memoIdx = 0;
    const tree = Page();
    for (const eff of effectSlots) if (eff.changed) { eff.changed = false; eff.fn(); }
    return tree;
  };
  const findByTestId = (node, tid) => {
    if (!node || typeof node !== 'object') return null;
    if (node.props?.['data-testid'] === tid) return node;
    for (const k of (Array.isArray(node.children) ? node.children.flat(Infinity) : [])) {
      const hit = findByTestId(k, tid);
      if (hit) return hit;
    }
    return null;
  };
  let tree = render();
  findByTestId(tree, 'dxos-tab-built-apps').props.onClick();
  tree = render();
  await new Promise((r) => setTimeout(r, 20));
  tree = render();
  findByTestId(tree, 'dxos-built-app-view-ui-refresh-app').props.onClick();
  tree = render();
  assert.ok(JSON.stringify(findByTestId(tree, 'dxos-built-app-detail-ui-refresh-app')).includes('snap-v1'));
  findByTestId(tree, 'dxos-built-app-plan-toggle-ui-refresh-app').props.onClick();
  tree = render();
  findByTestId(tree, 'dxos-plan-prompt-ui-refresh-app').props.onChange({ target: { value: 'thêm trường notes' } });
  tree = render();
  await findByTestId(tree, 'dxos-plan-preview-btn-ui-refresh-app').props.onClick();
  tree = render();
  await findByTestId(tree, 'dxos-patch-apply-btn-ui-refresh-app').props.onClick();
  tree = render();
  const detailNode = findByTestId(tree, 'dxos-built-app-detail-ui-refresh-app');
  assert.ok(detailNode, 'Expanded detail card must remain open');
  assert.ok(JSON.stringify(detailNode).includes('snap-v2'), 'Expanded detail card must immediately refresh to v2 snapshot');
});

test('Bug #5 regression: parseNaturalAppPlanOrPatch extracts explicit Vietnamese technical field codes without bogus ASCII/accent splits', () => {
  const { parseNaturalAppPlanOrPatch, applySpecPatch } = require('../src/server/app-builder-planner');
  const baseSpec = {
    appKey: 'warranty-suite',
    portalSlug: 'services',
    pageTitle: 'Bảo hành',
    collectionName: 'latticeCustomWarranties',
    fields: [{ name: 'serialNumber', type: 'string', title: 'Số seri' }],
  };

  // Exact PR #77 reproduction (plan-diff.png)
  const p1 = parseNaturalAppPlanOrPatch(
    'Thêm trường ghi chú bảo hành có mã warrantyNote, kiểu văn bản.',
    baseSpec,
  );
  assert.ok(Array.isArray(p1.addFields), 'Expected addFields array');
  assert.equal(p1.addFields.length, 1, `Expected exactly 1 field, got: ${JSON.stringify(p1.addFields)}`);
  assert.equal(p1.addFields[0].name, 'warrantyNote');
  assert.equal(p1.addFields[0].type, 'text');
  assert.equal(p1.addFields[0].collectionName, 'latticeCustomWarranties');
  assert.equal(p1.addFields.some((f) => f.name === 'ghi' || f.name === 'ki'), false);

  const patched1 = applySpecPatch(
    baseSpec,
    null,
    'Thêm trường ghi chú bảo hành có mã warrantyNote, kiểu văn bản.',
  );
  assert.deepEqual(
    patched1.fields.map((f) => f.name),
    ['serialNumber', 'warrantyNote'],
  );

  // Additional Vietnamese variants
  const p2 = parseNaturalAppPlanOrPatch(
    'Thêm trường hạn mức tín dụng có mã creditLimit, kiểu số thực, bắt buộc.',
    baseSpec,
  );
  assert.equal(p2.addFields?.length, 1, `Expected 1 field, got: ${JSON.stringify(p2.addFields)}`);
  assert.equal(p2.addFields[0].name, 'creditLimit');
  assert.equal(p2.addFields[0].type, 'float');
  assert.equal(p2.addFields[0].required, true);

  const p3 = parseNaturalAppPlanOrPatch(
    'Thêm trường ngày hết hạn mã expiryDate, kiểu ngày.',
    baseSpec,
  );
  assert.equal(p3.addFields?.length, 1, `Expected 1 field, got: ${JSON.stringify(p3.addFields)}`);
  assert.equal(p3.addFields[0].name, 'expiryDate');
  assert.equal(p3.addFields[0].type, 'date');

  // Mixed multi-field prompt (ASCII + explicit Vietnamese field code + modifier clauses)
  const p4 = parseNaturalAppPlanOrPatch(
    'Thêm các trường priority bắt buộc, budget kiểu float và ghi chú bảo hành có mã warrantyNote, kiểu văn bản',
    baseSpec,
  );
  assert.equal(p4.addFields?.length, 3, `Expected 3 fields, got: ${JSON.stringify(p4.addFields)}`);
  assert.deepEqual(
    p4.addFields.map((f) => f.name),
    ['priority', 'budget', 'warrantyNote'],
  );
  assert.equal(p4.addFields[0].required, true);
  assert.equal(p4.addFields[1].type, 'float');
  assert.equal(p4.addFields[2].type, 'text');

  // Enum comma values must not be split into bogus fields
  const p5 = parseNaturalAppPlanOrPatch(
    'Thêm các trường priority bắt buộc, budget kiểu float và status enum: draft, active',
    baseSpec,
  );
  assert.equal(p5.addFields?.length, 3, `Expected 3 fields, got: ${JSON.stringify(p5.addFields)}`);
  assert.deepEqual(p5.addFields.map((f) => f.name), ['priority', 'budget', 'status']);
  assert.equal(p5.addFields[2].type, 'enum');
  assert.deepEqual(p5.addFields[2].enumValues, ['draft', 'active']);
});
