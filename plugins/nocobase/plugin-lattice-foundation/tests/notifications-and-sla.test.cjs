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
const { readFileSync, readdirSync } = require('node:fs');
const path = require('node:path');

function makeEnterpriseHarness(seed = {}) {
  let notifSeq = 0;
  let policySeq = 0;
  let chatterSeq = 0;

  const tables = {
    latticeEmployees: (seed.employees || [
      { id: 10, userId: 101, organizationId: 'org-a', active: true, code: 'EMP-A1', name: 'Nguyen An', departmentId: 1 },
      { id: 11, userId: 102, organizationId: 'org-a', active: true, code: 'EMP-A2', name: 'Tran Binh (Mgr)', departmentId: 1 },
      { id: 12, userId: 103, organizationId: 'org-a', active: false, code: 'EMP-A3', name: 'Inactive Mgr', departmentId: 1 },
      { id: 20, userId: 201, organizationId: 'org-b', active: true, code: 'EMP-B1', name: 'Le Cuong (Org B Mgr)', departmentId: 2 },
    ]).map((r) => ({ ...r })),
    roles: (seed.roles || [
      { name: 'ldx_employee', title: 'Nhân viên', allowConfigure: false, snippets: [] },
      { name: 'ldx_manager', title: 'Quản lý', allowConfigure: false, snippets: [] },
      { name: 'ldx_admin', title: 'Quản trị', allowConfigure: true, snippets: ['pm'] },
    ]).map((r) => ({ ...r })),
    rolesUsers: (seed.rolesUsers || [
      { userId: 101, roleName: 'ldx_employee' },
      { userId: 102, roleName: 'ldx_manager' },
      { userId: 103, roleName: 'ldx_manager' },
      { userId: 201, roleName: 'ldx_manager' },
    ]).map((r) => ({ ...r })),
    latticeNotifications: (seed.notifications || []).map((r) => ({ ...r })),
    latticeSlaPolicies: (seed.slaPolicies || []).map((r) => ({ ...r })),
    latticeRequests: (seed.requests || []).map((r) => ({ ...r })),
    latticeOrders: (seed.orders || []).map((r) => ({ ...r })),
    latticeServiceTickets: (seed.serviceTickets || []).map((r) => ({ ...r })),
    latticeIncidentCases: (seed.incidentCases || []).map((r) => ({ ...r })),
    latticeRecordChatter: (seed.chatter || []).map((r) => ({ ...r })),
  };

  const match = (row, filter = {}) => Object.entries(filter || {}).every(([k, cond]) => {
    if (k === '$and' && Array.isArray(cond)) return cond.every((sub) => match(row, sub));
    if (k === '$or' && Array.isArray(cond)) return cond.some((sub) => match(row, sub));
    if (cond && typeof cond === 'object' && !Array.isArray(cond) && !(cond instanceof Date)) {
      if (Array.isArray(cond.$in)) return cond.$in.includes(row[k]);
      if (cond.$gt !== undefined) return new Date(row[k]).getTime() > new Date(cond.$gt).getTime();
      if (cond.$gte !== undefined) return new Date(row[k]).getTime() >= new Date(cond.$gte).getTime();
      if (cond.$ne !== undefined) return row[k] !== cond.$ne;
    }
    return row[k] === cond;
  });

  const wrap = (tableName, row) => (row ? {
    ...row,
    get: (k) => row[k],
    toJSON: () => ({ ...row }),
    update: async (patch) => {
      Object.assign(row, patch);
      return row;
    },
  } : null);

  const db = {
    sequelize: {
      transaction: async (fn) => fn({ LOCK: { UPDATE: 'UPDATE' }, id: 'tx-notif' }),
    },
    getRepository(name) {
      if (!(name in tables)) return null;
      return {
        find: async ({ filter, sort, limit = 500, offset = 0 } = {}) => {
          let out = tables[name].filter((r) => match(r, filter));
          if (Array.isArray(sort) && sort.length) {
            out = out.slice().sort((a, b) => {
              for (const s of sort) {
                const desc = String(s).startsWith('-');
                const field = desc ? String(s).slice(1) : String(s);
                const av = a[field] ?? 0;
                const bv = b[field] ?? 0;
                if (av !== bv) return desc ? (bv > av ? 1 : -1) : (av > bv ? 1 : -1);
              }
              return 0;
            });
          }
          return out.slice(offset, offset + limit).map((r) => wrap(name, r));
        },
        findOne: async ({ filter, filterByTk } = {}) => {
          const row = filterByTk != null && !filter
            ? tables[name].find((r) => Number(r.id) === Number(filterByTk))
            : tables[name].find((r) => match(r, filter));
          return wrap(name, row);
        },
        count: async ({ filter } = {}) => tables[name].filter((r) => match(r, filter)).length,
        create: async ({ values }) => {
          const id = name === 'latticeNotifications'
            ? ++notifSeq
            : name === 'latticeSlaPolicies'
              ? ++policySeq
              : name === 'latticeRecordChatter'
                ? ++chatterSeq
                : (tables[name].length + 1);
          const created = {
            id,
            createdAt: values.createdAt || new Date().toISOString(),
            updatedAt: values.updatedAt || new Date().toISOString(),
            ...values,
          };
          tables[name].push(created);
          return wrap(name, created);
        },
        update: async ({ filterByTk, filter, values }) => {
          const updated = [];
          for (const row of tables[name]) {
            const idOk = filterByTk == null || Number(row.id) === Number(filterByTk);
            const filterOk = !filter || match(row, filter);
            if (idOk && filterOk) {
              Object.assign(row, values);
              updated.push(wrap(name, row));
            }
          }
          return updated;
        },
      };
    },
  };

  return { db, tables };
}

function makeAppHarness(db) {
  const resources = new Map();
  const aclAllows = [];
  const cronJobs = [];
  const middlewares = [];
  const app = {
    db,
    resourceManager: {
      define(def) { resources.set(def.name, def.actions); },
      use(fn) { middlewares.push(fn); },
    },
    acl: {
      allow(...args) { aclAllows.push(args); },
    },
    cronJobManager: {
      addJob(job) { cronJobs.push(job); },
    },
    logger: { error() {}, warn() {}, info() {} },
  };
  return { app, resources, aclAllows, cronJobs, middlewares };
}

function makeCtx({ user = { id: 101, username: 'an' }, role = 'ldx_employee', roles, method = 'GET', params = {}, values } = {}) {
  const fullParams = values !== undefined ? { ...params, values } : { ...params };
  return {
    method,
    state: {
      currentUser: user,
      currentRole: role,
      currentRoles: roles || (role ? [role] : []),
    },
    action: { params: fullParams },
    throw(status, message) {
      throw Object.assign(new Error(message || `HTTP ${status}`), { status });
    },
  };
}

test('dispatchNotification validates tenant/recipient, writes row, and deduplicates within 30 minutes', async () => {
  const { dispatchNotification } = require('../src/server/notification-center');
  const { db, tables } = makeEnterpriseHarness({
    notifications: [
      {
        id: 900,
        organizationId: 'org-a',
        recipientUserId: 101,
        dedupKey: 'old-key',
        title: 'Old expired notification',
        createdAt: new Date(Date.now() - 31 * 60_000).toISOString(),
        readAt: null,
        active: true,
      },
    ],
  });

  await assert.rejects(
    () => dispatchNotification(db, { recipientUserId: 101, title: 'Missing org' }),
    (err) => err.status === 400,
  );
  await assert.rejects(
    () => dispatchNotification(db, { organizationId: 'org-a', title: 'Missing user' }),
    (err) => err.status === 400,
  );

  // First notification creates row
  const first = await dispatchNotification(db, {
    organizationId: 'org-a',
    recipientUserId: 101,
    recipientEmployeeId: 10,
    category: 'voucher',
    severity: 'warning',
    title: 'Đơn cần duyệt',
    body: 'ORD-001 đã trình duyệt',
    targetCollection: 'latticeOrders',
    targetRecordId: 1,
    targetPath: '/p/logistics',
    dedupKey: 'voucher:ord:1',
  });
  assert.equal(first.deduplicated, false);
  assert.equal(first.organizationId, 'org-a');
  assert.equal(first.recipientUserId, 101);
  assert.deepEqual(first.channelsDispatched, ['in_app']);

  // Duplicate within 30 minutes for same (org, user, dedupKey) is skipped
  const second = await dispatchNotification(db, {
    organizationId: 'org-a',
    recipientUserId: 101,
    title: 'Đơn cần duyệt (lần 2)',
    dedupKey: 'voucher:ord:1',
  });
  assert.equal(second.deduplicated, true);
  assert.equal(tables.latticeNotifications.filter((n) => n.dedupKey === 'voucher:ord:1').length, 1);

  // Same dedupKey for different user or org creates its own row
  const otherUser = await dispatchNotification(db, {
    organizationId: 'org-a',
    recipientUserId: 102,
    title: 'Đơn cần duyệt',
    dedupKey: 'voucher:ord:1',
  });
  assert.equal(otherUser.deduplicated, false);

  // Expired >30m dedupKey allows new notification
  const afterExpiry = await dispatchNotification(db, {
    organizationId: 'org-a',
    recipientUserId: 101,
    title: 'Renewed notification',
    dedupKey: 'old-key',
  });
  assert.equal(afterExpiry.deduplicated, false);
});

test('dispatchNotification validates external webhook/apprise/telegram URLs against SSRF and degrades non-fatally', async () => {
  const { dispatchNotification, isSafeExternalWebhookUrl, isSafeExternalWebhookUrlAsync } = require('../src/server/notification-center');

  // SSRF-unsafe URLs rejected
  for (const unsafe of [
    'http://169.254.169.254/latest/meta-data/',
    'http://127.0.0.1:8080/hook',
    'http://localhost:3000/notify',
    'http://[::1]:8080/hook',
    'http://[fd00:ec2::254]/latest/meta-data',
    'http://[fe80::1]/hook',
    'http://[::ffff:169.254.169.254]/hook',
    'http://[::ffff:127.0.0.1]/hook',
    'http://[0:0:0:0:0:ffff:169.254.169.254]/hook',
    'http://[::169.254.169.254]/hook',
    'http://2130706433/hook',
    'http://0x7f000001/hook',
    'http://0177.0.0.1/hook',
    'http://127.1/hook',
    'http://redis:6379/',
    'http://postgres:5432/',
    'http://keycloak:8080/',
    'http://n8n:5678/webhook',
    'http://0.0.0.0/hook',
    'http://10.0.0.5/hook',
    'http://192.168.1.10/hook',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://metadata.azure.com/metadata/instance',
    'https://user:secret@hooks.example.com/notify',
    'ftp://hooks.example.com/notify',
    'file:///etc/passwd',
  ]) {
    assert.equal(isSafeExternalWebhookUrl(unsafe), false, `Expected SSRF block for ${unsafe}`);
  }
  assert.equal(isSafeExternalWebhookUrl('https://hooks.example.com/apprise'), true);
  assert.equal(isSafeExternalWebhookUrl('https://fcm.googleapis.com/fcm/send'), true);

  // Async DNS-rebinding rejection in notification-center
  assert.equal(
    await isSafeExternalWebhookUrlAsync('https://rebind.example.com/hook', {
      lookupImpl: async () => [{ address: '::ffff:127.0.0.1', family: 6 }],
    }),
    false,
  );
  assert.equal(
    await isSafeExternalWebhookUrlAsync('https://rebind.example.com/hook', {
      lookupImpl: async () => [{ address: '169.254.169.254', family: 4 }],
    }),
    false,
  );
  assert.equal(
    await isSafeExternalWebhookUrlAsync('https://public.example.com/hook', {
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
    }),
    true,
  );

  const calls = [];
  const { db } = makeEnterpriseHarness();

  // Unsafe URLs never invoke fetchImpl, in-app still succeeds
  const blockedRes = await dispatchNotification(db, {
    organizationId: 'org-a',
    recipientUserId: 101,
    title: 'SSRF guard test',
    dedupKey: 'ssrf-1',
  }, {
    env: {
      DX_APPRISE_URL: 'http://169.254.169.254/latest/meta-data',
      DX_NOTIFICATION_WEBHOOK_URL: 'https://admin:pw@127.0.0.1/hook',
    },
    fetchImpl: async (url) => {
      calls.push(url);
      return { ok: true };
    },
  });
  assert.equal(calls.length, 0);
  assert.deepEqual(blockedRes.channelsDispatched, ['in_app']);

  // DNS rebinding to loopback/link-local blocks fetchImpl in dispatchNotification
  const dnsRebindRes = await dispatchNotification(db, {
    organizationId: 'org-a',
    recipientUserId: 101,
    title: 'DNS rebinding guard test',
    dedupKey: 'ssrf-dns-rebind',
  }, {
    env: {
      DX_APPRISE_URL: 'https://rebind-apprise.example.com/notify',
      DX_NOTIFICATION_WEBHOOK_URL: 'https://rebind-hook.example.com/hook',
    },
    lookupImpl: async (host) => (host.includes('apprise')
      ? [{ address: '127.0.0.1', family: 4 }]
      : [{ address: '::ffff:169.254.169.254', family: 6 }]),
    fetchImpl: async (url) => {
      calls.push(url);
      return { ok: true };
    },
  });
  assert.equal(calls.length, 0);
  assert.deepEqual(dnsRebindRes.channelsDispatched, ['in_app']);

  // Valid external endpoints fan out with timeout + redirect: 'error'
  const okRes = await dispatchNotification(db, {
    organizationId: 'org-a',
    recipientUserId: 101,
    category: 'alarm',
    severity: 'critical',
    title: 'Nhiệt độ kho vượt ngưỡng',
    body: 'Kho A: -10°C',
    dedupKey: 'ext-ok',
  }, {
    env: {
      DX_APPRISE_URL: 'https://apprise.example.com/notify',
      DX_NOTIFICATION_WEBHOOK_URL: 'https://hooks.example.com/webhook',
      DX_TELEGRAM_BOT_TOKEN: '123456789:ABCDEFghijklmnopqrstuvwxyz12345',
      DX_TELEGRAM_CHAT_ID: '-1001234567890',
    },
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), redirect: init?.redirect, hasSignal: Boolean(init?.signal) });
      return { ok: true, status: 200, body: { cancel: async () => {} } };
    },
  });
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => c.redirect === 'error' && c.hasSignal));
  assert.deepEqual(okRes.channelsDispatched, ['in_app', 'apprise', 'webhook', 'telegram']);

  // Timeout / network failure degrades non-fatally
  const failRes = await dispatchNotification(db, {
    organizationId: 'org-a',
    recipientUserId: 101,
    title: 'Webhook timeout test',
    dedupKey: 'ext-fail',
  }, {
    env: { DX_NOTIFICATION_WEBHOOK_URL: 'https://hooks.example.com/down' },
    fetchImpl: async () => { throw new Error('ETIMEDOUT'); },
  });
  assert.equal(failRes.title, 'Webhook timeout test');
  assert.deepEqual(failRes.channelsDispatched, ['in_app']);
});

