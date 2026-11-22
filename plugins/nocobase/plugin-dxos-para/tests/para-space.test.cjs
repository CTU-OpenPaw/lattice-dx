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

test('plugin-dxos-para defines uiManageable latticeParaDocuments schema and validates fields', async () => {
  const { paraDocuments, validateParaDocument } = require(path.join(PLUGIN_ROOT, 'src/server/schema.js'));
  assert.equal(paraDocuments.name, 'latticeParaDocuments');
  assert.equal(paraDocuments.uiManageable, true);
  assert.equal(paraDocuments.titleField, 'title');

  const fieldNames = paraDocuments.fields.map((f) => f.name);
  for (const required of ['code', 'title', 'organizationId', 'paraSpace', 'summary', 'contentMarkdown', 'tags', 'status', 'attachmentUrl', 'relatedCollection', 'relatedRecordId', 'active', 'department', 'owner']) {
    assert.ok(fieldNames.includes(required), `Missing field ${required}`);
  }

  // Valid record passes and receives normalized values
  const data = new Map([['code', ' PARA-01 '], ['title', ' Chiến lược 2026 '], ['organizationId', 'org-a'], ['paraSpace', 'projects'], ['attachmentUrl', 'https://docs.example.org/spec']]);
  const model = {
    isNewRecord: true,
    get: (k) => data.get(k),
    set: (k, v) => data.set(k, v),
  };
  validateParaDocument(model, { context: { state: { latticeNativeActor: { organizationId: 'org-a', employeeId: 7 } } } });
  assert.equal(data.get('code'), 'PARA-01');
  assert.equal(data.get('title'), 'Chiến lược 2026');
  assert.equal(data.get('ownerId'), 7);
  assert.equal(data.get('status'), 'active');

  // Invalid paraSpace rejected
  assert.throws(
    () => validateParaDocument({
      isNewRecord: true,
      get: (k) => ({ code: 'P2', title: 'X', organizationId: 'org-a', paraSpace: 'invalid-space' }[k]),
      set: () => {},
    }),
    (err) => err.status === 400 && err.code === 'PARA_SPACE_INVALID',
  );

  // Invalid status rejected
  assert.throws(
    () => validateParaDocument({
      isNewRecord: false,
      get: (k) => ({ code: 'P2', title: 'X', organizationId: 'org-a', paraSpace: 'areas', status: 'deleted' }[k]),
      set: () => {},
    }),
    (err) => err.status === 400 && err.code === 'PARA_STATUS_INVALID',
  );

  // Unsafe attachment URL rejected
  for (const badUrl of ['javascript:alert(1)', 'data:text/html,<script>', '//evil.invalid/x']) {
    assert.throws(
      () => validateParaDocument({
        isNewRecord: true,
        get: (k) => ({ code: 'P3', title: 'Bad', organizationId: 'org-a', paraSpace: 'resources', attachmentUrl: badUrl }[k]),
        set: () => {},
      }),
      (err) => err.status === 400 && err.code === 'PARA_ATTACHMENT_URL_INVALID',
    );
  }
});

