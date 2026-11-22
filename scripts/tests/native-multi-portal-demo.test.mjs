/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  COLLECTION_FIELD_GROUPS,
  PORTALS,
  assertSafeLabOrigin,
  createRootApiClient,
  ensureLogisticsDemoCrew,
  provisionMultiPortalDemo,
  resolveCliTarget,
} from '../setup-native-multi-portal-demo.mjs';

const require = createRequire(import.meta.url);
const schemas = {
  ...require('../../plugins/nocobase/plugin-lattice-foundation/src/server/schema.js'),
  ...require('../../plugins/nocobase/plugin-dxos-para/src/server/schema.js'),
  ...require('../../plugins/nocobase/plugin-dxos-studio/src/server/service-schema.js'),
};

function createMockNocoBase({ failOnBlueprintCall = null, seedForeignRoute = false, studioDisabled = false } = {}) {
  let nextRouteId = 100;
  let blueprintCalls = 0;
  const settings = { id: 1, title: 'NocoBase', options: { brand: 'NocoBase', keepMe: true } };
  const layouts = new Map();
  const models = new Map();
  const routes = seedForeignRoute
    ? [{ id: 1, parentId: null, type: 'group', title: 'Yêu cầu mua sắm', uiLayouts: [] },
       { id: 2, parentId: 1, type: 'flowPage', title: 'Tạo yêu cầu mới', uiLayouts: [] }]
    : [];
  const rolesDesktopRoutes = new Map();
  const events = [];

  const routeBelongsTo = (route, uid) => {
    if (route.uiLayouts?.some((l) => l.uid === uid)) return true;
    if (route.parentId == null) return false;
    const parent = routes.find((r) => r.id === route.parentId);
    return parent ? routeBelongsTo(parent, uid) : false;
  };

  async function api(path, { method = 'GET', values } = {}) {
    events.push({ path: path.split('?')[0], method, values });
    if (path === 'systemSettings:get?filterByTk=1') return structuredClone(settings);
    if (path === 'systemSettings:update?filterByTk=1' && method === 'POST') {
      Object.assign(settings, values);
      return structuredClone(settings);
    }
    if (path.startsWith('flowModels:findOne?uid=')) return models.get(path.split('=')[1]) ?? {};
    if (path === 'flowModels:save' && method === 'POST') {
      models.set(values.uid, structuredClone(values));
      return values.uid;
    }
    if (path === 'latticePortals:save' && method === 'POST') {
      layouts.set(values.uid, { ...values, enabled: values.enabled !== false });
      const ids = routes.filter((r) => routeBelongsTo(r, values.uid)).map((r) => r.id);
      for (const role of values.roles ?? []) {
        rolesDesktopRoutes.set(role, new Set([...(rolesDesktopRoutes.get(role) ?? []), ...ids]));
      }
      return layouts.get(values.uid);
    }
    if (path === 'desktopRoutes:list?paginate=false&appends[]=uiLayouts') {
      return routes.map((r) => ({ ...r, uiLayouts: r.uiLayouts ?? [] }));
    }
    if (path === 'flowSurfaces:applyBlueprint' && method === 'POST') {
      blueprintCalls += 1;
      if (failOnBlueprintCall === blueprintCalls) throw new Error('Simulated network crash');
      const { layoutUid, group: groupSpec, item } = values.navigation;
      assert.equal(layouts.get(layoutUid)?.enabled, true, `Layout ${layoutUid} must be enabled`);
      let group = routes.find((r) => r.type === 'group' && r.title === groupSpec.title && routeBelongsTo(r, layoutUid));
      if (!group) {
        group = { id: ++nextRouteId, parentId: null, type: 'group', title: groupSpec.title, uiLayouts: [{ uid: layoutUid }] };
        routes.push(group);
      }
      const page = { id: ++nextRouteId, parentId: group.id, type: 'flowPage', title: item.title };
      const tab = { id: ++nextRouteId, parentId: page.id, type: 'tabs', title: values.tabs[0].title };
      routes.push(page, tab);
      return { target: { pageSchemaUid: `page_${page.id}` }, surface: { tree: { props: { routeId: page.id } } } };
    }
    if (path === 'dxosStudio:composePortals' && method === 'POST') {
      if (studioDisabled) {
        throw new Error('dxosStudio:composePortals HTTP 404: Action not found');
      }
      return { createdPages: 4, attachedBlocks: 12, dxosBlocksAttached: true };
    }
    throw new Error(`Unexpected API call: ${method} ${path}`);
  }

  return { api, settings, layouts, models, routes, rolesDesktopRoutes, events };
}

