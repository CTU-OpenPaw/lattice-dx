/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { registerNativePortals, isPortalAdmin } = require('../src/server/native-portals');

function createMockDb(seed = {}) {
  const tables = {
    uiLayouts: seed.uiLayouts ? seed.uiLayouts.map(r => ({ ...r })) : [
      { uid: 'admin-layout-model', title: 'Main Admin', layoutType: 'desktop', routeName: 'admin', routePath: '/admin', authCheck: true, enabled: true },
      { uid: 'mobile-layout-model', title: 'Mobile App', layoutType: 'mobile', routeName: 'mobile', routePath: '/m', authCheck: true, enabled: true },
    ],
    desktopRoutes: seed.desktopRoutes ? seed.desktopRoutes.map(r => ({ ...r })) : [],
    desktopRoutesUiLayouts: seed.desktopRoutesUiLayouts ? seed.desktopRoutesUiLayouts.map(r => ({ ...r })) : [],
    rolesDesktopRoutes: seed.rolesDesktopRoutes ? seed.rolesDesktopRoutes.map(r => ({ ...r })) : [],
    roles: seed.roles ? seed.roles.map(r => ({ ...r })) : [
      { name: 'ldx_employee', title: 'Nhân viên', allowConfigure: false, snippets: [] },
      { name: 'ldx_manager', title: 'Quản lý', allowConfigure: false, snippets: [] },
      { name: 'ui_builder', title: 'UI Builder', allowConfigure: true, snippets: ['pm'] },
    ],
    applicationPlugins: seed.applicationPlugins !== undefined ? seed.applicationPlugins.map(r => ({ ...r })) : [
      { name: '@latticedx/plugin-lattice-foundation', options: {} },
    ],
  };

  function match(row, filter = {}) {
    return Object.entries(filter).every(([k, v]) => {
      if (v && typeof v === 'object' && '$in' in v) return v.$in.includes(row[k]);
      if (v && typeof v === 'object' && '$startsWith' in v) return String(row[k] || '').startsWith(v.$startsWith);
      return row[k] === v;
    });
  }

  const db = {
    sequelize: { transaction: fn => fn({ id: 'tx' }) },
    getRepository(name) {
      if (!(name in tables)) return null;
      return {
        async find({ filter } = {}) { return tables[name].filter(r => match(r, filter)); },
        async findOne({ filter } = {}) { return tables[name].find(r => match(r, filter)) || null; },
        async create({ values }) { const row = { ...values }; tables[name].push(row); return row; },
        async update({ filter, values }) {
          for (const row of tables[name]) if (match(row, filter)) Object.assign(row, values);
        },
        async destroy({ filter }) {
          tables[name] = tables[name].filter(r => !match(r, filter));
        },
      };
    },
  };
  return { db, tables };
}

function setupServer(seed) {
  const { db, tables } = createMockDb(seed);
  let resource;
  const grants = [];
  const app = {
    db,
    resourceManager: { define: def => { resource = def; } },
    acl: { allow: (...args) => grants.push(args) },
  };
  registerNativePortals(app, db);
  return { actions: resource.actions, grants, db, tables };
}

function makeCtx({ user = { id: 1 }, roles = ['root'], method = 'GET', values = {}, params = {}, query = {} } = {}) {
  return {
    method,
    query,
    state: { currentUser: user, currentRole: roles[0], currentRoles: roles },
    action: { params: { ...params, values } },
    throw(status, message) { throw Object.assign(new Error(message || 'HTTP ' + status), { status }); },
  };
}

test('registers latticePortals resource and loggedIn ACL with admin guard', async () => {
  const { actions, grants, db } = setupServer();
  assert.deepEqual(Object.keys(actions).sort(), ['destroy', 'exportBlueprint', 'list', 'listAccessible', 'save']);
  assert.deepEqual(grants, [['latticePortals', ['list', 'listAccessible', 'save', 'destroy', 'exportBlueprint'], 'loggedIn']]);
  assert.equal(await isPortalAdmin(makeCtx({ roles: ['root'] }), db), true);
  assert.equal(await isPortalAdmin(makeCtx({ roles: ['ui_builder'] }), db), true);
  assert.equal(await isPortalAdmin(makeCtx({ roles: ['ldx_employee'] }), db), false);
});

test('denies admin actions with 403 for ldx_employee and 401 when unauthenticated', async () => {
  const { actions } = setupServer();
  const empGet = makeCtx({ roles: ['ldx_employee'], method: 'GET', params: { uid: 'admin-layout-model' } });
  const empPost = makeCtx({ roles: ['ldx_employee'], method: 'POST', values: { slug: 'hr', title: 'HR' } });
  await assert.rejects(actions.list(empGet), { status: 403 });
  await assert.rejects(actions.save(empPost), { status: 403 });
  await assert.rejects(actions.destroy(empPost), { status: 403 });
  await assert.rejects(actions.exportBlueprint(empGet), { status: 403 });
  await assert.rejects(actions.listAccessible(makeCtx({ user: null, roles: [] })), { status: 401 });
});

