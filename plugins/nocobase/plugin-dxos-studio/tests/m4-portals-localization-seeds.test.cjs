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

function makeDomainDb(initialCollections = []) {
  const store = {
    collections: new Map(),
    fields: [],
    roles: [{ name: 'ldx_admin' }, { name: 'ldx_manager' }, { name: 'ldx_operator' }, { name: 'ldx_employee' }],
    rolesCollections: [],
    uiLayouts: [],
    desktopRoutes: [],
    desktopRoutesUiLayouts: [],
    rolesDesktopRoutes: [],
    flowModels: [],
    latticeDecisionTables: [],
    latticeAutomationRules: [],
    latticeCustomWorkOrders: [],
    latticeCustomPartnerClaims: [],
    latticeParaDocuments: [],
    applicationPlugins: [
      { packageName: '@latticedx/plugin-dxos-blocks', enabled: true },
      { packageName: '@latticedx/plugin-lattice-foundation', enabled: true, options: { portals: {} } },
    ],
  };
  for (const name of initialCollections) store.collections.set(name, { name, title: name });
  let seq = 1;

  const matchesFilter = (row, filter = {}) => Object.entries(filter || {}).every(([k, v]) => {
    if (v && typeof v === 'object' && Array.isArray(v.$in)) return v.$in.includes(row[k]);
    return row[k] === v;
  });

  const arrayRepo = (arr) => ({
    async find({ filter } = {}) { return arr.filter((r) => matchesFilter(r, filter)); },
    async findOne({ filter } = {}) { return arr.find((r) => matchesFilter(r, filter)) || null; },
    async count({ filter } = {}) { return arr.filter((r) => matchesFilter(r, filter)).length; },
    async create({ values }) {
      const row = { id: seq++, ...structuredClone(values) };
      arr.push(row);
      return row;
    },
    async update({ filterByTk, filter, values }) {
      let count = 0;
      for (const row of arr) {
        if ((filterByTk != null && row.id === filterByTk) || (filter && matchesFilter(row, filter))) {
          Object.assign(row, structuredClone(values));
          count += 1;
        }
      }
      return count;
    },
  });

  const repos = {
    collections: {
      async findOne({ filter }) { return store.collections.get(filter?.name) || null; },
      async create({ values }) { const row = { ...structuredClone(values) }; store.collections.set(row.name, row); return row; },
      async update({ filter, values }) { const cur = store.collections.get(filter?.name); if (cur) Object.assign(cur, values); return cur ? 1 : 0; },
    },
    fields: arrayRepo(store.fields),
    roles: arrayRepo(store.roles),
    rolesCollections: arrayRepo(store.rolesCollections),
    uiLayouts: arrayRepo(store.uiLayouts),
    desktopRoutes: arrayRepo(store.desktopRoutes),
    desktopRoutesUiLayouts: arrayRepo(store.desktopRoutesUiLayouts),
    rolesDesktopRoutes: arrayRepo(store.rolesDesktopRoutes),
    latticeDecisionTables: arrayRepo(store.latticeDecisionTables),
    latticeAutomationRules: arrayRepo(store.latticeAutomationRules),
    latticeCustomWorkOrders: arrayRepo(store.latticeCustomWorkOrders),
    latticeCustomPartnerClaims: arrayRepo(store.latticeCustomPartnerClaims),
    latticeParaDocuments: arrayRepo(store.latticeParaDocuments),
    applicationPlugins: arrayRepo(store.applicationPlugins),
    flowModels: {
      ...arrayRepo(store.flowModels),
      async findModelByParentId(parentId, { subKey } = {}) {
        return store.flowModels.find((m) => m.parentId === parentId && (!subKey || m.subKey === subKey)) || null;
      },
      async upsertModel(spec) {
        const cur = store.flowModels.find((m) => m.uid === spec.uid);
        if (cur) Object.assign(cur, structuredClone(spec));
        else store.flowModels.push({ id: seq++, ...structuredClone(spec) });
      },
      async updateSingleNode(spec) {
        const cur = store.flowModels.find((m) => m.uid === spec.uid);
        if (cur) Object.assign(cur, structuredClone(spec));
      },
    },
  };

  return {
    store,
    hasCollection: (name) => store.collections.has(name),
    collection(def) {
      store.collections.set(def.name, def);
      return {
        ...def,
        fields: new Map((def.fields || []).map((f) => [f.name, f])),
        async sync() {},
      };
    },
    getCollection: (name) => {
      const def = store.collections.get(name);
      return def ? { ...def, fields: new Map((def.fields || []).map((f) => [f.name, f])), attach: () => {} } : null;
    },
    getRepository: (name) => repos[name] || null,
    sync: async () => {},
    async attachLatticeRlsPolicy() {},
    sequelize: {
      getDialect: () => 'postgres',
      transaction: async (fn) => fn({}),
      async query(sql) {
        if (String(sql).includes('FROM pg_class')) return [[{ rls_enabled: true }], []];
        return [[], []];
      },
    },
  };
}

