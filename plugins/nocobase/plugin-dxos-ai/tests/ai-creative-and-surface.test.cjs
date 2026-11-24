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

const { createDxosTools, CUSTOM_COLLECTION_RE } = require('../src/server/ai-tools-core');
const { createDxosAiActions } = require('../src/server/ai-resource');

function makeV3Harness() {
  const flowModels = [
    {
      uid: 'grid-cold-qa',
      use: 'BlockGridModel',
      parentId: 'tab-cold-qa',
      subKey: 'grid',
      props: { rows: { dxos_row_0: [['hero-cold']], dxos_row_1: [['kpi-cold']] }, sizes: { dxos_row_0: [24], dxos_row_1: [24] }, rowOrder: ['dxos_row_0', 'dxos_row_1'] },
      stepParams: { gridSettings: { grid: { rows: { dxos_row_0: [['hero-cold']], dxos_row_1: [['kpi-cold']] }, sizes: { dxos_row_0: [24], dxos_row_1: [24] }, rowOrder: ['dxos_row_0', 'dxos_row_1'] } } },
    },
    {
      uid: 'hero-cold',
      use: 'DxosPortalHeroBlockModel',
      parentId: 'grid-cold-qa',
      props: { title: 'Hero Kho lạnh', accentColor: '#1677ff' },
      stepParams: { dxosBlockSettings: { config: { title: 'Hero Kho lạnh', accentColor: '#1677ff' } } },
    },
    {
      uid: 'kpi-cold',
      use: 'DxosKpiMetricBlockModel',
      parentId: 'grid-cold-qa',
      props: { title: 'KPI Kho lạnh [D]', columns: 3 },
      stepParams: { dxosBlockSettings: { config: { title: 'KPI Kho lạnh [D]', columns: 3 } } },
    },
  ];
  const uiLayouts = [{ uid: 'ldx-portal-cold-qa', title: 'Kiểm định Kho lạnh', layoutType: 'desktop', routeName: 'p_cold_qa', routePath: '/p/cold-qa' }];
  const desktopRoutes = [
    { id: 100, title: 'Giám sát Kho lạnh QA', type: 'group', parentId: null },
    { id: 101, title: 'Bảng Kiểm định Kho lạnh', type: 'flowPage', parentId: 100, schemaUid: 'pg-cold-qa' },
    { id: 102, title: 'Bảng Kiểm định Kho lạnh', type: 'tabs', parentId: 101, schemaUid: 'tab-cold-qa' },
  ];
  const desktopRoutesUiLayouts = [
    { desktopRouteId: 100, uiLayoutUid: 'ldx-portal-cold-qa' },
    { desktopRouteId: 101, uiLayoutUid: 'ldx-portal-cold-qa' },
    { desktopRouteId: 102, uiLayoutUid: 'ldx-portal-cold-qa' },
  ];
  const rolesDesktopRoutes = [
    { id: 1, roleName: 'ldx_employee', desktopRouteId: 100 },
    { id: 2, roleName: 'ldx_employee', desktopRouteId: 101 },
  ];
  const collections = [
    {
      name: 'latticeCustomColdAudits',
      title: 'Kiểm định Kho lạnh',
      fields: [
        { name: 'code', type: 'string', title: 'Mã hồ sơ' },
        { name: 'name', type: 'string', title: 'Tiêu đề' },
        { name: 'temperatureC', type: 'float', title: 'Nhiệt độ đo' },
        { name: 'warehouseZone', type: 'string', interface: 'select', title: 'Khu vực', uiSchema: { enum: [{ value: 'Zone-A' }, { value: 'Zone-B' }] } },
        { name: 'auditVerdict', type: 'string', title: 'Kết luận kiểm định' },
        { name: 'status', type: 'string', interface: 'select', title: 'Trạng thái', uiSchema: { enum: [{ value: 'draft' }, { value: 'approved' }] } },
      ],
    },
  ];
  const roles = [
    { name: 'root', title: 'Root', allowConfigure: true },
    { name: 'admin', title: 'Admin', allowConfigure: true },
    { name: 'ldx_employee', title: 'Nhân viên', allowConfigure: false },
    { name: 'ldx_manager', title: 'Quản lý', allowConfigure: false },
  ];
  const store = {
    flowModels,
    uiLayouts,
    desktopRoutes,
    desktopRoutesUiLayouts,
    rolesDesktopRoutes,
    collections,
    fields: [],
    roles,
    rolesUsers: [{ userId: 1, roleName: 'root' }, { userId: 9, roleName: 'ldx_employee' }],
    dataSourcesRoles: [],
    dataSourcesRolesResources: [],
    latticeEmployees: [{ id: 13, userId: 9, organizationId: 'native-ui-lab', active: true }],
    latticeUiSnapshots: [],
    latticeAiProfiles: [],
    aiEmployees: [],
    rolesAiEmployees: [],
    aiMcpClients: [],
    workflows: [],
    flow_nodes: [],
    latticeAiAuditLogs: [],
  };

  let seq = 1000;
  const flowSurfaceCalls = [];

  const matchFilter = (row, filter = {}) => Object.entries(filter).every(([k, cond]) => {
    if (cond && typeof cond === 'object' && '$in' in cond) return cond.$in.includes(row[k]);
    return row[k] === cond;
  });

  const wrap = (arr, row, extra = {}, repoName = '') => ({
    ...row,
    ...extra,
    get: (k) => (k === 'fields' && row.fields ? row.fields : row[k]),
    toJSON: () => ({ ...row }),
    update: async (u) => {
      if (repoName === 'roles' && u.title && arr.some((r) => r !== row && r.title === u.title)) {
        throw new Error('Validation error');
      }
      Object.assign(row, u);
      return wrap(arr, row, extra, repoName);
    },
  });

  const db = {
    store,
    flowSurfaceCalls,
    hasCollection: (n) => Boolean(store[n]) || store.collections.some((c) => c.name === n),
    getCollection: (n) => {
      if (n === 'latticeUiSnapshots') return { sync: async () => { db.syncedSnapshots = true; } };
      return null;
    },
    sequelize: { transaction: async (fn) => fn({}) },
    getRepository(name) {
      const arr = store[name];
      if (!arr) return null;
      const base = {
        find: async ({ filter = {}, sort, limit = 200 } = {}) => {
          let rows = arr.filter((r) => matchFilter(r, filter));
          if (Array.isArray(sort) && sort.includes('-id')) rows = [...rows].sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
          return rows.slice(0, limit).map((r) => wrap(arr, r, {}, name));
        },
        findOne: async ({ filter = {}, filterByTk } = {}) => {
          const hit = filterByTk != null
            ? arr.find((r) => String(r.id ?? r.uid ?? r.name ?? r.username) === String(filterByTk))
            : arr.find((r) => matchFilter(r, filter));
          if (!hit) return null;
          return name === 'collections'
            ? wrap(arr, hit, { getFields: async () => hit.fields || [] }, name)
            : wrap(arr, hit, {}, name);
        },
        count: async ({ filter = {} } = {}) => arr.filter((r) => matchFilter(r, filter)).length,
        create: async ({ values = {} } = {}) => {
          if (name === 'roles') {
            if (arr.some((r) => r.name === values.name || (values.title && r.title === values.title))) {
              throw new Error('Validation error');
            }
          }
          const id = values.id ?? ++seq;
          const row = { id, ...values };
          arr.push(row);
          return wrap(arr, row, {}, name);
        },
        update: async ({ filter = {}, filterByTk, values = {} } = {}) => {
          const hits = arr.filter((r) => (filterByTk != null ? String(r.id ?? r.uid ?? r.name ?? r.username) === String(filterByTk) : matchFilter(r, filter)));
          for (const h of hits) Object.assign(h, values);
          return hits.map((h) => wrap(arr, h, {}, name));
        },
        destroy: async ({ filter = {} } = {}) => {
          let removed = 0;
          for (let i = arr.length - 1; i >= 0; i--) {
            if (matchFilter(arr[i], filter)) { arr.splice(i, 1); removed++; }
          }
          return removed;
        },
      };
      if (name === 'flowModels') {
        return {
          ...base,
          findModelByParentId: async (parentId, { subKey } = {}) => {
            const m = flowModels.find((x) => x.parentId === parentId && (!subKey || x.subKey === subKey));
            return m ? { ...m, subModels: { items: flowModels.filter((c) => c.parentId === m.uid) } } : null;
          },
          findModelById: async (uid) => flowModels.find((x) => x.uid === uid) || null,
          upsertModel: async (model) => {
            const idx = flowModels.findIndex((x) => x.uid === model.uid);
            const clean = { ...model };
            if (idx >= 0) flowModels[idx] = { ...flowModels[idx], ...clean };
            else flowModels.push(clean);
            return clean;
          },
          updateSingleNode: async (patch) => {
            const hit = flowModels.find((x) => x.uid === patch.uid);
            if (hit) Object.assign(hit, patch);
            return hit || null;
          },
          remove: async (uid) => {
            const idx = flowModels.findIndex((x) => x.uid === uid);
            if (idx >= 0) flowModels.splice(idx, 1);
          },
        };
      }
      return base;
    },
  };

  const flowSurfaceAction = (actionName) => async (ctx) => {
    const vals = ctx.action?.params?.values || {};
    flowSurfaceCalls.push({ actionName, values: vals });
    if (actionName === 'addBlock') {
      const uid = `fs-${vals.type || 'block'}-${++seq}`;
      const grid = flowModels.find((m) => m.uid === vals.target?.uid);
      const model = { uid, use: 'TableBlockModel', parentId: grid?.uid || 'grid-cold-qa', subKey: 'items', props: { title: vals.title || vals.type } };
      flowModels.push(model);
      if (grid) {
        const key = `fs_row_${seq}`;
        grid.props.rows[key] = [[uid]];
        grid.props.sizes[key] = [24];
        grid.props.rowOrder.push(key);
        grid.stepParams.gridSettings.grid = { ...grid.props };
      }
      ctx.body = { data: { uid, type: vals.type } };
      return;
    }
    if (actionName === 'applyBlueprint') {
      const pageTitle = vals.page?.title || 'Trang mới';
      const pageId = ++seq;
      const tabUid = `tab-${pageId}`;
      const gridUid = `grid-${pageId}`;
      const grp = { id: ++seq, title: vals.navigation?.group?.title || pageTitle, type: 'group', parentId: null };
      const pg = { id: pageId, title: pageTitle, type: 'flowPage', parentId: grp.id, schemaUid: `pg-${pageId}` };
      const tab = { id: ++seq, title: pageTitle, type: 'tabs', parentId: pageId, schemaUid: tabUid };
      desktopRoutes.push(grp, pg, tab);
      desktopRoutesUiLayouts.push(
        { desktopRouteId: grp.id, uiLayoutUid: vals.navigation?.layoutUid || 'ldx-portal-cold-qa' },
        { desktopRouteId: pg.id, uiLayoutUid: vals.navigation?.layoutUid || 'ldx-portal-cold-qa' },
        { desktopRouteId: tab.id, uiLayoutUid: vals.navigation?.layoutUid || 'ldx-portal-cold-qa' },
      );
      flowModels.push({
        uid: gridUid,
        use: 'BlockGridModel',
        parentId: tabUid,
        subKey: 'grid',
        props: { rows: {}, sizes: {}, rowOrder: [] },
        stepParams: { gridSettings: { grid: { rows: {}, sizes: {}, rowOrder: [] } } },
      });
      ctx.body = { data: { target: { pageSchemaUid: `pg-${pageId}` } } };
      return;
    }
    ctx.body = { data: { ok: true, actionName } };
  };

  const fsActions = new Map(
    ['addBlock', 'addField', 'addAction', 'addRecordAction', 'updateSettings', 'setFieldLinkageRules', 'setFieldValueRules', 'applyBlueprint'].map(
      (n) => [n, { handler: flowSurfaceAction(n) }],
    ),
  );
  const portalSaveCalls = [];
  db.portalSaveCalls = portalSaveCalls;
  const portalActions = new Map([
    [
      'save',
      {
        handler: async (ctx) => {
          const vals = ctx.action?.params?.values || {};
          const slugUid = `ldx-portal-${vals.slug}`;
          const exists = uiLayouts.some((l) => l.uid === slugUid || l.routePath === `/p/${vals.slug}`);
          if (exists && !vals.uid) {
            throw new Error('Portal with this slug already exists.');
          }
          portalSaveCalls.push(vals);
          if (!exists) {
            uiLayouts.push({ uid: vals.uid || slugUid, title: vals.title, layoutType: vals.layoutType || 'desktop', routePath: `/p/${vals.slug}` });
          }
          ctx.body = { data: { uid: vals.uid || slugUid, slug: vals.slug, roles: vals.roles || [] } };
        },
      },
    ],
  ]);

  const app = {
    db,
    resourceManager: {
      isDefined: (n) => n === 'flowSurfaces' || n === 'latticePortals',
      getResource: (n) => (n === 'flowSurfaces' ? { actions: fsActions } : n === 'latticePortals' ? { actions: portalActions } : null),
    },
    acl: { getRole: () => null },
    dataSourceManager: { dataSources: new Map() },
  };

  const adminCtx = { app, db, state: { currentUser: { id: 1, username: 'root' }, currentRoles: ['root'] } };
  const empCtx = { app, db, state: { currentUser: { id: 9, username: 'emp' }, currentRoles: ['ldx_employee'] } };
  const byName = new Map(createDxosTools().map((t) => [t.definition.name, t]));
  return { db, app, flowSurfaceCalls, byName, adminCtx, empCtx };
}

