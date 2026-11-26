/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSafeLabOrigin } from './setup-native-multi-portal-demo.mjs';

const DEFAULT_ORG = 'native-ui-lab';
const DEMO_PASS = process.env.NATIVE_DEMO_PASSWORD ?? 'NativeLab-2026!';

export function parseAcceptanceArgs(argv) {
  let origin = null;
  let reportPath = null;
  let organizationId = DEFAULT_ORG;

  for (const arg of argv) {
    if (arg.startsWith('--origin=')) origin = arg.slice('--origin='.length);
    else if (arg.startsWith('--org=')) organizationId = arg.slice('--org='.length).trim();
    else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else if (reportPath === null) reportPath = arg;
    else throw new Error(`Unexpected argument: ${arg}`);
  }

  if (!origin && !reportPath) {
    throw new Error('Usage: node scripts/acceptance-logistics-and-rbac.mjs <clean-install report.json> | --origin=http://localhost:13014 [--org=native-ui-lab]');
  }
  if (origin !== null) {
    origin = assertSafeLabOrigin(origin);
  }
  return { origin, reportPath, organizationId };
}

export function buildLogisticsInstallParams(employees, organizationId = DEFAULT_ORG) {
  const byCode = new Map(employees.map((e) => [e.code, e]));
  const mgr = byCode.get('NATIVE-UI-MANAGER');
  const wh = byCode.get('NATIVE-UI-WORKER');
  const disp = byCode.get('NATIVE-UI-DISPATCHER');
  const drv = byCode.get('NATIVE-UI-DRIVER');
  if (!mgr?.id || !wh?.id || !disp?.id || !drv?.id) {
    throw new Error('Missing one or more native-ui-lab crew members (MANAGER/WORKER/DISPATCHER/DRIVER)');
  }
  return {
    templateKey: 'logistics-5step',
    organizationId,
    managerEmployeeId: mgr.id,
    warehouseEmployeeId: wh.id,
    dispatcherEmployeeId: disp.id,
    driverEmployeeId: drv.id,
  };
}

export function buildOrderCreatePayload(code, organizationId = DEFAULT_ORG) {
  return {
    code,
    name: `Đơn vận chuyển E2E ${code}`,
    organizationId,
    customer: 'Trung tâm Y tế Cần Thơ',
    origin: 'Kho lạnh Cần Thơ',
    destination: 'TP. Thủ Đức',
    quantity: 120,
    category: 'cold-chain',
  };
}

export function findPendingManualTask(tasks, recordCode, titleSubstr) {
  const rows = Array.isArray(tasks) ? tasks : [];
  const matched = rows.find((t) => {
    const code = t?.execution?.context?.data?.code;
    const title = t?.node?.title || '';
    return (!recordCode || code === recordCode) && (!titleSubstr || title.includes(titleSubstr));
  });
  if (!matched) {
    throw new Error(`Missing manual task "${titleSubstr}" for record ${recordCode}`);
  }
  return matched;
}

export function assertHttpDeniedOrForeignRejected(res, forbiddenOrg) {
  if (!res.ok || res.status >= 400) return;
  const row = res.data || {};
  if (row.organizationId === forbiddenOrg || row.status === 'approved') {
    throw new Error(`Security boundary violated: accepted forbidden values (${JSON.stringify(row)})`);
  }
}