test('latticeNotifications resource enforces strict user+org isolation and returns 404 on cross-user/cross-org markRead', async () => {
  const { registerNotificationCenter, dispatchNotification } = require('../src/server/notification-center');
  const { db } = makeEnterpriseHarness();
  const { app, resources, aclAllows } = makeAppHarness(db);
  registerNotificationCenter(app);

  assert.deepEqual(aclAllows, [
    ['latticeNotifications', ['listMine', 'unreadCount', 'markRead', 'markAllRead'], 'loggedIn'],
  ]);
  const actions = resources.get('latticeNotifications');

  const nUser101 = await dispatchNotification(db, { organizationId: 'org-a', recipientUserId: 101, title: 'N1 for 101', category: 'mention' });
  const nUser102 = await dispatchNotification(db, { organizationId: 'org-a', recipientUserId: 102, title: 'N2 for 102', category: 'voucher' });
  const nOrgB = await dispatchNotification(db, { organizationId: 'org-b', recipientUserId: 201, title: 'N3 for org-b', category: 'alarm' });

  // Unauthenticated blocked 401
  await assert.rejects(() => actions.unreadCount(makeCtx({ user: null })), { status: 401 });

  // User 101 only sees own notifications in org-a
  const countCtx = makeCtx({ user: { id: 101 }, role: 'ldx_employee', method: 'GET' });
  await actions.unreadCount(countCtx, async () => {});
  assert.equal(countCtx.body.unreadCount, 1);

  const listCtx = makeCtx({ user: { id: 101 }, role: 'ldx_employee', method: 'GET' });
  await actions.listMine(listCtx, async () => {});
  assert.equal(listCtx.body.items.length, 1);
  assert.equal(listCtx.body.items[0].id, nUser101.id);

  // Cross-user (same org) and cross-org markRead return 404
  await assert.rejects(
    () => actions.markRead(makeCtx({ user: { id: 101 }, role: 'ldx_employee', method: 'POST', values: { id: nUser102.id } }), async () => {}),
    (err) => err.status === 404,
  );
  await assert.rejects(
    () => actions.markRead(makeCtx({ user: { id: 101 }, role: 'ldx_employee', method: 'POST', values: { id: nOrgB.id } }), async () => {}),
    (err) => err.status === 404,
  );

  // Own markRead succeeds and decrements unreadCount
  const readCtx = makeCtx({ user: { id: 101 }, role: 'ldx_employee', method: 'POST', values: { id: nUser101.id } });
  await actions.markRead(readCtx, async () => {});
  assert.ok(readCtx.body.readAt);

  const countAfter = makeCtx({ user: { id: 101 }, role: 'ldx_employee', method: 'GET' });
  await actions.unreadCount(countAfter, async () => {});
  assert.equal(countAfter.body.unreadCount, 0);

  // markAllRead marks remaining unread for 101 only, leaving 102 and 201 untouched
  await dispatchNotification(db, { organizationId: 'org-a', recipientUserId: 101, title: 'N4 for 101' });
  await dispatchNotification(db, { organizationId: 'org-a', recipientUserId: 101, title: 'N5 for 101' });
  const markAllCtx = makeCtx({ user: { id: 101 }, role: 'ldx_employee', method: 'POST' });
  await actions.markAllRead(markAllCtx, async () => {});
  assert.equal(markAllCtx.body.updatedCount, 2);

  const count102 = makeCtx({ user: { id: 102 }, role: 'ldx_manager', method: 'GET' });
  await actions.unreadCount(count102, async () => {});
  assert.equal(count102.body.unreadCount, 1);
});

test('evaluateSlaBreaches detects warning/breached items, applies policy/fallbacks, deduplicates, and logs Chatter sla_escalation', async () => {
  const { evaluateSlaBreaches, registerSlaEngine } = require('../src/server/sla-engine');
  const now = new Date('2026-11-23T12:00:00.000Z');
  const minsAgo = (m) => new Date(now.getTime() - m * 60_000).toISOString();

  const { db, tables } = makeEnterpriseHarness({
    slaPolicies: [
      {
        id: 1,
        organizationId: 'org-a',
        targetCollection: 'latticeServiceTickets',
        priority: 'medium',
        warnAfterMinutes: 45,
        breachAfterMinutes: 90,
        escalateToRole: 'ldx_manager',
        active: true,
      },
    ],
    requests: [
      { id: 1, organizationId: 'org-a', code: 'REQ-1', name: 'Draft req', status: 'draft', priority: 'high', createdAt: minsAgo(300) },
      { id: 2, organizationId: 'org-a', code: 'REQ-2', name: 'Warn req', status: 'submitted', priority: 'normal', submittedAt: minsAgo(300), createdAt: minsAgo(310) },
    ],
    orders: [
      { id: 3, organizationId: 'org-a', code: 'ORD-3', name: 'Completed ord', status: 'completed', priority: 'high', submittedAt: minsAgo(500), createdAt: minsAgo(500) },
    ],
    serviceTickets: [
      { id: 4, organizationId: 'org-a', code: 'TKT-4', name: 'Breached ticket', status: 'in_progress', priority: 'medium', createdAt: minsAgo(100) },
    ],
    incidentCases: [
      { id: 5, organizationId: 'org-a', code: 'INC-5', name: 'Critical breach', status: 'open', severity: 'critical', firstSeenAt: minsAgo(75), createdAt: minsAgo(75) },
      { id: 6, organizationId: 'org-b', code: 'INC-6', name: 'Org B ok', status: 'open', severity: 'low', createdAt: minsAgo(10) },
    ],
  });

  const firstRun = await evaluateSlaBreaches(db, { organizationId: 'org-a', now });
  assert.equal(firstRun.scanned, 3); // REQ-2 (submitted), TKT-4 (in_progress), INC-5 (open); draft & completed ignored
  assert.equal(firstRun.warningCount, 1); // REQ-2 (300m >= 240m warn, < 1440m breach)
  assert.equal(firstRun.breachedCount, 2); // TKT-4 (100m >= 90m policy) and INC-5 (75m >= 60m critical fallback)
  assert.equal(firstRun.escalatedCount, 2);
  assert.equal(firstRun.items.length, 3);

  // Notifications sent only to org-a active manager (userId 102), NOT org-b (201) or inactive (103)
  const slaNotifs = tables.latticeNotifications.filter((n) => n.category === 'sla');
  assert.equal(slaNotifs.length, 2);
  assert.ok(slaNotifs.every((n) => n.organizationId === 'org-a' && n.recipientUserId === 102));
  assert.deepEqual(
    slaNotifs.map((n) => n.dedupKey).sort(),
    ['sla:latticeIncidentCases:5:breached', 'sla:latticeServiceTickets:4:breached'],
  );

  // Chatter entries appended with entryType: 'sla_escalation'
  const escalations = tables.latticeRecordChatter.filter((c) => c.entryType === 'sla_escalation');
  assert.equal(escalations.length, 2);

  // Second run within 30 minutes deduplicates notifications and avoids duplicate chatter
  const secondRun = await evaluateSlaBreaches(db, { organizationId: 'org-a', now });
  assert.equal(secondRun.breachedCount, 2);
  assert.equal(secondRun.escalatedCount, 0);
  assert.equal(tables.latticeNotifications.filter((n) => n.category === 'sla').length, 2);
  assert.equal(tables.latticeRecordChatter.filter((c) => c.entryType === 'sla_escalation').length, 2);

  // Resource ACL & cron guard checks
  const prevCron = process.env.DX_SLA_CRON_ENABLED;
  process.env.DX_SLA_CRON_ENABLED = 'true';
  try {
    const { app, resources, aclAllows, cronJobs } = makeAppHarness(db);
    registerSlaEngine(app);
    registerSlaEngine(app); // second call must respect _latticeSlaCronRegistered guard
    assert.equal(cronJobs.length, 1);
    assert.equal(app._latticeSlaCronRegistered, true);
    assert.deepEqual(aclAllows[0], ['latticeSla', ['summary', 'policies', 'savePolicy', 'evaluateNow'], 'loggedIn']);

    const slaActions = resources.get('latticeSla');

    // Non-admin can read summary & policies scoped by org, but cannot savePolicy or evaluateNow
    const sumCtx = makeCtx({ user: { id: 101 }, role: 'ldx_employee', method: 'GET' });
    await slaActions.summary(sumCtx, async () => {});
    assert.equal(sumCtx.body.organizationId, 'org-a');
    assert.equal(typeof sumCtx.body.breachedCount, 'number');

    const polCtx = makeCtx({ user: { id: 101 }, role: 'ldx_employee', method: 'GET' });
    await slaActions.policies(polCtx, async () => {});
    assert.equal(polCtx.body.items.length, 1);

    await assert.rejects(
      () => slaActions.savePolicy(makeCtx({
        user: { id: 101 },
        role: 'ldx_employee',
        method: 'POST',
        values: { targetCollection: 'latticeRequests', priority: 'high', warnAfterMinutes: 15, breachAfterMinutes: 30 },
      }), async () => {}),
      { status: 403 },
    );
    await assert.rejects(
      () => slaActions.evaluateNow(makeCtx({ user: { id: 102 }, role: 'ldx_manager', method: 'POST' }), async () => {}),
      { status: 403 },
    );

    // Admin (ldx_admin with pm snippet) can savePolicy and evaluateNow
    const saveCtx = makeCtx({
      user: { id: 102 },
      role: 'ldx_admin',
      method: 'POST',
      values: {
        organizationId: 'org-a',
        targetCollection: 'latticeRequests',
        priority: 'high',
        warnAfterMinutes: 20,
        breachAfterMinutes: 45,
        escalateToRole: 'ldx_manager',
      },
    });
    await slaActions.savePolicy(saveCtx, async () => {});
    assert.equal(saveCtx.body.breachAfterMinutes, 45);
  } finally {
    if (prevCron === undefined) delete process.env.DX_SLA_CRON_ENABLED;
    else process.env.DX_SLA_CRON_ENABLED = prevCron;
  }
});

