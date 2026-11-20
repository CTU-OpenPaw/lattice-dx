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