async function waitForValue(label, fn, pred, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const val = await fn();
      if (pred(val)) return val;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for ${label}${lastErr ? `: ${lastErr.message}` : ''}`);
}

export async function runLogisticsAndRbacAcceptance(callActor, { organizationId = DEFAULT_ORG } = {}) {
  const encFilter = (obj) => 'filter=' + encodeURIComponent(JSON.stringify(obj));
  const listMinePath = `workflowManualTasks:listMine?pageSize=20&sort=-id&appends[]=node&appends[]=execution&${encFilter({ status: 0 })}`;
  const okActor = async (actorRole, path, opts) => {
    const res = await callActor(actorRole, path, opts);
    assert.ok(res.ok && res.status < 300, `${actorRole} ${path.split('?')[0]} failed (${res.status}): ${JSON.stringify(res.data)}`);
    return res.data;
  };

  const empList = await okActor('root', `latticeEmployees:list?pageSize=50&${encFilter({ organizationId, active: true })}`);
  const byCode = new Map((Array.isArray(empList) ? empList : []).map((e) => [e.code, e]));
  const employee = byCode.get('NATIVE-UI-EMPLOYEE');
  const manager = byCode.get('NATIVE-UI-MANAGER');
  assert.ok(employee?.id && manager?.id, 'Missing NATIVE-UI-EMPLOYEE or NATIVE-UI-MANAGER');

  // Ensure both workflows exist and are active
  const logInstall = await okActor('root', 'dxosStudio:installWorkflow', {
    method: 'POST',
    values: { ...buildLogisticsInstallParams(empList, organizationId), enabled: true },
  });
  if (!logInstall?.enabled && logInstall?.workflowId) {
    await okActor('root', `workflows:update?filterByTk=${logInstall.workflowId}`, {
      method: 'POST',
      values: { enabled: true },
    });
  }
  const srvInstall = await okActor('root', 'dxosStudio:installWorkflow', {
    method: 'POST',
    values: {
      templateKey: 'internal-service',
      organizationId,
      reviewerEmployeeId: manager.id,
      assigneeEmployeeId: employee.id,
      enabled: true,
    },
  });
  if (!srvInstall?.enabled && srvInstall?.workflowId) {
    await okActor('root', `workflows:update?filterByTk=${srvInstall.workflowId}`, {
      method: 'POST',
      values: { enabled: true },
    });
  }

  const ts = Date.now().toString(36).slice(-6).toUpperCase();
  const orderCode = `ORD-E2E-${ts}`;
  const srvCode = `SRV-E2E-${ts}`;
  let createdOrder = null;
  let createdTicket = null;
  const negativeRbacChecks = [];

  try {
    // 1. Negative RBAC checks on Admin Studio & cross-org / status spoofing
    for (const [label, path, method, values] of [
      ['employee_denied_dxosStudio_readiness', 'dxosStudio:readiness', 'GET', undefined],
      ['employee_denied_dxosStudio_composePortals', 'dxosStudio:composePortals', 'POST', {}],
      ['employee_denied_dxosStudio_installWorkflow', 'dxosStudio:installWorkflow', 'POST', { templateKey: 'procurement', organizationId }],
    ]) {
      const r = await callActor('employee', path, { method, values });
      assert.equal(r.status, 403, `Expected 403 for ${label}, got ${r.status}`);
      negativeRbacChecks.push({ check: label, status: r.status, passed: true });
    }

    for (const [label, path, values] of [
      ['employee_denied_foreign_org_serviceTicket', 'latticeServiceTickets:create', { code: `SRV-FOR-${ts}`, name: 'Foreign test', organizationId: 'foreign-org' }],
      ['employee_denied_foreign_org_paraDoc', 'latticeParaDocuments:create', { code: `PARA-FOR-${ts}`, title: 'Foreign PARA', organizationId: 'foreign-org', paraSpace: 'resources' }],
      ['employee_denied_spoof_approved_request', 'latticeRequests:create', { code: `REQ-FOR-${ts}`, name: 'Spoof request', organizationId: 'foreign-org', status: 'approved' }],
    ]) {
      const r = await callActor('employee', path, { method: 'POST', values });
      assertHttpDeniedOrForeignRejected(r, 'foreign-org');
      negativeRbacChecks.push({ check: label, status: r.status, passed: true });
    }

    // 2. 5-Stage Cross-Department Logistics Workflow (Employee -> Manager -> Warehouse -> Dispatcher -> Driver)
    createdOrder = await okActor('employee', 'latticeOrders:create', {
      method: 'POST',
      values: buildOrderCreatePayload(orderCode, organizationId),
    });

    const mgrTask = await waitForValue(
      'logistics stage 2 manager review task',
      async () => findPendingManualTask(await okActor('manager', listMinePath), orderCode, 'Quản lý duyệt'),
      Boolean,
    );

    // Negative check: employee cannot hijack/submit manager's manual task!
    const hijackRes = await callActor('employee', `workflowManualTasks:submit?filterByTk=${mgrTask.id}`, {
      method: 'POST',
      values: { result: { review: {}, _: 'approve' } },
    });
    assert.ok(!hijackRes.ok && hijackRes.status >= 400, `Employee must not submit manager task (got ${hijackRes.status})`);
    negativeRbacChecks.push({ check: 'employee_cannot_submit_manager_manual_task', status: hijackRes.status, passed: true });

    const submitTask = async (actorRole, task, form, action, values = {}) => {
      const r = await callActor(actorRole, `workflowManualTasks:submit?filterByTk=${task.id}`, {
        method: 'POST',
        values: { result: { [form]: values, _: action } },
      });
      assert.ok(r.status < 300, `${actorRole} manual submit (${form}/${action}) failed (${r.status}): ${JSON.stringify(r.data)}`);
    };

    await submitTask('manager', mgrTask, 'review', 'approve');

    const whTask = await waitForValue(
      'logistics stage 3 warehouse task',
      async () => findPendingManualTask(await okActor('warehouse', listMinePath), orderCode, 'Kho chuẩn bị'),
      Boolean,
    );
    await submitTask('warehouse', whTask, 'prepareWarehouse', 'prepared');

    const dispTask = await waitForValue(
      'logistics stage 4 dispatcher task',
      async () => findPendingManualTask(await okActor('dispatcher', listMinePath), orderCode, 'Điều phối'),
      Boolean,
    );
    await submitTask('dispatcher', dispTask, 'dispatchOrder', 'dispatched', { vehicleNote: '65C-999.99 / Tuyến CT-HCM' });

    const drvTask = await waitForValue(
      'logistics stage 5 driver task',
      async () => findPendingManualTask(await okActor('driver', listMinePath), orderCode, 'Tài xế'),
      Boolean,
    );
    await submitTask('driver', drvTask, 'driverDeliver', 'delivered', { deliveryNote: 'Đã giao nguyên seal E2E OK' });

    const finalOrder = await waitForValue(
      'logistics order final completed status',
      async () => {
        const list = await okActor('root', `latticeOrders:list?${encFilter({ code: orderCode })}`);
        return Array.isArray(list) ? list[0] : null;
      },
      (row) => row?.status === 'completed',
    );

    // 3. 2nd Domain End-to-End: internal-service (latticeServiceTickets)
    createdTicket = await okActor('employee', 'latticeServiceTickets:create', {
      method: 'POST',
      values: {
        code: srvCode,
        name: `Yêu cầu dịch vụ IT E2E ${srvCode}`,
        organizationId,
        serviceType: 'it_support',
        priority: 'medium',
        description: 'Kiểm chứng domain thứ 2 trên cùng nền tảng NocoBase + DX-OS.',
      },
    });

    const srvReview = await waitForValue(
      'internal-service review task',
      async () => findPendingManualTask(await okActor('manager', listMinePath), srvCode, 'Duyệt'),
      Boolean,
    );
    await submitTask('manager', srvReview, 'review', 'approve');

    const srvWork = await waitForValue(
      'internal-service work task',
      async () => findPendingManualTask(await okActor('employee', listMinePath), srvCode, 'Thực hiện'),
      Boolean,
    );
    await submitTask('employee', srvWork, 'work', 'complete', { note: 'Hoàn tất cấp quyền VPN E2E OK' });

    const finalTicket = await waitForValue(
      'internal-service completed status',
      async () => {
        const list = await okActor('root', `latticeServiceTickets:list?${encFilter({ code: srvCode })}`);
        return Array.isArray(list) ? list[0] : null;
      },
      (row) => row?.status === 'completed',
    );

    return {
      result: 'PASS',
      organizationId,
      logistics5Step: {
        workflowId: logInstall.workflowId,
        orderCode,
        finalStatus: finalOrder.status,
        assigneeId: finalOrder.assigneeId,
        decisionReason: finalOrder.decisionReason,
      },
      internalServiceDomain: {
        workflowId: srvInstall.workflowId,
        ticketCode: srvCode,
        finalStatus: finalTicket.status,
        resolutionNote: finalTicket.resolutionNote,
      },
      negativeRbacChecks,
    };
  } finally {
    if (createdOrder?.id) {
      await callActor('root', `latticeOrders:destroy?filterByTk=${createdOrder.id}`, { method: 'POST' }).catch(() => {});
    }
    if (createdTicket?.id) {
      await callActor('root', `latticeServiceTickets:destroy?filterByTk=${createdTicket.id}`, { method: 'POST' }).catch(() => {});
    }
  }
}

export async function createMultiActorCaller(origin) {
  const safeOrigin = assertSafeLabOrigin(origin);
  const tokens = {};

  async function signIn(email, password) {
    const res = await fetch(new URL('/api/auth:signIn', safeOrigin), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(15000),
    });
    const json = await res.json();
    assert.ok(res.ok && json?.data?.token, `Sign-in failed for ${email}: HTTP ${res.status}`);
    return json.data.token;
  }

  tokens.root = await signIn(process.env.NOCOBASE_ADMIN_EMAIL ?? 'admin@nocobase.com', process.env.NOCOBASE_ADMIN_PASSWORD ?? 'admin123');
  tokens.employee = await signIn('native.lab.employee@example.invalid', DEMO_PASS);
  tokens.manager = await signIn('native.lab.manager@example.invalid', DEMO_PASS);
  tokens.worker = await signIn('native.lab.worker@example.invalid', DEMO_PASS);
  tokens.warehouse = tokens.worker;
  tokens.dispatcher = await signIn('native.lab.dispatcher@example.invalid', DEMO_PASS);
  tokens.driver = await signIn('native.lab.driver@example.invalid', DEMO_PASS);

  return async function callActor(actorRole, path, { method = 'GET', values } = {}) {
    const tok = tokens[actorRole];
    if (!tok) throw new Error(`Unknown actor role: ${actorRole}`);
    const response = await fetch(new URL('/api/' + path, safeOrigin), {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${tok}`,
        ...(actorRole === 'root' ? { 'X-Role': 'root' } : {}),
      },
      ...(values !== undefined ? { body: JSON.stringify(values) } : {}),
      signal: AbortSignal.timeout(20000),
    });
    const text = await response.text();
    let payload = {};
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text }; }
    return {
      ok: response.ok,
      status: response.status,
      data: payload.data !== undefined ? payload.data : payload,
    };
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  (async () => {
    const opts = parseAcceptanceArgs(process.argv.slice(2));
    let origin = opts.origin;
    if (opts.reportPath) {
      const report = JSON.parse(await readFile(resolve(opts.reportPath), 'utf8'));
      origin = report.origin;
    }
    const callActor = await createMultiActorCaller(origin);
    const result = await runLogisticsAndRbacAcceptance(callActor, { organizationId: opts.organizationId });
    console.log(JSON.stringify(result, null, 2));
  })().catch((err) => {
    console.error(JSON.stringify({ result: 'FAIL', error: err.message }));
    process.exitCode = 1;
  });
}