test('first run creates 5 portals and 14 pages scoped to layoutUid, preserves Clause 5.2, and syncs roles', async () => {
  const mock = createMockNocoBase({ seedForeignRoute: true });
  const schemaByName = new Map(Object.values(schemas).filter((s) => s && Array.isArray(s.fields)).map((s) => [s.name, new Set(['code', 'name', 'organizationId', 'active', ...s.fields.map((f) => f.name)])]));
  for (const portal of PORTALS) {
    for (const page of portal.pages) {
      const fields = schemaByName.get(page.block.collection);
      assert.ok(fields, `Unknown collection ${page.block.collection}`);
      for (const field of page.block.fields) assert.ok(fields.has(field), `Unknown field ${page.block.collection}.${field}`);
    }
  }

  const summary = await provisionMultiPortalDemo(mock.api, 'http://localhost:13013');
  assert.equal(summary.result, 'PASS');
  assert.equal(summary.origin, 'http://localhost:13013');
  assert.equal(summary.settingsUrl, 'http://localhost:13013/admin/settings/multi-portal');
  assert.equal(summary.createdPages, 14);
  assert.equal(summary.composedOverview?.attachedBlocks, 12);
  assert.deepEqual(summary.portals.map((p) => p.layoutUid), ['ldx-portal-procurement', 'ldx-portal-incidents', 'ldx-portal-logistics', 'ldx-portal-services', 'ldx-portal-logistics-employee']);
  assert.equal(mock.settings.title, 'LatticeDX');
  assert.deepEqual(mock.settings.options, { brand: 'NocoBase', keepMe: true });
  assert.deepEqual(mock.models.get('admin-layout-model-app-switcher-actions'), {
    uid: 'admin-layout-model-app-switcher-actions',
    use: 'AppSwitcherActionPanelModel',
    parentId: 'admin-layout-model',
    subKey: 'appSwitcher',
    subType: 'object',
  });

  const blueprints = mock.events.filter((e) => e.path === 'flowSurfaces:applyBlueprint');
  assert.equal(blueprints.length, 14);
  for (const portal of PORTALS) {
    const uid = `ldx-portal-${portal.slug}`;
    const portalRouteIds = mock.routes.filter((r) => r.id >= 100 && (r.uiLayouts?.[0]?.uid === uid || mock.routes.some((p) => p.id === r.parentId && (p.uiLayouts?.[0]?.uid === uid || mock.routes.some((g) => g.id === p.parentId && g.uiLayouts?.[0]?.uid === uid))))).map((r) => r.id);
    for (const role of portal.roles) {
      const granted = mock.rolesDesktopRoutes.get(role);
      for (const id of portalRouteIds) assert.ok(granted?.has(id), `Role ${role} missing route ${id}`);
    }
    if (portal.slug === 'logistics') {
      const employeeRoutes = mock.rolesDesktopRoutes.get('ldx_employee');
      for (const id of portalRouteIds) assert.ok(!employeeRoutes.has(id), `Employee unexpectedly received operations route ${id}`);
    }
    const lastBlueprintIdx = mock.events.findLastIndex((e) => e.path === 'flowSurfaces:applyBlueprint' && e.values.navigation.layoutUid === uid);
    const lastSaveIdx = mock.events.findLastIndex((e) => e.path === 'latticePortals:save' && e.values.uid === uid);
    assert.ok(lastSaveIdx > lastBlueprintIdx, `Expected latticePortals:save after blueprint creation for ${uid}`);
  }
});

