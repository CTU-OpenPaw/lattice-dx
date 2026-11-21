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
  assertHttpDeniedOrForeignRejected,
  buildLogisticsInstallParams,
  buildOrderCreatePayload,
  findPendingManualTask,
  parseAcceptanceArgs,
  runLogisticsAndRbacAcceptance,
} from '../acceptance-logistics-and-rbac.mjs';

test('parseAcceptanceArgs requires valid safe lab origin', () => {
  assert.throws(() => parseAcceptanceArgs([]), /Usage:/);
  assert.throws(() => parseAcceptanceArgs(['--origin=http://localhost:13000']), /Unsafe lab port/);
  const parsed = parseAcceptanceArgs(['--origin=http://localhost:13014', '--org=native-ui-lab']);
  assert.equal(parsed.origin, 'http://localhost:13014');
  assert.equal(parsed.organizationId, 'native-ui-lab');
});

test('payload builders pick distinct 5-stage crew IDs and build order payload', () => {
  const crew = [
    { id: 10, code: 'NATIVE-UI-MANAGER' },
    { id: 11, code: 'NATIVE-UI-WORKER' },
    { id: 12, code: 'NATIVE-UI-DISPATCHER' },
    { id: 13, code: 'NATIVE-UI-DRIVER' },
    { id: 14, code: 'NATIVE-UI-EMPLOYEE' },
  ];
  const params = buildLogisticsInstallParams(crew, 'native-ui-lab');
  assert.deepEqual(params, {
    templateKey: 'logistics-5step',
    organizationId: 'native-ui-lab',
    managerEmployeeId: 10,
    warehouseEmployeeId: 11,
    dispatcherEmployeeId: 12,
    driverEmployeeId: 13,
  });

  const order = buildOrderCreatePayload('ORD-E2E-123', 'native-ui-lab');
  assert.equal(order.code, 'ORD-E2E-123');
  assert.equal(order.quantity, 120);
  assert.equal(order.organizationId, 'native-ui-lab');
  assert.equal('status' in order, false);
  assert.equal('requesterId' in order, false);
});

test('findPendingManualTask matches target record and node title cleanly', () => {
  const tasks = [
    { id: 1, node: { title: 'Bước 2 — Quản lý duyệt đơn' }, execution: { context: { data: { code: 'OTHER' } } } },
    { id: 2, node: { title: 'Bước 2 — Quản lý duyệt đơn' }, execution: { context: { data: { code: 'ORD-E2E-123' } } } },
  ];
  const found = findPendingManualTask(tasks, 'ORD-E2E-123', 'Quản lý duyệt');
  assert.equal(found.id, 2);
  assert.throws(() => findPendingManualTask(tasks, 'MISSING', 'Quản lý duyệt'), /Missing manual task/);
});

test('assertHttpDeniedOrForeignRejected enforces 403 or server rewrite without foreign org leak', () => {
  assertHttpDeniedOrForeignRejected({ ok: false, status: 403 }, 'foreign-org');
  assertHttpDeniedOrForeignRejected({ ok: true, status: 200, data: { organizationId: 'native-ui-lab', status: 'draft' } }, 'foreign-org');
  assert.throws(
    () => assertHttpDeniedOrForeignRejected({ ok: true, status: 200, data: { organizationId: 'foreign-org', status: 'approved' } }, 'foreign-org'),
    /Security boundary violated/,
  );
});