test('tools catalog registers 17 tools including 4 v3 architect/creative tools strictly restricted to admins', async () => {
  const { byName, empCtx } = makeV3Harness();
  assert.equal(byName.size, 17);
  for (const name of [
    'dxos_recommend_page_blueprint',
    'dxos_design_creative_block',
    'dxos_snapshot_or_rollback_page',
    'dxos_provision_role_workspace',
  ]) {
    const tool = byName.get(name);
    assert.ok(tool, `Missing tool ${name}`);
    await assert.rejects(() => tool.invoke(empCtx, {}), (err) => err.status === 403 && err.code === 'DXOS_ADMIN_REQUIRED');
  }
  assert.ok(CUSTOM_COLLECTION_RE.test('latticeCustomColdAudits'));
});

test('dxos_recommend_page_blueprint inspects collection fields and proposes Creative + Native 2-column layout', async () => {
  const { byName, adminCtx } = makeV3Harness();
  const rec = await byName.get('dxos_recommend_page_blueprint').invoke(adminCtx, {
    collectionName: 'latticeCustomColdAudits',
    portalSlug: 'cold-qa',
    targetRole: 'ldx_manager',
    goal: 'Giám sát nhiệt độ và duyệt sự cố',
  });
  assert.equal(rec.collectionName, 'latticeCustomColdAudits');
  assert.ok(rec.recommendedCreativeBlock?.blueprint?.widgets?.some((w) => w.type === 'thermometer'));
  assert.ok(rec.recommendedStandardBlocks?.some((b) => b.type === 'table'));
  assert.ok(Array.isArray(rec.recommendedGridLayout));
});