test('employee Logistics portal provisions an own-orders table and a draft creation form', () => {
  const portal = PORTALS.find(({ slug }) => slug === 'logistics-employee');
  assert.deepEqual(portal.roles, ['ldx_employee']);
  const [list, create] = portal.pages;
  assert.equal(list.title, 'Đơn của tôi');
  assert.equal(list.block.collection, 'latticeOrders');
  assert.deepEqual(list.block.settings.dataScope, {
    logic: '$and',
    items: [{ path: 'requester.userId', operator: '$eq', value: '{{ ctx.user.id }}' }],
  });
  assert.equal(create.title, 'Tạo đơn');
  assert.equal(create.block.type, 'createForm');
  assert.equal(create.block.collection, 'latticeOrders');
  for (const field of ['status', 'organizationId', 'requesterId', 'assigneeId']) {
    assert.ok(!create.block.fields.includes(field), `Protected field ${field} appears in the form`);
  }
});

test('partial failure recovers without duplicate groups or pages and subsequent rerun is strictly idempotent', async () => {
  const mock = createMockNocoBase({ failOnBlueprintCall: 7, seedForeignRoute: true });
  await assert.rejects(() => provisionMultiPortalDemo(mock.api, 'http://127.0.0.1:13013'), /Simulated network crash/);
  assert.equal(mock.routes.filter((r) => r.id >= 100 && r.type === 'flowPage').length, 6);

  const recovery = await provisionMultiPortalDemo(mock.api, 'http://127.0.0.1:13013');
  assert.equal(recovery.createdPages, 8);
  assert.deepEqual(recovery.portals.map((p) => p.createdPages), [0, 0, 2, 4, 2]);
  assert.equal(mock.routes.filter((r) => r.id >= 100 && r.type === 'group').length, 9);
  assert.equal(mock.routes.filter((r) => r.id >= 100 && r.type === 'flowPage').length, 14);

  const beforeRerunEvents = mock.events.length;
  const rerun = await provisionMultiPortalDemo(mock.api, 'http://127.0.0.1:13013');
  assert.equal(rerun.createdPages, 0);
  const rerunEvents = mock.events.slice(beforeRerunEvents);
  assert.equal(rerunEvents.filter((e) => e.path === 'flowSurfaces:applyBlueprint').length, 0);
  assert.equal(rerunEvents.filter((e) => e.path === 'systemSettings:update').length, 0);
  assert.equal(rerunEvents.filter((e) => e.path === 'flowModels:save').length, 0);
  assert.equal(mock.routes.filter((r) => r.id >= 100 && r.type === 'flowPage').length, 14);
});