test('domain-packs localizes cmms-maintenance & coldchain-partner-settlement collections, fields, DMN, rules, and portals to Vietnamese', async () => {
  const { BUSINESS_PACK_CATALOG, installBusinessPackAction } = require(path.join(PLUGIN_ROOT, 'src/server/domain-packs.js'));

  const cmmsMeta = BUSINESS_PACK_CATALOG.find((p) => p.packKey === 'cmms-maintenance');
  const settleMeta = BUSINESS_PACK_CATALOG.find((p) => p.packKey === 'coldchain-partner-settlement');
  assert.ok(cmmsMeta.name.includes('Bảo trì') || cmmsMeta.name.includes('CMMS'), cmmsMeta.name);
  assert.ok(cmmsMeta.description.includes('Phiếu công việc') || cmmsMeta.description.includes('bảo trì'), cmmsMeta.description);
  assert.ok(settleMeta.name.includes('Đối soát') || settleMeta.name.includes('Bồi thường'), settleMeta.name);
  assert.ok(settleMeta.description.includes('Hồ sơ') || settleMeta.description.includes('đối tác'), settleMeta.description);

  const db = makeDomainDb();
  const makeCtx = (packKey, extraParams = {}) => ({
    method: 'POST',
    state: { currentUser: { id: 1, username: 'root', roles: [{ name: 'root' }] }, currentRole: 'root' },
    action: { params: { packKey, organizationId: 'org-a', ...extraParams } },
    body: null,
  });
  const requireBuilderAdmin = async () => ({ organizationId: 'org-a', actor: { userId: 1, username: 'root' } });

  const c1 = makeCtx('cmms-maintenance');
  await installBusinessPackAction(db, c1, async () => {}, { requireBuilderAdmin });
  assert.equal(db.store.collections.get('latticeCustomWorkOrders').title, 'Lệnh Công việc Bảo trì (CMMS)');
  assert.equal(c1.body.domain.portalPage.path, '/p/cmms');
  const cmmsRoute = db.store.desktopRoutes.find((r) => r.id === c1.body.domain.portalPage.routeId);
  assert.equal(cmmsRoute.title, 'Bảo trì CMMS');
  assert.ok(db.store.fields.some((f) => f.collectionName === 'latticeCustomWorkOrders' && f.name === 'workOrderCode' && f.uiSchema?.title === 'Mã lệnh công việc'));
  assert.ok(c1.body.dmnTable.name.includes('Ưu tiên') || c1.body.dmnTable.name.includes('Sự cố'), c1.body.dmnTable.name);

  const c2 = makeCtx('coldchain-partner-settlement');
  await installBusinessPackAction(db, c2, async () => {}, { requireBuilderAdmin });
  assert.equal(db.store.collections.get('latticeCustomPartnerClaims').title, 'Hồ sơ Bồi thường Đối tác');
  const claimRoute = db.store.desktopRoutes.find((r) => r.id === c2.body.domain.portalPage.routeId);
  assert.equal(claimRoute.title, 'Đối soát Đối tác');
  assert.ok(db.store.fields.some((f) => f.collectionName === 'latticeCustomPartnerClaims' && f.name === 'claimCode' && f.uiSchema?.title === 'Mã hồ sơ'));
  assert.ok(c2.body.dmnTable.name.includes('Đối soát') || c2.body.dmnTable.name.includes('Bồi thường'), c2.body.dmnTable.name);
});

