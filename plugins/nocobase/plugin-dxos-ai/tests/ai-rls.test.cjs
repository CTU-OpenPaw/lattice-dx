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
const { runWithTenantRls, runWithSystemRlsBypass, runInRlsSavepoint } = require('../src/server/ai-rls');

test('ai-rls runs callback directly when PG RLS session is inactive', async () => {
  const calls = [];
  const res1 = await runWithTenantRls({}, 'native-ui-lab', async (tx) => {
    calls.push(['tenant', tx]);
    return 'ok-tenant';
  });
  const res2 = await runWithSystemRlsBypass({}, async (tx) => {
    calls.push(['bypass', tx]);
    return 'ok-bypass';
  });
  const res3 = await runInRlsSavepoint({}, async (tx) => {
    calls.push(['sp', tx]);
    return 'ok-sp';
  });
  assert.equal(res1, 'ok-tenant');
  assert.equal(res2, 'ok-bypass');
  assert.equal(res3, 'ok-sp');
  assert.deepEqual(calls, [['tenant', null], ['bypass', null], ['sp', null]]);
});

test('ai-rls delegates to pgRls withTenantRlsContext / withSystemRlsBypass when PG RLS is active', async () => {
  const seen = [];
  const fakeSeq = { id: 'seq1' };
  const fakeDb = { sequelize: fakeSeq };
  const fakePgRls = {
    canUsePgRlsSession: () => true,
    getActiveRlsContext: () => null,
    withTenantRlsContext: async (_db, orgId, fn) => {
      seen.push(['withTenant', orgId]);
      return fn('tx-tenant');
    },
    withSystemRlsBypass: async (_db, fn) => {
      seen.push(['withBypass']);
      return fn('tx-bypass');
    },
    runInRlsSavepoint: async (_db, fn) => {
      seen.push(['savepoint']);
      return fn('tx-sp');
    },
  };

  assert.equal(await runWithTenantRls(fakeDb, 'native-ui-lab', async (tx) => tx, fakePgRls), 'tx-tenant');
  assert.equal(await runWithTenantRls(fakeDb, '', async (tx) => tx, fakePgRls), 'tx-bypass');
  assert.equal(await runWithSystemRlsBypass(fakeDb, async (tx) => tx, fakePgRls), 'tx-bypass');
  assert.equal(await runInRlsSavepoint(fakeDb, async (tx) => tx, fakePgRls), 'tx-sp');
  assert.deepEqual(seen, [
    ['withTenant', 'native-ui-lab'],
    ['withBypass'],
    ['withBypass'],
    ['savepoint'],
  ]);
});
