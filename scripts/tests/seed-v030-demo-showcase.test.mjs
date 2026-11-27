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
import {
  runV030DemoShowcaseSeed,
  seedQuickServicePublicForm,
} from '../seed-v030-demo-showcase.mjs';

function createMockV030Server({ autoSubmitOnCreate = false } = {}) {
  const state = {
    nextId: 10,
    requests: [],
    chatter: [],
    slaPolicies: [],
    assets: [],
    telemetry: [],
    approvals: [],
    publicForms: [],
    calls: [],
  };

  const jsonResp = (data) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ data }),
  });
  const errorResp = (status, code, message) => ({
    ok: false,
    status,
    text: async () => JSON.stringify({ errors: [{ code, message }] }),
  });

  const mockFetch = async (url, init = {}) => {
    const parsedUrl = new URL(String(url));
    const path = `${parsedUrl.pathname}${parsedUrl.search}`;
    const body = init.body ? JSON.parse(init.body) : {};
    state.calls.push(path);

    if (parsedUrl.pathname === '/api/latticeDepartments:list') {
      return jsonResp([{ id: 1, code: 'NATIVE-UI-LAB', organizationId: 'native-ui-lab' }]);
    }
    if (parsedUrl.pathname === '/api/latticeEmployees:list') {
      return jsonResp([{ id: 2, userId: 5, code: 'NATIVE-UI-EMPLOYEE', email: 'native.lab.employee@example.invalid', active: true }]);
    }
    if (parsedUrl.pathname === '/api/latticeRequests:list') {
      const f = JSON.parse(parsedUrl.searchParams.get('filter') || '{}');
      return jsonResp(state.requests.filter((r) => (!f.organizationId || r.organizationId === f.organizationId) && (!f.code || r.code === f.code)));
    }
    if (parsedUrl.pathname === '/api/latticeRequests:create') {
      const row = { id: ++state.nextId, version: 1, status: 'draft', ...body };
      state.requests.push(row);
      const returned = { ...row };
      if (autoSubmitOnCreate) {
        // Simulate async mode:1 collection workflow flipping draft -> submitted immediately after create returns
        row.status = 'submitted';
        row.version = 2;
      }
      return jsonResp(returned);
    }
    if (parsedUrl.pathname === '/api/latticeVoucher:submit') {
      const row = state.requests.find((r) => r.id === body.id);
      if (!row) return errorResp(404, 'VOUCHER_NOT_FOUND', 'Not found');
      if (row.status !== 'draft') {
        return errorResp(409, 'VOUCHER_SUBMIT_INVALID_STATE', 'Chỉ chứng từ ở trạng thái nháp (draft) mới được trình duyệt.');
      }
      if (body.expectedVersion != null && row.version !== body.expectedVersion) {
        return errorResp(409, 'VERSION_CONFLICT', 'Bản ghi đã bị thay đổi bởi người khác.');
      }
      row.status = 'submitted';
      row.version += 1;
      return jsonResp({ ...row });
    }
    if (parsedUrl.pathname === '/api/latticeVoucher:cancel') {
      const row = state.requests.find((r) => r.id === body.id);
      if (!row) return errorResp(404, 'VOUCHER_NOT_FOUND', 'Not found');
      if (!['submitted', 'approved', 'in_progress'].includes(row.status)) {
        return errorResp(409, 'VOUCHER_CANCEL_INVALID_STATE', 'Invalid cancel state');
      }
      if (body.expectedVersion != null && row.version !== body.expectedVersion) {
        return errorResp(409, 'VERSION_CONFLICT', 'Bản ghi đã bị thay đổi bởi người khác.');
      }
      row.status = 'cancelled';
      row.version += 1;
      row.cancelReason = body.cancelReason;
      return jsonResp({ ...row });
    }
    if (parsedUrl.pathname === '/api/latticeVoucher:amend') {
      const orig = state.requests.find((r) => r.id === body.id);
      const amended = {
        id: ++state.nextId,
        organizationId: orig.organizationId,
        code: `${orig.code}-AMD1`,
        status: 'draft',
        version: 1,
        ...body.patch,
      };
      state.requests.push(amended);
      return jsonResp({ amended });
    }
    if (parsedUrl.pathname === '/api/latticeChatter:list') {
      const rid = Number(parsedUrl.searchParams.get('targetRecordId'));
      return jsonResp({ items: state.chatter.filter((c) => c.targetRecordId === rid) });
    }
    if (parsedUrl.pathname === '/api/latticeChatter:post') {
      state.chatter.push({ entryType: 'comment', ...body });
      return jsonResp({ ok: true });
    }
    if (parsedUrl.pathname === '/api/latticeSla:savePolicy') {
      state.slaPolicies.push(body);
      return jsonResp({ saved: true });
    }
    if (parsedUrl.pathname === '/api/latticeSla:evaluateNow') {
      return jsonResp({ evaluated: 0 });
    }
    if (parsedUrl.pathname === '/api/latticeAssets:list') {
      const f = JSON.parse(parsedUrl.searchParams.get('filter') || '{}');
      return jsonResp(state.assets.filter((a) => a.code === f.code));
    }
    if (parsedUrl.pathname === '/api/latticeAssets:create') {
      const asset = { id: ++state.nextId, ...body };
      state.assets.push(asset);
      return jsonResp(asset);
    }
    if (parsedUrl.pathname === '/api/dxosBlocks:telemetrySeries') {
      return jsonResp({ points: state.telemetry });
    }
    if (parsedUrl.pathname === '/api/dxosBlocks:telemetryIngest') {
      state.telemetry.push({ timestamp: body.observedAt, value: body.numericValue });
      return jsonResp({ ingested: true });
    }
    if (parsedUrl.pathname === '/api/dxosForms:list') {
      const org = parsedUrl.searchParams.get('organizationId');
      return jsonResp({ organizationId: org, items: state.publicForms.filter((f) => f.organizationId === org) });
    }
    if (parsedUrl.pathname === '/api/dxosForms:save') {
      if (state.publicForms.some((f) => f.slug === body.slug)) {
        return errorResp(409, 'FORM_SLUG_CONFLICT', `Slug "${body.slug}" is already in use.`);
      }
      const saved = { id: ++state.nextId, ...body };
      state.publicForms.push(saved);
      return jsonResp(saved);
    }
    if (parsedUrl.pathname === '/api/latticePara:reindex') {
      return jsonResp({ indexedCount: 0 });
    }
    if (parsedUrl.pathname === '/api/dxosAi:listApprovals') {
      return jsonResp({ items: state.approvals });
    }
    if (parsedUrl.pathname === '/api/dxos-mcp') {
      const approval = { id: ++state.nextId, status: 'pending', ...body };
      state.approvals.push(approval);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: { content: [{ text: JSON.stringify({ status: 'pending_approval', approvalId: approval.id }) }] },
        }),
      };
    }
    if (parsedUrl.pathname === '/api/latticeAiApprovalQueue:create') {
      const approval = { id: ++state.nextId, ...body };
      state.approvals.push(approval);
      return jsonResp(approval);
    }
    if (parsedUrl.pathname === '/api/dxosStudio:composePortals') {
      return jsonResp({ composed: 7 });
    }
    throw new Error(`Unexpected path in v030 mock: ${path}`);
  };

  return { state, mockFetch };
}