test('dxos_design_creative_block & dxos_compose_page_blocks v3 attach inline native+creative blocks side-by-side (12:12), configure rules, and rollback via Time-Machine', async () => {
  const { db, byName, adminCtx, empCtx, flowSurfaceCalls } = makeV3Harness();
  const compose = byName.get('dxos_compose_page_blocks');
  const creative = byName.get('dxos_design_creative_block');
  const snapTool = byName.get('dxos_snapshot_or_rollback_page');

  // 1. Admin creates creative cockpit block side-by-side next to kpi-cold ([12, 12])
  const designed = await creative.invoke(adminCtx, {
    portalSlug: 'cold-qa',
    pageTitle: 'Bảng Kiểm định Kho lạnh',
    placeBesideBlockUid: 'kpi-cold',
    blueprint: {
      title: 'Buồng Nhiệt độ Kho lạnh [AI]',
      theme: 'industrial-cockpit',
      columns: 2,
      queries: [{ id: 'audits', collection: 'latticeCustomColdAudits', limit: 20 }],
      widgets: [
        { type: 'thermometer', title: 'Nhiệt độ mới nhất', queryId: 'audits', metric: 'latest', field: 'temperatureC', min: -30, max: 10, warningThreshold: -15, unit: '°C' },
        { type: 'quick-actions', title: 'Thao tác', buttons: [{ label: 'XSS', kind: 'navigate', targetPath: 'javascript:alert(1)' }, { label: 'Mở P.A.R.A.', kind: 'navigate', targetPath: '/p/services' }] },
      ],
    },
  });
  assert.equal(designed.applied, true);
  assert.equal(designed.sideBySideWith, 'kpi-cold');

  const gridAfterCreative = db.store.flowModels.find((m) => m.uid === 'grid-cold-qa');
  const twoColKey = Object.keys(gridAfterCreative.props.sizes).find((k) => gridAfterCreative.props.sizes[k].length === 2);
  assert.ok(twoColKey, 'Grid must contain a 2-column row');
  assert.deepEqual(gridAfterCreative.props.sizes[twoColKey], [12, 12]);
  assert.ok(db.store.latticeUiSnapshots.length >= 1, 'Pre-mutation snapshot must be saved automatically');

  // 2. Attach native formal table inline onto EXISTING page grid via flowSurfaces:addBlock
  const addedNative = await compose.invoke(adminCtx, {
    action: 'addBlock',
    portalSlug: 'cold-qa',
    pageTitle: 'Bảng Kiểm định Kho lạnh',
    blockUse: 'table',
    title: 'Bảng Lô kiểm định',
    collection: 'latticeCustomColdAudits',
    fields: ['code', 'temperatureC', 'auditVerdict'],
  });
  assert.equal(addedNative.applied, true);
  assert.ok(flowSurfaceCalls.some((c) => c.actionName === 'addBlock' && c.values.target?.uid === 'grid-cold-qa'));

  // 3. Configure deep settings / linkage rule on native block via configureNativeBlock
  const configured = await compose.invoke(adminCtx, {
    action: 'configureNativeBlock',
    portalSlug: 'cold-qa',
    blockUid: addedNative.blockUid,
    surfaceAction: 'addField',
    surfacePayload: { fieldPath: 'warehouseZone' },
  });
  assert.equal(configured.applied, true);
  assert.ok(flowSurfaceCalls.some((c) => c.actionName === 'addField' && c.values.fieldPath === 'warehouseZone'));

  // 4. Rollback restores original 2-block baseline (hero-cold + kpi-cold) cleanly
  const snaps = await snapTool.invoke(adminCtx, { action: 'listSnapshots', portalSlug: 'cold-qa' });
  assert.ok(snaps.snapshots.length >= 2);
  const oldestSnap = snaps.snapshots[snaps.snapshots.length - 1];
  const rolled = await snapTool.invoke(adminCtx, { action: 'rollback', portalSlug: 'cold-qa', snapshotUid: oldestSnap.snapshotUid });
  assert.equal(rolled.rolledBack, true);
  const gridRestored = db.store.flowModels.find((m) => m.uid === 'grid-cold-qa');
  assert.deepEqual(gridRestored.props.rowOrder, ['dxos_row_0', 'dxos_row_1']);
  assert.equal(db.store.flowModels.some((m) => m.uid === designed.blockUid), false);

  // 5. dxosAi endpoints enforce pageSurfaceState for employee & lock inspect/rollback to admin
  const actions = createDxosAiActions(db);
  const stateCtx = { app: adminCtx.app, db, state: { ...empCtx.state }, action: { params: { portalSlug: 'cold-qa' } } };
  await actions.pageSurfaceState(stateCtx, async () => {});
  assert.ok(stateCtx.body.revision >= 1);

  const inspectCtx = { app: adminCtx.app, db, state: { ...adminCtx.state }, action: { params: { portalSlug: 'cold-qa' } } };
  await actions.inspectPageBlocks(inspectCtx, async () => {});
  assert.ok(Array.isArray(inspectCtx.body.blocks) && inspectCtx.body.blocks.length >= 2);
  assert.ok(Boolean(inspectCtx.body.gridRows));
  assert.equal('rows' in inspectCtx.body, false);

  await assert.rejects(
    () => actions.inspectPageBlocks({ db, state: { ...empCtx.state }, action: { params: { portalSlug: 'cold-qa' } } }, async () => {}),
    (err) => err.status === 403 && err.code === 'DXOS_ADMIN_REQUIRED',
  );
  await assert.rejects(
    () => actions.rollbackPageSnapshot({ db, state: { ...empCtx.state }, action: { params: { values: { portalSlug: 'cold-qa' } } } }, async () => {}),
    (err) => err.status === 403 && err.code === 'DXOS_ADMIN_REQUIRED',
  );
});

