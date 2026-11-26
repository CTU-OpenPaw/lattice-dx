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
const path = require('node:path');

const PLUGIN_ROOT = path.resolve(__dirname, '..');

test('surface-events publishes local subscribers, broadcasts over app.pubSubManager, and avoids echo loops', async () => {
  const {
    CHANNEL,
    attachAppPubSub,
    subscribeSurfaceEvents,
    publishSurfaceUpdate,
  } = require(path.join(PLUGIN_ROOT, 'src/server/surface-events.js'));

  const published = [];
  let subscribedHandler = null;
  const mockApp = {
    pubSubManager: {
      subscribe: async (ch, fn) => {
        assert.equal(ch, CHANNEL);
        subscribedHandler = fn;
      },
      publish: async (ch, msg) => {
        published.push({ ch, msg });
      },
    },
  };
  attachAppPubSub(mockApp);

  const localEvents = [];
  const off = subscribeSurfaceEvents('services', (ev) => localEvents.push(ev));

  publishSurfaceUpdate('services', { revision: 4, blockCount: 3, layoutSignature: 'a,b,c', message: 'Added KPI' });
  await new Promise((r) => setTimeout(r, 5));

  assert.equal(localEvents.length, 1);
  assert.equal(localEvents[0].revision, 4);
  assert.equal(published.length, 1);
  assert.equal(published[0].ch, CHANNEL);
  assert.equal(published[0].msg.portalSlug, 'services');
  assert.ok(published[0].msg.instanceId);

  // Echo from same instanceId is ignored
  await subscribedHandler(published[0].msg);
  assert.equal(localEvents.length, 1);

  // Remote instance message is relayed cleanly
  await subscribedHandler({ portalSlug: 'services', revision: 5, instanceId: 'remote-node-2', layoutSignature: 'a,b,c,d' });
  assert.equal(localEvents.length, 2);
  assert.equal(localEvents[1].revision, 5);

  off();
});

test('surfaceEvents SSE handler streams snapshot, pushes live updates, rejects 401/400, and unsubscribes on close', async () => {
  const {
    createSurfaceEventsHandler,
    publishSurfaceUpdate,
  } = require(path.join(PLUGIN_ROOT, 'src/server/surface-events.js'));

  const handler = createSurfaceEventsHandler({
    getInitialState: async (_ctx, portalSlug, pageTitle) => ({
      portalSlug,
      pageTitle: pageTitle || null,
      revision: 2,
      blockCount: 2,
      layoutSignature: 'x,y',
    }),
  });

  await assert.rejects(
    () => handler({ state: {}, action: { params: { portalSlug: 'services' } }, query: {} }),
    (err) => err.status === 401,
  );
  await assert.rejects(
    () => handler({ state: { currentUser: { id: 1 } }, action: { params: { portalSlug: '../bad' } }, query: {} }),
    (err) => err.status === 400,
  );

  const writes = [];
  const headers = {};
  const req = new EventEmitter();
  const res = new EventEmitter();
  res.writeHead = (status, hdrs) => {
    res.statusCode = status;
    Object.assign(headers, hdrs);
  };
  res.write = (chunk) => {
    writes.push(String(chunk));
    return true;
  };
  res.flushHeaders = () => {};

  const ctx = {
    state: { currentUser: { id: 1 } },
    action: { params: { portalSlug: 'coldchain', pageTitle: 'Kho lạnh' } },
    query: {},
    req,
    res,
    respond: true,
  };

  await handler(ctx);
  assert.equal(ctx.respond, false);
  assert.equal(res.statusCode, 200);
  assert.match(headers['Content-Type'], /text\/event-stream/);
  assert.equal(headers['X-Accel-Buffering'], 'no');
  assert.ok(writes.some((w) => w.includes('event: snapshot') && w.includes('"revision":2')));

  publishSurfaceUpdate('coldchain', { revision: 3, blockCount: 3, layoutSignature: 'x,y,z', message: 'Thêm nhiệt kế' });
  assert.ok(writes.some((w) => w.includes('event: update') && w.includes('"revision":3')));

  const beforeClose = writes.length;
  req.emit('close');
  publishSurfaceUpdate('coldchain', { revision: 4, blockCount: 4, layoutSignature: 'x,y,z,w' });
  assert.equal(writes.length, beforeClose);
});