test('Bug #3 regression: runV030DemoShowcaseSeed succeeds idempotently even when auto-submit workflow transitions req2/req3 immediately on create', async () => {
  const { state, mockFetch } = createMockV030Server({ autoSubmitOnCreate: true });
  const opts = {
    origin: 'http://localhost:13014',
    organizationId: 'native-ui-lab',
    token: 'tok-root',
  };

  const first = await runV030DemoShowcaseSeed(opts, mockFetch);
  assert.equal(first.result, 'PASS');
  assert.deepEqual(first.vouchers.created, ['REQ-2026-001', 'REQ-2026-002', 'REQ-2026-003', 'REQ-2026-003-AMD1']);
  assert.equal(first.publicForm.seeded, true);
  assert.equal(first.publicForm.slug, 'yeu-cau-dich-vu-nhanh');

  const req2 = state.requests.find((r) => r.code === 'REQ-2026-002');
  const req3 = state.requests.find((r) => r.code === 'REQ-2026-003');
  const req3Amd = state.requests.find((r) => r.code === 'REQ-2026-003-AMD1');
  assert.equal(req2.status, 'submitted');
  assert.equal(req3.status, 'cancelled');
  assert.ok(req3Amd);

  // Repeat run must be completely idempotent
  const second = await runV030DemoShowcaseSeed(opts, mockFetch);
  assert.equal(second.result, 'PASS');
  assert.deepEqual(second.vouchers.created, []);
  assert.equal(second.publicForm.seeded, false);
  assert.equal(second.publicForm.alreadyExists, true);
  assert.equal(state.requests.length, 4);
  assert.equal(state.publicForms.length, 1);
});

test('Bug #4 regression: seedQuickServicePublicForm handles cross-org FORM_SLUG_CONFLICT idempotently', async () => {
  const calls = [];
  const api = async (path) => {
    calls.push(path);
    if (path.startsWith('dxosForms:list')) return { items: [] };
    if (path === 'dxosForms:save') {
      throw new Error('dxosForms:save HTTP 409: FORM_SLUG_CONFLICT: Slug "yeu-cau-dich-vu-nhanh" is already in use.');
    }
    throw new Error(`Unexpected: ${path}`);
  };
  const res = await seedQuickServicePublicForm(api, 'other-org');
  assert.equal(res.seeded, false);
  assert.equal(res.slugConflict, true);
  assert.equal(res.slug, 'yeu-cau-dich-vu-nhanh');
  assert.equal(calls.length, 2);
});
