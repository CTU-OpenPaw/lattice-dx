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

function makeDb({ employees = [], assets = [], proposals = [], outbox = [], roles = [], resources = [] } = {}) {
  return {
    getRepository(name) {
      if (name === 'latticeEmployees') {
        return { find: async ({ filter }) => employees.filter((e) => Number(e.userId) === Number(filter?.userId)) };
      }
      if (name === 'latticeAssets') {
        return {
          findOne: async ({ filter }) => assets.find((a) => (!filter?.id || Number(a.id) === Number(filter.id)) && (!filter?.code || a.code === filter.code) && (!filter?.organizationId || a.organizationId === filter.organizationId)) || null,
          find: async ({ filter }) => assets.filter((a) => !filter?.organizationId || a.organizationId === filter.organizationId),
        };
      }
      if (name === 'latticeRequests' || name === 'latticeIncidentCases' || name === 'latticeOrders' || name === 'latticeServiceTickets') {
        return {
          findOne: async ({ filter }) => ({ id: filter?.id, organizationId: filter?.organizationId === 'org-a' ? 'org-a' : null }).organizationId ? { id: filter.id, organizationId: filter.organizationId } : null,
        };
      }
      if (name === 'latticeAgentProposals') {
        return {
          find: async ({ filter, limit = 20 }) => proposals.filter((p) => (
            (!filter?.organizationId || p.organizationId === filter.organizationId)
            && (!filter?.targetCollection || p.targetCollection === filter.targetCollection)
            && (!filter?.targetRecordId || Number(p.targetRecordId) === Number(filter.targetRecordId))
            && (!filter?.state || p.state === filter.state)
          )).slice(0, limit),
          count: async ({ filter }) => proposals.filter((p) => (
            (!filter?.organizationId || p.organizationId === filter.organizationId)
            && (!filter?.targetCollection || p.targetCollection === filter.targetCollection)
            && (!filter?.targetRecordId || Number(p.targetRecordId) === Number(filter.targetRecordId))
            && (!filter?.state || p.state === filter.state)
          )).length,
        };
      }
      if (name === 'latticeContextOutbox') {
        return {
          find: async ({ filter }) => outbox.filter((o) => (
            (!filter?.organizationId || o.organizationId === filter.organizationId)
            && (!filter?.collectionName || o.collectionName === filter.collectionName)
            && (!filter?.recordId || Number(o.recordId) === Number(filter.recordId))
          )),
        };
      }
      if (name === 'roles') {
        return { findOne: async ({ filter }) => roles.find((r) => r.name === filter?.name) || null };
      }
      if (name === 'dataSourcesRolesResources') {
        return {
          findOne: async ({ filter }) => resources.find((r) => r.roleName === filter?.roleName && r.name === filter?.name && r.dataSourceKey === filter?.dataSourceKey) || null,
        };
      }
      return null;
    },
  };
}

test('dxosBlocks:proposals enforces ACL, org scoping, state filters, and root preview', async () => {
  const { createDxosBlocksActions } = require(path.join(PLUGIN_ROOT, 'src/server/blocks-api.js'));
  const db = makeDb({
    employees: [{ id: 10, userId: 201, organizationId: 'org-a', active: true }],
    proposals: [
      { id: 1, organizationId: 'org-a', targetCollection: 'latticeIncidentCases', targetRecordId: 5, state: 'proposed', recommendation: 'Check sensor A', evidence: [{ kind: 'native-record' }], receiptKey: 'SECRET-1' },
      { id: 2, organizationId: 'org-a', targetCollection: 'latticeIncidentCases', targetRecordId: 6, state: 'reviewed', recommendation: 'Resolved B', evidence: [], receiptKey: 'SECRET-2' },
      { id: 3, organizationId: 'org-b', targetCollection: 'latticeIncidentCases', targetRecordId: 9, state: 'proposed', recommendation: 'Org B private', evidence: [], receiptKey: 'SECRET-3' },
    ],
  });
  const actions = createDxosBlocksActions(db);

  // Disallowed collection throws 403
  await assert.rejects(
    () => actions.proposals({
      method: 'POST',
      state: { currentRole: 'ldx_manager', currentUser: { id: 201 } },
      can: () => true,
      action: { params: { values: { targetCollection: 'users' } } },
    }, async () => {}),
    (err) => err.status === 403 && err.code === 'DXOS_COLLECTION_FORBIDDEN',
  );

  // Denied view ACL throws 403
  await assert.rejects(
    () => actions.proposals({
      method: 'POST',
      state: { currentRole: 'ldx_employee', currentUser: { id: 201 } },
      can: () => null,
      action: { params: { values: { targetCollection: 'latticeIncidentCases' } } },
    }, async () => {}),
    (err) => err.status === 403 && err.code === 'DXOS_ACL_DENIED',
  );

  // Invalid state filter throws 400
  await assert.rejects(
    () => actions.proposals({
      method: 'POST',
      state: { currentRole: 'ldx_manager', currentUser: { id: 201 } },
      can: () => ({}),
      action: { params: { values: { targetCollection: 'latticeIncidentCases', state: 'bogus' } } },
    }, async () => {}),
    (err) => err.status === 400,
  );

  // Valid org-a manager sees only org-a proposed items without internal secrets
  const mgrCtx = {
    method: 'POST',
    state: { currentRole: 'ldx_manager', currentUser: { id: 201 } },
    can: () => ({}),
    action: { params: { values: { targetCollection: 'latticeIncidentCases', state: 'proposed', pageSize: 10 } } },
  };
  await actions.proposals(mgrCtx, async () => {});
  assert.equal(mgrCtx.body.items.length, 1);
  assert.equal(mgrCtx.body.items[0].id, 1);
  assert.equal(mgrCtx.body.items[0].receiptKey, undefined);

  // Root without employee row gets preview across orgs
  const rootCtx = {
    method: 'GET',
    state: { currentRole: 'root', currentUser: { id: 1 } },
    action: { params: { targetCollection: 'latticeIncidentCases', state: 'all' } },
  };
  await actions.proposals(rootCtx, async () => {});
  assert.equal(rootCtx.body.preview, true);
  assert.equal(rootCtx.body.items.length, 3);
});