test('T1-FLOW-01: flow-studio SSE ACL allows ldx_manager/ldx_admin/admin/root, rejects ldx_employee/ldx_driver/anonymous and cross-org', async () => {
  const { createSurfaceEventsHandler } = require(path.join(PLUGIN_ROOT, 'src/server/surface-events.js'));

  const store = {
    roles: [
      { name: 'root', allowConfigure: true, snippets: ['pm'] },
      { name: 'admin', allowConfigure: true, snippets: ['pm'] },
      { name: 'ldx_admin', allowConfigure: true, snippets: ['pm'] },
      { name: 'ldx_manager', allowConfigure: false, snippets: [] },
      { name: 'ldx_employee', allowConfigure: false, snippets: [] },
      { name: 'ldx_driver', allowConfigure: false, snippets: [] },
    ],
    rolesUsers: [
      { userId: 1, roleName: 'root' },
      { userId: 2, roleName: 'admin' },
      { userId: 3, roleName: 'ldx_admin' },
      { userId: 4, roleName: 'ldx_manager' },
      { userId: 5, roleName: 'ldx_employee' },
      { userId: 6, roleName: 'ldx_driver' },
    ],
    latticeEmployees: [
      { id: 101, userId: 1, organizationId: 'org-a', active: true },
      { id: 102, userId: 2, organizationId: 'org-a', active: true },
      { id: 103, userId: 3, organizationId: 'org-a', active: true },
      { id: 104, userId: 4, organizationId: 'org-a', active: true },
      { id: 105, userId: 5, organizationId: 'org-a', active: true },
      { id: 106, userId: 6, organizationId: 'org-a', active: true },
    ],
    latticeOrganizations: [
      { id: 1, organizationId: 'org-a', active: true, status: 'active' },
      { id: 2, organizationId: 'org-b', active: true, status: 'active' },
    ],
  };
  const matches = (row, filter = {}) => Object.entries(filter || {}).every(([k, cond]) => {
    if (cond && typeof cond === 'object' && '$in' in cond) return cond.$in.includes(row[k]);
    return String(row[k]) === String(cond);
  });
  const db = {
    getRepository: (name) => {
      const arr = store[name];
      if (!arr) return null;
      return {
        find: async ({ filter = {}, limit = 500 } = {}) => arr.filter((r) => matches(r, filter)).slice(0, limit),
        findOne: async ({ filter = {} } = {}) => arr.find((r) => matches(r, filter)) || null,
      };
    },
  };

  const handler = createSurfaceEventsHandler({
    db,
    getInitialState: async (_ctx, portalSlug, _pageTitle, organizationId) => ({
      organizationId,
      portalSlug,
      revision: 1,
    }),
  });

  // Authorized roles on flow-studio: root, admin, ldx_admin, ldx_manager
  for (const [userId, role] of [[1, 'root'], [2, 'admin'], [3, 'ldx_admin'], [4, 'ldx_manager']]) {
    const writes = [];
    const req = new EventEmitter();
    const res = new EventEmitter();
    res.writeHead = (status) => { res.statusCode = status; };
    res.write = (chunk) => { writes.push(String(chunk)); return true; };
    res.flushHeaders = () => {};
    await handler({
      state: { currentUser: { id: userId }, currentRoles: [role] },
      action: { params: { portalSlug: 'flow-studio' } },
      query: {},
      req,
      res,
      respond: true,
    });
    assert.equal(res.statusCode, 200, `${role} should be authorized on flow-studio`);
    assert.ok(writes.some((w) => w.includes('event: snapshot') && w.includes('"portalSlug":"flow-studio"')));
    req.emit('close');
  }

  // Unauthorized roles: ldx_employee, ldx_driver -> 403 PORTAL_ACL_FORBIDDEN
  for (const [userId, role] of [[5, 'ldx_employee'], [6, 'ldx_driver']]) {
    await assert.rejects(
      () => handler({
        state: { currentUser: { id: userId }, currentRoles: [role] },
        action: { params: { portalSlug: 'flow-studio' } },
        query: {},
      }),
      (err) => err.status === 403 && err.code === 'PORTAL_ACL_FORBIDDEN',
      `${role} must receive 403 PORTAL_ACL_FORBIDDEN on flow-studio`,
    );
  }

  // Anonymous -> 401 NATIVE_LOGIN_REQUIRED
  await assert.rejects(
    () => handler({ state: {}, action: { params: { portalSlug: 'flow-studio' } }, query: {} }),
    (err) => err.status === 401 && err.code === 'NATIVE_LOGIN_REQUIRED',
  );

  // Cross-org ldx_manager -> 403 DXOS_ORG_MISMATCH
  await assert.rejects(
    () => handler({
      state: { currentUser: { id: 4 }, currentRoles: ['ldx_manager'] },
      action: { params: { portalSlug: 'flow-studio', organizationId: 'org-b' } },
      query: {},
    }),
    (err) => err.status === 403 && err.code === 'DXOS_ORG_MISMATCH',
  );
});