test('dxos_provision_role_workspace builds new ldx_* role + RBAC + page + creative block + dedicated non-admin AI assistant end-to-end', async () => {
  const { db, byName, adminCtx } = makeV3Harness();
  const provision = byName.get('dxos_provision_role_workspace');

  // Guard: refuses privileged or invalid role names
  await assert.rejects(() => provision.invoke(adminCtx, {
    roleName: 'root',
    portalSlug: 'cold-qa',
    pageTitle: 'Illegal',
    collectionName: 'latticeCustomColdAudits',
  }), (err) => err.status === 403);

  const res = await provision.invoke(adminCtx, {
    roleName: 'ldx_cold_inspector',
    roleTitle: 'Thanh tra Chuỗi lạnh',
    portalSlug: 'cold-qa',
    pageTitle: 'Trạm Thanh tra Nhiệt độ',
    collectionName: 'latticeCustomColdAudits',
    lockedFields: ['auditVerdict'],
    creativeTheme: 'amber-alert',
    aiUsername: 'dxos-cold-inspector',
    aiNickname: 'Trợ lý Thanh tra Chuỗi lạnh AI',
  });

  assert.equal(res.provisioned, true);
  assert.equal(res.roleName, 'ldx_cold_inspector');
  assert.ok(db.portalSaveCalls.length >= 1);
  assert.equal(db.portalSaveCalls[0].uid, 'ldx-portal-cold-qa');
  assert.ok(db.portalSaveCalls[0].roles.includes('ldx_cold_inspector'));
  assert.ok(db.store.roles.some((r) => r.name === 'ldx_cold_inspector'));
  assert.ok(db.store.dataSourcesRolesResources.some((r) => r.roleName === 'ldx_cold_inspector' && r.name === 'latticeCustomColdAudits'));
  const aiProf = db.store.latticeAiProfiles.find((p) => p.username === 'dxos-cold-inspector');
  assert.ok(aiProf);
  assert.equal(aiProf.isAdminBuilder, false);
  assert.deepEqual(aiProf.allowedRoles, ['ldx_cold_inspector']);
});