test('runLogisticsAndRbacAcceptance runs 5 stages, 2nd domain, negative checks, and cleanup via mock API', async () => {
  let step = 0;
  const createdCodes = { orders: [], tickets: [] };
  let cleaned = false;

  const mockCall = async (actorRole, path, { method = 'GET', values } = {}) => {
    const basePath = path.split('?')[0];
    if (basePath === 'latticeEmployees:list') {
      return {
        ok: true,
        status: 200,
        data: [
          { id: 1, code: 'NATIVE-UI-EMPLOYEE', email: 'native.lab.employee@example.invalid' },
          { id: 2, code: 'NATIVE-UI-MANAGER', email: 'native.lab.manager@example.invalid' },
          { id: 3, code: 'NATIVE-UI-WORKER', email: 'native.lab.worker@example.invalid' },
          { id: 4, code: 'NATIVE-UI-DISPATCHER', email: 'native.lab.dispatcher@example.invalid' },
          { id: 5, code: 'NATIVE-UI-DRIVER', email: 'native.lab.driver@example.invalid' },
        ],
      };
    }
    if (path === 'dxosStudio:installWorkflow') {
      if (actorRole === 'employee') return { ok: false, status: 403, data: {} };
      return { ok: true, status: 200, data: { workflowId: values.templateKey === 'logistics-5step' ? 501 : 502, existed: false } };
    }
    if (path === 'dxosStudio:readiness' || path === 'dxosStudio:composePortals') {
      return { ok: false, status: 403, data: {} };
    }
    if (path === 'latticeOrders:create') {
      createdCodes.orders.push({ id: 77, code: values.code, status: 'draft', organizationId: 'native-ui-lab' });
      return { ok: true, status: 200, data: createdCodes.orders[0] };
    }
    if (path === 'latticeServiceTickets:create') {
      if (values.organizationId === 'foreign-org') return { ok: false, status: 403, data: {} };
      createdCodes.tickets.push({ id: 88, code: values.code, status: 'draft', organizationId: 'native-ui-lab' });
      return { ok: true, status: 200, data: createdCodes.tickets[0] };
    }
    if (path === 'latticeRequests:create' || path === 'latticeParaDocuments:create') {
      return { ok: false, status: 403, data: {} };
    }
    if (path.startsWith('workflowManualTasks:listMine')) {
      assert.equal(path.includes('appends[]=node') && path.includes('appends[]=execution'), true, `listMine must append node and execution: ${path}`);
      step += 1;
      const stages = {
        manager: { id: 100 + step, node: { title: 'Bước 2 — Quản lý duyệt đơn' }, execution: { context: { data: { code: createdCodes.orders[0]?.code } } } },
        warehouse: { id: 100 + step, node: { title: 'Bước 3 — Kho chuẩn bị hàng' }, execution: { context: { data: { code: createdCodes.orders[0]?.code } } } },
        dispatcher: { id: 100 + step, node: { title: 'Bước 4 — Điều phối xe & tuyến' }, execution: { context: { data: { code: createdCodes.orders[0]?.code } } } },
        driver: { id: 100 + step, node: { title: 'Bước 5 — Tài xế xác nhận giao hàng' }, execution: { context: { data: { code: createdCodes.orders[0]?.code } } } },
      };
      if (actorRole === 'manager' && createdCodes.tickets.length > 0) {
        return { ok: true, status: 200, data: [{ id: 201, node: { title: 'Duyệt yêu cầu' }, execution: { context: { data: { code: createdCodes.tickets[0].code } } } }] };
      }
      if (actorRole === 'employee' && createdCodes.tickets.length > 0) {
        return { ok: true, status: 200, data: [{ id: 202, node: { title: 'Thực hiện công việc' }, execution: { context: { data: { code: createdCodes.tickets[0].code } } } }] };
      }
      return { ok: true, status: 200, data: stages[actorRole] ? [stages[actorRole]] : [] };
    }
    if (basePath === 'workflowManualTasks:submit') {
      if (actorRole === 'employee' && path.includes('filterByTk=101')) return { ok: false, status: 403, data: {} };
      return { ok: true, status: 200, data: { ok: true } };
    }
    if (path.startsWith('latticeOrders:list')) {
      return { ok: true, status: 200, data: [{ id: 77, code: createdCodes.orders[0].code, status: 'completed', assigneeId: 5, decisionReason: 'Delivered E2E OK' }] };
    }
    if (path.startsWith('latticeServiceTickets:list')) {
      return { ok: true, status: 200, data: [{ id: 88, code: createdCodes.tickets[0].code, status: 'completed', resolutionNote: 'Resolved E2E OK' }] };
    }
    if (path.startsWith('latticeOrders:destroy') || path.startsWith('latticeServiceTickets:destroy')) {
      cleaned = true;
      return { ok: true, status: 200, data: 1 };
    }
    if (path.startsWith('executions:cancel')) {
      return { ok: true, status: 200, data: { ok: true } };
    }
    throw new Error(`Unexpected mockCall(${actorRole}, ${method} ${path})`);
  };

  const report = await runLogisticsAndRbacAcceptance(mockCall, { organizationId: 'native-ui-lab' });
  assert.equal(report.result, 'PASS');
  assert.equal(report.logistics5Step.finalStatus, 'completed');
  assert.equal(report.internalServiceDomain.finalStatus, 'completed');
  assert.equal(report.negativeRbacChecks.length >= 6, true);
  assert.equal(cleaned, true);
});