test('para-scope enforces strict organization isolation, actor mapping, and safe references', async () => {
  const { createParaScopeMiddleware } = require(path.join(PLUGIN_ROOT, 'src/server/para-scope.js'));

  const employees = [{ id: 11, userId: 101, organizationId: 'org-a', departmentId: 3, active: true }];
  const departments = [{ id: 3, organizationId: 'org-a', active: true }, { id: 99, organizationId: 'org-b', active: true }];
  const db = {
    getRepository(name) {
      if (name === 'latticeEmployees') {
        return { find: async ({ filter }) => employees.filter((e) => Number(e.userId) === Number(filter?.userId)) };
      }
      if (name === 'latticeDepartments') {
        return { findOne: async ({ filter }) => departments.find((d) => Number(d.id) === Number(filter?.id) && d.organizationId === filter?.organizationId && d.active === filter?.active) || null };
      }
      return null;
    },
  };
  const mw = createParaScopeMiddleware(db);

  // Unmapped user gets 403
  await assert.rejects(
    () => mw({ state: { currentRole: 'ldx_employee', currentUser: { id: 999 } }, action: { resourceName: 'latticeParaDocuments', actionName: 'list', params: {} } }, async () => {}),
    (err) => err.status === 403 && err.code === 'NATIVE_MEMBERSHIP_REQUIRED',
  );

  // Read filters to caller org
  const readCtx = { state: { currentRole: 'ldx_employee', currentUser: { id: 101 } }, action: { resourceName: 'latticeParaDocuments', actionName: 'list', params: { filter: { paraSpace: 'projects' } } } };
  let proceeded = false;
  await mw(readCtx, async () => { proceeded = true; });
  assert.equal(proceeded, true);
  assert.deepEqual(readCtx.action.params.filter, { $and: [{ organizationId: 'org-a' }, { paraSpace: 'projects' }] });

  // Spoofed organizationId on create throws 403
  await assert.rejects(
    () => mw({ state: { currentRole: 'ldx_employee', currentUser: { id: 101 } }, action: { resourceName: 'latticeParaDocuments', actionName: 'create', params: { values: { title: 'Doc', code: 'D1', organizationId: 'org-b' } } } }, async () => {}),
    (err) => err.status === 403 && err.code === 'NATIVE_ORGANIZATION_MISMATCH',
  );

  // Spoofed ownerId rejected
  await assert.rejects(
    () => mw({ state: { currentRole: 'ldx_employee', currentUser: { id: 101 } }, action: { resourceName: 'latticeParaDocuments', actionName: 'create', params: { values: { title: 'Doc', code: 'D1', ownerId: 55 } } } }, async () => {}),
    (err) => err.status === 403 && err.code === 'NATIVE_PROTECTED_FIELD',
  );

  // Cross-org department reference rejected
  await assert.rejects(
    () => mw({ state: { currentRole: 'ldx_employee', currentUser: { id: 101 } }, action: { resourceName: 'latticeParaDocuments', actionName: 'create', params: { values: { title: 'Doc', code: 'D1', departmentId: 99 } } } }, async () => {}),
    (err) => err.status === 403 && err.code === 'NATIVE_REFERENCE_UNAVAILABLE',
  );

  // Valid create stamps organizationId and ownerId and departmentId
  const createCtx = { state: { currentRole: 'ldx_employee', currentUser: { id: 101 } }, action: { resourceName: 'latticeParaDocuments', actionName: 'create', params: { values: { title: 'SOP', code: 'SOP-1', paraSpace: 'areas' } } } };
  await mw(createCtx, async () => {});
  assert.equal(createCtx.action.params.values.organizationId, 'org-a');
  assert.equal(createCtx.action.params.values.ownerId, 11);
  assert.equal(createCtx.action.params.values.departmentId, 3);

  // Root passthrough works without employee row
  let rootRan = false;
  await mw({ state: { currentRole: 'root', currentUser: { id: 1 } }, action: { resourceName: 'latticeParaDocuments', actionName: 'list', params: {} } }, async () => { rootRan = true; });
  assert.equal(rootRan, true);

  // charts:queryData on latticeParaDocuments enforces organization scope
  const chartCtx = {
    state: { currentRole: 'ldx_employee', currentUser: { id: 101 } },
    action: { resourceName: 'charts', actionName: 'queryData', params: { values: { mode: 'builder', collection: 'latticeParaDocuments', filter: { paraSpace: 'projects' } } } },
  };
  await mw(chartCtx, async () => {});
  assert.deepEqual(chartCtx.action.params.values.filter, { $and: [{ organizationId: 'org-a' }, { paraSpace: 'projects' }] });
});

test('installParaRoleGrants configures 7 ldx_* roles idempotently', async () => {
  const { installParaRoleGrants } = require(path.join(PLUGIN_ROOT, 'src/server/para-roles.js'));
  const existingRoles = ['ldx_employee', 'ldx_manager', 'ldx_warehouse', 'ldx_dispatcher', 'ldx_driver', 'ldx_director', 'ldx_admin'];
  const createdResources = [];

  const db = {
    sequelize: { transaction: async (fn) => fn({}) },
    getRepository(name) {
      if (name === 'roles') {
        return { findOne: async ({ filter }) => (existingRoles.includes(filter.name) ? { name: filter.name } : null) };
      }
      if (name === 'dataSourcesRolesResources') {
        return {
          findOne: async ({ filter }) => createdResources.find((r) => r.name === filter.name && r.roleName === filter.roleName && r.dataSourceKey === filter.dataSourceKey) || null,
          create: async ({ values }) => { createdResources.push(values); return values; },
        };
      }
      return null;
    },
  };

  await installParaRoleGrants(db);
  assert.equal(createdResources.length, 7);
  const directorGrant = createdResources.find((r) => r.roleName === 'ldx_director');
  assert.deepEqual(directorGrant.actions.map((a) => a.name), ['view']);
  const employeeGrant = createdResources.find((r) => r.roleName === 'ldx_employee');
  assert.deepEqual(employeeGrant.actions.map((a) => a.name), ['view', 'create', 'update']);
  const createAction = employeeGrant.actions.find((a) => a.name === 'create');
  assert.ok(!createAction.fields.includes('organizationId'));
  assert.ok(!createAction.fields.includes('ownerId'));

  // Re-running does not duplicate
  await installParaRoleGrants(db);
  assert.equal(createdResources.length, 7);
});