test('save validates slugs, rejects reserved slugs, and protects admin-layout-model fields', async () => {
  const { actions, db, tables } = setupServer();
  for (const slug of ['', 'a', 'Bad_Slug', 'admin', 'settings', 'api', 'lattice', 'p']) {
    await assert.rejects(actions.save(makeCtx({ method: 'POST', values: { slug, title: 'Portal' } })), { status: 400 });
  }
  await assert.rejects(actions.save(makeCtx({ method: 'POST', values: { slug: 'hr', title: '' } })), { status: 400 });
  const created = makeCtx({ method: 'POST', values: { slug: 'hr-ops', title: 'Cổng Nhân sự', color: '#0f766e', isDefault: true, roles: ['ldx_employee'] } });
  await actions.save(created);
  assert.equal(created.body.uid, 'ldx-portal-hr-ops');
  assert.equal(created.body.routeName, 'p_hr_ops');
  assert.equal(created.body.routePath, '/p/hr-ops');

  // Partial toggle preserves metadata
  const toggle = makeCtx({ method: 'POST', values: { uid: 'ldx-portal-hr-ops', slug: 'hr-ops', title: 'Cổng Nhân sự', enabled: false } });
  await actions.save(toggle);
  assert.equal(toggle.body.color, '#0f766e');
  assert.equal(toggle.body.isDefault, true);
  assert.equal(toggle.body.enabled, false);

  // Admin layout update never passes protected fields
  let updateCall;
  const origRepo = db.getRepository('uiLayouts');
  const wrappedDb = {
    ...db,
    getRepository: name => name !== 'uiLayouts' ? db.getRepository(name) : {
      ...origRepo,
      update: async arg => { updateCall = arg; return origRepo.update(arg); },
    },
  };
  let adminActions;
  registerNativePortals({ db: wrappedDb, resourceManager: { define: r => { adminActions = r.actions; } }, acl: { allow() {} } }, wrappedDb);
  const adminCtx = makeCtx({
    method: 'POST',
    values: { uid: 'admin-layout-model', title: 'Studio Core', routePath: '/hacked', enabled: false, layoutType: 'mobile' },
  });
  await adminActions.save(adminCtx);
  assert.deepEqual(updateCall.values, { title: 'Studio Core' });
  assert.equal(tables.uiLayouts[0].routePath, '/admin');
  assert.equal(tables.uiLayouts[0].enabled, true);
});

test('save synchronizes rolesDesktopRoutes only within target portal and preserves other portals', async () => {
  const { actions, tables } = setupServer({
    uiLayouts: [
      { uid: 'admin-layout-model', title: 'Admin', layoutType: 'desktop', routeName: 'admin', routePath: '/admin', enabled: true },
      { uid: 'ldx-portal-hr', title: 'HR', layoutType: 'desktop', routeName: 'p_hr', routePath: '/p/hr', enabled: true },
    ],
    desktopRoutes: [
      { id: 10, type: 'flowPage', schemaUid: 'admin_home', title: 'Admin Home' },
      { id: 20, type: 'flowPage', schemaUid: 'hr_home', title: 'HR Home' },
    ],
    desktopRoutesUiLayouts: [
      { desktopRouteId: 10, uiLayoutUid: 'admin-layout-model' },
      { desktopRouteId: 20, uiLayoutUid: 'ldx-portal-hr' },
    ],
    rolesDesktopRoutes: [
      { desktopRouteId: 10, roleName: 'ldx_employee' },
      { desktopRouteId: 20, roleName: 'ldx_manager' },
      { desktopRouteId: 20, roleName: 'custom_non_ldx' },
    ],
  });
  await actions.save(makeCtx({ method: 'POST', values: { uid: 'ldx-portal-hr', slug: 'hr', title: 'HR', roles: ['ldx_employee'] } }));
  assert.ok(tables.rolesDesktopRoutes.some(g => g.desktopRouteId === 10 && g.roleName === 'ldx_employee'));
  assert.ok(tables.rolesDesktopRoutes.some(g => g.desktopRouteId === 20 && g.roleName === 'ldx_employee'));
  assert.ok(!tables.rolesDesktopRoutes.some(g => g.desktopRouteId === 20 && g.roleName === 'ldx_manager'));
  assert.ok(tables.rolesDesktopRoutes.some(g => g.desktopRouteId === 20 && g.roleName === 'custom_non_ldx'));
});

