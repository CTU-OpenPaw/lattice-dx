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

function makeVoucherDbHarness() {
  let seq = 10;
  let chatterSeq = 0;
  const employees = [
    { id: 3, userId: 30, organizationId: 'org-a', active: true, code: 'EMP-A', name: 'A' },
    { id: 8, userId: 80, organizationId: 'org-b', active: true, code: 'EMP-B', name: 'B' },
  ];
  const orders = [
    {
      id: 1,
      organizationId: 'org-a',
      code: 'ORD-001',
      name: 'Đơn lạnh 001',
      description: 'Vắc-xin lô 1',
      category: 'cold-chain',
      customer: 'Bệnh viện X',
      origin: 'HCM',
      destination: 'Cần Thơ',
      quantity: 100,
      departmentId: 2,
      requesterId: 3,
      status: 'draft',
      version: 1,
      amendmentNo: 0,
      amendedFromId: null,
    },
    {
      id: 2,
      organizationId: 'org-b',
      code: 'ORD-002',
      name: 'Đơn Org B',
      status: 'draft',
      version: 1,
      amendmentNo: 0,
      amendedFromId: null,
    },
  ];
  const chatter = [];

  const match = (row, filter = {}) => Object.entries(filter).every(([k, cond]) => {
    if (k === '$and' && Array.isArray(cond)) return cond.every((sub) => match(row, sub));
    if (cond && typeof cond === 'object' && Array.isArray(cond.$in)) return cond.$in.includes(row[k]);
    return row[k] === cond;
  });

  const wrap = (row) => (row ? {
    ...row,
    toJSON: () => ({ ...row }),
    get: (k) => row[k],
    update: async (patch) => Object.assign(row, patch),
  } : null);

  const db = {
    sequelize: {
      transaction: async (fn) => fn({ LOCK: { UPDATE: 'UPDATE' }, id: 'tx-v' }),
    },
    getModel(name) {
      if (name === 'latticeOrders' || name === 'latticeRequests') {
        return {
          findOne: async ({ where }) => orders.find((r) => match(r, where)) || null,
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
      if (name === 'latticeOrders' || name === 'latticeRequests') {
        return {
          findOne: async ({ filter, filterByTk }) => {
            if (filterByTk != null && !filter) return wrap(orders.find((r) => Number(r.id) === Number(filterByTk)));
            return wrap(orders.find((r) => match(r, filter)));
          },
          find: async ({ filter }) => orders.filter((r) => match(r, filter)).map(wrap),
          create: async ({ values }) => {
            if (orders.some((o) => o.organizationId === values.organizationId && o.code === values.code)) {
              throw new Error(`Duplicate org+code ${values.code}`);
            }
            const created = { id: ++seq, createdAt: new Date().toISOString(), ...values };
            orders.push(created);
            return wrap(created);
          },
          update: async ({ filterByTk, filter, values }) => {
            const target = orders.find((r) => (filterByTk != null ? Number(r.id) === Number(filterByTk) : true) && (!filter || match(r, filter)));
            if (!target) return [];
            Object.assign(target, values);
            return [wrap(target)];
          },
        };
      }
      if (name === 'latticeRecordChatter') {
        return {
          create: async ({ values }) => {
            const c = { id: ++chatterSeq, ...values };
            chatter.push(c);
            return c;
          },
        };
      }
      return null;
    },
  };
  return { db, orders, chatter };
}

test('buildAmendedCode replaces existing -AMD suffix cleanly and increments revision cleanly', () => {
  const { buildAmendedCode } = require('../src/server/voucher-lifecycle');
  assert.equal(buildAmendedCode('ORD-001', 1), 'ORD-001-AMD1');
  assert.equal(buildAmendedCode('ORD-001-AMD1', 2), 'ORD-001-AMD2');
  assert.equal(buildAmendedCode('ORD-001-amd9', 10), 'ORD-001-AMD10');
});

test('immutable voucher blocks direct :update after submit and completes Cancel -> Amend -> Re-Amend lineage cleanly', async () => {
  const { registerVoucherLifecycleResource } = require('../src/server/voucher-lifecycle');
  const { updateScopedDocument } = require('../src/server/native-scope');
  const { db, orders, chatter } = makeVoucherDbHarness();

  let actions;
  const app = {
    db,
    resourceManager: { define: (def) => { actions = def.actions; } },
    acl: { allow: () => {} },
  };
  registerVoucherLifecycleResource(app);

  const empA = (params, method = 'POST') => ({
    method,
    state: { currentUser: { id: 30, username: 'emp-a' }, currentRole: 'ldx_employee' },
    action: { resourceName: 'latticeVoucher', params },
    throw(status, message) { throw Object.assign(new Error(message || String(status)), { status }); },
  });
  const empB = (params, method = 'POST') => ({
    method,
    state: { currentUser: { id: 80, username: 'emp-b' }, currentRole: 'ldx_employee' },
    action: { resourceName: 'latticeVoucher', params },
    throw(status, message) { throw Object.assign(new Error(message || String(status)), { status }); },
  });

  // 1. Cannot cancel a draft or amend a draft
  await assert.rejects(
    () => actions.cancel(empA({ values: { collection: 'latticeOrders', id: 1, cancelReason: 'Hủy nháp sai' } }), async () => {}),
    (err) => err.status === 409 && err.code === 'VOUCHER_CANCEL_INVALID_STATE',
  );
  await assert.rejects(
    () => actions.amend(empA({ values: { collection: 'latticeOrders', id: 1 } }), async () => {}),
    (err) => err.status === 409 && err.code === 'VOUCHER_AMEND_REQUIRES_CANCELLED',
  );

  // 2. Submit draft -> submitted (bumps version)
  const subCtx = empA({ values: { collection: 'latticeOrders', id: 1, expectedVersion: 1 } });
  await actions.submit(subCtx, async () => {});
  assert.equal(subCtx.body.status, 'submitted');
  assert.equal(subCtx.body.version, 2);
  assert.ok(subCtx.body.submittedAt);

  // 3. Direct update on submitted voucher MUST fail 409 VOUCHER_IMMUTABLE
  await assert.rejects(
    () => updateScopedDocument(
      db,
      { action: { resourceName: 'latticeOrders', params: { filterByTk: 1, values: { name: 'Sửa lén', expectedVersion: 2 } } }, state: {} },
      { userId: '30', employeeId: 3, organizationId: 'org-a' },
    ),
    (err) => err.status === 409 && err.code === 'VOUCHER_IMMUTABLE',
  );

  // 4. Cross-org caller denied 404
  await assert.rejects(
    () => actions.cancel(empB({ values: { collection: 'latticeOrders', id: 1, cancelReason: 'Cross org attempt' } }), async () => {}),
    (err) => err.status === 404,
  );

  // 5. Cancel requires >= 3 char cancelReason
  await assert.rejects(
    () => actions.cancel(empA({ values: { collection: 'latticeOrders', id: 1, cancelReason: 'ok' } }), async () => {}),
    (err) => err.status === 400 && err.code === 'VOUCHER_CANCEL_REASON_REQUIRED',
  );

  const canCtx = empA({ values: { collection: 'latticeOrders', id: 1, cancelReason: 'Sai số lượng lô vắc-xin', expectedVersion: 2 } });
  await actions.cancel(canCtx, async () => {});
  assert.equal(canCtx.body.status, 'cancelled');
  assert.equal(canCtx.body.cancelReason, 'Sai số lượng lô vắc-xin');

  // 6. Amend cancelled ORD-001 -> creates ORD-001-AMD1
  const amd1Ctx = empA({ values: { collection: 'latticeOrders', id: 1, patch: { quantity: 120, status: 'approved' } } });
  await actions.amend(amd1Ctx, async () => {});
  assert.equal(amd1Ctx.body.code, 'ORD-001-AMD1');
  assert.equal(amd1Ctx.body.status, 'draft');
  assert.equal(amd1Ctx.body.amendedFromId, 1);
  assert.equal(amd1Ctx.body.amendmentNo, 1);
  assert.equal(amd1Ctx.body.quantity, 120);

  // Re-amending the exact same already-amended source is blocked
  await assert.rejects(
    () => actions.amend(empA({ values: { collection: 'latticeOrders', id: 1 } }), async () => {}),
    (err) => err.status === 409 && err.code === 'VOUCHER_ALREADY_AMENDED',
  );

  // 7. Submit & Cancel ORD-001-AMD1, then Amend -> ORD-001-AMD2
  await actions.submit(empA({ values: { collection: 'latticeOrders', id: amd1Ctx.body.id } }), async () => {});
  await actions.cancel(empA({ values: { collection: 'latticeOrders', id: amd1Ctx.body.id, cancelReason: 'Đổi điểm giao' } }), async () => {});
  const amd2Ctx = empA({ values: { collection: 'latticeOrders', id: amd1Ctx.body.id } });
  await actions.amend(amd2Ctx, async () => {});
  assert.equal(amd2Ctx.body.code, 'ORD-001-AMD2');
  assert.equal(amd2Ctx.body.amendmentNo, 2);
  assert.equal(amd2Ctx.body.amendedFromId, amd1Ctx.body.id);

  // 8. Lineage returns chronological root -> AMD1 -> AMD2 chain
  const linCtx = empA({ collection: 'latticeOrders', id: amd2Ctx.body.id }, 'GET');
  await actions.lineage(linCtx, async () => {});
  assert.equal(linCtx.body.rootId, 1);
  assert.deepEqual(linCtx.body.items.map((x) => x.code), ['ORD-001', 'ORD-001-AMD1', 'ORD-001-AMD2']);
  assert.ok(orders.length >= 4);
  assert.ok(chatter.some((c) => c.entryType === 'lifecycle'));
});

test('migration 20261122001000 adds and drops voucher lifecycle columns and short indexes reversibly', () => {
  const migSrc = readFileSync(path.resolve(__dirname, '../src/server/migrations/20261122001000-voucher-lifecycle-columns.js'), 'utf8');
  assert.match(migSrc, /submittedAt/);
  assert.match(migSrc, /amendedFromId/);
  assert.match(migSrc, /idx_lattice_requests_org_amended/);
  assert.match(migSrc, /idx_lattice_orders_org_amended/);
  assert.match(migSrc, /\bdown\s*\(/);
});