test('v3.1 natural Vietnamese helpers resolve collection, block hints, field titles, role slugs, and synthesize blueprints without jargon', async () => {
  const {
    stripVietnameseDiacritics,
    slugifyVietnameseToLdxRole,
  } = require('../src/server/ai-surface-creative-tools');

  assert.equal(stripVietnameseDiacritics('Độ ẩm & Thanh tra Chuỗi lạnh'), 'Do am & Thanh tra Chuoi lanh');
  assert.equal(slugifyVietnameseToLdxRole('Thanh tra Chuỗi lạnh'), 'ldx_thanh_tra_chuoi_lanh');

  const { db, byName, adminCtx } = makeV3Harness();
  // Add a TableBlockModel on cold-qa grid so portal primary collection can be inferred without collectionName
  db.store.flowModels.push({
    uid: 'tbl-cold',
    use: 'TableBlockModel',
    parentId: 'grid-cold-qa',
    props: {},
    stepParams: { resourceSettings: { init: { collectionName: 'latticeCustomColdAudits' } } },
  });
  const grid = db.store.flowModels.find((m) => m.uid === 'grid-cold-qa');
  grid.props.rows.dxos_row_2 = [['tbl-cold']];
  grid.props.sizes.dxos_row_2 = [24];
  grid.props.rowOrder.push('dxos_row_2');

  // 1. dxos_recommend_page_blueprint infers collectionName automatically & contains NO askAi quick button
  const recTool = byName.get('dxos_recommend_page_blueprint');
  const rec = await recTool.invoke(adminCtx, { portalSlug: 'cold-qa' });
  assert.equal(rec.collectionName, 'latticeCustomColdAudits');
  assert.ok(rec.recommendedCreativeBlock?.blueprint?.widgets?.some((w) => w.type === 'thermometer'));
  const qaBtns = rec.recommendedCreativeBlock.blueprint.widgets.find((w) => w.type === 'quick-actions')?.buttons || [];
  assert.equal(qaBtns.some((b) => b.kind === 'askAi'), false);

  // 2. dxos_design_creative_block resolves placeBesideTitle='Chỉ số' & synthesizes widgets from natural goal
  const creativeTool = byName.get('dxos_design_creative_block');
  const designed = await creativeTool.invoke(adminCtx, {
    portalSlug: 'cold-qa',
    placeBesideTitle: 'Chỉ số',
    title: 'Buồng Nhiệt độ Kho lạnh',
    theme: 'industrial-cockpit',
    goal: 'Theo dõi nhiệt độ và cảnh báo đỏ nếu cao hơn âm 15 độ C, tiến trình 4 bước thẩm định và nút mở kho tài liệu',
  });
  assert.equal(designed.applied, true);
  assert.equal(designed.sideBySideWith, 'kpi-cold');
  assert.ok(designed.blueprint.widgets.some((w) => w.type === 'thermometer'));
  const callout = designed.blueprint.widgets.find((w) => w.type === 'rule-callout');
  assert.ok(callout);
  assert.equal(callout.threshold, -15);
  assert.equal(callout.operator, 'gt');

  // 3. dxos_provision_role_workspace accepts roleTitle + Vietnamese locked field label without roleName/collectionName/aiUsername
  const provisionTool = byName.get('dxos_provision_role_workspace');
  const prov = await provisionTool.invoke(adminCtx, {
    roleTitle: 'Thanh tra Chuỗi lạnh',
    portalSlug: 'cold-qa',
    pageTitle: 'Trạm Thanh tra Nhiệt độ',
    lockedFields: ['Kết luận kiểm định'],
    creativeTheme: 'amber-alert',
  });
  assert.equal(prov.provisioned, true);
  assert.equal(prov.roleName, 'ldx_thanh_tra_chuoi_lanh');
  assert.equal(prov.collectionName, 'latticeCustomColdAudits');
  assert.deepEqual(prov.lockedFields, ['auditVerdict']);
  const resRbac = db.store.dataSourcesRolesResources.find((r) => r.roleName === 'ldx_thanh_tra_chuoi_lanh');
  const createAct = resRbac.actions.find((a) => a.name === 'create');
  assert.equal(createAct.fields.includes('auditVerdict'), false);
  const newAi = db.store.latticeAiProfiles.find((p) => p.username === prov.aiEmployee);
  assert.ok(newAi && newAi.isAdminBuilder === false);
});