test('upsertPortalPageForDomain & composePortals repair blank grids, preserve desktopRoutesUiLayouts links, and update titles idempotently', async () => {
  const { upsertPortalPageForDomain } = require(path.join(PLUGIN_ROOT, 'src/server/domain-portal-composer.js'));
  const { composePortals, attachDxosBlocksToTab } = require(path.join(PLUGIN_ROOT, 'src/server/portal-composer.js'));

  const db = makeDomainDb(['latticeCustomWorkOrders', 'latticeRequests', 'latticeIncidentCases', 'latticeOrders', 'latticeServiceTickets', 'latticeParaDocuments']);
  // Pre-seed old English portal page created by applyBlueprint
  const pageRoute = await db.getRepository('desktopRoutes').create({
    type: 'flowPage',
    values: { type: 'flowPage', title: 'CMMS Maintenance', schemaUid: 'pg-cmms', options: { path: '/p/cmms', collectionName: 'latticeCustomWorkOrders' } },
  });
  const tabRoute = await db.getRepository('desktopRoutes').create({
    values: { type: 'tabs', parentId: pageRoute.id, title: 'CMMS Maintenance', schemaUid: 'tab-cmms', hideInMenu: true },
  });
  await db.getRepository('uiLayouts').create({
    values: { uid: 'ldx-portal-cmms', title: 'CMMS Maintenance', layoutType: 'desktop', routeName: 'p_cmms', routePath: '/p/cmms', authCheck: true, enabled: true },
  });
  await db.getRepository('desktopRoutesUiLayouts').create({ values: { uiLayoutUid: 'ldx-portal-cmms', desktopRouteId: pageRoute.id } });
  await db.getRepository('flowModels').upsertModel({ uid: 'pg-cmms', use: 'PageModel', props: { title: 'CMMS Maintenance' } });
  await db.getRepository('flowModels').upsertModel({ uid: 'tab-cmms', use: 'PageTabModel', parentId: 'pg-cmms', props: { title: 'CMMS Maintenance' } });

  const mockApplyBlueprint = async () => {
    throw new Error('Should NOT create duplicate blueprint page when pageRoute already exists');
  };

  await upsertPortalPageForDomain(db, {
    slug: 'cmms',
    title: 'Bảo trì CMMS',
    collectionName: 'latticeCustomWorkOrders',
    fields: [{ name: 'workOrderCode', type: 'string' }],
    applyBlueprint: mockApplyBlueprint,
  });

  assert.equal(db.store.desktopRoutes.filter((r) => r.type === 'flowPage').length, 1);
  assert.equal(db.store.desktopRoutes.find((r) => r.id === pageRoute.id).title, 'Bảo trì CMMS');
  assert.equal(db.store.flowModels.find((m) => m.uid === 'pg-cmms').props.title, 'Bảo trì CMMS');
  assert.equal(db.store.flowModels.find((m) => m.uid === 'tab-cmms').props.title, 'Bảo trì CMMS');
  assert.ok(db.store.desktopRoutesUiLayouts.some((l) => l.uiLayoutUid === 'ldx-portal-cmms' && l.desktopRouteId === tabRoute.id));

  // Partial grid repair: block model exists already, but GridModel rows is empty -> blank render!
  await db.getRepository('flowModels').upsertModel({
    uid: 'grid-services',
    use: 'GridModel',
    parentId: 'tab-services',
    subKey: 'grid',
    props: { rows: {}, sizes: {}, rowOrder: [] },
    stepParams: { gridSettings: { grid: { rows: {}, sizes: {}, rowOrder: [] } } },
  });
  await db.getRepository('flowModels').upsertModel({
    uid: 'dxos-ov-services-hero',
    use: 'DxosPortalHeroBlockModel',
    parentId: 'grid-services',
    subKey: 'items',
    props: { title: 'Services' },
  });
  await attachDxosBlocksToTab(db, 'tab-services', 'services', [{ uidSuffix: 'hero', use: 'DxosPortalHeroBlockModel', config: { title: 'Services' } }]);
  const repairedGrid = db.store.flowModels.find((m) => m.uid === 'grid-services');
  assert.ok(Object.values(repairedGrid.props.rows).flat(2).includes('dxos-ov-services-hero'), 'Existing GridModel with empty rows must be repaired even when block model already existed');
  assert.ok(Object.values(repairedGrid.stepParams.gridSettings.grid.rows).flat(2).includes('dxos-ov-services-hero'));

  // composePortals recognizes desktopRoutesUiLayouts links even if desktopRoutes.find forgets appends.uiLayouts
  const svcGroup = await db.getRepository('desktopRoutes').create({ values: { type: 'group', title: 'Kho tri thức P.A.R.A.' } });
  const svcPage = await db.getRepository('desktopRoutes').create({ values: { type: 'flowPage', title: 'Tài liệu P.A.R.A.', parentId: svcGroup.id, schemaUid: 'pg-para' } });
  await db.getRepository('desktopRoutesUiLayouts').create({ values: { uiLayoutUid: 'ldx-portal-services', desktopRouteId: svcGroup.id } });
  await db.getRepository('desktopRoutesUiLayouts').create({ values: { uiLayoutUid: 'ldx-portal-services', desktopRouteId: svcPage.id } });
  let createdTitles = [];
  await composePortals(db, {
    applyBlueprint: async (doc) => {
      createdTitles.push(doc.page?.title);
      const r = await db.getRepository('desktopRoutes').create({ values: { type: 'flowPage', title: doc.page?.title, schemaUid: `pg-${createdTitles.length}` } });
      await db.getRepository('desktopRoutesUiLayouts').create({ values: { uiLayoutUid: doc.navigation.layoutUid, desktopRouteId: r.id } });
      return { target: { routeId: r.id, tabSchemaUid: `tab-${createdTitles.length}` } };
    },
  });
  assert.equal(createdTitles.includes('Tài liệu P.A.R.A.'), false, 'Must detect existing page via desktopRoutesUiLayouts link');
});

