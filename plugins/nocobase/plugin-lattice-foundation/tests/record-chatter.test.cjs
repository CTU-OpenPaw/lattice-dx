/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

function makeChatterDbHarness({ withNotifications = true } = {}) {
  let seq = 0;
  let notifSeq = 0;
  const employees = [
    { id: 10, userId: 101, organizationId: 'org-a', active: true, code: 'EMP-A1', name: 'Nguyen An', email: 'an@orga.example' },
    { id: 11, userId: 102, organizationId: 'org-a', active: true, code: 'EMP-A2', name: 'Tran Binh', email: 'binh@orga.example' },
    { id: 12, userId: 103, organizationId: 'org-a', active: false, code: 'EMP-INACTIVE', name: 'Inactive A', email: 'off@orga.example' },
    { id: 20, userId: 201, organizationId: 'org-b', active: true, code: 'EMP-B1', name: 'Le Cuong', email: 'cuong@orgb.example' },
  ];
  const requests = [
    { id: 5, organizationId: 'org-a', code: 'REQ-A5', name: 'Mua server', status: 'draft', description: 'Cu', version: 1 },
    { id: 9, organizationId: 'org-b', code: 'REQ-B9', name: 'Mua xe', status: 'draft', description: 'Org B secret', version: 1 },
  ];
  const chatter = [];
  const notifications = [];
  const match = (row, filter = {}) => Object.entries(filter).every(([k, cond]) => {
    if (k === '$and' && Array.isArray(cond)) return cond.every((sub) => match(row, sub));
    if (cond && typeof cond === 'object' && Array.isArray(cond.$in)) return cond.$in.includes(row[k]);
    return row[k] === cond;
  });

  const db = {
    sequelize: {
      transaction: async (fn) => fn({ LOCK: { UPDATE: 'UPDATE' }, id: 'tx' }),
    },
    getModel(name) {
      if (name === 'latticeRequests') {
        return {
          findOne: async ({ where }) => requests.find((r) => match(r, where)) || null,
        };
      }
      return null;
    },
    getRepository(name) {
      if (name === 'latticeEmployees') {
        return {
          find: async ({ filter }) => employees.filter((e) => match(e, filter)),
        };
      }
      if (name === 'latticeRequests') {
        return {
          findOne: async ({ filter, filterByTk }) => {
            if (filterByTk != null && !filter) return requests.find((r) => Number(r.id) === Number(filterByTk)) || null;
            return requests.find((r) => match(r, filter)) || null;
          },
          update: async ({ filterByTk, values }) => {
            const row = requests.find((r) => Number(r.id) === Number(filterByTk));
            if (!row) return [];
            Object.assign(row, values);
            return [row];
          },
        };
      }
      if (name === 'latticeRecordChatter') {
        return {
          find: async ({ filter, limit = 50 }) => chatter.filter((c) => match(c, filter)).slice(0, limit),
          count: async ({ filter }) => chatter.filter((c) => match(c, filter)).length,
          create: async ({ values }) => {
            const entry = { id: ++seq, createdAt: new Date().toISOString(), ...values };
            chatter.push(entry);
            return entry;
          },
        };
      }
      if (name === 'latticeNotifications' && withNotifications) {
        return {
          find: async ({ filter, limit = 50 }) => notifications.filter((n) => match(n, filter)).slice(0, limit),
          create: async ({ values }) => {
            const row = { id: ++notifSeq, createdAt: new Date().toISOString(), ...values };
            notifications.push(row);
            return row;
          },
        };
      }
      return null;
    },
  };
  return { db, chatter, requests, notifications };
}

test('extractMentionTokens parses clean handles and resolveOrganizationMentions isolates same-org active employees with userId', async () => {
  const { extractMentionTokens, resolveOrganizationMentions } = require('../src/server/record-chatter');
  const tokens = extractMentionTokens('Xin @EMP-A2 và @an xem giúp (không tính mail@foreign.com, giữ @emp-a2 và @EMP-B1)');
  assert.deepEqual(tokens, ['emp-a2', 'an', 'emp-b1']);

  const { db } = makeChatterDbHarness();
  const resolved = await resolveOrganizationMentions(db, 'org-a', tokens);
  assert.equal(resolved.length, 2);
  assert.deepEqual(resolved.map((m) => m.code).sort(), ['EMP-A1', 'EMP-A2']);
  assert.deepEqual(resolved.map((m) => m.userId).sort((a, b) => a - b), [101, 102]);
  assert.equal(resolved.some((m) => m.code === 'EMP-B1' || m.code === 'EMP-INACTIVE'), false);
});