test('dxos_provision_role_workspace handles roles_title_key collisions and normalizes aiUsername underscores', async () => {
  const { db, byName, adminCtx } = makeV3Harness();
  const provision = byName.get('dxos_provision_role_workspace');

  // Seed existing ldx_* role owning Vietnamese title 'Thanh tra Chuỗi lạnh' and a system role owning 'Nhân sự Hệ thống'
  db.store.roles.push(
    { name: 'ldx_cold_inspector', title: 'Thanh tra Chuỗi lạnh', allowConfigure: false },
    { name: 'staff_sys', title: 'Nhân sự Hệ thống', allowConfigure: false },
  );

  // 1. Reuses existing ldx_* role instead of crashing on roles_title_key, and normalizes aiUsername underscores
  const resReuse = await provision.invoke(adminCtx, {
    roleName: 'ldx_cold_qa_team',
    roleTitle: 'Thanh tra Chuỗi lạnh',
    portalSlug: 'cold-qa',
    pageTitle: 'Trạm Thanh tra Nhiệt độ',
    lockedFields: ['Kết luận kiểm định'],
    aiUsername: 'ai_cold_qa_team',
  });
  assert.equal(resReuse.provisioned, true);
  assert.equal(resReuse.roleName, 'ldx_cold_inspector');
  assert.equal(resReuse.aiEmployee, 'ai-cold-qa-team');

  // 2. Disambiguates roleTitle when collided with a non-ldx_* role
  const resDisambig = await provision.invoke(adminCtx, {
    roleName: 'ldx_staff_qa',
    roleTitle: 'Nhân sự Hệ thống',
    portalSlug: 'cold-qa',
    pageTitle: 'Trang Nhân sự QA',
  });
  assert.equal(resDisambig.provisioned, true);
  assert.equal(resDisambig.roleName, 'ldx_staff_qa');
  const createdStaffRole = db.store.roles.find((r) => r.name === 'ldx_staff_qa');
  assert.equal(createdStaffRole.title, 'Nhân sự Hệ thống (ldx_staff_qa)');
});