test('port guard rejects port 13000 and external origins; CLI report validator and fixturesOnly work', async () => {
  for (const bad of ['http://localhost:13000', 'http://127.0.0.1:13003', 'http://localhost:14000', 'https://localhost:13013', 'http://evil.example:13013', 'http://u@localhost:13013']) {
    assert.throws(() => assertSafeLabOrigin(bad));
    await assert.rejects(() => provisionMultiPortalDemo(async () => ({}), bad));
  }
  assert.equal(assertSafeLabOrigin('http://localhost:13004'), 'http://localhost:13004');
  assert.equal(assertSafeLabOrigin('http://127.0.0.1:13999/'), 'http://127.0.0.1:13999');

  const dir = await mkdtemp(join(tmpdir(), 'ldx-portal-test-'));
  try {
    const validPath = join(dir, 'report.json');
    const badPath = join(dir, 'bad.json');
    await writeFile(validPath, JSON.stringify({ format: 'latticedx.native-clean-install', complete: true, origin: 'http://localhost:13015' }));
    await writeFile(badPath, JSON.stringify({ format: 'latticedx.native-clean-install', complete: false, origin: 'http://localhost:13015' }));
    assert.deepEqual(await resolveCliTarget([validPath, '--fixtures-only']), { origin: 'http://localhost:13015', fixturesOnly: true });
    await assert.rejects(() => resolveCliTarget([badPath]));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  const mock = createMockNocoBase({ studioDisabled: true });
  const fixturesRes = await provisionMultiPortalDemo(mock.api, 'http://localhost:13015', { fixturesOnly: true });
  assert.equal(mock.settings.title, 'NocoBase');
  assert.equal(fixturesRes.composedOverview, null);
});

test('createRootApiClient signs in as admin and attaches Bearer token with X-Role root', async () => {
  const seen = [];
  const fakeFetch = async (url, init) => {
    seen.push({ href: url.href, headers: init.headers, body: init.body });
    const data = url.pathname.endsWith('auth:signIn') ? { token: 'jwt-root-1' } : { title: 'NocoBase' };
    return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const api = await createRootApiClient('http://localhost:13013', fakeFetch);
  await api('systemSettings:get?filterByTk=1');
  assert.equal(seen[0].href, 'http://localhost:13013/api/auth:signIn');
  assert.equal(seen[1].href, 'http://localhost:13013/api/systemSettings:get?filterByTk=1');
  assert.equal(seen[1].headers.authorization, 'Bearer jwt-root-1');
  assert.equal(seen[1].headers['X-Role'], 'root');
});

test('ensureLogisticsDemoCrew idempotently seeds dispatcher and driver in native-ui-lab', async () => {
  const users = [];
  const employees = [];
  let seq = 10;
  const api = async (path, { method = 'GET', values } = {}) => {
    if (path.startsWith('latticeDepartments:list')) return [{ id: 1, code: 'NATIVE-UI-LAB', organizationId: 'native-ui-lab' }];
    if (path.startsWith('users:list')) {
      const q = JSON.parse(decodeURIComponent(path.split('filter=')[1]));
      return users.filter((u) => u.username === q.username);
    }
    if (path === 'users:create' && method === 'POST') {
      const u = { id: ++seq, ...values };
      users.push(u);
      return u;
    }
    if (path.startsWith('latticeEmployees:list')) {
      const q = JSON.parse(decodeURIComponent(path.split('filter=')[1]));
      return employees.filter((e) => e.code === q.code && e.organizationId === q.organizationId);
    }
    if (path === 'latticeEmployees:create' && method === 'POST') {
      const e = { id: ++seq, ...values };
      employees.push(e);
      return e;
    }
    throw new Error(`Unexpected API: ${method} ${path}`);
  };
  const first = await ensureLogisticsDemoCrew(api);
  assert.equal(first.createdUsers, 2);
  assert.equal(first.createdEmployees, 2);
  assert.deepEqual(employees.map((e) => e.code), ['NATIVE-UI-DISPATCHER', 'NATIVE-UI-DRIVER']);
  const rerun = await ensureLogisticsDemoCrew(api);
  assert.equal(rerun.createdUsers, 0);
  assert.equal(rerun.createdEmployees, 0);
});

test('multi-portal COLLECTION_FIELD_GROUPS covers every interface field across domain schemas', () => {
  const allSchemas = Object.values(schemas);
  for (const [colName, groups] of Object.entries(COLLECTION_FIELD_GROUPS)) {
    const schema = allSchemas.find((s) => s?.name === colName);
    assert.ok(schema, `Missing schema for ${colName}`);
    const covered = new Set(groups.flatMap((g) => g.fields));
    const missing = (schema.fields || [])
      .filter((f) => Boolean(f.interface))
      .map((f) => f.name)
      .filter((name) => !covered.has(name));
    assert.deepEqual(missing, [], `COLLECTION_FIELD_GROUPS[${colName}] missing interface fields: ${missing.join(', ')}`);
  }
});