test('computeRecordFieldDiff computes clean field diffs and strips timestamps, versions, and secrets', () => {
  const { computeRecordFieldDiff } = require('../src/server/record-chatter');
  const diffs = computeRecordFieldDiff(
    { name: 'Cũ', status: 'draft', version: 1, updatedAt: 't1', apiKey: 'secret1', passwordHash: 'h1' },
    { name: 'Mới', status: 'draft', version: 2, updatedAt: 't2', apiKey: 'secret2', passwordHash: 'h2' },
  );
  assert.deepEqual(diffs, [{ field: 'name', before: 'Cũ', after: 'Mới' }]);
});

test('latticeChatter actions enforce collection allowlist, body bounds, and cross-org target isolation (404 IDOR defense)', async () => {
  const { registerChatterResource } = require('../src/server/record-chatter');
  const { db, chatter } = makeChatterDbHarness();
  let actions;
  const app = {
    db,
    resourceManager: { define: (def) => { actions = def.actions; } },
    acl: { allow: () => {} },
  };
  registerChatterResource(app);

  const empCtx = (params, method = 'POST') => ({
    method,
    state: { currentUser: { id: 101, username: 'an' }, currentRole: 'ldx_employee' },
    action: { params },
    throw(status, message) { throw Object.assign(new Error(message || String(status)), { status }); },
  });

  // Disallowed collection fails closed
  await assert.rejects(
    () => actions.post(empCtx({ values: { targetCollection: 'users', targetRecordId: 1, body: 'hi' } }), async () => {}),
    (err) => err.status === 400,
  );

  // Empty body rejected
  await assert.rejects(
    () => actions.post(empCtx({ values: { targetCollection: 'latticeRequests', targetRecordId: 5, body: '   ' } }), async () => {}),
    (err) => err.status === 400,
  );

  // Cross-org target record ID returns 404 (no leak of org-b record #9)
  await assert.rejects(
    () => actions.post(empCtx({ values: { targetCollection: 'latticeRequests', targetRecordId: 9, body: 'Probe org-b @EMP-B1' } }), async () => {}),
    (err) => err.status === 404,
  );
  await assert.rejects(
    () => actions.list(empCtx({ targetCollection: 'latticeRequests', targetRecordId: 9 }, 'GET'), async () => {}),
    (err) => err.status === 404,
  );

  // Same-org comment succeeds & only resolves same-org @mention and dispatches mention notification
  const { db: dbWithNotif, notifications } = makeChatterDbHarness({ withNotifications: true });
  let notifActions;
  registerChatterResource({
    db: dbWithNotif,
    resourceManager: { define: (def) => { notifActions = def.actions; } },
    acl: { allow: () => {} },
  });
  const okPost = empCtx({ values: { targetCollection: 'latticeRequests', targetRecordId: 5, body: 'Nhờ @EMP-A2 và @EMP-B1 kiểm tra nhé' } });
  await actions.post(okPost, async () => {});
  assert.equal(okPost.body.entryType, 'comment');
  assert.equal(okPost.body.organizationId, 'org-a');
  assert.deepEqual(okPost.body.mentionsJson.map((m) => m.code), ['EMP-A2']);
  assert.equal(okPost.body.mentionsJson[0].userId, 102);

  await notifActions.post(empCtx({ values: { targetCollection: 'latticeRequests', targetRecordId: 5, body: 'Ping @EMP-A2 kiểm tra' } }), async () => {});
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].organizationId, 'org-a');
  assert.equal(notifications[0].recipientUserId, 102);
  assert.equal(notifications[0].category, 'mention');
  assert.equal(notifications[0].targetCollection, 'latticeRequests');
  assert.equal(notifications[0].targetRecordId, 5);
  assert.ok(notifications[0].targetPath);

  // Non-fatal when latticeNotifications repo is absent in older mocks
  const { db: dbNoNotif } = makeChatterDbHarness({ withNotifications: false });
  let oldActions;
  registerChatterResource({
    db: dbNoNotif,
    resourceManager: { define: (def) => { oldActions = def.actions; } },
    acl: { allow: () => {} },
  });
  const fallbackPost = empCtx({ values: { targetCollection: 'latticeRequests', targetRecordId: 5, body: 'Test @EMP-A2 no notif repo' } });
  await oldActions.post(fallbackPost, async () => {});
  assert.equal(fallbackPost.body.entryType, 'comment');

  const okList = empCtx({ targetCollection: 'latticeRequests', targetRecordId: 5 }, 'GET');
  await actions.list(okList, async () => {});
  assert.equal(okList.body.items.length, 1);
  assert.equal(chatter.length, 1);
});