test('latticePara:summary returns per-space org-scoped counts and root preview', async () => {
  const { createParaActions } = require(path.join(PLUGIN_ROOT, 'src/server/para-resource.js'));
  const docs = [
    { id: 1, organizationId: 'org-a', paraSpace: 'projects', active: true },
    { id: 2, organizationId: 'org-a', paraSpace: 'projects', active: true },
    { id: 3, organizationId: 'org-a', paraSpace: 'areas', active: true },
    { id: 4, organizationId: 'org-b', paraSpace: 'archives', active: true },
  ];
  const db = {
    getRepository(name) {
      if (name === 'latticeEmployees') {
        return {
          find: async ({ filter } = {}) => {
            if (filter?.userId != null) {
              return Number(filter.userId) === 10 ? [{ id: 1, userId: 10, organizationId: 'org-a', active: true }] : [];
            }
            return [
              { id: 1, organizationId: 'org-a', active: true },
              { id: 2, organizationId: 'org-b', active: true },
              { id: 3, organizationId: 'org-b', active: true },
            ];
          },
        };
      }
      if (name === 'latticeDepartments') {
        return { find: async () => [{ id: 1, organizationId: 'org-c', active: true }] };
      }
      if (name === 'latticeParaDocuments') {
        return {
          find: async ({ filter }) => docs.filter((d) => (!filter?.organizationId || d.organizationId === filter.organizationId) && d.active),
        };
      }
      return null;
    },
  };
  const actions = createParaActions(db);

  // Org-a user sees only org-a docs (total 3)
  const ctxUser = { method: 'GET', state: { currentRole: 'ldx_employee', currentUser: { id: 10 } }, action: { params: {} }, throw(s, m) { throw Object.assign(new Error(m), { status: s }); } };
  await actions.summary(ctxUser, async () => {});
  assert.equal(ctxUser.body.organizationId, 'org-a');
  assert.deepEqual(ctxUser.body.organizations, ['org-a']);
  assert.deepEqual(ctxUser.body.spaces, { projects: 2, areas: 1, resources: 0, archives: 0 });
  assert.equal(ctxUser.body.total, 3);

  // Root without employee row gets preview across orgs with orgs sorted by headcount DESC
  const ctxRoot = { method: 'GET', state: { currentRole: 'root', currentUser: { id: 1 } }, action: { params: {} }, throw(s, m) { throw Object.assign(new Error(m), { status: s }); } };
  await actions.summary(ctxRoot, async () => {});
  assert.equal(ctxRoot.body.total, 4);
  assert.equal(ctxRoot.body.spaces.archives, 1);
  assert.deepEqual(ctxRoot.body.organizations, ['org-b', 'org-a', 'org-c']);

  // Unmapped business user gets 403
  await assert.rejects(
    () => actions.summary({ method: 'GET', state: { currentRole: 'ldx_employee', currentUser: { id: 99 } }, action: { params: {} }, throw(s, m) { throw Object.assign(new Error(m), { status: s }); } }, async () => {}),
    (err) => err.status === 403,
  );
});