test('Notification Bell UI anchors cleanly at top-right, hides on /signin, supports Alt+N & polling, and Workspace sets document.title', async () => {
  const { createNotificationBellProvider, isVisibleBellPath } = require('../src/client/notification-bell');
  assert.equal(isVisibleBellPath('/p/incidents'), true);
  assert.equal(isVisibleBellPath('/admin/lattice-workspace'), true);
  assert.equal(isVisibleBellPath('/signin'), false);
  assert.equal(isVisibleBellPath('/'), false);

  const prevWindow = globalThis.window;
  const prevDocument = globalThis.document;
  try {
    const keyListeners = [];
    const visListeners = [];
    let currentPath = '/signin';
    const navigations = [];
    const apiCalls = [];
    let unread = 3;

    globalThis.window = {
      location: { pathname: currentPath, assign: (p) => navigations.push(p) },
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
      addEventListener(ev, fn) { if (ev === 'keydown') keyListeners.push(fn); },
      removeEventListener(ev, fn) {
        const idx = keyListeners.indexOf(fn);
        if (idx >= 0) keyListeners.splice(idx, 1);
      },
    };
    globalThis.document = {
      title: 'Loading...',
      visibilityState: 'visible',
      addEventListener(ev, fn) { if (ev === 'visibilitychange') visListeners.push(fn); },
      removeEventListener(ev, fn) {
        const idx = visListeners.indexOf(fn);
        if (idx >= 0) visListeners.splice(idx, 1);
      },
    };

    let cursor = 0;
    const state = [];
    const effects = [];
    const React = {
      Fragment: 'Fragment',
      createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
      useState(init) {
        const idx = cursor++;
        if (!(idx in state)) state[idx] = typeof init === 'function' ? init() : init;
        return [state[idx], (v) => { state[idx] = typeof v === 'function' ? v(state[idx]) : v; }];
      },
      useEffect(fn, deps) {
        const idx = cursor++;
        const prev = state[idx];
        if (!prev || !deps || deps.some((d, i) => d !== prev.deps[i])) {
          state[idx] = { deps };
          effects.push(fn);
        }
      },
      useCallback: (fn) => fn,
      useMemo: (fn) => fn(),
      useRef: (init) => {
        const idx = cursor++;
        return state[idx] ?? (state[idx] = { current: init });
      },
    };

    const api = {
      auth: { role: 'ldx_employee', getToken: () => 'tok-123' },
      request: async ({ url, method, data }) => {
        apiCalls.push({ url, method, data });
        if (url === 'latticeNotifications:unreadCount') return { data: { data: { unreadCount: unread } } };
        if (url === 'latticeNotifications:listMine') {
          return {
            data: {
              data: {
                items: [
                  { id: 55, category: 'sla', severity: 'critical', title: 'SLA Quá hạn', body: 'TKT-4', targetPath: '/p/services', readAt: null, createdAt: '2026-11-23T10:00:00Z' },
                ],
                unreadCount: unread,
              },
            },
          };
        }
        if (url === 'latticeNotifications:markRead') {
          unread = Math.max(0, unread - 1);
          return { data: { data: { id: 55, readAt: '2026-11-23T10:05:00Z' } } };
        }
        if (url === 'latticeNotifications:markAllRead') {
          unread = 0;
          return { data: { data: { updatedCount: 3 } } };
        }
        return { data: {} };
      },
    };
    const app = { router: { navigate: (p) => navigations.push(p) } };
    const Provider = createNotificationBellProvider({ useAPIClient: () => api }, React, {}, app);

    const find = (node, pred) => {
      if (!node || typeof node !== 'object') return null;
      if (pred(node)) return node;
      if (typeof node.type === 'function') return find(node.type(node.props), pred);
      return node.children?.flat(Infinity).map((c) => find(c, pred)).find(Boolean) || null;
    };
    const renderBell = () => {
      cursor = 0;
      const ui = Provider({ children: React.createElement('div', null, 'child') });
      while (effects.length) {
        const fn = effects.shift();
        fn();
      }
      return ui;
    };

    // Hidden on /signin
    const signinUi = renderBell();
    assert.equal(find(signinUi, (n) => n.props?.['data-testid'] === 'ldx-notification-bell-btn'), null);

    // Visible on /p/incidents at top-right (top: 8, right: 210)
    currentPath = '/p/incidents';
    globalThis.window.location.pathname = currentPath;
    state.length = 0;
    let portalUi = renderBell();
    await Promise.resolve();
    await Promise.resolve();
    portalUi = renderBell();
    const bellWrap = find(portalUi, (n) => n.props?.['data-testid'] === 'ldx-notification-bell-wrap');
    assert.ok(bellWrap);
    assert.equal(bellWrap.props.style.top, 8);
    assert.equal(bellWrap.props.style.right, 210);
    assert.equal(bellWrap.props.style.bottom, undefined);

    // Hotkey Alt+N opens popover & loads listMine
    const altN = keyListeners[keyListeners.length - 1];
    assert.equal(typeof altN, 'function');
    altN({ altKey: true, key: 'n', preventDefault() {} });
    await Promise.resolve();
    await Promise.resolve();
    portalUi = renderBell();
    await Promise.resolve();
    portalUi = renderBell();
    const popover = find(portalUi, (n) => n.props?.['data-testid'] === 'ldx-notification-popover');
    assert.ok(popover);
    assert.ok(apiCalls.some((c) => c.url === 'latticeNotifications:listMine'));

    // Click item calls markRead & navigates to targetPath
    const itemBtn = find(popover, (n) => n.props?.['data-testid'] === 'ldx-notification-item-55');
    assert.ok(itemBtn);
    await itemBtn.props.onClick();
    assert.ok(apiCalls.some((c) => c.url === 'latticeNotifications:markRead' && c.data?.id === 55));
    assert.equal(navigations.at(-1), '/p/services');

    // Reopen popover, click "Đánh dấu tất cả đã đọc", verify mobile positioning & hidden-tab poll guard
    unread = 2;
    globalThis.window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
    state.length = 0;
    const callsBeforeHidden = apiCalls.length;
    globalThis.document.visibilityState = 'hidden';
    renderBell();
    assert.equal(apiCalls.slice(callsBeforeHidden).some((c) => c.url === 'latticeNotifications:unreadCount'), false);

    globalThis.document.visibilityState = 'visible';
    state.length = 0;
    let mobileUi = renderBell();
    await Promise.resolve();
    await Promise.resolve();
    mobileUi = renderBell();
    const mobileWrap = find(mobileUi, (n) => n.props?.['data-testid'] === 'ldx-notification-bell-wrap');
    assert.equal(mobileWrap.props.style.top, 6);
    assert.equal(mobileWrap.props.style.right, 54);

    // Open via click and markAllRead
    const bellBtn = find(mobileUi, (n) => n.props?.['data-testid'] === 'ldx-notification-bell-btn');
    bellBtn.props.onClick();
    await Promise.resolve();
    mobileUi = renderBell();
    const markAllBtn = find(mobileUi, (n) => n.props?.['data-testid'] === 'ldx-notification-mark-all');
    assert.ok(markAllBtn);
    await markAllBtn.props.onClick();
    assert.ok(apiCalls.some((c) => c.url === 'latticeNotifications:markAllRead'));
    assert.equal(unread, 0);

    // Workspace Landing sets clean Vietnamese document.title
    const { createNativeWorkspace } = require('../src/client/native-workspace');
    let wsComponent;
    createNativeWorkspace(
      {
        useAPIClient: () => api,
        useAllAccessDesktopRoutes: () => ({ allAccessRoutes: [], refresh: async () => {} }),
        SchemaComponent: 'Schema',
        PagePopups: 'Popups',
      },
      React,
      { Button: 'Button', Input: 'Input', Alert: 'Alert', Empty: 'Empty', Tabs: 'Tabs', ConfigProvider: 'ConfigProvider' },
      { router: { add: (name, r) => { if (name === 'admin.lattice-workspace') wsComponent = r.Component; } } },
      { Link: 'Link', Outlet: 'Outlet', useLocation: () => ({ pathname: '/admin/lattice-workspace', search: '' }), useNavigate: () => () => {} },
    );
    cursor = 0;
    state.length = 0;
    wsComponent();
    while (effects.length) effects.shift()();
    assert.equal(globalThis.document.title, 'Không gian Làm việc — LatticeDX');
  } finally {
    if (prevWindow === undefined) delete globalThis.window;
    else globalThis.window = prevWindow;
    if (prevDocument === undefined) delete globalThis.document;
    else globalThis.document = prevDocument;
  }
});

test('notification-bell preserves other categories on filtered markAllRead and avoids StrictMode double-fetch on Alt+N', async () => {
  const { createNotificationBellProvider } = require('../src/client/notification-bell');
  const prevWindow = globalThis.window;
  const prevDocument = globalThis.document;
  try {
    const keyListeners = [];
    globalThis.window = {
      location: { pathname: '/p/services', assign() {} },
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
      addEventListener(ev, fn) { if (ev === 'keydown') keyListeners.push(fn); },
      removeEventListener() {},
    };
    globalThis.document = {
      visibilityState: 'visible',
      addEventListener() {},
      removeEventListener() {},
    };

    let cursor = 0;
    const state = [];
    const effects = [];
    const React = {
      Fragment: 'Fragment',
      createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
      useState(init) {
        const idx = cursor++;
        if (!(idx in state)) state[idx] = typeof init === 'function' ? init() : init;
        return [
          state[idx],
          (v) => {
            if (typeof v === 'function') {
              // Simulate React 18 StrictMode double-invoking state updaters
              const first = v(state[idx]);
              const second = v(state[idx]);
              state[idx] = second ?? first;
            } else {
              state[idx] = v;
            }
          },
        ];
      },
      useEffect(fn, deps) {
        const idx = cursor++;
        const prev = state[idx];
        if (!prev || !deps || deps.some((d, i) => d !== prev.deps[i])) {
          state[idx] = { deps };
          effects.push(fn);
        }
      },
      useCallback: (fn) => fn,
      useMemo: (fn) => fn(),
      useRef: (init) => {
        const idx = cursor++;
        return state[idx] ?? (state[idx] = { current: init });
      },
    };

    const dbRows = [
      { id: 1, category: 'sla', severity: 'critical', title: 'SLA 1', readAt: null },
      { id: 2, category: 'sla', severity: 'high', title: 'SLA 2', readAt: null },
      { id: 3, category: 'voucher', severity: 'info', title: 'Voucher 1', readAt: null },
      { id: 4, category: 'voucher', severity: 'info', title: 'Voucher 2', readAt: null },
      { id: 5, category: 'voucher', severity: 'info', title: 'Voucher 3', readAt: null },
    ];
    let listMineCalls = 0;
    const markAllPayloads = [];
    const api = {
      auth: { role: 'ldx_employee', getToken: () => 'tok-1' },
      request: async ({ url, params, data }) => {
        if (url === 'latticeNotifications:unreadCount') {
          return { data: { data: { unreadCount: dbRows.filter((r) => !r.readAt).length } } };
        }
        if (url === 'latticeNotifications:listMine') {
          listMineCalls += 1;
          const cat = params?.category;
          const filtered = cat ? dbRows.filter((r) => r.category === cat) : dbRows;
          return { data: { data: { items: filtered.map((r) => ({ ...r })), unreadCount: dbRows.filter((r) => !r.readAt).length } } };
        }
        if (url === 'latticeNotifications:markAllRead') {
          markAllPayloads.push(data);
          const cat = data?.category;
          let updatedCount = 0;
          for (const r of dbRows) {
            if (!r.readAt && (!cat || r.category === cat)) {
              r.readAt = '2026-11-23T12:00:00Z';
              updatedCount += 1;
            }
          }
          return { data: { data: { updatedCount } } };
        }
        return { data: {} };
      },
    };

    const Provider = createNotificationBellProvider({ useAPIClient: () => api }, React, {}, {});
    const find = (node, pred) => {
      if (!node || typeof node !== 'object') return null;
      if (pred(node)) return node;
      if (typeof node.type === 'function') return find(node.type(node.props), pred);
      return node.children?.flat(Infinity).map((c) => find(c, pred)).find(Boolean) || null;
    };
    const render = () => {
      cursor = 0;
      const ui = Provider({ children: React.createElement('div') });
      while (effects.length) effects.shift()();
      return ui;
    };

    let ui = render();
    await Promise.resolve();
    await Promise.resolve();
    ui = render();

    // Alt+N under StrictMode double-updater must only fetchInbox ONCE
    const altN = keyListeners.at(-1);
    const beforeAltN = listMineCalls;
    altN({ altKey: true, key: 'n', preventDefault() {} });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(listMineCalls - beforeAltN, 1, 'Alt+N must not invoke fetchInbox inside React state updater');

    ui = render();
    // Filter by 'sla' category and click markAllRead
    const slaTab = find(ui, (n) => n.props?.['data-testid'] === 'ldx-notification-cat-sla');
    assert.ok(slaTab);
    slaTab.props.onClick();
    await Promise.resolve();
    await Promise.resolve();
    ui = render();

    const markAllBtn = find(ui, (n) => n.props?.['data-testid'] === 'ldx-notification-mark-all');
    assert.ok(markAllBtn);
    await markAllBtn.props.onClick();
    await Promise.resolve();
    ui = render();

    assert.deepEqual(markAllPayloads, [{ category: 'sla' }]);
    const badge = find(ui, (n) => n.props?.['data-testid'] === 'ldx-notification-badge');
    assert.ok(badge, 'Remaining voucher unread notifications must keep badge visible');
    assert.equal(badge.children[0], '3');
  } finally {
    if (prevWindow === undefined) delete globalThis.window;
    else globalThis.window = prevWindow;
    if (prevDocument === undefined) delete globalThis.document;
    else globalThis.document = prevDocument;
  }
});