test('updateScopedDocument records automatic field_diff chatter after updating scoped record', async () => {
  const { updateScopedDocument } = require('../src/server/native-scope');
  const { db, chatter } = makeChatterDbHarness();
  const ctx = {
    action: {
      resourceName: 'latticeRequests',
      params: { filterByTk: 5, values: { name: 'Mua server Rack G2', expectedVersion: 1 } },
    },
    status: 200,
  };
  await updateScopedDocument(db, ctx, { userId: '101', employeeId: 10, organizationId: 'org-a' });
  assert.equal(chatter.length, 1);
  assert.equal(chatter[0].entryType, 'field_diff');
  assert.equal(chatter[0].organizationId, 'org-a');
  assert.deepEqual(chatter[0].diffJson, [{ field: 'name', before: 'Mua server', after: 'Mua server Rack G2' }]);
});

test('migration 20261122000900 creates and drops latticeRecordChatter reversibly', () => {
  const migSrc = readFileSync(path.resolve(__dirname, '../src/server/migrations/20261122000900-record-chatter-table.js'), 'utf8');
  assert.match(migSrc, /CREATE TABLE IF NOT EXISTS "latticeRecordChatter"/);
  assert.match(migSrc, /idx_lattice_chatter_org_target/);
  assert.match(migSrc, /idx_lattice_chatter_org_type/);
  assert.match(migSrc, /idx_lattice_chatter_org_author/);
  assert.match(migSrc, /DROP TABLE IF EXISTS "latticeRecordChatter"/);
});