test('surfaceRevisionStore bounds memory cache size under high portal cardinality', () => {
  const { bumpSurfaceRevision, surfaceRevisionStore } = require('../src/server/ai-surface-creative-tools');
  for (let i = 0; i < 620; i += 1) {
    bumpSurfaceRevision(`portal-${i}`, { blockCount: 1, layoutSignature: `sig-${i}` });
  }
  assert.ok(surfaceRevisionStore.size <= 500, `Expected surfaceRevisionStore bounded <= 500, got ${surfaceRevisionStore.size}`);
});

test('creative DSL supports chatter, export-bar, and voucher-actions widgets and snapshots use crypto randomness', () => {
  const { readFileSync } = require('node:fs');
  const path = require('node:path');
  const { sanitizeCreativeBlueprintPayload, VALID_WIDGET_TYPES } = require('../src/server/ai-surface-creative-tools');

  for (const wt of ['chatter', 'export-bar', 'voucher-actions']) {
    assert.equal(VALID_WIDGET_TYPES.has(wt), true, `Expected ${wt} in VALID_WIDGET_TYPES`);
  }

  const sanitized = sanitizeCreativeBlueprintPayload({
    title: 'Wave 5 Workbench',
    theme: 'clean-light',
    queries: [{ id: 'q1', collection: 'latticeOrders', limit: 10 }],
    widgets: [
      { type: 'chatter', title: 'Trao đổi Chatter', collection: 'latticeOrders', recordId: 5 },
      { type: 'export-bar', title: 'Xuất dữ liệu', collection: 'latticeOrders', formats: ['csv', 'xlsx', 'pdf'] },
      { type: 'voucher-actions', title: 'Vòng đời chứng từ', collection: 'latticeOrders', recordId: 5 },
    ],
  });
  assert.equal(sanitized.widgets.length, 3);
  assert.deepEqual(sanitized.widgets.map((w) => w.type), ['chatter', 'export-bar', 'voucher-actions']);

  const src = readFileSync(path.join(__dirname, '../src/server/ai-surface-creative-tools.js'), 'utf8');
  assert.equal(src.includes('Math.random'), false);
});

