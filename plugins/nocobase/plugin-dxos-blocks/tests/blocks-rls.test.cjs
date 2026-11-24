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

const { runWithOptionalRls } = require('../src/server/blocks-rls');
const { createDxosBlocksActions } = require('../src/server/blocks-api');
const { createDxosBrokerActions } = require('../src/server/broker-control');

function makePgMockDb(collections = {}) {
  const queries = [];
  let activeTx = null;
  let txCounter = 0;

  const db = {
    sequelize: {
      getDialect: () => 'postgres',
      async transaction(fn) {
        txCounter += 1;
        const tx = { id: txCounter };
        activeTx = tx;
        try {
          return await fn(tx);
        } finally {
          activeTx = null;
        }
      },
      async query(sql, opts = {}) {
        queries.push({ sql, opts });
        return [[], {}];
      },
    },
    getRepository(name) {
      const store = collections[name] || [];
      const requireTx = () => {
        if (name.startsWith('lattice')) {
          assert.ok(activeTx, `Expected active PG RLS transaction on ${name}`);
        }
      };
      return {
        async find(opts = {}) {
          requireTx();
          const filter = opts.filter || {};
          return store.filter((row) => Object.entries(filter).every(([k, v]) => row[k] === v));
        },
        async findOne(opts = {}) {
          requireTx();
          const filter = opts.filter || {};
          return store.find((row) => Object.entries(filter).every(([k, v]) => row[k] === v)) || null;
        },
        async count(opts = {}) {
          requireTx();
          const filter = opts.filter || {};
          return store.filter((row) => Object.entries(filter).every(([k, v]) => row[k] === v)).length;
        },
        async create(opts = {}) {
          requireTx();
          const rec = { id: store.length + 1, ...opts.values };
          store.push(rec);
          return rec;
        },
      };
    },
  };

  return { db, queries };
}

test('blocks-rls sets app.current_org for tenant scope and app.rls_bypass for null scope under DX_PG_RLS_SESSION=true', async () => {
  const prev = process.env.DX_PG_RLS_SESSION;
  process.env.DX_PG_RLS_SESSION = 'true';
  try {
    const { db, queries } = makePgMockDb();
    await runWithOptionalRls(db, 'native-ui-lab', async (tx) => {
      assert.ok(tx && tx.id === 1);
    });
    await runWithOptionalRls(db, null, async (tx) => {
      assert.ok(tx && tx.id === 2);
    });

    assert.equal(queries.length, 2);
    assert.match(queries[0].sql, /set_config\('app\.current_org'/);
    assert.equal(queries[0].opts.replacements.orgId, 'native-ui-lab');
    assert.match(queries[1].sql, /set_config\('app\.rls_bypass', 'on'/);
  } finally {
    if (prev === undefined) delete process.env.DX_PG_RLS_SESSION;
    else process.env.DX_PG_RLS_SESSION = prev;
  }
});

test('dxosBlocks:telemetryIngest, dxosBlocks:twinShadow, and dxosBroker:listDevices run inside PostgreSQL RLS transaction', async () => {
  const prev = process.env.DX_PG_RLS_SESSION;
  process.env.DX_PG_RLS_SESSION = 'true';
  try {
    const { db, queries } = makePgMockDb({
      latticeAssets: [{ id: 7, code: 'COLD-07', name: 'Chiller 07', organizationId: 'org-rls', status: 'active' }],
      latticeTelemetryPoints: [],
      latticeIncidentRules: [],
      latticeTwinShadows: [],
      latticeIotDevices: [{ id: 1, organizationId: 'org-rls', deviceKey: 'dev-1', name: 'Dev 1', status: 'online' }],
      rolesUsers: [{ userId: 1, roleName: 'root' }],
    });

    const blocks = createDxosBlocksActions(db, { ingestToken: 'edge-token-0123456789abcdef' });
    const broker = createDxosBrokerActions(db);

    const ctxIngest = {
      method: 'POST',
      headers: { 'x-lattice-edge-token': 'edge-token-0123456789abcdef' },
      action: { params: { values: { organizationId: 'org-rls', assetId: 7, metricName: 'temperature', numericValue: 3.4 } } },
    };
    await blocks.telemetryIngest(ctxIngest, async () => {});
    assert.equal(ctxIngest.body?.point?.numericValue, 3.4);

    const ctxTwin = {
      method: 'GET',
      state: { currentRole: 'root', currentUser: { id: 1, username: 'root' } },
      action: { params: { organizationId: 'org-rls', assetId: 7 } },
    };
    await blocks.twinShadow(ctxTwin, async () => {});
    assert.equal(ctxTwin.body?.asset?.code, 'COLD-07');

    const ctxBroker = {
      method: 'GET',
      state: { currentRole: 'root', currentUser: { id: 1, username: 'root' } },
      action: { params: { organizationId: 'org-rls' } },
    };
    await broker.listDevices(ctxBroker, async () => {});
    assert.equal(ctxBroker.body?.items?.length, 1);

    const orgQueries = queries.filter((q) => q.opts?.replacements?.orgId === 'org-rls');
    assert.ok(orgQueries.length >= 3, `Expected >=3 app.current_org queries, got ${orgQueries.length}`);
  } finally {
    if (prev === undefined) delete process.env.DX_PG_RLS_SESSION;
    else process.env.DX_PG_RLS_SESSION = prev;
  }
});