test('para-scope blocks dotted filters, oversized pageSize, and non-owner edits; summary prefers count()', async () => {
  const { createParaScopeMiddleware } = require(path.join(PLUGIN_ROOT, 'src/server/para-scope.js'));
  const { createParaActions } = require(path.join(PLUGIN_ROOT, 'src/server/para-resource.js'));

  const employees = [
    { id: 11, userId: 101, organizationId: 'org-a', departmentId: 3, active: true },
    { id: 12, userId: 102, organizationId: 'org-a', departmentId: 3, active: true },
  ];
  const docs = [{ id: 50, organizationId: 'org-a', ownerId: 11, paraSpace: 'projects', active: true }];
  const db = {
    getRepository(name) {
      if (name === 'latticeEmployees') {
        return { find: async ({ filter }) => employees.filter((e) => Number(e.userId) === Number(filter?.userId)) };
      }
      if (name === 'latticeParaDocuments') {
        return { findOne: async ({ filter }) => docs.find((d) => Number(d.id) === Number(filter?.id) && d.organizationId === filter?.organizationId) || null };
      }
      return null;
    },
  };
  const mw = createParaScopeMiddleware(db);

  // Dotted filter rejected
  await assert.rejects(
    () => mw({ state: { currentRole: 'ldx_employee', currentUser: { id: 101 } }, action: { resourceName: 'latticeParaDocuments', actionName: 'list', params: { filter: { 'owner.user.password': { $ne: null } } } } }, async () => {}),
    (err) => err.status === 403 && err.code === 'NATIVE_RELATION_EXPANSION_UNSUPPORTED',
  );

  // Oversized pageSize clamped
  const listCtx = { state: { currentRole: 'ldx_employee', currentUser: { id: 101 } }, action: { resourceName: 'latticeParaDocuments', actionName: 'list', params: { pageSize: 99999 } } };
  await mw(listCtx, async () => {});
  assert.equal(listCtx.action.params.pageSize, 200);

  // Non-owner employee cannot update another employee's P.A.R.A. document
  await assert.rejects(
    () => mw({ state: { currentRole: 'ldx_employee', currentUser: { id: 102 } }, action: { resourceName: 'latticeParaDocuments', actionName: 'update', params: { filterByTk: 50, values: { title: 'Hijack' } } } }, async () => {}),
    (err) => err.status === 403 && err.code === 'PARA_OWNER_REQUIRED',
  );

  // Non-owner employee destroy also blocked
  await assert.rejects(
    () => mw({ state: { currentRole: 'ldx_employee', currentUser: { id: 102 } }, action: { resourceName: 'latticeParaDocuments', actionName: 'destroy', params: { filterByTk: 50 } } }, async () => {}),
    (err) => err.status === 403 && err.code === 'PARA_OWNER_REQUIRED',
  );

  // Owner or manager CAN update
  const ownerCtx = { state: { currentRole: 'ldx_employee', currentUser: { id: 101 } }, action: { resourceName: 'latticeParaDocuments', actionName: 'update', params: { filterByTk: 50, values: { title: 'Mine' } } } };
  await mw(ownerCtx, async () => {});
  assert.equal(ownerCtx.action.params.values.title, 'Mine');

  const mgrCtx = { state: { currentRole: 'ldx_manager', currentUser: { id: 102 } }, action: { resourceName: 'latticeParaDocuments', actionName: 'update', params: { filterByTk: 50, values: { title: 'Mgr' } } } };
  await mw(mgrCtx, async () => {});
  assert.equal(mgrCtx.action.params.values.title, 'Mgr');

  // summary() uses repo.count() without loading rows via find()
  let findCalled = false;
  let countCalls = 0;
  const countDb = {
    getRepository(name) {
      if (name === 'latticeEmployees') return { find: async () => [employees[0]] };
      if (name === 'latticeParaDocuments') {
        return {
          find: async () => { findCalled = true; return []; },
          count: async ({ filter }) => {
            countCalls += 1;
            return docs.filter((d) => d.organizationId === filter.organizationId && d.paraSpace === filter.paraSpace && d.active).length;
          },
        };
      }
      return null;
    },
  };
  const sumCtx = { method: 'GET', state: { currentRole: 'ldx_employee', currentUser: { id: 101 } }, action: { params: {} }, throw(s, m) { throw Object.assign(new Error(m), { status: s }); } };
  await createParaActions(countDb).summary(sumCtx, async () => {});
  assert.equal(findCalled, false);
  assert.equal(countCalls, 4);
  assert.equal(sumCtx.body.spaces.projects, 1);
  assert.equal(sumCtx.body.total, 1);
});

test('para-scope enforces optimistic version locking on updates', async () => {
  const { createParaScopeMiddleware } = require(path.join(PLUGIN_ROOT, 'src/server/para-scope.js'));
  const employees = [{ id: 11, userId: 101, organizationId: 'org-a', departmentId: 3, active: true }];
  const docs = [{ id: 50, organizationId: 'org-a', ownerId: 11, version: 3, paraSpace: 'projects', active: true }];
  const db = {
    getRepository(name) {
      if (name === 'latticeEmployees') return { find: async () => employees };
      if (name === 'latticeParaDocuments') return { findOne: async () => docs[0] };
      return null;
    },
  };
  const mw = createParaScopeMiddleware(db);

  // Stale expectedVersion fails 409 VERSION_CONFLICT
  await assert.rejects(
    () => mw({
      state: { currentRole: 'ldx_employee', currentUser: { id: 101 } },
      action: { resourceName: 'latticeParaDocuments', actionName: 'update', params: { filterByTk: 50, values: { title: 'Stale', expectedVersion: 2 } } },
    }, async () => {}),
    (err) => err.status === 409 && err.code === 'VERSION_CONFLICT',
  );

  // Matching expectedVersion succeeds and increments version to 4
  const okCtx = {
    state: { currentRole: 'ldx_employee', currentUser: { id: 101 } },
    action: { resourceName: 'latticeParaDocuments', actionName: 'update', params: { filterByTk: 50, values: { title: 'Fresh', expectedVersion: 3 } } },
  };
  await mw(okCtx, async () => {});
  assert.equal(okCtx.action.params.values.version, 4);
  assert.equal(okCtx.action.params.values.expectedVersion, undefined);
});