test('Task 16: custom non-ldx_ business role ops_manager works across provision, RBAC, and portal tools while reserved roles stay blocked', async () => {
  const { db, byName, adminCtx } = makeV3Harness();
  db.store.latticeOrganizations = [{ id: 1, organizationId: 'acme-pharma', active: true, status: 'active' }];
  const provision = byName.get('dxos_provision_role_workspace');
  const rbacTool = byName.get('dxos_manage_rbac_permissions');
  const portalTool = byName.get('dxos_manage_portal_and_acl');

  for (const forbidden of ['root', 'admin', 'anonymous', 'member', 'ldx_sysadmin', 'ldx_connector', 'r_temp']) {
    await assert.rejects(
      () => provision.invoke(adminCtx, { roleName: forbidden, portalSlug: 'cold-qa', pageTitle: 'Bad Role', collectionName: 'latticeCustomColdAudits' }),
      (err) => err.status === 403 && err.code === 'ROLE_FORBIDDEN',
    );
    await assert.rejects(
      () => rbacTool.invoke(adminCtx, { operation: 'ensureCustomRole', roleName: forbidden }),
      (err) => err.status === 403 && err.code === 'ROLE_TARGET_FORBIDDEN',
    );
  }

  const provRes = await provision.invoke(adminCtx, {
    roleName: 'ops_manager',
    roleTitle: 'Operations Manager',
    portalSlug: 'cold-qa',
    pageTitle: 'Ops Control',
    collectionName: 'latticeCustomColdAudits',
    lockedFields: ['auditVerdict'],
  });
  assert.equal(provRes.provisioned, true);
  assert.equal(provRes.roleName, 'ops_manager');
  assert.ok(db.store.roles.some((r) => r.name === 'ops_manager'));
  const aiProf = db.store.latticeAiProfiles.find((p) => p.username === provRes.aiEmployee);
  assert.equal(aiProf.organizationId, 'acme-pharma');
  assert.deepEqual(aiProf.allowedRoles, ['ops_manager']);

  const rbacRes = await rbacTool.invoke(adminCtx, {
    operation: 'grantResource',
    roleName: 'ops_manager',
    collectionName: 'latticeCustomColdAudits',
    actions: ['view', 'create'],
  });
  assert.equal(rbacRes.applied, true);

  const portalRes = await portalTool.invoke(adminCtx, {
    operation: 'grant',
    slug: 'cold-qa',
    roleNames: ['ops_manager', 'anonymous', 'r_bad'],
  });
  assert.equal(portalRes.applied, true);
  assert.ok(portalRes.assignedRoles.includes('ops_manager'));
  assert.equal(portalRes.assignedRoles.includes('anonymous'), false);
  assert.equal(portalRes.assignedRoles.includes('r_bad'), false);
});