test('domain-packs seedBusinessPackSamples and dxosStudio:seedShowcaseData seed Vietnamese CMMS, Partner Claims, and 4 P.A.R.A. spaces idempotently', async () => {
  const { installBusinessPackAction } = require(path.join(PLUGIN_ROOT, 'src/server/domain-packs.js'));
  const { createDxosStudioActions } = require(path.join(PLUGIN_ROOT, 'src/server/studio-resource.js'));

  const db = makeDomainDb(['latticeCustomWorkOrders', 'latticeCustomPartnerClaims', 'latticeParaDocuments']);
  const requireBuilderAdmin = async () => ({ organizationId: 'org-a', actor: { userId: 1, username: 'root' } });
  const packCtx = (packKey, seedSamples) => ({
    method: 'POST',
    state: { currentUser: { id: 1, username: 'root', roles: [{ name: 'root' }] }, currentRole: 'root' },
    action: { params: { packKey, organizationId: 'org-a', seedSamples } },
    body: null,
  });

  await installBusinessPackAction(db, packCtx('cmms-maintenance', true), async () => {}, { requireBuilderAdmin });
  await installBusinessPackAction(db, packCtx('coldchain-partner-settlement', true), async () => {}, { requireBuilderAdmin });
  assert.ok(db.store.latticeCustomWorkOrders.length >= 2, 'Expected deterministic CMMS work order seeds');
  assert.ok(db.store.latticeCustomPartnerClaims.length >= 2, 'Expected deterministic Partner Claim seeds');

  // Re-run with seedSamples=true is strictly idempotent
  const woCount = db.store.latticeCustomWorkOrders.length;
  const claimCount = db.store.latticeCustomPartnerClaims.length;
  await installBusinessPackAction(db, packCtx('cmms-maintenance', true), async () => {}, { requireBuilderAdmin });
  await installBusinessPackAction(db, packCtx('coldchain-partner-settlement', true), async () => {}, { requireBuilderAdmin });
  assert.equal(db.store.latticeCustomWorkOrders.length, woCount);
  assert.equal(db.store.latticeCustomPartnerClaims.length, claimCount);

  const actions = createDxosStudioActions(db);
  assert.equal(typeof actions.seedShowcaseData, 'function');
  const seedCtx = {
    method: 'POST',
    state: { currentUser: { id: 1, username: 'root', roles: [{ name: 'root' }] }, currentRole: 'root' },
    action: { params: { organizationId: 'org-a' } },
    body: null,
  };
  await actions.seedShowcaseData(seedCtx, async () => {});
  assert.equal(seedCtx.body.ok, true);
  const paraSpaces = new Set(db.store.latticeParaDocuments.map((d) => d.paraSpace));
  assert.deepEqual([...paraSpaces].sort(), ['archives', 'areas', 'projects', 'resources']);

  // Second seedShowcaseData call does not duplicate records
  const paraCount = db.store.latticeParaDocuments.length;
  await actions.seedShowcaseData(seedCtx, async () => {});
  assert.equal(db.store.latticeParaDocuments.length, paraCount);
});