test('Task 7: isChatterCollectionAllowed, latticeChatter actions, and recordFieldDiffChatter unlock latticeCustom* with strict org-scope and RBAC', async () => {
  const {
    isChatterCollectionAllowed,
    recordFieldDiffChatter,
    registerChatterResource,
  } = require('../src/server/record-chatter');

  assert.equal(typeof isChatterCollectionAllowed, 'function');
  assert.equal(isChatterCollectionAllowed('latticeRequests'), true);
  assert.equal(isChatterCollectionAllowed('latticeCustomWorkOrders'), true);
  assert.equal(isChatterCollectionAllowed('latticeCustomColdAlerts'), true);
  assert.equal(isChatterCollectionAllowed('users'), false);
  assert.equal(isChatterCollectionAllowed('latticeBuiltApps'), false);
  assert.equal(isChatterCollectionAllowed('latticeCustom_bad'), false);

  let seq = 0;
  const employees = [
    { id: 10, userId: 101, organizationId: 'org-a', active: true, code: 'EMP-A1', name: 'Nguyen An', email: 'an@orga.example' },
    { id: 20, userId: 201, organizationId: 'org-b', active: true, code: 'EMP-B1', name: 'Le Cuong', email: 'cuong@orgb.example' },
  ];
  const customOrders = [
    { id: 31, organizationId: 'org-a', code: 'WO-A31', equipmentName: 'Chiller 01', status: 'open' },
    { id: 32, organizationId: 'org-b', code: 'WO-B32', equipmentName: 'Chiller Org B', status: 'open' },
  ];
  const chatter = [];
  const match = (row, filter = {}) => Object.entries(filter).every(([k, cond]) => {
    if (k === '$and' && Array.isArray(cond)) return cond.every((sub) => match(row, sub));
    return row[k] === cond;
  });

  const db = {
    getRepository(name) {
      if (name === 'latticeEmployees') return { find: async ({ filter }) => employees.filter((e) => match(e, filter)) };
      if (name === 'latticeCustomWorkOrders') {
        return {
          // Deliberately test org-scope even when filter matches id=32 if org-b row returned
          findOne: async ({ filter }) => customOrders.find((r) => match(r, filter)) || null,
        };
      }
      if (name === 'latticeRecordChatter') {
        return {
          find: async ({ filter, limit = 50 }) => chatter.filter((c) => match(c, filter)).slice(0, limit),
          count: async ({ filter }) => chatter.filter((c) => match(c, filter)).length,
          create: async ({ values }) => {
            const entry = { id: ++seq, createdAt: new Date().toISOString(), ...values };
            chatter.push(entry);
            return entry;
          },
        };
      }
      return null;
    },
  };

  let actions;
  registerChatterResource({
    db,
    resourceManager: { define: (def) => { actions = def.actions; } },
    acl: { allow: () => {} },
  });

  const makeCtx = (params, method = 'POST', { can = null } = {}) => ({
    method,
    state: { currentUser: { id: 101, username: 'an' }, currentRole: 'ldx_operator' },
    action: { params },
    ...(can ? { can } : {}),
    throw(status, message) { throw Object.assign(new Error(message || String(status)), { status }); },
  });

  // 1. RBAC denial on targetCollection returns 403
  await assert.rejects(
    () => actions.list(
      makeCtx({ targetCollection: 'latticeCustomWorkOrders', targetRecordId: 31 }, 'GET', { can: () => false }),
      async () => {},
    ),
    (err) => err.status === 403,
  );
  await assert.rejects(
    () => actions.post(
      makeCtx({ values: { targetCollection: 'latticeCustomWorkOrders', targetRecordId: 31, body: 'Test' } }, 'POST', { can: () => false }),
      async () => {},
    ),
    (err) => err.status === 403,
  );

  // 2. Cross-org record returns 404 (IDOR defense)
  await assert.rejects(
    () => actions.post(
      makeCtx(
        { values: { targetCollection: 'latticeCustomWorkOrders', targetRecordId: 32, body: 'Probe B' } },
        'POST',
        { can: ({ resource }) => resource === 'latticeCustomWorkOrders' },
      ),
      async () => {},
    ),
    (err) => err.status === 404,
  );

  // 3. Same-org post & list succeed on latticeCustomWorkOrders
  const postCtx = makeCtx(
    { values: { targetCollection: 'latticeCustomWorkOrders', targetRecordId: 31, body: 'Kiểm tra máy nén @EMP-A1' } },
    'POST',
    { can: ({ resource, action }) => resource === 'latticeCustomWorkOrders' && action === 'view' },
  );
  await actions.post(postCtx, async () => {});
  assert.equal(postCtx.body.targetCollection, 'latticeCustomWorkOrders');
  assert.equal(postCtx.body.organizationId, 'org-a');

  const listCtx = makeCtx(
    { targetCollection: 'latticeCustomWorkOrders', targetRecordId: 31 },
    'GET',
    { can: ({ resource, action }) => resource === 'latticeCustomWorkOrders' && action === 'list' },
  );
  await actions.list(listCtx, async () => {});
  assert.equal(listCtx.body.items.length, 1);

  // 4. recordFieldDiffChatter works on latticeCustomWorkOrders while stripping sensitive fields
  const diffEntry = await recordFieldDiffChatter(db, {
    organizationId: 'org-a',
    targetCollection: 'latticeCustomWorkOrders',
    targetRecordId: 31,
    before: { status: 'open', equipmentName: 'Chiller 01', apiKey: 'old-sec' },
    after: { status: 'assigned', equipmentName: 'Chiller 01', apiKey: 'new-sec' },
    actor: { userId: '101', employeeId: 10, username: 'an' },
  });
  assert.ok(diffEntry, 'recordFieldDiffChatter must record field diff for latticeCustomWorkOrders');
  assert.equal(diffEntry.entryType, 'field_diff');
  assert.deepEqual(diffEntry.diffJson, [{ field: 'status', before: 'open', after: 'assigned' }]);

  // 5. Defense-in-depth: even if a custom repo ignores filter.organizationId, mismatched row org fails 404;
  //    and dataSourcesRolesResources RBAC denial fails 403 when ctx.can is omitted.
  const leakyDb = {
    getRepository(name) {
      if (name === 'latticeCustomWorkOrders') {
        return { findOne: async () => ({ id: 32, organizationId: 'org-b', code: 'WO-B32' }) };
      }
      if (name === 'roles') {
        return { findOne: async () => ({ name: 'ldx_operator', allowAll: false }) };
      }
      if (name === 'dataSourcesRolesResources') {
        return { findOne: async () => null };
      }
      return db.getRepository(name);
    },
  };
  let leakyActions;
  registerChatterResource({
    db: leakyDb,
    resourceManager: { define: (def) => { leakyActions = def.actions; } },
    acl: { allow: () => {} },
  });
  await assert.rejects(
    () => leakyActions.list(makeCtx({ targetCollection: 'latticeCustomWorkOrders', targetRecordId: 32 }, 'GET'), async () => {}),
    (err) => err.status === 403 && err.code === 'CHATTER_ACCESS_DENIED',
  );
  await assert.rejects(
    () => leakyActions.list(
      makeCtx({ targetCollection: 'latticeCustomWorkOrders', targetRecordId: 32 }, 'GET', { can: () => true }),
      async () => {},
    ),
    (err) => err.status === 404,
  );
});