test('notification-center filters rolesUsers by userId, strips trailing dots in SSRF guard, fans out concurrently, and blocks non-dedicated actions', async () => {
  const {
    isSafeExternalWebhookUrl,
    dispatchNotification,
    dispatchRoleNotifications,
    registerNotificationCenter,
  } = require('../src/server/notification-center');

  // 1. Trailing-dot hostnames must be rejected by SSRF guard
  for (const unsafe of [
    'http://localhost./hook',
    'http://metadata.google.internal./computeMetadata/v1/',
    'http://foo.local./hook',
    'http://127.0.0.1./hook',
    'http://[::1]./hook',
  ]) {
    assert.equal(isSafeExternalWebhookUrl(unsafe), false, `Expected SSRF block for trailing-dot URL ${unsafe}`);
  }

  // 2. resolveEmployeeUsersForRoles filters rolesUsers by userId.$in so >2000 rows from other orgs do not hide org-a managers
  const ruFilters = [];
  const manyOtherBindings = Array.from({ length: 2100 }, (_, i) => ({ userId: 5000 + i, roleName: 'ldx_manager' }));
  manyOtherBindings.push({ userId: 102, roleName: 'ldx_manager' });
  const { db } = makeEnterpriseHarness({ rolesUsers: manyOtherBindings });
  const origGetRepo = db.getRepository.bind(db);
  db.getRepository = (name) => {
    const repo = origGetRepo(name);
    if (name !== 'rolesUsers') return repo;
    return {
      ...repo,
      find: async (opts) => {
        ruFilters.push(opts?.filter);
        return repo.find(opts);
      },
    };
  };
  const roleRes = await dispatchRoleNotifications(db, {
    organizationId: 'org-a',
    roleNames: ['ldx_manager'],
    title: 'Notify Org-A Mgr',
  });
  assert.equal(roleRes.recipientCount, 1);
  assert.equal(roleRes.dispatchedCount, 1);
  assert.ok(ruFilters[0]?.userId?.$in, 'rolesUsers.find must filter by userId.$in');
  assert.deepEqual(ruFilters[0].userId.$in.slice().sort((a, b) => a - b), [101, 102]);

  // 3. Concurrent external fan-out via Promise.all
  const startedUrls = [];
  const resolvers = [];
  const fanoutPromise = dispatchNotification(db, {
    organizationId: 'org-a',
    recipientUserId: 101,
    title: 'Concurrent Fanout',
    dedupKey: 'fanout-concurrent',
  }, {
    env: {
      DX_APPRISE_URL: 'https://apprise.example.com/notify',
      DX_NOTIFICATION_WEBHOOK_URL: 'https://hooks.example.com/hook',
      DX_TELEGRAM_BOT_TOKEN: '123456789:ABCDEFghijklmnopqrstuvwxyz12345',
      DX_TELEGRAM_CHAT_ID: '-1001234567890',
    },
    fetchImpl: (url) => {
      startedUrls.push(String(url));
      return new Promise((resolve) => {
        resolvers.push(() => resolve({ ok: true, status: 200, body: { cancel: async () => {} } }));
      });
    },
  });
  // Allow dispatchNotification pre-fetch DB insert microtasks to run, then verify ALL 3 fetches started before ANY resolved
  for (let i = 0; i < 6 && startedUrls.length < 3; i += 1) {
    await new Promise((r) => setImmediate(r));
  }
  assert.equal(startedUrls.length, 3, 'All 3 external channels must be dispatched concurrently');
  while (resolvers.length) resolvers.shift()();
  const fanoutRes = await fanoutPromise;
  assert.deepEqual(fanoutRes.channelsDispatched, ['in_app', 'apprise', 'webhook', 'telegram']);

  // 4. Resource middleware blocks raw CRUD, non-dedicated actions, associations, and chart queries for non-root
  const { app, middlewares } = makeAppHarness(db);
  registerNotificationCenter(app);
  assert.ok(middlewares.length >= 1);
  const guard = middlewares[0];

  const blockedRequests = [
    { resourceName: 'latticeNotifications', actionName: 'list' },
    { resourceName: 'latticeNotifications', actionName: 'count' },
    { resourceName: 'latticeNotifications', actionName: 'export' },
    { resourceName: 'latticeNotifications', actionName: 'updateOrCreate' },
    { resourceName: 'latticeNotifications.recipient', actionName: 'get' },
    { resourceName: 'latticeSlaPolicies', actionName: 'list' },
    { resourceName: 'latticeSlaPolicies', actionName: 'export' },
    { resourceName: 'latticeSlaPolicies.org', actionName: 'list' },
    { resourceName: 'charts', actionName: 'queryData', params: { values: { collection: 'latticeNotifications' } } },
    { resourceName: 'charts', actionName: 'queryData', params: { values: { collection: 'latticeSlaPolicies' } } },
  ];
  for (const action of blockedRequests) {
    await assert.rejects(
      () => guard({ state: { currentRole: 'ldx_admin', currentUser: { id: 102 } }, action }, async () => {}),
      (err) => err.status === 403 && err.code === 'NOTIFICATION_DIRECT_CRUD_FORBIDDEN',
      `Expected 403 for ${action.resourceName}:${action.actionName}`,
    );
  }

  let dedicatedPassed = false;
  await guard(
    { state: { currentRole: 'ldx_employee', currentUser: { id: 101 } }, action: { resourceName: 'latticeNotifications', actionName: 'listMine' } },
    async () => { dedicatedPassed = true; },
  );
  assert.equal(dedicatedPassed, true);

  let rootPassed = false;
  await guard(
    { state: { currentRole: 'root', currentUser: { id: 1 } }, action: { resourceName: 'latticeNotifications', actionName: 'list' } },
    async () => { rootPassed = true; },
  );
  assert.equal(rootPassed, true);
});

test('evaluateSlaBreaches paginates deterministically by createdAt/id so older breaching records beyond 1000 rows are never skipped', async () => {
  const { evaluateSlaBreaches } = require('../src/server/sla-engine');
  const now = new Date('2026-11-23T12:00:00.000Z');
  const minsAgo = (m) => new Date(now.getTime() - m * 60_000).toISOString();

  // Place 150 fresh (non-breaching) rows first, followed by 1050 older (breaching) rows
  const serviceTickets = [];
  for (let i = 1; i <= 150; i += 1) {
    serviceTickets.push({
      id: i,
      organizationId: 'org-a',
      code: `TKT-NEW-${i}`,
      name: 'Fresh',
      status: 'open',
      priority: 'high',
      createdAt: minsAgo(5),
    });
  }
  for (let i = 151; i <= 1200; i += 1) {
    serviceTickets.push({
      id: i,
      organizationId: 'org-a',
      code: `TKT-OLD-${i}`,
      name: 'Breached',
      status: 'open',
      priority: 'high',
      createdAt: minsAgo(120),
    });
  }

  const { db } = makeEnterpriseHarness({ serviceTickets });
  const findCalls = [];
  const origGetRepo = db.getRepository.bind(db);
  db.getRepository = (name) => {
    const repo = origGetRepo(name);
    if (name !== 'latticeServiceTickets') return repo;
    return {
      ...repo,
      find: async (opts) => {
        findCalls.push({ sort: opts?.sort, offset: opts?.offset, limit: opts?.limit });
        return repo.find(opts);
      },
    };
  };

  const report = await evaluateSlaBreaches(db, { organizationId: 'org-a', now, dryRun: true });
  assert.equal(report.scanned, 1200);
  assert.equal(report.breachedCount, 1050);
  assert.deepEqual(
    findCalls,
    [
      { sort: ['createdAt', 'id'], offset: 0, limit: 500 },
      { sort: ['createdAt', 'id'], offset: 500, limit: 500 },
      { sort: ['createdAt', 'id'], offset: 1000, limit: 500 },
    ],
  );
});