test('dxosStudio:seedShowcaseData enforces PG16 FORCE RLS context and blocks non-root cross-org seeding', async () => {
  const { createDxosStudioActions } = require(path.join(PLUGIN_ROOT, 'src/server/studio-resource.js'));
  const prevRls = process.env.DX_PG_RLS_SESSION;
  process.env.DX_PG_RLS_SESSION = 'true';

  try {
    const db = makeDomainDb(['latticeCustomWorkOrders', 'latticeCustomPartnerClaims', 'latticeParaDocuments']);
    db.store.roles.push(
      { name: 'ldx_admin', allowConfigure: true, allowAll: false, snippets: ['pm'] },
      { name: 'root', allowConfigure: true, allowAll: true, snippets: ['*'] },
    );
    db.store.rolesUsers = [
      { userId: 1, roleName: 'root' },
      { userId: 202, roleName: 'ldx_admin' },
    ];
    db.store.latticeEmployees = [
      { id: 20, userId: 202, organizationId: 'org-b', active: true },
    ];
    db.getRepository = ((origGetRepo) => {
      const extraRepos = {
        rolesUsers: {
          async find({ filter } = {}) {
            return db.store.rolesUsers.filter((r) => !filter?.userId || r.userId === filter.userId);
          },
        },
        latticeEmployees: {
          async find({ filter } = {}) {
            return db.store.latticeEmployees.filter((r) => !filter?.userId || String(r.userId) === String(filter.userId));
          },
        },
      };
      return (name) => extraRepos[name] || origGetRepo(name);
    })(db.getRepository);

    // Track PG RLS session context & enforce transaction + app.current_org on latticeParaDocuments
    const rlsLog = [];
    const txOrgMap = new WeakMap();
    db.sequelize = {
      getDialect: () => 'postgres',
      async transaction(fn) {
        const tx = { id: `tx-${rlsLog.length + 1}` };
        return fn(tx);
      },
      async query(sql, opts = {}) {
        const sqlText = String(sql);
        const org = opts?.replacements?.orgId ?? opts?.replacements?.org ?? opts?.replacements?.[0] ?? null;
        if (sqlText.includes('app.current_org') && opts?.transaction) {
          txOrgMap.set(opts.transaction, org);
          rlsLog.push({ sql: sqlText, org });
        }
        return [[], []];
      },
    };

    const origParaRepo = db.getRepository('latticeParaDocuments');
    const rlsGuardedParaRepo = {
      async findOne(args = {}) {
        const txOrg = args.transaction ? txOrgMap.get(args.transaction) : null;
        if (!txOrg) {
          throw Object.assign(new Error('42501: violates row-level security policy for table "latticeParaDocuments"'), { code: '42501' });
        }
        return origParaRepo.findOne(args);
      },
      async create(args = {}) {
        const txOrg = args.transaction ? txOrgMap.get(args.transaction) : null;
        if (!txOrg) {
          throw Object.assign(new Error('42501: violates row-level security policy for table "latticeParaDocuments"'), { code: '42501' });
        }
        assert.equal(args.values.organizationId, txOrg, 'Inserted doc org must match active RLS app.current_org');
        return origParaRepo.create(args);
      },
    };
    const baseGetRepo = db.getRepository;
    db.getRepository = (name) => (name === 'latticeParaDocuments' ? rlsGuardedParaRepo : baseGetRepo(name));

    const actions = createDxosStudioActions(db);

    // 1. Non-root tenant admin in org-b attempting to seed org-a must be rejected with 403
    const crossOrgCtx = {
      method: 'POST',
      state: { currentUser: { id: 202, username: 'admin_b', roles: [{ name: 'ldx_admin' }] }, currentRole: 'ldx_admin' },
      action: { params: { organizationId: 'org-a' } },
      body: null,
    };
    await assert.rejects(
      () => actions.seedShowcaseData(crossOrgCtx, async () => {}),
      (err) => err?.status === 403 && err?.code === 'DXOS_ORG_MISMATCH',
      'Non-root org-b admin must not be allowed to seed org-a',
    );

    // 2. Non-root tenant admin in org-b omitting organizationId seeds ONLY org-b under PG RLS
    const scopedOrgBCtx = {
      method: 'POST',
      state: { currentUser: { id: 202, username: 'admin_b', roles: [{ name: 'ldx_admin' }] }, currentRole: 'ldx_admin' },
      action: { params: {} },
      body: null,
    };
    await actions.seedShowcaseData(scopedOrgBCtx, async () => {});
    assert.equal(scopedOrgBCtx.body.ok, true);
    assert.equal(scopedOrgBCtx.body.organizationId, 'org-b');
    assert.ok(db.store.latticeParaDocuments.every((d) => d.organizationId === 'org-b'));
    assert.ok(rlsLog.some((entry) => entry.org === 'org-b'), 'Expected app.current_org=org-b RLS session');

    // 3. Root caller seeding org-a succeeds under PG RLS with app.current_org=org-a
    const rootCtx = {
      method: 'POST',
      state: { currentUser: { id: 1, username: 'root', roles: [{ name: 'root' }] }, currentRole: 'root' },
      action: { params: { organizationId: 'org-a' } },
      body: null,
    };
    await actions.seedShowcaseData(rootCtx, async () => {});
    assert.equal(rootCtx.body.ok, true);
    assert.equal(rootCtx.body.organizationId, 'org-a');
    assert.ok(db.store.latticeParaDocuments.some((d) => d.organizationId === 'org-a'));
    assert.ok(rlsLog.some((entry) => entry.org === 'org-a'), 'Expected app.current_org=org-a RLS session');

    // 4. Invalid organizationId ('all') rejected with 400
    await assert.rejects(
      () => actions.seedShowcaseData({
        method: 'POST',
        state: { currentUser: { id: 1, username: 'root', roles: [{ name: 'root' }] }, currentRole: 'root' },
        action: { params: { organizationId: 'all' } },
        body: null,
      }, async () => {}),
      (err) => err?.status === 400,
    );
  } finally {
    if (prevRls === undefined) delete process.env.DX_PG_RLS_SESSION;
    else process.env.DX_PG_RLS_SESSION = prevRls;
  }
});