test('listAccessible filters portals by role routes, excludes hidden pages, and computes firstPagePath', async () => {
  const { actions } = setupServer({
    uiLayouts: [
      { uid: 'admin-layout-model', title: 'Admin', layoutType: 'desktop', routeName: 'admin', routePath: '/admin', enabled: true },
      { uid: 'mobile-layout-model', title: 'Mobile', layoutType: 'mobile', routeName: 'mobile', routePath: '/m', enabled: true },
      { uid: 'ldx-portal-hr', title: 'HR', layoutType: 'desktop', routeName: 'p_hr', routePath: '/p/hr', enabled: true },
      { uid: 'ldx-portal-fin', title: 'Finance', layoutType: 'desktop', routeName: 'p_fin', routePath: '/p/fin', enabled: true },
    ],
    desktopRoutes: [
      { id: 1, type: 'page', schemaUid: 'admin_1', title: 'Admin 1', sort: 1 },
      { id: 2, type: 'page', schemaUid: 'hr_hidden', title: 'Hidden', hidden: true, sort: 1 },
      { id: 3, type: 'group', title: 'HR Group', sort: 2 },
      { id: 4, parentId: 3, type: 'flowPage', schemaUid: 'hr_leave', title: 'Leave', sort: 1 },
      { id: 5, type: 'page', schemaUid: 'fin_hidden', title: 'Fin Hidden', hideInMenu: true, sort: 1 },
    ],
    desktopRoutesUiLayouts: [
      { desktopRouteId: 1, uiLayoutUid: 'admin-layout-model' },
      { desktopRouteId: 2, uiLayoutUid: 'ldx-portal-hr' },
      { desktopRouteId: 4, uiLayoutUid: 'ldx-portal-hr' },
      { desktopRouteId: 3, uiLayoutUid: 'ldx-portal-hr' },
      { desktopRouteId: 5, uiLayoutUid: 'ldx-portal-fin' },
    ],
    rolesDesktopRoutes: [
      { desktopRouteId: 4, roleName: 'ldx_employee' },
      { desktopRouteId: 5, roleName: 'ldx_employee' },
    ],
  });
  const empCtx = makeCtx({ roles: ['ldx_employee'] });
  await actions.listAccessible(empCtx);
  assert.deepEqual(empCtx.body.map(p => [p.uid, p.firstPagePath]), [['ldx-portal-hr', '/p/hr/hr_leave']]);

  const adminCtx = makeCtx({ roles: ['root'] });
  await actions.listAccessible(adminCtx);
  assert.deepEqual(adminCtx.body.map(p => p.uid), ['admin-layout-model', 'ldx-portal-fin', 'ldx-portal-hr']);
  assert.equal(adminCtx.body[0].firstPagePath, '/admin/admin_1');
});

test('destroy protects built-ins and exportBlueprint outputs deterministic Apache-2.0 JSON', async () => {
  const { actions } = setupServer({
    uiLayouts: [
      { uid: 'admin-layout-model', title: 'Admin', layoutType: 'desktop', routeName: 'admin', routePath: '/admin', enabled: true },
      { uid: 'mobile-layout-model', title: 'Mobile', layoutType: 'mobile', routeName: 'mobile', routePath: '/m', enabled: true },
      { uid: 'ldx-portal-ops', title: 'Ops', layoutType: 'desktop', routeName: 'p_ops', routePath: '/p/ops', enabled: true },
    ],
    desktopRoutes: [
      { id: 10, type: 'group', title: 'Nhóm', sort: 1, createdAt: '2026-01-01', updatedAt: '2026-01-01' },
      { id: 11, parentId: 10, type: 'flowPage', schemaUid: 'ops_board', title: 'Board', sort: 1, createdById: 1 },
    ],
    desktopRoutesUiLayouts: [
      { desktopRouteId: 10, uiLayoutUid: 'ldx-portal-ops' },
      { desktopRouteId: 11, uiLayoutUid: 'ldx-portal-ops' },
    ],
    rolesDesktopRoutes: [{ desktopRouteId: 11, roleName: 'ldx_dispatcher' }],
    applicationPlugins: [],
  });
  await assert.rejects(actions.destroy(makeCtx({ method: 'POST', values: { uid: 'admin-layout-model' } })), { status: 400 });
  await assert.rejects(actions.destroy(makeCtx({ method: 'POST', values: { uid: 'mobile-layout-model' } })), { status: 400 });

  const expCtx = makeCtx({ method: 'GET', params: { uid: 'ldx-portal-ops' } });
  await actions.exportBlueprint(expCtx);
  assert.equal(expCtx.body.format, 'latticedx.portal-blueprint.v1');
  assert.equal(expCtx.body.license, 'Apache-2.0');
  assert.deepEqual(expCtx.body.roles, ['ldx_dispatcher']);
  assert.equal(expCtx.body.routes[0].children[0].schemaUid, 'ops_board');
  assert.equal(expCtx.body.routes[0].createdAt, undefined);
  assert.equal(expCtx.body.routes[0].children[0].createdById, undefined);

  const delCtx = makeCtx({ method: 'POST', values: { uid: 'ldx-portal-ops' } });
  await actions.destroy(delCtx);
  assert.deepEqual(delCtx.body, { deleted: true, uid: 'ldx-portal-ops' });
});