test('Task 2.1 src files have zero Math.random() and src/client/*.js has zero non-relative require() (excluding UMD entry header)', () => {
  const checkedSrcFiles = [
    path.resolve(__dirname, '../src/client/notification-bell.js'),
    path.resolve(__dirname, '../src/client/native-workspace.js'),
    path.resolve(__dirname, '../src/client/index.js'),
    path.resolve(__dirname, '../src/server/notification-center.js'),
    path.resolve(__dirname, '../src/server/sla-engine.js'),
    path.resolve(__dirname, '../src/server/record-chatter.js'),
    path.resolve(__dirname, '../src/server/voucher-lifecycle.js'),
  ];
  for (const filePath of checkedSrcFiles) {
    const src = readFileSync(filePath, 'utf8');
    assert.doesNotMatch(src, /\bMath\.random\s*\(/, `${path.basename(filePath)} must not use Math.random()`);
  }
  const clientDir = path.resolve(__dirname, '../src/client');
  for (const file of readdirSync(clientDir).filter((f) => f.endsWith('.js'))) {
    const src = readFileSync(path.join(clientDir, file), 'utf8');
    if (file !== 'index.js') {
      for (const m of src.matchAll(/require\(['"]([^'"]+)['"]\)/g)) {
        assert.ok(m[1].startsWith('./') || m[1].startsWith('../'), `${file} has non-relative require(${m[1]})`);
      }
    }
  }
});

test('computeElapsedSlaMinutes excludes Vietnamese weekends/holidays/lunch in GMT+7 when businessHoursOnly=true and preserves wall-clock when false', () => {
  const {
    VN_FIXED_HOLIDAYS,
    VN_BUSINESS_WINDOWS,
    VN_UTC_OFFSET_MS,
    computeElapsedSlaMinutes,
  } = require('../src/server/sla-engine');

  assert.equal(typeof computeElapsedSlaMinutes, 'function');
  assert.ok(VN_FIXED_HOLIDAYS instanceof Set);
  for (const h of ['01-01', '04-30', '05-01', '09-02']) {
    assert.equal(VN_FIXED_HOLIDAYS.has(h), true, `Missing Vietnamese fixed holiday ${h}`);
  }
  assert.ok(Array.isArray(VN_BUSINESS_WINDOWS) && VN_BUSINESS_WINDOWS.length === 2);
  assert.equal(VN_UTC_OFFSET_MS, 7 * 60 * 60_000);

  // Wall-clock mode untouched
  assert.equal(
    computeElapsedSlaMinutes('2026-11-21T08:00:00+07:00', '2026-11-21T10:30:00+07:00'),
    150,
  );
  assert.equal(computeElapsedSlaMinutes(null, '2026-11-21T10:30:00+07:00'), 0);
  assert.equal(computeElapsedSlaMinutes('2026-11-21T12:00:00+07:00', '2026-11-21T10:00:00+07:00'), 0);

  // Weekend (Saturday & Sunday in GMT+7) = 0 business minutes
  assert.equal(
    computeElapsedSlaMinutes('2026-11-21T08:00:00+07:00', '2026-11-22T17:30:00+07:00', { businessHoursOnly: true }),
    0,
  );

  // Vietnamese fixed holidays = 0 business minutes
  assert.equal(
    computeElapsedSlaMinutes('2026-09-02T08:00:00+07:00', '2026-09-02T17:30:00+07:00', { businessHoursOnly: true }),
    0,
  );
  assert.equal(
    computeElapsedSlaMinutes('2026-01-01T08:00:00+07:00', '2026-01-01T17:30:00+07:00', { businessHoursOnly: true }),
    0,
  );
  assert.equal(
    computeElapsedSlaMinutes('2026-04-30T08:00:00+07:00', '2026-05-01T17:30:00+07:00', { businessHoursOnly: true }),
    0,
  );

  // Lunch break 12:00-13:30 GMT+7 excluded: 11:30 to 14:00 = 30 + 30 = 60 minutes
  assert.equal(
    computeElapsedSlaMinutes('2026-11-23T11:30:00+07:00', '2026-11-23T14:00:00+07:00', { businessHoursOnly: true }),
    60,
  );

  // Crossing National Day holiday (Tue 2026-09-01 17:00 -> Thu 2026-09-03 09:00) = 30 + 0 + 60 = 90 minutes
  assert.equal(
    computeElapsedSlaMinutes('2026-09-01T17:00:00+07:00', '2026-09-03T09:00:00+07:00', { businessHoursOnly: true }),
    90,
  );

  // Multi-day Mon..Wed full working days = 3 * 480 = 1440 minutes
  assert.equal(
    computeElapsedSlaMinutes('2026-11-23T08:00:00+07:00', '2026-11-25T17:30:00+07:00', { businessHoursOnly: true }),
    1440,
  );

  // Friday 16:30+07:00 to Monday 10:00+07:00 = 60 (Fri) + 0 (Sat/Sun) + 120 (Mon) = 180 minutes
  assert.equal(
    computeElapsedSlaMinutes('2026-11-20T16:30:00+07:00', '2026-11-23T10:00:00+07:00', { businessHoursOnly: true }),
    180,
  );
});

test('SLA engine pushes active:{$ne:false} to DB filter and honors saved businessHoursOnly policies cleanly', async () => {
  const { evaluateSlaBreaches, registerSlaEngine } = require('../src/server/sla-engine');
  const { db, tables } = makeEnterpriseHarness({
    serviceTickets: [
      {
        id: 1,
        organizationId: 'org-a',
        code: 'TKT-INACTIVE',
        name: 'Soft deleted',
        status: 'open',
        priority: 'high',
        active: false,
        createdAt: '2026-11-10T01:00:00.000Z',
      },
      {
        id: 2,
        organizationId: 'org-a',
        code: 'TKT-WEEKEND',
        name: 'Opened Fri afternoon',
        status: 'open',
        priority: 'high',
        active: true,
        createdAt: '2026-11-20T17:00:00+07:00',
      },
    ],
  });

  const capturedFilters = [];
  const origGetRepo = db.getRepository.bind(db);
  db.getRepository = (name) => {
    const repo = origGetRepo(name);
    if (!repo || !['latticeRequests', 'latticeOrders', 'latticeServiceTickets', 'latticeIncidentCases'].includes(name)) {
      return repo;
    }
    return {
      ...repo,
      find: async (opts) => {
        capturedFilters.push({ collection: name, filter: opts?.filter });
        return repo.find(opts);
      },
    };
  };

  // Admin saves businessHoursOnly: true policy with notifyChannels: ['apprise']
  const { app, resources } = makeAppHarness(db);
  registerSlaEngine(app);
  const slaActions = resources.get('latticeSla');
  const saveCtx = makeCtx({
    user: { id: 102 },
    role: 'ldx_admin',
    method: 'POST',
    values: {
      organizationId: 'org-a',
      targetCollection: 'latticeServiceTickets',
      priority: 'high',
      warnAfterMinutes: 45,
      breachAfterMinutes: 90,
      escalateToRole: 'ldx_manager',
      notifyChannels: ['apprise'],
      businessHoursOnly: true,
    },
  });
  await slaActions.savePolicy(saveCtx, async () => {});
  assert.equal(saveCtx.body.businessHoursOnly, true);
  assert.deepEqual(saveCtx.body.notifyChannels, ['apprise']);

  const polCtx = makeCtx({ user: { id: 101 }, role: 'ldx_employee', method: 'GET' });
  await slaActions.policies(polCtx, async () => {});
  assert.equal(polCtx.body.items[0].businessHoursOnly, true);
  assert.deepEqual(polCtx.body.items[0].notifyChannels, ['apprise']);

  // At Mon 2026-11-23 08:30+07:00 -> 60 business minutes (Fri 17:00-17:30 + Mon 08:00-08:30): warning (not breached)
  const monWarn = await evaluateSlaBreaches(db, {
    organizationId: 'org-a',
    now: new Date('2026-11-23T08:30:00+07:00'),
    dryRun: true,
  });
  assert.equal(capturedFilters.length, 4);
  for (const call of capturedFilters) {
    assert.deepEqual(call.filter.active, { $ne: false }, `${call.collection} must push down active: { $ne: false }`);
  }
  assert.equal(monWarn.scanned, 1); // TKT-INACTIVE excluded at DB layer
  assert.equal(monWarn.warningCount, 1);
  assert.equal(monWarn.breachedCount, 0);
  assert.equal(monWarn.items[0].elapsedMinutes, 60);

  // At Mon 2026-11-23 09:00+07:00 -> 90 business minutes: breached
  const monBreach = await evaluateSlaBreaches(db, {
    organizationId: 'org-a',
    now: new Date('2026-11-23T09:00:00+07:00'),
    dryRun: false,
  });
  assert.equal(monBreach.breachedCount, 1);
  assert.equal(monBreach.escalatedCount, 1);
  assert.equal(monBreach.items[0].elapsedMinutes, 90);
  assert.equal(tables.latticeNotifications.filter((n) => n.category === 'sla').length, 1);
});

test('SLA engine handles weekend-holiday overlaps (01-01/04-30/05-01/09-02), parses JSON-string notifyChannels, and dispatches unwrapped channels via fetchImpl', async () => {
  const { computeElapsedSlaMinutes, evaluateSlaBreaches, registerSlaEngine } = require('../src/server/sla-engine');

  // 1. Weekend-holiday overlap coverage in GMT+7 (Sat/Sun overlapping fixed holidays must stay 0 with no boundary drift)
  // 2028-01-01 (Saturday)
  assert.equal(
    computeElapsedSlaMinutes('2028-01-01T08:00:00+07:00', '2028-01-02T17:30:00+07:00', { businessHoursOnly: true }),
    0,
  );
  assert.equal(
    computeElapsedSlaMinutes('2027-12-31T17:00:00+07:00', '2028-01-03T09:00:00+07:00', { businessHoursOnly: true }),
    90,
  );
  // 2028-04-30 (Sunday) followed by 2028-05-01 (Monday)
  assert.equal(
    computeElapsedSlaMinutes('2028-04-28T17:00:00+07:00', '2028-05-02T09:00:00+07:00', { businessHoursOnly: true }),
    90,
  );
  // 2027-05-01 (Saturday) preceded by 2027-04-30 (Friday)
  assert.equal(
    computeElapsedSlaMinutes('2027-04-29T16:30:00+07:00', '2027-05-03T08:30:00+07:00', { businessHoursOnly: true }),
    90,
  );
  // 2028-09-02 (Saturday) & 2029-09-02 (Sunday)
  assert.equal(
    computeElapsedSlaMinutes('2028-09-01T17:00:00+07:00', '2028-09-04T08:30:00+07:00', { businessHoursOnly: true }),
    60,
  );
  assert.equal(
    computeElapsedSlaMinutes('2029-08-31T17:00:00+07:00', '2029-09-03T08:30:00+07:00', { businessHoursOnly: true }),
    60,
  );

  // 2. End-to-end fetchImpl dispatch with businessHoursOnly: true wrapper + raw JSON string notifyChannels from ORM/DB driver
  const { db, tables } = makeEnterpriseHarness({
    slaPolicies: [
      {
        id: 1,
        organizationId: 'org-a',
        targetCollection: 'latticeServiceTickets',
        priority: 'high',
        warnAfterMinutes: 45,
        breachAfterMinutes: 90,
        escalateToRole: 'ldx_manager',
        notifyChannels: '{"channels":["apprise"],"businessHoursOnly":true}',
        active: true,
      },
      {
        id: 2,
        organizationId: 'org-a',
        targetCollection: 'latticeRequests',
        priority: 'normal',
        warnAfterMinutes: 120,
        breachAfterMinutes: 240,
        escalateToRole: 'ldx_manager',
        notifyChannels: '["webhook"]',
        active: true,
      },
      {
        id: 3,
        organizationId: 'org-a',
        targetCollection: 'latticeOrders',
        priority: 'low',
        warnAfterMinutes: 120,
        breachAfterMinutes: 240,
        escalateToRole: 'ldx_manager',
        notifyChannels: '{invalid-json',
        active: true,
      },
    ],
    serviceTickets: [
      {
        id: 10,
        organizationId: 'org-a',
        code: 'TKT-BH-FETCH',
        name: 'Apprise unwrap test',
        status: 'open',
        priority: 'high',
        active: true,
        createdAt: '2026-11-20T17:00:00+07:00',
      },
    ],
  });

  // policies action deserializes raw JSON string rows cleanly
  const { app, resources } = makeAppHarness(db);
  registerSlaEngine(app);
  const slaActions = resources.get('latticeSla');
  const polCtx = makeCtx({ user: { id: 101 }, role: 'ldx_employee', method: 'GET' });
  await slaActions.policies(polCtx, async () => {});
  const ticketPolicy = polCtx.body.items.find((p) => p.targetCollection === 'latticeServiceTickets');
  const reqPolicy = polCtx.body.items.find((p) => p.targetCollection === 'latticeRequests');
  const ordPolicy = polCtx.body.items.find((p) => p.targetCollection === 'latticeOrders');
  assert.deepEqual(ticketPolicy.notifyChannels, ['apprise']);
  assert.equal(ticketPolicy.businessHoursOnly, true);
  assert.deepEqual(reqPolicy.notifyChannels, ['webhook']);
  assert.equal(reqPolicy.businessHoursOnly, false);
  assert.equal(ordPolicy.notifyChannels, null);
  assert.equal(ordPolicy.businessHoursOnly, false);

  // Breach evaluation at Mon 09:00+07:00 (90 business mins) dispatches ONLY to unwrapped 'apprise' URL via fetchImpl
  const fetchedUrls = [];
  const report = await evaluateSlaBreaches(db, {
    organizationId: 'org-a',
    now: new Date('2026-11-23T09:00:00+07:00'),
    dryRun: false,
    env: {
      DX_APPRISE_URL: 'https://apprise.example.com/sla-notify',
      DX_NOTIFICATION_WEBHOOK_URL: 'https://hooks.example.com/should-not-fire',
    },
    fetchImpl: async (url, init) => {
      fetchedUrls.push({ url: String(url), method: init?.method, body: JSON.parse(init?.body || '{}') });
      return { ok: true, status: 200, body: { cancel: async () => {} } };
    },
  });

  assert.equal(report.breachedCount, 1);
  assert.equal(report.escalatedCount, 1);
  assert.equal(report.items[0].businessHoursOnly, true);
  assert.equal(report.items[0].elapsedMinutes, 90);
  assert.equal(fetchedUrls.length, 1);
  assert.equal(fetchedUrls[0].url, 'https://apprise.example.com/sla-notify');
  assert.equal(fetchedUrls[0].method, 'POST');
  assert.equal(fetchedUrls[0].body.tag, 'sla');

  const notifRows = tables.latticeNotifications.filter((n) => n.category === 'sla');
  assert.equal(notifRows.length, 1);
  assert.deepEqual(notifRows[0].channelsDispatched, ['in_app', 'apprise']);
});

test('Task 1 remediation: evaluateSlaBreaches never holds a DB transaction open across fetchImpl, forwards transaction, and isolates chatter 25P02 failures', async () => {
  const { evaluateSlaBreaches } = require('../src/server/sla-engine');
  const prevFlag = process.env.DX_PG_RLS_SESSION;
  let openTxCount = 0;
  let txAborted = false;
  let activeSp = null;
  const chatterFindTxs = [];
  const chatterCreateTxs = [];
  const savepointQueries = [];

  const { db, tables } = makeEnterpriseHarness({
    requests: [
      {
        id: 1,
        organizationId: 'org-a',
        code: 'REQ-SLA-TX',
        name: 'Breached Request',
        status: 'submitted',
        priority: 'critical',
        active: true,
        submittedAt: new Date(Date.now() - 120 * 60_000).toISOString(),
      },
    ],
  });

  db.sequelize = {
    getDialect: () => 'postgres',
    transaction: async (cb) => {
      openTxCount += 1;
      txAborted = false;
      activeSp = null;
      try {
        return await cb({ id: `tx-sla-${openTxCount}`, LOCK: { UPDATE: 'UPDATE' } });
      } finally {
        openTxCount -= 1;
      }
    },
    query: async (sql) => {
      const text = String(sql);
      savepointQueries.push(text);
      if (text.startsWith('SAVEPOINT ')) {
        activeSp = text;
        return [[]];
      }
      if (text.startsWith('ROLLBACK TO SAVEPOINT ')) {
        txAborted = false;
        return [[]];
      }
      if (text.startsWith('RELEASE SAVEPOINT ')) {
        activeSp = null;
        return [[]];
      }
      return [[]];
    },
  };

  const origGetRepo = db.getRepository.bind(db);
  let failChatterFindOnce = true;
  db.getRepository = (name) => {
    const repo = origGetRepo(name);
    if (name === 'latticeRecordChatter') {
      return {
        ...repo,
        find: async (opts) => {
          chatterFindTxs.push(opts?.transaction || null);
          if (failChatterFindOnce) {
            failChatterFindOnce = false;
            txAborted = true;
            throw Object.assign(new Error('simulated chatter lookup error'), { code: '42P01' });
          }
          if (txAborted) throw Object.assign(new Error('25P02 aborted'), { code: '25P02' });
          return repo.find(opts);
        },
        create: async (opts) => {
          chatterCreateTxs.push(opts?.transaction || null);
          if (txAborted) throw Object.assign(new Error('25P02 aborted'), { code: '25P02' });
          return repo.create(opts);
        },
      };
    }
    return repo;
  };

  let fetchSawOpenTx = null;
  try {
    process.env.DX_PG_RLS_SESSION = 'true';
    const report = await evaluateSlaBreaches(db, {
      organizationId: 'org-a',
      now: new Date(),
      env: { DX_NOTIFICATION_WEBHOOK_URL: 'https://hooks.example.com/sla-tx-test' },
      fetchImpl: async () => {
        fetchSawOpenTx = openTxCount;
        return { ok: true, status: 200, body: { cancel: async () => {} } };
      },
    });
    assert.equal(report.breachedCount, 1);
    assert.equal(report.escalatedCount, 1);
    assert.equal(fetchSawOpenTx, 0, 'DB transaction must NOT be open during outbound HTTP fetch');
    assert.equal(chatterFindTxs.length, 1);
    assert.ok(chatterFindTxs[0], 'hasRecentSlaChatter must receive explicit transaction');
    assert.equal(chatterCreateTxs.length, 1);
    assert.ok(chatterCreateTxs[0], 'recordChatterEntry must receive explicit transaction after savepoint rollback');
    assert.ok(savepointQueries.some((q) => q.startsWith('ROLLBACK TO SAVEPOINT ')));
    assert.equal(tables.latticeRecordChatter.length, 1);
  } finally {
    if (prevFlag === undefined) delete process.env.DX_PG_RLS_SESSION;
    else process.env.DX_PG_RLS_SESSION = prevFlag;
  }
});

test('Task 16: Notification Bell supports /v/mobile, Topbar variant, authenticated fetch SSE updates/reconnect/cleanup, and server pub/sub bridge', async () => {
  const {
    isVisibleBellPath,
    resolveBellPortalSlug,
    createTopbarNotificationBell,
    createNotificationBellProvider,
  } = require('../src/client/notification-bell');
  const { dispatchNotification } = require('../src/server/notification-center');

  // 1. Visibility & portal slug resolution for /v/mobile and /mobile
  for (const p of ['/v/mobile', '/v/mobile/outbox', '/mobile', '/mobile/field', '/p/logistics', '/admin/lattice-workspace']) {
    assert.equal(isVisibleBellPath(p), true, `Expected bell visible on ${p}`);
  }
  for (const p of ['', '/', '/signin', '/signin/oidc', '/signup']) {
    assert.equal(isVisibleBellPath(p), false, `Expected bell hidden on ${p}`);
  }
  assert.equal(resolveBellPortalSlug('/v/mobile/outbox'), 'mobile');
  assert.equal(resolveBellPortalSlug('/mobile'), 'mobile');
  assert.equal(resolveBellPortalSlug('/p/incidents/case-1'), 'incidents');
  assert.equal(resolveBellPortalSlug('/admin/lattice-workspace'), 'admin');

  // 2. Topbar Bell renders inline variant, subscribes via authenticated fetch() SSE, updates badge, and aborts on unmount
  const prevWindow = globalThis.window;
  const prevDocument = globalThis.document;
  const prevFetch = globalThis.fetch;
  try {
    const encoder = new TextEncoder();
    const fetchCalls = [];
    let pushChunk = null;
    let closeStream = null;

    globalThis.fetch = async (url, init) => {
      const controller = {
        aborted: false,
        signal: init?.signal || null,
      };
      init?.signal?.addEventListener?.('abort', () => {
        controller.aborted = true;
        closeStream?.();
      });
      fetchCalls.push({ url, init, controller });
      const pendingChunks = [
        'event: snapshot\ndata: {"portalSlug":"incidents","revision":1}\n\n',
      ];
      let waitingResolve = null;
      let closed = false;
      pushChunk = (raw) => {
        if (closed) return;
        if (waitingResolve) {
          const r = waitingResolve;
          waitingResolve = null;
          r({ done: false, value: encoder.encode(raw) });
        } else {
          pendingChunks.push(raw);
        }
      };
      closeStream = () => {
        closed = true;
        if (waitingResolve) {
          const r = waitingResolve;
          waitingResolve = null;
          r({ done: true });
        }
      };
      return {
        ok: true,
        status: 200,
        body: {
          getReader: () => ({
            read: async () => {
              if (pendingChunks.length) {
                return { done: false, value: encoder.encode(pendingChunks.shift()) };
              }
              if (closed) return { done: true };
              return new Promise((resolve) => {
                waitingResolve = resolve;
              });
            },
            cancel: async () => {
              closeStream();
            },
          }),
        },
      };
    };

    globalThis.window = {
      location: { pathname: '/v/mobile', assign() {} },
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
      addEventListener() {},
      removeEventListener() {},
    };
    globalThis.document = {
      visibilityState: 'visible',
      addEventListener() {},
      removeEventListener() {},
    };

    let cursor = 0;
    const state = [];
    const effects = [];
    const cleanups = [];
    const React = {
      Fragment: 'Fragment',
      createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
      useState(init) {
        const idx = cursor++;
        if (!(idx in state)) state[idx] = typeof init === 'function' ? init() : init;
        return [state[idx], (v) => { state[idx] = typeof v === 'function' ? v(state[idx]) : v; }];
      },
      useEffect(fn, deps) {
        const idx = cursor++;
        const prev = state[idx];
        if (!prev || !deps || deps.some((d, i) => d !== prev.deps[i])) {
          state[idx] = { deps };
          effects.push({ idx, fn });
        }
      },
      useCallback: (fn) => fn,
      useMemo: (fn) => fn(),
      useRef: (init) => {
        const idx = cursor++;
        return state[idx] ?? (state[idx] = { current: init });
      },
    };

    let serverUnread = 2;
    let unreadCalls = 0;
    const api = {
      auth: { role: 'ldx_driver', getToken: () => 'tok-mobile' },
      request: async ({ url }) => {
        if (url === 'latticeNotifications:unreadCount') {
          unreadCalls += 1;
          return { data: { data: { unreadCount: serverUnread } } };
        }
        return { data: { data: { items: [], unreadCount: serverUnread } } };
      },
    };

    const TopbarBell = createTopbarNotificationBell({ useAPIClient: () => api }, React, {}, {});
    const find = (node, pred) => {
      if (!node || typeof node !== 'object') return null;
      if (pred(node)) return node;
      if (typeof node.type === 'function') return find(node.type(node.props), pred);
      return node.children?.flat(Infinity).map((c) => find(c, pred)).find(Boolean) || null;
    };
    const renderTopbar = (props) => {
      cursor = 0;
      const ui = TopbarBell(props);
      while (effects.length) {
        const { fn } = effects.shift();
        const cleanup = fn();
        if (typeof cleanup === 'function') cleanups.push(cleanup);
      }
      return ui;
    };

    let ui = renderTopbar({ variant: 'topbar', pathname: '/p/incidents' });
    await new Promise((r) => setTimeout(r, 15));
    ui = renderTopbar({ variant: 'topbar', pathname: '/p/incidents' });

    const wrap = find(ui, (n) => n.props?.['data-testid'] === 'ldx-notification-bell-wrap');
    assert.ok(wrap);
    assert.equal(wrap.props['data-variant'], 'topbar');
    assert.equal(wrap.props.style.position, 'relative');
    assert.equal(wrap.props.style.height, 46);
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].url, '/api/dxosAi:surfaceEvents?portalSlug=incidents');
    assert.equal(fetchCalls[0].init.headers.Authorization, 'Bearer tok-mobile');
    assert.equal(fetchCalls[0].init.headers.Accept, 'text/event-stream');
    assert.equal(find(ui, (n) => n.props?.['data-testid'] === 'ldx-notification-badge').children[0], '2');

    // Direct unreadCount SSE update on 'unread_count'
    pushChunk('event: unread_count\ndata: {"unreadCount":5}\n\n');
    await new Promise((r) => setTimeout(r, 15));
    ui = renderTopbar({ variant: 'topbar', pathname: '/p/incidents' });
    assert.equal(find(ui, (n) => n.props?.['data-testid'] === 'ldx-notification-badge').children[0], '5');

    // 'update' frame emitted by surface-events.js with type: 'notification' triggers unreadCount refresh
    serverUnread = 9;
    const beforeUpdateCalls = unreadCalls;
    pushChunk('event: update\ndata: {"kind":"notification","type":"notification","portalSlug":"incidents"}\n\n');
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(unreadCalls, beforeUpdateCalls + 1);
    ui = renderTopbar({ variant: 'topbar', pathname: '/p/incidents' });
    assert.equal(find(ui, (n) => n.props?.['data-testid'] === 'ldx-notification-badge').children[0], '9');

    // Unmount aborts active SSE fetch stream cleanly
    while (cleanups.length) cleanups.pop()();
    assert.equal(fetchCalls[0].controller.aborted, true);

    // Floating provider suppresses duplicate desktop pill when hasTopbar: true, but still renders on /v/mobile
    state.length = 0;
    const FloatingWithTopbar = createNotificationBellProvider({ useAPIClient: () => api }, React, {}, {}, { hasTopbar: true });
    cursor = 0;
    globalThis.window.location.pathname = '/p/incidents';
    const suppressedDesktop = FloatingWithTopbar({ children: React.createElement('div', null, 'app') });
    assert.equal(find(suppressedDesktop, (n) => n.props?.['data-testid'] === 'ldx-notification-bell-wrap'), null);

    state.length = 0;
    cursor = 0;
    globalThis.window.location.pathname = '/v/mobile';
    const mobileFallback = FloatingWithTopbar({ children: React.createElement('div', null, 'mobile') });
    while (effects.length) {
      const { fn } = effects.shift();
      const cleanup = fn();
      if (typeof cleanup === 'function') cleanups.push(cleanup);
    }
    const mobileWrap = find(mobileFallback, (n) => n.props?.['data-testid'] === 'ldx-notification-bell-wrap');
    assert.ok(mobileWrap, 'Floating bell fallback must remain visible on /v/mobile');
    while (cleanups.length) cleanups.pop()();
  } finally {
    if (prevWindow === undefined) delete globalThis.window;
    else globalThis.window = prevWindow;
    if (prevDocument === undefined) delete globalThis.document;
    else globalThis.document = prevDocument;
    if (prevFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = prevFetch;
  }

  // 3. Server dispatchNotification publishes to 'latticedx:surface-updates'
  const published = [];
  const { db } = makeEnterpriseHarness();
  const mockApp = {
    pubSubManager: {
      publish: async (channel, msg) => {
        published.push({ channel, msg });
      },
    },
  };
  const created = await dispatchNotification(db, {
    organizationId: 'org-a',
    recipientUserId: 101,
    category: 'sla',
    severity: 'high',
    title: 'SLA Warning',
    targetCollection: 'latticeIncidentCases',
    dedupKey: 'task16-sse-bridge-1',
  }, { app: mockApp });
  assert.equal(created.deduplicated, false);
  assert.equal(published.length, 1);
  assert.equal(published[0].channel, 'latticedx:surface-updates');
  assert.equal(published[0].msg.kind, 'notification');
  assert.equal(published[0].msg.type, 'notification');
  assert.equal(published[0].msg.portalSlug, 'incidents');
  assert.equal(published[0].msg.organizationId, 'org-a');
  assert.equal(published[0].msg.recipientUserId, 101);
  assert.equal(published[0].msg.category, 'sla');
  assert.equal(published[0].msg.severity, 'high');

  // Deduplicated call does not emit duplicate pub/sub event
  const deduped = await dispatchNotification(db, {
    organizationId: 'org-a',
    recipientUserId: 101,
    category: 'sla',
    severity: 'high',
    title: 'SLA Warning',
    targetCollection: 'latticeIncidentCases',
    dedupKey: 'task16-sse-bridge-1',
  }, { app: mockApp });
  assert.equal(deduped.deduplicated, true);
  assert.equal(published.length, 1);
});