test('dxosBlocks:contextTelemetry enforces org boundary, sanitizes outbox, and degrades when broker is offline', async () => {
  const { createDxosBlocksActions } = require(path.join(PLUGIN_ROOT, 'src/server/blocks-api.js'));
  const db = makeDb({
    employees: [{ id: 10, userId: 201, organizationId: 'org-a', active: true }],
    assets: [
      { id: 4, code: 'COLD-01', name: 'Kho lạnh 01', organizationId: 'org-a', status: 'active' },
      { id: 9, code: 'COLD-B', name: 'Kho org B', organizationId: 'org-b', status: 'active' },
    ],
    outbox: [
      { id: 1, organizationId: 'org-a', collectionName: 'latticeAssets', recordId: 4, state: 'delivered', payload: { secret: 'hide' }, deliveredAt: '2026-11-20T09:00:00Z' },
      { id: 2, organizationId: 'org-a', collectionName: 'latticeAssets', recordId: 4, state: 'pending', payload: { secret: 'hide' } },
      { id: 3, organizationId: 'org-b', collectionName: 'latticeAssets', recordId: 9, state: 'failed', payload: { secret: 'cross-org' } },
    ],
  });

  // Cross-org URN blocked with 403
  const offlineActions = createDxosBlocksActions(db, {
    brokerUrl: 'http://orion-ld.invalid:1026',
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
  });

  await assert.rejects(
    () => offlineActions.contextTelemetry({
      method: 'POST',
      state: { currentRole: 'ldx_manager', currentUser: { id: 201 } },
      can: () => ({}),
      action: { params: { values: { assetEntityId: 'urn:ngsi-ld:Asset:org-b:native:9' } } },
    }, async () => {}),
    (err) => err.status === 403 && err.code === 'DXOS_CROSS_ORG_FORBIDDEN',
  );

  // Offline Orion-LD degrades smoothly & strips cross-org outbox & payloads
  const okCtx = {
    method: 'POST',
    state: { currentRole: 'ldx_manager', currentUser: { id: 201 } },
    can: () => ({}),
    action: { params: { values: { assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:4' } } },
  };
  await offlineActions.contextTelemetry(okCtx, async () => {});
  assert.equal(okCtx.body.brokerStatus, 'offline');
  assert.equal(okCtx.body.asset.id, 4);
  assert.deepEqual(okCtx.body.syncSummary, { pending: 1, retry: 0, delivered: 1, failed: 0, lastDeliveredAt: '2026-11-20T09:00:00Z' });

  // Live Orion-LD telemetry returned cleanly
  const onlineActions = createDxosBlocksActions(db, {
    brokerUrl: 'http://orion-ld:1026',
    fetchImpl: async () => new Response(JSON.stringify({ id: 'urn:ngsi-ld:Asset:org-a:native:4', type: 'Asset', temperature: { type: 'Property', value: -18.4, unitCode: 'CEL' } }), { status: 200 }),
  });
  const liveCtx = {
    method: 'GET',
    state: { currentRole: 'ldx_manager', currentUser: { id: 201 } },
    can: () => ({}),
    action: { params: { assetId: 4 } },
  };
  await onlineActions.contextTelemetry(liveCtx, async () => {});
  assert.equal(liveCtx.body.brokerStatus, 'online');
  assert.equal(liveCtx.body.telemetry.temperature.value, -18.4);
});

test('dxosBlocks:proposals enforces caller ownScope for non-managers and contextTelemetry compares deliveredAt via Date.parse', async () => {
  const { createDxosBlocksActions } = require(path.join(PLUGIN_ROOT, 'src/server/blocks-api.js'));
  const db = makeDb({
    employees: [
      { id: 10, userId: 201, organizationId: 'org-a', active: true },
      { id: 11, userId: 202, organizationId: 'org-a', active: true },
    ],
    orders: [
      { id: 30, code: 'ORD-OWN', organizationId: 'org-a', requesterId: 10 },
      { id: 31, code: 'ORD-PEER', organizationId: 'org-a', requesterId: 11 },
    ],
    proposals: [
      { id: 501, targetCollection: 'latticeOrders', targetRecordId: 30, organizationId: 'org-a', state: 'proposed', recommendation: 'My order' },
      { id: 502, targetCollection: 'latticeOrders', targetRecordId: 31, organizationId: 'org-a', state: 'proposed', recommendation: 'Peer order' },
    ],
    assets: [{ id: 4, code: 'COLD-01', name: 'Kho lạnh 01', organizationId: 'org-a', status: 'active' }],
    outbox: [
      { id: 1, organizationId: 'org-a', collectionName: 'latticeAssets', recordId: 4, state: 'delivered', deliveredAt: '2026-11-20T16:00:00+07:00' }, // 09:00Z
      { id: 2, organizationId: 'org-a', collectionName: 'latticeAssets', recordId: 4, state: 'delivered', deliveredAt: '2026-11-20T10:00:00Z' }, // 10:00Z (chronologically newer!)
    ],
  });

  // Add latticeOrders repo to makeDb-backed mock
  const origGetRepo = db.getRepository.bind(db);
  const orderRows = [{ id: 30, organizationId: 'org-a', requesterId: 10 }, { id: 31, organizationId: 'org-a', requesterId: 11 }];
  db.getRepository = (n) => (n === 'latticeOrders'
    ? {
      find: async ({ filter = {} } = {}) => orderRows.filter((r) => !filter.id || (Array.isArray(filter.id?.$in) ? filter.id.$in.includes(r.id) : r.id === filter.id)),
      findOne: async ({ filter = {} } = {}) => orderRows.find((r) => (!filter.id || Number(r.id) === Number(filter.id)) && (!filter.organizationId || r.organizationId === filter.organizationId)) || null,
    }
    : origGetRepo(n));

  const actions = createDxosBlocksActions(db, { brokerUrl: '', fetchImpl: async () => { throw new Error('offline'); } });

  // Non-manager employee sees only proposals targeting own record (id 501 -> targetRecordId 30), NOT peer order (502 -> 31)
  const empCtx = {
    method: 'POST',
    state: { currentRole: 'ldx_employee', currentUser: { id: 201 } },
    can: () => ({}),
    action: { params: { values: { targetCollection: 'latticeOrders', state: 'all' } } },
  };
  await actions.proposals(empCtx, async () => {});
  assert.deepEqual(empCtx.body.items.map((i) => i.id), [501]);

  // Passing peer's targetRecordId directly as ldx_employee denied 403
  await assert.rejects(
    () => actions.proposals({
      method: 'POST',
      state: { currentRole: 'ldx_employee', currentUser: { id: 201 } },
      can: () => ({}),
      action: { params: { values: { targetCollection: 'latticeOrders', targetRecordId: 31 } } },
    }, async () => {}),
    (err) => err.status === 403,
  );

  // contextTelemetry sorts deliveredAt numerically (10:00Z > 09:00Z / 16:00+07:00)
  const telCtx = {
    method: 'GET',
    state: { currentRole: 'ldx_manager', currentUser: { id: 201 } },
    can: () => ({}),
    action: { params: { assetId: 4 } },
  };
  await actions.contextTelemetry(telCtx, async () => {});
  assert.equal(telCtx.body.syncSummary.lastDeliveredAt, '2026-11-20T10:00:00Z');
});

test('dxosBlocks:aggregateQuery enforces ACL, strict collection/field/filter allowlists, RBAC/own-scope, and aggregates bar/line/pie/kpi/pivot safely', async () => {
  const Module = require('node:module');
  const { createDxosBlocksActions } = require(path.join(PLUGIN_ROOT, 'src/server/blocks-api.js'));
  const { assertSafeFilter } = require(path.join(PLUGIN_ROOT, 'src/server/governed-export.js'));

  assert.equal(typeof assertSafeFilter, 'function', 'assertSafeFilter must be exported from governed-export.js');
  assert.deepEqual(assertSafeFilter({ $and: [{ status: { $in: ['open', 'closed'] } }, { totalAmount: { $gte: 100 } }] }), {
    $and: [{ status: { $in: ['open', 'closed'] } }, { totalAmount: { $gte: 100 } }],
  });
  for (const badFilter of [
    { $where: '1=1' },
    { $raw: 'SELECT 1' },
    { $sql: 'DROP TABLE users' },
    { $eval: 'process.exit()' },
    { $function: { body: 'return 1' } },
    { $expr: { $eq: [1, 1] } },
    { 'user.password': 'x' },
    { searchVector: 'leak' },
    JSON.parse('{"__proto__":"pollute"}'),
  ]) {
    assert.throws(
      () => assertSafeFilter(badFilter),
      (err) => err.status === 403 && err.code === 'EXPORT_FILTER_FORBIDDEN',
    );
  }
  let deepFilter = { status: 'ok' };
  for (let i = 0; i < 18; i += 1) deepFilter = { $and: [deepFilter] };
  assert.throws(
    () => assertSafeFilter(deepFilter),
    (err) => err.status === 403 && err.code === 'EXPORT_FILTER_FORBIDDEN',
  );

  // Verify ACL registration in src/server/index.js
  const origLoad = Module._load;
  let DxosBlocksServerPlugin;
  Module._load = function (request, parent, isMain) {
    if (request === '@nocobase/server') return { Plugin: class Plugin {} };
    return origLoad.call(this, request, parent, isMain);
  };
  try {
    const srvPath = path.join(PLUGIN_ROOT, 'src/server/index.js');
    delete require.cache[require.resolve(srvPath)];
    DxosBlocksServerPlugin = require(srvPath);
  } finally {
    Module._load = origLoad;
  }
  const aclAllowCalls = [];
  const fakePlugin = new DxosBlocksServerPlugin({});
  fakePlugin.app = {
    resourceManager: { use() {}, define() {} },
    acl: { allow: (res, actions, role) => aclAllowCalls.push({ res, actions, role }) },
  };
  fakePlugin.db = {};
  await fakePlugin.load();
  const loggedInAllow = aclAllowCalls.find((c) => c.res === 'dxosBlocks' && c.role === 'loggedIn');
  assert.ok(loggedInAllow && loggedInAllow.actions.includes('aggregateQuery'), 'aggregateQuery must be registered in loggedIn ACL');

  const ordersRows = [
    { id: 1, organizationId: 'org-a', status: 'approved', region: 'HCM', totalAmount: 100, requesterId: 10, passwordHash: 'sec1' },
    { id: 2, organizationId: 'org-a', status: 'approved', region: 'HN', totalAmount: 300, requesterId: 20, passwordHash: 'sec2' },
    { id: 3, organizationId: 'org-a', status: 'draft', region: 'HCM', totalAmount: 50, requesterId: 10, passwordHash: 'sec3' },
    { id: 4, organizationId: 'org-a', status: '__proto__', region: 'constructor', totalAmount: 25, requesterId: 10, passwordHash: 'sec4' },
    { id: 5, organizationId: 'org-b', status: 'approved', region: 'DN', totalAmount: 9999, requesterId: 30, passwordHash: 'sec5' },
  ];
  const joinRows = [
    { id: 1, organizationId: 'org-a', month: '2026-01', qty: 4 },
    { id: 2, organizationId: 'org-a', month: '2026-02', qty: 8 },
    { id: 3, organizationId: 'org-a', month: '2026-02', qty: 12 },
  ];

  const collectionsMap = new Map([
    [
      'latticeOrders',
      {
        name: 'latticeOrders',
        fields: new Map([
          ['id', { name: 'id', type: 'bigInt' }],
          ['organizationId', { name: 'organizationId', type: 'string' }],
          ['status', { name: 'status', type: 'string' }],
          ['region', { name: 'region', type: 'string' }],
          ['totalAmount', { name: 'totalAmount', type: 'decimal' }],
          ['requesterId', { name: 'requesterId', type: 'bigInt' }],
          ['passwordHash', { name: 'passwordHash', type: 'string' }],
          ['searchVector', { name: 'searchVector', type: 'text' }],
          ['virtualNote', { name: 'virtualNote', type: 'virtual' }],
          ['items', { name: 'items', type: 'hasMany' }],
        ]),
      },
    ],
    [
      'latticeCustom_join_items',
      {
        name: 'latticeCustom_join_items',
        fields: new Map([
          ['id', { name: 'id', type: 'bigInt' }],
          ['organizationId', { name: 'organizationId', type: 'string' }],
          ['month', { name: 'month', type: 'string' }],
          ['qty', { name: 'qty', type: 'integer' }],
        ]),
      },
    ],
  ]);

  let roleRestrictedFields = null;
  const matchRow = (row, filter = {}) => Object.entries(filter).every(([k, cond]) => {
    if (k === '$and' && Array.isArray(cond)) return cond.every((sub) => matchRow(row, sub));
    if (k === '$or' && Array.isArray(cond)) return cond.some((sub) => matchRow(row, sub));
    if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
      if ('$eq' in cond) return row[k] === cond.$eq;
      if ('$ne' in cond) return row[k] !== cond.$ne;
      if ('$in' in cond && Array.isArray(cond.$in)) return cond.$in.includes(row[k]);
      if ('$gte' in cond) return Number(row[k]) >= Number(cond.$gte);
      if ('$lte' in cond) return Number(row[k]) <= Number(cond.$lte);
    }
    return row[k] === cond;
  });

  const db = {
    collections: collectionsMap,
    getCollection: (name) => collectionsMap.get(name) || null,
    getRepository(name) {
      if (name === 'latticeEmployees') {
        return {
          find: async ({ filter }) => {
            if (Number(filter?.userId) === 201) return [{ id: 10, userId: 201, organizationId: 'org-a', active: true }];
            return [];
          },
        };
      }
      if (name === 'roles') {
        return { findOne: async ({ filter }) => ({ name: filter.name, allowAll: false }) };
      }
      if (name === 'dataSourcesRolesResources') {
        return {
          findOne: async ({ filter }) => (roleRestrictedFields
            ? { roleName: filter.roleName, name: filter.name, usingActionsConfig: true, actions: [{ name: 'view', fields: roleRestrictedFields }] }
            : { roleName: filter.roleName, name: filter.name, usingActionsConfig: false }),
        };
      }
      if (name === 'latticeOrders') {
        return {
          find: async ({ filter = {}, limit = 500, offset = 0 }) => ordersRows.filter((r) => matchRow(r, filter)).slice(offset, offset + limit),
        };
      }
      if (name === 'latticeCustom_join_items') {
        return {
          find: async ({ filter = {}, limit = 500, offset = 0 }) => joinRows.filter((r) => matchRow(r, filter)).slice(offset, offset + limit),
        };
      }
      return null;
    },
  };

  const actions = createDxosBlocksActions(db);
  assert.equal(typeof actions.aggregateQuery, 'function');

  // 1. Auth & Method guards
  await assert.rejects(
    () => actions.aggregateQuery({ method: 'POST', state: {}, action: { params: { collection: 'latticeOrders', chartType: 'kpi' } } }, async () => {}),
    (err) => err.status === 401 && err.code === 'NATIVE_LOGIN_REQUIRED',
  );
  await assert.rejects(
    () => actions.aggregateQuery({ method: 'DELETE', state: { currentRole: 'root', currentUser: { id: 1 } }, action: { params: {} } }, async () => {}),
    (err) => err.status === 405 && err.code === 'METHOD_NOT_ALLOWED',
  );

  // 2. Strict collection allowlist enforced EVEN for root
  for (const forbiddenCol of ['users', 'roles', 'latticeBuiltApps', 'latticeApiKeys', 'latticeCustom', '']) {
    await assert.rejects(
      () => actions.aggregateQuery({
        method: 'POST',
        state: { currentRole: 'root', currentUser: { id: 1 } },
        action: { params: { values: { collection: forbiddenCol, chartType: 'kpi' } } },
      }, async () => {}),
      (err) => err.status === 403 && err.code === 'DXOS_COLLECTION_FORBIDDEN',
    );
  }

  // 3. RBAC & Cross-org enforcement
  await assert.rejects(
    () => actions.aggregateQuery({
      method: 'POST',
      state: { currentRole: 'ldx_employee', currentUser: { id: 201 } },
      can: () => false,
      action: { params: { values: { collection: 'latticeOrders', chartType: 'kpi' } } },
    }, async () => {}),
    (err) => err.status === 403 && err.code === 'DXOS_ACL_DENIED',
  );
  await assert.rejects(
    () => actions.aggregateQuery({
      method: 'POST',
      state: { currentRole: 'ldx_manager', currentUser: { id: 201 } },
      can: () => true,
      action: { params: { values: { collection: 'latticeOrders', chartType: 'kpi', organizationId: 'org-b' } } },
    }, async () => {}),
    (err) => err.status === 403 && err.code === 'DXOS_CROSS_ORG_FORBIDDEN',
  );

  // 4. 404 when allowlisted collection has no repo/metadata
  await assert.rejects(
    () => actions.aggregateQuery({
      method: 'POST',
      state: { currentRole: 'root', currentUser: { id: 1 } },
      action: { params: { values: { collection: 'latticeCustomMissingTable', chartType: 'kpi' } } },
    }, async () => {}),
    (err) => err.status === 404 && err.code === 'DXOS_COLLECTION_NOT_FOUND',
  );

  // 5. Validation errors: chartType, metric.op, limit, groupBy, secondaryGroupBy, field existence, numeric requirement
  const rootPost = (values) => actions.aggregateQuery({
    method: 'POST',
    state: { currentRole: 'root', currentUser: { id: 1 } },
    action: { params: { values } },
  }, async () => {});

  await assert.rejects(() => rootPost({ collection: 'latticeOrders', chartType: 'radar' }), (e) => e.status === 400 && e.code === 'DXOS_INVALID_CHART_TYPE');
  await assert.rejects(() => rootPost({ collection: 'latticeOrders', chartType: 'kpi', metric: { op: 'median', field: 'totalAmount' } }), (e) => e.status === 400 && e.code === 'DXOS_INVALID_METRIC_OP');
  await assert.rejects(() => rootPost({ collection: 'latticeOrders', chartType: 'kpi', limit: 0 }), (e) => e.status === 400 && e.code === 'DXOS_INVALID_LIMIT');
  await assert.rejects(() => rootPost({ collection: 'latticeOrders', chartType: 'kpi', limit: 501 }), (e) => e.status === 400 && e.code === 'DXOS_INVALID_LIMIT');
  await assert.rejects(() => rootPost({ collection: 'latticeOrders', chartType: 'bar' }), (e) => e.status === 400 && e.code === 'DXOS_GROUP_BY_REQUIRED');
  await assert.rejects(() => rootPost({ collection: 'latticeOrders', chartType: 'pivot', groupBy: 'status' }), (e) => e.status === 400 && e.code === 'DXOS_SECONDARY_GROUP_BY_REQUIRED');
  await assert.rejects(() => rootPost({ collection: 'latticeOrders', chartType: 'pivot', groupBy: 'status', secondaryGroupBy: 'status' }), (e) => e.status === 400 && e.code === 'DXOS_INVALID_FIELD');
  await assert.rejects(() => rootPost({ collection: 'latticeOrders', chartType: 'bar', groupBy: 'noSuchField' }), (e) => e.status === 400 && e.code === 'DXOS_INVALID_FIELD');
  await assert.rejects(() => rootPost({ collection: 'latticeOrders', chartType: 'bar', groupBy: 'virtualNote' }), (e) => e.status === 400 && e.code === 'DXOS_INVALID_FIELD');
  await assert.rejects(() => rootPost({ collection: 'latticeOrders', chartType: 'kpi', metric: { op: 'sum' } }), (e) => e.status === 400 && e.code === 'DXOS_METRIC_FIELD_REQUIRED');
  await assert.rejects(() => rootPost({ collection: 'latticeOrders', chartType: 'kpi', metric: { op: 'sum', field: 'status' } }), (e) => e.status === 400 && e.code === 'DXOS_NUMERIC_FIELD_REQUIRED');

  // 6. Sensitive/blocked/role-restricted fields & unsafe filter
  await assert.rejects(() => rootPost({ collection: 'latticeOrders', chartType: 'bar', groupBy: 'passwordHash' }), (e) => e.status === 403 && e.code === 'DXOS_FIELD_FORBIDDEN');
  await assert.rejects(() => rootPost({ collection: 'latticeOrders', chartType: 'bar', groupBy: 'searchVector' }), (e) => e.status === 403 && e.code === 'DXOS_FIELD_FORBIDDEN');
  await assert.rejects(() => rootPost({ collection: 'latticeOrders', chartType: 'bar', groupBy: '__proto__' }), (e) => e.status === 403 && e.code === 'DXOS_FIELD_FORBIDDEN');
  await assert.rejects(() => rootPost({ collection: 'latticeOrders', chartType: 'bar', groupBy: 'status', filter: { $where: '1=1' } }), (e) => e.status === 403 && e.code === 'EXPORT_FILTER_FORBIDDEN');
  await assert.rejects(() => rootPost({ collection: 'latticeOrders', chartType: 'bar', groupBy: 'status', filter: { unknownCol: 'x' } }), (e) => e.status === 400 && e.code === 'DXOS_INVALID_FIELD');

  roleRestrictedFields = ['status', 'region'];
  await assert.rejects(
    () => actions.aggregateQuery({
      method: 'POST',
      state: { currentRole: 'ldx_manager', currentUser: { id: 201 } },
      can: () => true,
      action: { params: { values: { collection: 'latticeOrders', chartType: 'bar', groupBy: 'status', metric: { op: 'sum', field: 'totalAmount' } } } },
    }, async () => {}),
    (err) => err.status === 403 && err.code === 'DXOS_FIELD_FORBIDDEN',
  );
  roleRestrictedFields = null;

  // 7. Own-scope enforcement for non-manager vs manager on latticeOrders
  const empCtx = {
    method: 'POST',
    state: { currentRole: 'ldx_employee', currentUser: { id: 201 } },
    can: () => true,
    action: { params: { values: { collection: 'latticeOrders', chartType: 'kpi', metric: { op: 'sum', field: 'totalAmount' } } } },
  };
  await actions.aggregateQuery(empCtx, async () => {});
  assert.equal(empCtx.body.ok, true);
  assert.equal(empCtx.body.totalRows, 3);
  assert.equal(empCtx.body.summary.sum, 175); // rows 1 (100) + 3 (50) + 4 (25)

  const mgrCtx = {
    method: 'POST',
    state: { currentRole: 'ldx_manager', currentUser: { id: 201 } },
    can: () => true,
    action: { params: { values: { collection: 'latticeOrders', chartType: 'bar', groupBy: 'status', metric: { op: 'sum', field: 'totalAmount' } } } },
  };
  await actions.aggregateQuery(mgrCtx, async () => {});
  assert.equal(mgrCtx.body.totalRows, 4); // org-a rows only (row 5 in org-b excluded)
  assert.equal(mgrCtx.body.pivotMatrix, null);
  assert.equal(mgrCtx.body.summary.sum, 475);
  const approvedBar = mgrCtx.body.series.find((s) => s.key === 'approved');
  assert.equal(approvedBar.value, 400);
  assert.equal(approvedBar.count, 2);
  assert.equal(({}).polluted, undefined);

  // 8. Line on M1.2 underscore custom collection + avg
  const lineCtx = {
    method: 'GET',
    state: { currentRole: 'root', currentUser: { id: 1 } },
    action: { params: { collection: 'latticeCustom_join_items', chartType: 'line', groupBy: 'month', metric: { op: 'avg', field: 'qty' }, organizationId: 'org-a' } },
  };
  await actions.aggregateQuery(lineCtx, async () => {});
  assert.equal(lineCtx.body.chartType, 'line');
  assert.equal(lineCtx.body.series.find((s) => s.key === '2026-02').value, 10);
  assert.equal(lineCtx.body.meta.preview, false);

  // 9. Pie & Pivot (including prototype-safe keys '__proto__' / 'constructor')
  const pivotCtx = {
    method: 'POST',
    state: { currentRole: 'ldx_manager', currentUser: { id: 201 } },
    can: () => true,
    action: { params: { values: { collection: 'latticeOrders', chartType: 'pivot', groupBy: 'status', secondaryGroupBy: 'region', metric: { op: 'sum', field: 'totalAmount' } } } },
  };
  await actions.aggregateQuery(pivotCtx, async () => {});
  assert.equal(pivotCtx.body.chartType, 'pivot');
  assert.ok(pivotCtx.body.pivotMatrix);
  assert.equal(pivotCtx.body.pivotMatrix.rowField, 'status');
  assert.equal(pivotCtx.body.pivotMatrix.colField, 'region');
  assert.equal(pivotCtx.body.pivotMatrix.grandTotal, 475);
  assert.ok(pivotCtx.body.pivotMatrix.rows.includes('__proto__'));
  assert.ok(pivotCtx.body.pivotMatrix.columns.includes('constructor'));
  assert.equal(pivotCtx.body.pivotMatrix.cells.__proto__ !== Object.prototype, true);
  assert.equal(pivotCtx.body.pivotMatrix.cells['__proto__']['constructor'], 25);
});

test('M1.1 Iteration 2: aggregateQuery strict numeric parsing, formula eligibility, recursive filter keys, array filter rejection, role empty fields, and pivot grandTotal', async () => {
  const { createDxosBlocksActions } = require(path.join(PLUGIN_ROOT, 'src/server/blocks-api.js'));

  const dirtyRows = [
    { id: 1, organizationId: 'org-a', status: 'r1', region: 'c1', totalAmount: 100, calcNum: 10, calcPct: 20, calcData: 30, calcStr: 'abc' },
    { id: 2, organizationId: 'org-a', status: 'r1', region: 'c2', totalAmount: '   ', calcNum: 20, calcPct: 40, calcData: 60, calcStr: 'def' },
    { id: 3, organizationId: 'org-a', status: 'r2', region: 'c1', totalAmount: false, calcNum: 5, calcPct: 10, calcData: 15, calcStr: 'ghi' },
    { id: 4, organizationId: 'org-a', status: 'r2', region: 'c2', totalAmount: [], calcNum: 15, calcPct: 30, calcData: 45, calcStr: 'jkl' },
    { id: 5, organizationId: 'org-a', status: 'r1', region: 'c1', totalAmount: true, calcNum: 0, calcPct: 0, calcData: 0, calcStr: 'mno' },
  ];

  const collectionsMap = new Map([
    [
      'latticeOrders',
      {
        name: 'latticeOrders',
        fields: new Map([
          ['id', { name: 'id', type: 'bigInt' }],
          ['organizationId', { name: 'organizationId', type: 'string' }],
          ['status', { name: 'status', type: 'string' }],
          ['region', { name: 'region', type: 'string' }],
          ['totalAmount', { name: 'totalAmount', type: 'decimal' }],
          ['calcNum', { name: 'calcNum', type: 'formula', interface: 'number' }],
          ['calcPct', { name: 'calcPct', type: 'formula', interface: 'percent' }],
          ['calcData', { name: 'calcData', type: 'formula', dataType: 'float' }],
          ['calcStr', { name: 'calcStr', type: 'formula', interface: 'input', dataType: 'string' }],
          ['passwordHash', { name: 'passwordHash', type: 'string' }],
        ]),
      },
    ],
  ]);

  let customRoleActions = null;
  const db = {
    collections: collectionsMap,
    getCollection: (name) => collectionsMap.get(name) || null,
    getRepository(name) {
      if (name === 'latticeEmployees') {
        return { find: async () => [{ id: 10, userId: 201, organizationId: 'org-a', active: true }] };
      }
      if (name === 'roles') {
        return { findOne: async ({ filter }) => ({ name: filter.name, allowAll: false }) };
      }
      if (name === 'dataSourcesRolesResources') {
        return {
          findOne: async ({ filter }) => (customRoleActions
            ? { roleName: filter.roleName, name: filter.name, usingActionsConfig: true, actions: customRoleActions }
            : { roleName: filter.roleName, name: filter.name, usingActionsConfig: false }),
        };
      }
      if (name === 'latticeOrders') {
        return { find: async () => dirtyRows };
      }
      return null;
    },
  };

  const actions = createDxosBlocksActions(db);
  const rootPost = (values) => actions.aggregateQuery({
    method: 'POST',
    state: { currentRole: 'root', currentUser: { id: 1 } },
    action: { params: { values } },
  }, async () => {});

  // 1. Medium 1: updateAcc rejects whitespace-only strings, booleans, and arrays/objects
  const dirtyCtx = {
    method: 'POST',
    state: { currentRole: 'root', currentUser: { id: 1 } },
    action: { params: { values: { collection: 'latticeOrders', chartType: 'kpi', metric: { op: 'avg', field: 'totalAmount' } } } },
  };
  await actions.aggregateQuery(dirtyCtx, async () => {});
  assert.equal(dirtyCtx.body.summary.sum, 100);
  assert.equal(dirtyCtx.body.summary.avg, 100);
  assert.equal(dirtyCtx.body.summary.min, 100);
  assert.equal(dirtyCtx.body.summary.max, 100);

  // 2. Medium 2: numeric formula fields (interface number/percent or numeric dataType) allowed; non-numeric formula rejected
  const formulaNumCtx = {
    method: 'POST',
    state: { currentRole: 'root', currentUser: { id: 1 } },
    action: { params: { values: { collection: 'latticeOrders', chartType: 'kpi', metric: { op: 'sum', field: 'calcNum' } } } },
  };
  await actions.aggregateQuery(formulaNumCtx, async () => {});
  assert.equal(formulaNumCtx.body.summary.sum, 50);

  const formulaPctCtx = {
    method: 'POST',
    state: { currentRole: 'root', currentUser: { id: 1 } },
    action: { params: { values: { collection: 'latticeOrders', chartType: 'kpi', metric: { op: 'sum', field: 'calcPct' } } } },
  };
  await actions.aggregateQuery(formulaPctCtx, async () => {});
  assert.equal(formulaPctCtx.body.summary.sum, 100);

  const formulaDataCtx = {
    method: 'POST',
    state: { currentRole: 'root', currentUser: { id: 1 } },
    action: { params: { values: { collection: 'latticeOrders', chartType: 'kpi', metric: { op: 'sum', field: 'calcData' } } } },
  };
  await actions.aggregateQuery(formulaDataCtx, async () => {});
  assert.equal(formulaDataCtx.body.summary.sum, 150);

  await assert.rejects(
    () => rootPost({ collection: 'latticeOrders', chartType: 'kpi', metric: { op: 'sum', field: 'calcStr' } }),
    (e) => e.status === 400 && e.code === 'DXOS_NUMERIC_FIELD_REQUIRED',
  );

  // 3. Minor 1: recursive validateFilterKeys catches nested field keys & $col under field keys while preserving standard operators
  await assert.rejects(
    () => rootPost({ collection: 'latticeOrders', chartType: 'bar', groupBy: 'status', filter: { status: { $and: [{ unknownCol: 'x' }] } } }),
    (e) => e.status === 400 && e.code === 'DXOS_INVALID_FIELD',
  );
  await assert.rejects(
    () => rootPost({ collection: 'latticeOrders', chartType: 'bar', groupBy: 'status', filter: { status: { $eq: { $col: 'passwordHash' } } } }),
    (e) => e.status === 403 && e.code === 'DXOS_FIELD_FORBIDDEN',
  );
  customRoleActions = [{ name: 'view', fields: ['status', 'region'] }];
  await assert.rejects(
    () => actions.aggregateQuery({
      method: 'POST',
      state: { currentRole: 'ldx_manager', currentUser: { id: 201 } },
      can: () => true,
      action: { params: { values: { collection: 'latticeOrders', chartType: 'bar', groupBy: 'status', filter: { status: { totalAmount: { $gt: 0 } } } } } },
    }, async () => {}),
    (e) => e.status === 403 && e.code === 'DXOS_FIELD_FORBIDDEN',
  );
  customRoleActions = null;

  // Standard NocoBase filter operators still pass
  await rootPost({
    collection: 'latticeOrders',
    chartType: 'bar',
    groupBy: 'status',
    filter: { status: { $in: ['r1', 'r2'] }, totalAmount: { $between: [0, 500] } },
  });

  // 4. Minor 2: top-level array filter rejected 400 DXOS_INVALID_FILTER
  await assert.rejects(
    () => rootPost({ collection: 'latticeOrders', chartType: 'bar', groupBy: 'status', filter: [{ status: 'r1' }] }),
    (e) => e.status === 400 && e.code === 'DXOS_INVALID_FILTER',
  );
  await assert.rejects(
    () => rootPost({ collection: 'latticeOrders', chartType: 'bar', groupBy: 'status', filter: '[{"status":"r1"}]' }),
    (e) => e.status === 400 && e.code === 'DXOS_INVALID_FILTER',
  );

  // 5. Minor 3: empty view.fields: [] must NOT mask populated list.fields
  customRoleActions = [{ name: 'view', fields: [] }, { name: 'list', fields: ['status'] }];
  await assert.rejects(
    () => actions.aggregateQuery({
      method: 'POST',
      state: { currentRole: 'ldx_manager', currentUser: { id: 201 } },
      can: () => true,
      action: { params: { values: { collection: 'latticeOrders', chartType: 'bar', groupBy: 'status', metric: { op: 'sum', field: 'totalAmount' } } } },
    }, async () => {}),
    (e) => e.status === 403 && e.code === 'DXOS_FIELD_FORBIDDEN',
  );
  customRoleActions = null;

  // 6. Minor 5: pivotMatrix.grandTotal === sum(rowTotals) === sum(colTotals) when limit slices rows/cols, while summary.value stays full dataset total
  const truncPivotCtx = {
    method: 'POST',
    state: { currentRole: 'root', currentUser: { id: 1 } },
    action: {
      params: {
        values: {
          collection: 'latticeOrders',
          chartType: 'pivot',
          groupBy: 'status',
          secondaryGroupBy: 'region',
          metric: { op: 'sum', field: 'calcNum' },
          limit: 1,
        },
      },
    },
  };
  await actions.aggregateQuery(truncPivotCtx, async () => {});
  const pm = truncPivotCtx.body.pivotMatrix;
  assert.equal(pm.rows.length, 1);
  assert.equal(pm.columns.length, 1);
  const sumRowTotals = Object.values(pm.rowTotals).reduce((a, b) => a + b, 0);
  const sumColTotals = Object.values(pm.colTotals).reduce((a, b) => a + b, 0);
  assert.equal(pm.grandTotal, sumRowTotals);
  assert.equal(pm.grandTotal, sumColTotals);
  assert.equal(truncPivotCtx.body.summary.value, 50);
  assert.notEqual(pm.grandTotal, truncPivotCtx.body.summary.value);
});

test('M1.1 Iteration 3: pivotMatrix.grandTotal aggregates count/sum/avg/min/max accurately and validateFilterKeys rejects non-string $col', async () => {
  const { createDxosBlocksActions } = require(path.join(PLUGIN_ROOT, 'src/server/blocks-api.js'));

  const fullRows = [
    { id: 1, organizationId: 'org-a', status: 'r1', region: 'c1', totalAmount: 10 },
    { id: 2, organizationId: 'org-a', status: 'r1', region: 'c1', totalAmount: 20 },
    { id: 3, organizationId: 'org-a', status: 'r1', region: 'c2', totalAmount: 30 },
    { id: 4, organizationId: 'org-a', status: 'r2', region: 'c1', totalAmount: 40 },
    { id: 5, organizationId: 'org-a', status: 'r2', region: 'c2', totalAmount: 60 },
  ];

  const truncRows = [
    { id: 10, organizationId: 'org-a', status: 'r2', region: 'c1', totalAmount: 40 },
    { id: 11, organizationId: 'org-a', status: 'r2', region: 'c1', totalAmount: 50 },
    { id: 12, organizationId: 'org-a', status: 'r2', region: 'c2', totalAmount: 30 },
    { id: 13, organizationId: 'org-a', status: 'r2', region: 'c2', totalAmount: 100 },
    { id: 14, organizationId: 'org-a', status: 'r1', region: 'c1', totalAmount: 10 },
    { id: 15, organizationId: 'org-a', status: 'r1', region: 'c2', totalAmount: 20 },
  ];

  const negativeMixedRows = [
    { id: 20, organizationId: 'org-a', status: 'r1', region: 'c1', totalAmount: -50 },
    { id: 21, organizationId: 'org-a', status: 'r1', region: 'c2', totalAmount: null },
    { id: 22, organizationId: 'org-a', status: 'r2', region: 'c1', totalAmount: '   ' },
    { id: 23, organizationId: 'org-a', status: 'r2', region: 'c2', totalAmount: -10 },
  ];

  const allNonNumericRows = [
    { id: 30, organizationId: 'org-a', status: 'r1', region: 'c1', totalAmount: null },
    { id: 31, organizationId: 'org-a', status: 'r2', region: 'c2', totalAmount: '   ' },
  ];

  let activeRows = fullRows;
  let customRoleActions = null;

  const collectionsMap = new Map([
    [
      'latticeOrders',
      {
        name: 'latticeOrders',
        fields: new Map([
          ['id', { name: 'id', type: 'bigInt' }],
          ['organizationId', { name: 'organizationId', type: 'string' }],
          ['status', { name: 'status', type: 'string' }],
          ['region', { name: 'region', type: 'string' }],
          ['totalAmount', { name: 'totalAmount', type: 'decimal' }],
          ['passwordHash', { name: 'passwordHash', type: 'string' }],
        ]),
      },
    ],
  ]);

  const db = {
    collections: collectionsMap,
    getCollection: (name) => collectionsMap.get(name) || null,
    getRepository(name) {
      if (name === 'latticeEmployees') {
        return { find: async () => [{ id: 10, userId: 201, organizationId: 'org-a', active: true }] };
      }
      if (name === 'roles') {
        return { findOne: async ({ filter }) => ({ name: filter.name, allowAll: false }) };
      }
      if (name === 'dataSourcesRolesResources') {
        return {
          findOne: async ({ filter }) => (customRoleActions
            ? { roleName: filter.roleName, name: filter.name, usingActionsConfig: true, actions: customRoleActions }
            : { roleName: filter.roleName, name: filter.name, usingActionsConfig: false }),
        };
      }
      if (name === 'latticeOrders') {
        return { find: async () => activeRows };
      }
      return null;
    },
  };

  const actions = createDxosBlocksActions(db);
  const runPivot = async (metric, limit = 10) => {
    const ctx = {
      method: 'POST',
      state: { currentRole: 'root', currentUser: { id: 1 } },
      action: {
        params: {
          values: {
            collection: 'latticeOrders',
            chartType: 'pivot',
            groupBy: 'status',
            secondaryGroupBy: 'region',
            metric,
            limit,
          },
        },
      },
    };
    await actions.aggregateQuery(ctx, async () => {});
    return ctx.body;
  };

  // A. Full 2x2 matrix across all 5 metric ops
  activeRows = fullRows;
  for (const [metric, expected] of [
    [{ op: 'count' }, 5],
    [{ op: 'sum', field: 'totalAmount' }, 160],
    [{ op: 'avg', field: 'totalAmount' }, 32],
    [{ op: 'min', field: 'totalAmount' }, 10],
    [{ op: 'max', field: 'totalAmount' }, 60],
  ]) {
    const body = await runPivot(metric, 10);
    assert.equal(body.summary.value, expected, `full matrix summary.value mismatch for ${metric.op}`);
    assert.equal(body.pivotMatrix.grandTotal, expected, `full matrix grandTotal mismatch for ${metric.op}`);
  }

  // Count with metric.field excludes null/empty values
  activeRows = negativeMixedRows;
  const countWithFieldBody = await runPivot({ op: 'count', field: 'totalAmount' }, 10);
  assert.equal(countWithFieldBody.summary.value, 3);
  assert.equal(countWithFieldBody.pivotMatrix.grandTotal, 3);

  // B. Truncated matrix (limit: 1 -> only displayed cell r2 x c1 [40, 50])
  activeRows = truncRows;
  for (const [metric, expectedGrandTotal, expectedSummary] of [
    [{ op: 'count' }, 2, 6],
    [{ op: 'sum', field: 'totalAmount' }, 90, 250],
    [{ op: 'avg', field: 'totalAmount' }, 45, 250 / 6],
    [{ op: 'min', field: 'totalAmount' }, 40, 10],
    [{ op: 'max', field: 'totalAmount' }, 50, 100],
  ]) {
    const body = await runPivot(metric, 1);
    assert.deepEqual(body.pivotMatrix.rows, ['r2']);
    assert.deepEqual(body.pivotMatrix.columns, ['c1']);
    assert.equal(body.pivotMatrix.grandTotal, expectedGrandTotal, `truncated grandTotal mismatch for ${metric.op}`);
    assert.ok(Math.abs(body.summary.value - expectedSummary) < 1e-9);
    assert.notEqual(body.pivotMatrix.grandTotal, body.summary.value);
  }

  // C. Empty rows, negative values + mixed non-numeric, and all-non-numeric cells
  activeRows = [];
  for (const metric of [
    { op: 'count' },
    { op: 'sum', field: 'totalAmount' },
    { op: 'avg', field: 'totalAmount' },
    { op: 'min', field: 'totalAmount' },
    { op: 'max', field: 'totalAmount' },
  ]) {
    const body = await runPivot(metric, 10);
    assert.deepEqual(body.pivotMatrix.rows, []);
    assert.deepEqual(body.pivotMatrix.columns, []);
    assert.equal(body.pivotMatrix.grandTotal, 0);
  }

  activeRows = negativeMixedRows;
  assert.equal((await runPivot({ op: 'min', field: 'totalAmount' }, 10)).pivotMatrix.grandTotal, -50);
  assert.equal((await runPivot({ op: 'max', field: 'totalAmount' }, 10)).pivotMatrix.grandTotal, -10);
  assert.equal((await runPivot({ op: 'avg', field: 'totalAmount' }, 10)).pivotMatrix.grandTotal, -30);

  activeRows = allNonNumericRows;
  assert.equal((await runPivot({ op: 'avg', field: 'totalAmount' }, 10)).pivotMatrix.grandTotal, 0);
  assert.equal((await runPivot({ op: 'min', field: 'totalAmount' }, 10)).pivotMatrix.grandTotal, 0);
  assert.equal((await runPivot({ op: 'max', field: 'totalAmount' }, 10)).pivotMatrix.grandTotal, 0);

  // D. Non-string / empty $col rejection + valid string $col and standard operators preserved
  activeRows = fullRows;
  const rootFilterPost = (filter) => actions.aggregateQuery({
    method: 'POST',
    state: { currentRole: 'root', currentUser: { id: 1 } },
    action: { params: { values: { collection: 'latticeOrders', chartType: 'bar', groupBy: 'status', filter } } },
  }, async () => {});

  for (const badFilter of [
    { status: { $eq: { $col: ['passwordHash'] } } },
    { $col: ['passwordHash'] },
    { status: { $eq: { $col: 123 } } },
    { status: { $eq: { $col: null } } },
    { status: { $eq: { $col: '' } } },
    { status: { $eq: { $col: '   ' } } },
    { status: { $eq: { $COL: 123 } } },
  ]) {
    await assert.rejects(
      () => rootFilterPost(badFilter),
      (e) => e.status === 400 && e.code === 'DXOS_INVALID_FILTER',
      `Expected 400 DXOS_INVALID_FILTER for ${JSON.stringify(badFilter)}`,
    );
  }

  await assert.rejects(
    () => rootFilterPost({ status: { $eq: { $col: 'passwordHash' } } }),
    (e) => e.status === 403 && e.code === 'DXOS_FIELD_FORBIDDEN',
  );
  await assert.rejects(
    () => rootFilterPost({ status: { $eq: { $col: 'unknownCol' } } }),
    (e) => e.status === 400 && e.code === 'DXOS_INVALID_FIELD',
  );

  await rootFilterPost({ status: { $eq: { $col: 'region' } } });
  await rootFilterPost({
    $and: [
      { status: { $in: ['r1', 'r2'] } },
      { $or: [{ totalAmount: { $between: [0, 500] } }, { region: { $eq: { $col: 'status' } } }] },
    ],
  });
});