test('Task 4 (Review Focus #1): Notification Bell skips /api/dxosAi:surfaceEvents completely when NOCOBASE_TOKEN is empty and aborts reconnect on 401', async () => {
  const { createTopbarNotificationBell, isAuthenticatedClient } = require('../src/client/notification-bell');
  const prevWindow = globalThis.window;
  const prevDocument = globalThis.document;
  const prevFetch = globalThis.fetch;
  const prevStorage = globalThis.localStorage;
  try {
    const fetchCalls = [];
    globalThis.fetch = async (url, init) => {
      fetchCalls.push({ url, init });
      return { ok: false, status: 401, body: null };
    };
    globalThis.localStorage = { getItem: () => '' };
    globalThis.window = {
      location: { pathname: '/p/incidents', assign() {} },
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
      addEventListener() {},
      removeEventListener() {},
    };
    globalThis.document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };

    let apiCalls = 0;
    const unauthApi = {
      auth: { role: 'ldx_driver', getToken: () => '' },
      request: async () => { apiCalls += 1; return { data: {} }; },
    };
    assert.equal(isAuthenticatedClient(unauthApi), false, 'Unauthenticated client without token must return false even if role is set');

    let cursor = 0;
    const state = [];
    const effects = [];
    const cleanups = [];
    const React = {
      Fragment: 'Fragment',
      createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
      useState(init) {
        const idx = cursor++;
        if (!(idx in state)) state[idx] = typeof init === 'function' ? init() : init;
        return [state[idx], (v) => { state[idx] = typeof v === 'function' ? v(state[idx]) : v; }];
      },
      useEffect(fn, deps) {
        const idx = cursor++;
        const prev = state[idx];
        if (!prev || !deps || deps.some((d, i) => d !== prev.deps[i])) {
          state[idx] = { deps };
          effects.push({ idx, fn });
        }
      },
      useCallback: (fn) => fn,
      useMemo: (fn) => fn(),
      useRef: (init) => {
        const idx = cursor++;
        return state[idx] ?? (state[idx] = { current: init });
      },
    };

    const TopbarBell = createTopbarNotificationBell({ useAPIClient: () => unauthApi }, React, {}, {});
    cursor = 0;
    const ui = TopbarBell({ variant: 'topbar', pathname: '/p/incidents' });
    while (effects.length) {
      const cln = effects.shift().fn();
      if (typeof cln === 'function') cleanups.push(cln);
    }
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(ui, null);
    assert.equal(fetchCalls.length, 0, 'Unauthenticated Bell must make ZERO fetch SSE calls');
    assert.equal(apiCalls, 0, 'Unauthenticated Bell must make ZERO API calls');
    while (cleanups.length) cleanups.pop()();

    // Token present but server returns 401 -> stops without retry spam
    state.length = 0;
    const expiredApi = {
      auth: { role: 'ldx_driver', getToken: () => 'expired-tok' },
      request: async () => ({ data: { data: { unreadCount: 0 } } }),
    };
    const ExpiredBell = createTopbarNotificationBell({ useAPIClient: () => expiredApi }, React, {}, {});
    cursor = 0;
    ExpiredBell({ variant: 'topbar', pathname: '/p/incidents' });
    while (effects.length) {
      const cln = effects.shift().fn();
      if (typeof cln === 'function') cleanups.push(cln);
    }
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].init.headers.Authorization, 'Bearer expired-tok');
    while (cleanups.length) cleanups.pop()();
  } finally {
    if (prevWindow === undefined) delete globalThis.window; else globalThis.window = prevWindow;
    if (prevDocument === undefined) delete globalThis.document; else globalThis.document = prevDocument;
    if (prevFetch === undefined) delete globalThis.fetch; else globalThis.fetch = prevFetch;
    if (prevStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = prevStorage;
  }
});

test('SSE Hub pools 1 stream per portalSlug, ignores AbortError on unmount, and bell guards against duplicate DOM mount', async () => {
  const { createTopbarNotificationBell } = require('../src/client/notification-bell');
  const { subscribeSurfaceEvents, isAbortError } = require('../src/client/sse-hub');

  assert.equal(isAbortError(Object.assign(new Error('BodyStreamBuffer was aborted'), { name: 'AbortError' })), true);

  const prevWindow = globalThis.window;
  const prevDocument = globalThis.document;
  const prevFetch = globalThis.fetch;
  try {
    const fetchCalls = [];
    const rejectHandlers = [];
    const mockWin = {
      location: { pathname: '/p/logistics', assign() {} },
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
      addEventListener() {},
      removeEventListener() {},
    };
    globalThis.window = mockWin;

    // 1. Two subscribers on same portalSlug open ONLY 1 fetch SSE stream and cancel rejects with AbortError silently
    let abortRejectFn = null;
    const mockFetch = async (url, init) => {
      fetchCalls.push({ url, init });
      return {
        ok: true,
        status: 200,
        body: {
          getReader: () => ({
            read: () => new Promise((_, reject) => {
              abortRejectFn = reject;
              init?.signal?.addEventListener?.('abort', () => {
                reject(Object.assign(new Error('BodyStreamBuffer was aborted'), { name: 'AbortError' }));
              });
            }),
            cancel: async () => {
              throw Object.assign(new Error('BodyStreamBuffer was aborted'), { name: 'AbortError' });
            },
          }),
        },
      };
    };

    const eventsA = [];
    const eventsB = [];
    const unsubA = subscribeSurfaceEvents({
      portalSlug: 'logistics',
      sseUrl: '/api/dxosAi:surfaceEvents?portalSlug=logistics',
      token: 'tok-pool-1',
      fetchFn: mockFetch,
      win: mockWin,
      onEvent: (e, d) => eventsA.push({ e, d }),
    });
    const unsubB = subscribeSurfaceEvents({
      portalSlug: 'logistics',
      sseUrl: '/api/dxosAi:surfaceEvents?portalSlug=logistics',
      token: 'tok-pool-1',
      fetchFn: mockFetch,
      win: mockWin,
      onEvent: (e, d) => eventsB.push({ e, d }),
    });

    await new Promise((r) => setTimeout(r, 15));
    assert.equal(fetchCalls.length, 1, 'Shared SSE hub must open at most 1 stream per portalSlug');
    assert.ok(mockWin.__LATTICEDX_SSE_HUB__);

    unsubA();
    assert.equal(fetchCalls[0].init.signal.aborted, false, 'Stream stays open while 2nd subscriber remains');
    unsubB();
    assert.equal(fetchCalls[0].init.signal.aborted, true, 'Last unsubscribe aborts stream cleanly without unhandled rejection');
    await new Promise((r) => setTimeout(r, 15));

    // 2. Duplicate bell guard suppresses rendering & SSE when [data-latticedx-notification-bell] is already in DOM
    globalThis.fetch = mockFetch;
    globalThis.document = {
      visibilityState: 'visible',
      addEventListener() {},
      removeEventListener() {},
      querySelectorAll(sel) {
        if (sel === '[data-latticedx-notification-bell]') {
          return [{ getAttribute: (k) => (k === 'data-ldx-bell-instance' ? 'existing-host-bell' : 'topbar') }];
        }
        return [];
      },
    };
    const api = {
      auth: { role: 'ldx_manager', getToken: () => 'tok-dup-check' },
      request: async () => ({ data: { data: { unreadCount: 1 } } }),
    };
    let cursor = 0;
    const state = [];
    const effects = [];
    const React = {
      Fragment: 'Fragment',
      createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
      useState(init) {
        const idx = cursor++;
        if (!(idx in state)) state[idx] = typeof init === 'function' ? init() : init;
        return [state[idx], (v) => { state[idx] = typeof v === 'function' ? v(state[idx]) : v; }];
      },
      useEffect(fn, deps) {
        const idx = cursor++;
        const prev = state[idx];
        if (!prev || !deps || deps.some((d, i) => d !== prev.deps[i])) {
          state[idx] = { deps };
          effects.push({ idx, fn });
        }
      },
      useCallback: (fn) => fn,
      useMemo: (fn) => fn(),
      useRef: (init) => {
        const idx = cursor++;
        return state[idx] ?? (state[idx] = { current: init });
      },
    };
    const DupBell = createTopbarNotificationBell({ useAPIClient: () => api }, React, {}, {});
    const fetchCountBeforeDup = fetchCalls.length;
    const dupUi = DupBell({ variant: 'topbar', pathname: '/p/logistics' });
    while (effects.length) effects.shift().fn();
    assert.equal(dupUi, null, 'Duplicate notification bell must suppress itself when existing bell is present');
    assert.equal(fetchCalls.length, fetchCountBeforeDup, 'Suppressed duplicate bell must NOT open SSE');
    void rejectHandlers;
    void abortRejectFn;
  } finally {
    if (prevWindow === undefined) delete globalThis.window; else globalThis.window = prevWindow;
    if (prevDocument === undefined) delete globalThis.document; else globalThis.document = prevDocument;
    if (prevFetch === undefined) delete globalThis.fetch; else globalThis.fetch = prevFetch;
  }
});

test('notification-center integrates omnichannel Vault adapter (channelConfig + no duplicate webhook + skipOmnichannel)', async () => {
  const { dispatchNotification } = require('../src/server/notification-center');
  const { encryptVaultSecrets } = require('../src/server/connector-vault');
  const { registerOmnichannelNotify } = require('../src/server/omnichannel-notify');

  const prevMaster = process.env.DX_VAULT_MASTER_KEY;
  process.env.DX_VAULT_MASTER_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  try {
    const encryptedWebhook = encryptVaultSecrets({
      webhookUrl: 'https://hooks.example.test/vault-notify',
      signingSecret: 'whsec_test_123',
    });

    const { db, tables } = makeEnterpriseHarness();
    tables.latticeConnectors = [
      {
        id: 1,
        organizationId: 'org-a',
        connectorKey: 'wh-ops',
        connectorType: 'webhook',
        name: 'Ops Webhook',
        baseUrl: 'https://hooks.example.test/vault-notify',
        secretsEncrypted: encryptedWebhook,
        active: true,
      },
    ];
    tables.latticeNotificationDeliveries = [];
    const origGetRepo = db.getRepository.bind(db);
    let deliverySeq = 0;
    db.getRepository = (name) => {
      if (name === 'latticeConnectors' || name === 'latticeNotificationDeliveries') {
        return {
          find: async ({ filter } = {}) => tables[name].filter((r) => (!filter?.organizationId || r.organizationId === filter.organizationId)).map((r) => ({ ...r, get: (k) => r[k] })),
          findOne: async ({ filter } = {}) => {
            const found = tables[name].find((r) => Object.entries(filter || {}).every(([k, v]) => r[k] === v));
            return found ? { ...found, get: (k) => found[k] } : null;
          },
          create: async ({ values }) => {
            deliverySeq += 1;
            const row = { id: deliverySeq, ...values };
            tables[name].push(row);
            return { ...row, get: (k) => row[k], update: async (patch) => Object.assign(row, patch) };
          },
          update: async ({ filterByTk, values }) => {
            const row = tables[name].find((r) => r.id === filterByTk);
            if (row) Object.assign(row, values);
            return row ? [row] : [];
          },
        };
      }
      return origGetRepo(name);
    };

    const mockApp = {
      db,
      resourceManager: { use: () => {}, define: () => {} },
      acl: { allow: () => {} },
    };
    registerOmnichannelNotify(mockApp);

    const calls = [];
    const mockFetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return { ok: true, status: 200, text: async () => 'ok', body: { cancel: async () => {} } };
    };

    // 1. Singular channelConfig (like notify.send flow node) dispatches via Vault and avoids duplicate env webhook
    const res1 = await dispatchNotification(db, {
      organizationId: 'org-a',
      recipientUserId: 101,
      title: 'Vault Alert',
      body: 'Something happened',
      notifyChannels: ['webhook'],
      channelConfig: { connectorKey: 'wh-ops' },
      templateKey: 'incident_alert',
      dedupKey: 'vault-int-1',
    }, {
      app: mockApp,
      fetchImpl: mockFetch,
      env: { DX_NOTIFICATION_WEBHOOK_URL: 'https://hooks.example.test/env-fallback' },
    });

    assert.deepEqual(res1.channelsDispatched, ['in_app', 'webhook']);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://hooks.example.test/vault-notify');
    assert.equal(tables.latticeNotificationDeliveries.length, 1);
    assert.equal(tables.latticeNotificationDeliveries[0].templateKey, 'incident_alert');

    // 2. skipOmnichannel: true skips Vault adapter completely
    const res2 = await dispatchNotification(db, {
      organizationId: 'org-a',
      recipientUserId: 101,
      title: 'Skip Omni',
      notifyChannels: ['webhook'],
      skipOmnichannel: true,
      dedupKey: 'vault-int-2',
    }, {
      app: mockApp,
      fetchImpl: mockFetch,
      env: {},
    });
    assert.deepEqual(res2.channelsDispatched, ['in_app']);
    assert.equal(calls.length, 1);
    assert.equal(tables.latticeNotificationDeliveries.length, 1);
  } finally {
    if (prevMaster === undefined) delete process.env.DX_VAULT_MASTER_KEY;
    else process.env.DX_VAULT_MASTER_KEY = prevMaster;
  }
});

test('sla-engine aggregates evaluateApprovalSlas when latticeApprovalRequests repo exists and guards cron re-entrancy', async () => {
  const { evaluateSlaBreaches, registerSlaEngine } = require('../src/server/sla-engine');
  const now = new Date('2026-11-25T15:00:00.000Z');
  const { db, tables } = makeEnterpriseHarness({
    serviceTickets: [
      { id: 1, organizationId: 'org-a', code: 'TKT-1', name: 'Open Ticket', status: 'open', priority: 'high', createdAt: '2026-11-25T12:00:00.000Z' },
    ],
  });
  tables.latticeApprovalRequests = [
    {
      id: 10,
      organizationId: 'org-a',
      requestUid: 'apr-sla-1',
      targetCollection: 'latticeOrders',
      targetRecordId: 55,
      title: 'Overdue PO Approval',
      status: 'pending',
      currentStageIndex: 0,
      dueAt: '2026-11-25T13:00:00.000Z',
      stagesStateJson: [{
        name: 'Manager',
        mode: 'sequential',
        requiredApprovals: 1,
        approverRoles: ['ldx_manager'],
        escalateToRole: 'ldx_manager',
        dueAt: '2026-11-25T13:00:00.000Z',
        status: 'pending',
        decisions: [],
      }],
      payloadJson: {},
      active: true,
    },
  ];
  const origGetRepo = db.getRepository.bind(db);
  db.getRepository = (name) => {
    if (name === 'latticeApprovalRequests') {
      return {
        find: async ({ filter } = {}) => tables.latticeApprovalRequests
          .filter((r) => (!filter?.organizationId || r.organizationId === filter.organizationId))
          .map((r) => ({ ...r, get: (k) => r[k], update: async (patch) => Object.assign(r, patch) })),
        update: async ({ filterByTk, values }) => {
          const row = tables.latticeApprovalRequests.find((r) => r.id === filterByTk);
          if (row) Object.assign(row, values);
          return row ? [row] : [];
        },
      };
    }
    return origGetRepo(name);
  };

  const report = await evaluateSlaBreaches(db, { organizationId: 'org-a', now, dryRun: false });
  assert.equal(report.scanned, 2);
  assert.equal(report.breachedCount, 2);
  assert.equal(report.escalatedCount, 2);
  assert.ok(report.approvalSlas);
  assert.equal(report.approvalSlas.breachedCount, 1);
  const approvalItem = report.items.find((i) => i.collection === 'latticeApprovalRequests' && i.requestUid === 'apr-sla-1');
  assert.ok(approvalItem);
  assert.equal(approvalItem.status, 'breached');
  assert.equal(approvalItem.slaState, 'breached');

  // Cron re-entrancy guard prevents overlapping ticks
  const prevCron = process.env.DX_SLA_CRON_ENABLED;
  process.env.DX_SLA_CRON_ENABLED = 'true';
  try {
    let addedJob = null;
    let releaseFind;
    const slowGate = new Promise((resolve) => { releaseFind = resolve; });
    let findCalls = 0;
    const slowDb = {
      ...db,
      getRepository: (name) => {
        const repo = db.getRepository(name);
        if (name !== 'latticeSlaPolicies') return repo;
        return {
          ...repo,
          find: async (opts) => {
            findCalls += 1;
            await slowGate;
            return repo.find(opts);
          },
        };
      },
    };
    const cronApp = {
      db: slowDb,
      resourceManager: { define: () => {} },
      acl: { allow: () => {} },
      cronJobManager: { addJob: (job) => { addedJob = job; } },
      logger: { error: () => {} },
    };
    registerSlaEngine(cronApp);
    assert.ok(addedJob && typeof addedJob.onTick === 'function');
    const tick1 = addedJob.onTick();
    const tick2 = addedJob.onTick();
    releaseFind();
    await Promise.all([tick1, tick2]);
    assert.equal(findCalls, 1, 'Overlapping SLA cron tick must be skipped while previous tick is in flight');
  } finally {
    if (prevCron === undefined) delete process.env.DX_SLA_CRON_ENABLED;
    else process.env.DX_SLA_CRON_ENABLED = prevCron;
  }
});

test('notification-center deduplicates channel aliases (partner_webhook/webhook, email_smtp/smtp) without double-dispatch', async () => {
  const {
    dispatchNotification,
    dispatchRoleNotifications,
    normalizeNotificationChannelConfigs,
  } = require('../src/server/notification-center');
  const { encryptVaultSecrets } = require('../src/server/connector-vault');
  const { registerOmnichannelNotify } = require('../src/server/omnichannel-notify');

  // 1. Unit check on normalizeNotificationChannelConfigs alias normalization & deduplication
  const webhookCfg = normalizeNotificationChannelConfigs(
    ['partner_webhook', 'webhook'],
    { channel: 'webhook', url: 'https://hooks.example.test/alias-hook' },
    null,
    'tpl_alias',
  );
  assert.equal(webhookCfg.length, 1);
  assert.deepEqual(webhookCfg[0], {
    channel: 'webhook',
    url: 'https://hooks.example.test/alias-hook',
    templateKey: 'tpl_alias',
  });

  const smtpCfg = normalizeNotificationChannelConfigs(
    ['email_smtp', 'smtp_notify', 'email'],
    { channel: 'smtp', to: 'ops@example.test' },
    null,
    'tpl_smtp',
  );
  assert.equal(smtpCfg.length, 1);
  assert.deepEqual(smtpCfg[0], {
    channel: 'smtp',
    to: 'ops@example.test',
    templateKey: 'tpl_smtp',
  });

  const multiCfg = normalizeNotificationChannelConfigs(
    ['webhook', 'partner_webhook', 'email_smtp'],
    { connectorKey: 'wh-ops' },
    null,
    'tpl_multi',
  );
  assert.deepEqual(multiCfg, [
    { connectorKey: 'wh-ops', templateKey: 'tpl_multi', channel: 'webhook' },
    { connectorKey: 'wh-ops', templateKey: 'tpl_multi', channel: 'smtp' },
  ]);

  // 2. End-to-end dispatchNotification & dispatchRoleNotifications with aliases
  const prevMaster = process.env.DX_VAULT_MASTER_KEY;
  process.env.DX_VAULT_MASTER_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  try {
    const encryptedWebhook = encryptVaultSecrets({
      webhookUrl: 'https://hooks.example.test/vault-alias',
      signingSecret: 'whsec_alias_123',
    });
    const encryptedSmtp = encryptVaultSecrets({
      host: 'smtp.example.test',
      port: 587,
      username: 'alerts@example.test',
      password: 'smtp-secret-value',
      fromEmail: 'alerts@example.test',
      defaultTo: 'ops@example.test',
    });

    const { db, tables } = makeEnterpriseHarness();
    tables.latticeConnectors = [
      {
        id: 1,
        organizationId: 'org-a',
        connectorKey: 'wh-ops',
        connectorType: 'webhook',
        appType: 'partner_webhook',
        name: 'Ops Webhook',
        baseUrl: 'https://hooks.example.test/vault-alias',
        secretsEncrypted: encryptedWebhook,
        active: true,
      },
      {
        id: 2,
        organizationId: 'org-a',
        connectorKey: 'smtp-ops',
        connectorType: 'smtp_notify',
        appType: 'email_smtp',
        name: 'Ops SMTP',
        baseUrl: 'smtp://smtp.example.test:587',
        secretsEncrypted: encryptedSmtp,
        active: true,
      },
    ];
    tables.latticeNotificationDeliveries = [];
    const origGetRepo = db.getRepository.bind(db);
    let deliverySeq = 0;
    db.getRepository = (name) => {
      if (name === 'latticeConnectors' || name === 'latticeNotificationDeliveries') {
        return {
          find: async ({ filter } = {}) => tables[name]
            .filter((r) => (!filter?.organizationId || r.organizationId === filter.organizationId))
            .map((r) => ({ ...r, get: (k) => r[k] })),
          findOne: async ({ filter } = {}) => {
            const found = tables[name].find((r) => Object.entries(filter || {}).every(([k, v]) => r[k] === v));
            return found ? { ...found, get: (k) => found[k] } : null;
          },
          create: async ({ values }) => {
            deliverySeq += 1;
            const row = { id: deliverySeq, ...values };
            tables[name].push(row);
            return { ...row, get: (k) => row[k], update: async (patch) => Object.assign(row, patch) };
          },
          update: async ({ filterByTk, values }) => {
            const row = tables[name].find((r) => r.id === filterByTk);
            if (row) Object.assign(row, values);
            return row ? [row] : [];
          },
        };
      }
      return origGetRepo(name);
    };

    const mockApp = {
      db,
      resourceManager: { use: () => {}, define: () => {} },
      acl: { allow: () => {} },
    };
    registerOmnichannelNotify(mockApp);

    const fetchCalls = [];
    const mockFetch = async (url, init) => {
      fetchCalls.push({ url: String(url), init });
      return { ok: true, status: 200, text: async () => 'ok', body: { cancel: async () => {} } };
    };
    const dnsLookup = async () => [{ address: '93.184.216.34', family: 4 }];

    // 2a. notifyChannels: ['partner_webhook'] + channelConfig: { channel: 'webhook', ... } -> exactly 1 webhook
    const whRes = await dispatchNotification(db, {
      organizationId: 'org-a',
      recipientUserId: 101,
      title: 'Partner Webhook Alias',
      notifyChannels: ['partner_webhook'],
      channelConfig: { channel: 'webhook', url: 'https://hooks.example.test/explicit-hook' },
      templateKey: 'tpl_wh',
      dedupKey: 'alias-wh-1',
    }, {
      app: mockApp,
      fetchImpl: mockFetch,
      lookupImpl: dnsLookup,
      env: { DX_NOTIFICATION_WEBHOOK_URL: 'https://hooks.example.test/env-fallback' },
    });
    assert.deepEqual(whRes.channelsDispatched, ['in_app', 'webhook']);
    assert.equal(fetchCalls.length, 1, 'Expected exactly 1 webhook delivery for partner_webhook + webhook');
    assert.equal(fetchCalls[0].url, 'https://hooks.example.test/explicit-hook');
    assert.equal(tables.latticeNotificationDeliveries.length, 1);

    // 2b. dispatchRoleNotifications with ['webhook', 'partner_webhook'] (no channelConfig) -> 1 webhook
    const roleRes = await dispatchRoleNotifications(db, {
      organizationId: 'org-a',
      roleNames: ['ldx_manager'],
      title: 'Role Alias Dedup',
      notifyChannels: ['webhook', 'partner_webhook'],
      dedupKey: 'alias-role-wh-1',
    }, {
      app: mockApp,
      fetchImpl: mockFetch,
      lookupImpl: dnsLookup,
      env: { DX_NOTIFICATION_WEBHOOK_URL: 'https://hooks.example.test/env-fallback' },
    });
    assert.equal(roleRes.dispatchedCount, 1);
    assert.equal(fetchCalls.length, 2, 'Expected exactly 1 additional webhook delivery for duplicate alias array');

    // 2c. notifyChannels: ['email_smtp'] + channelConfig: { channel: 'smtp', dryRun: true } -> exactly 1 SMTP delivery
    const smtpRes = await dispatchNotification(db, {
      organizationId: 'org-a',
      recipientUserId: 101,
      title: 'SMTP Alias',
      body: 'Body text',
      notifyChannels: ['email_smtp'],
      channelConfig: { channel: 'smtp', connectorKey: 'smtp-ops', to: 'ops@example.test', dryRun: true },
      templateKey: 'tpl_smtp_1',
      dedupKey: 'alias-smtp-1',
    }, {
      app: mockApp,
      fetchImpl: mockFetch,
      lookupImpl: dnsLookup,
      env: {},
    });
    assert.ok(smtpRes);
    const smtpDeliveries = tables.latticeNotificationDeliveries.filter((d) => d.channel === 'smtp');
    assert.equal(smtpDeliveries.length, 1, 'Expected exactly 1 canonical SMTP delivery for email_smtp + smtp');
    assert.equal(smtpDeliveries[0].status, 'dry_run');
    assert.equal(smtpDeliveries[0].templateKey, 'tpl_smtp_1');
  } finally {
    if (prevMaster === undefined) delete process.env.DX_VAULT_MASTER_KEY;
    else process.env.DX_VAULT_MASTER_KEY = prevMaster;
  }
});
