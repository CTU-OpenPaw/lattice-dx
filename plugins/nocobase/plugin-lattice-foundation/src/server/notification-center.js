/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { resolveNativeActor } = require('./native-scope');
const { callerRoles } = require('./native-portal-helpers');
const { assertSafeConnectorUrl, assertSafeConnectorUrlAsync } = require('./connector-vault');

const VALID_CATEGORIES = new Set(['mention', 'voucher', 'sla', 'alarm', 'approval', 'system']);
const VALID_SEVERITIES = new Set(['info', 'warning', 'high', 'critical']);
const DEDUP_WINDOW_MS = 30 * 60_000;
const EXTERNAL_TIMEOUT_MS = 4500;
const ORG_RE = /^[a-zA-Z0-9_-]{1,80}$/;
const TELEGRAM_TOKEN_RE = /^[0-9]{5,16}:[A-Za-z0-9_-]{20,120}$/;
const TELEGRAM_CHAT_RE = /^-?[0-9a-zA-Z_@.-]{1,64}$/;

const COLLECTION_PORTAL_PATHS = {
  latticeRequests: '/p/procurement',
  latticeAssets: '/p/procurement',
  latticeOrders: '/p/logistics',
  latticeIncidentCases: '/p/incidents',
  latticeServiceTickets: '/p/services',
  latticeParaDocuments: '/p/services',
};

const val = (row, key) => (typeof row?.get === 'function' ? row.get(key) : row?.[key]);

function failNotif(code, status = 400, message = code) {
  return Object.assign(new Error(message), { code, status });
}

function readParams(ctx) {
  const p = ctx.action?.params || {};
  const v = p.values && typeof p.values === 'object' && !Array.isArray(p.values) ? p.values : {};
  return { ...p, ...v };
}

function resolveNotificationTargetPath(targetCollection) {
  const col = String(targetCollection || '').trim();
  return COLLECTION_PORTAL_PATHS[col] || '/admin/lattice-workspace';
}

function isSafeExternalWebhookUrl(rawUrl) {
  try {
    assertSafeConnectorUrl(rawUrl, { connectorType: 'webhook', allowInternal: false });
    return true;
  } catch {
    return false;
  }
}

async function isSafeExternalWebhookUrlAsync(rawUrl, { lookupImpl, skipDnsCheck = false } = {}) {
  try {
    await assertSafeConnectorUrlAsync(rawUrl, {
      connectorType: 'webhook',
      allowInternal: false,
      lookupImpl,
      skipDnsCheck,
    });
    return true;
  } catch {
    return false;
  }
}

async function sendJsonWebhook(fetchImpl, url, payload) {
  if (typeof fetchImpl !== 'function') return false;
  try {
    const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(EXTERNAL_TIMEOUT_MS)
      : undefined;
    const response = await fetchImpl(url, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      ...(signal ? { signal } : {}),
    });
    try { await response?.body?.cancel?.(); } catch {}
    return Boolean(response?.ok);
  } catch {
    return false;
  }
}

function serializeNotification(row) {
  return {
    id: val(row, 'id') ?? null,
    organizationId: val(row, 'organizationId') || null,
    recipientUserId: val(row, 'recipientUserId') != null ? Number(val(row, 'recipientUserId')) : null,
    recipientEmployeeId: val(row, 'recipientEmployeeId') != null ? Number(val(row, 'recipientEmployeeId')) : null,
    category: val(row, 'category') || 'system',
    severity: val(row, 'severity') || 'info',
    title: val(row, 'title') || '',
    body: val(row, 'body') || '',
    targetCollection: val(row, 'targetCollection') || null,
    targetRecordId: val(row, 'targetRecordId') != null ? Number(val(row, 'targetRecordId')) : null,
    targetPath: val(row, 'targetPath') || null,
    dedupKey: val(row, 'dedupKey') || null,
    readAt: val(row, 'readAt') || null,
    channelsDispatched: Array.isArray(val(row, 'channelsDispatched')) ? val(row, 'channelsDispatched') : ['in_app'],
    active: val(row, 'active') !== false,
    createdAt: val(row, 'createdAt') || null,
  };
}

function channelAllowed(notifyChannels, channelName) {
  if (!Array.isArray(notifyChannels) || notifyChannels.length === 0) return true;
  return notifyChannels.includes(channelName) || notifyChannels.includes('all') || notifyChannels.includes('external');
}

async function dispatchExternalChannels({
  env,
  fetchImpl,
  lookupImpl,
  enforceDnsInMock = false,
  notification,
  notifyChannels,
}) {
  if (typeof fetchImpl !== 'function' || !env || typeof env !== 'object') return [];

  const isMockFetch = fetchImpl !== globalThis.fetch;
  const skipDnsCheck = isMockFetch && typeof lookupImpl !== 'function' && !enforceDnsInMock;
  const tasks = [];
  const appriseUrl = String(env.DX_APPRISE_URL || '').trim();
  if (appriseUrl && channelAllowed(notifyChannels, 'apprise') && isSafeExternalWebhookUrl(appriseUrl)) {
    const typeMap = { critical: 'failure', high: 'failure', warning: 'warning', info: 'info' };
    tasks.push((async () => {
      if (!(await isSafeExternalWebhookUrlAsync(appriseUrl, { lookupImpl, skipDnsCheck }))) return null;
      const ok = await sendJsonWebhook(fetchImpl, appriseUrl, {
        title: notification.title,
        body: notification.body || notification.title,
        type: typeMap[notification.severity] || 'info',
        tag: notification.category,
      });
      return ok ? 'apprise' : null;
    })());
  }

  const webhookUrl = String(env.DX_NOTIFICATION_WEBHOOK_URL || '').trim();
  if (webhookUrl && channelAllowed(notifyChannels, 'webhook') && isSafeExternalWebhookUrl(webhookUrl)) {
    tasks.push((async () => {
      if (!(await isSafeExternalWebhookUrlAsync(webhookUrl, { lookupImpl, skipDnsCheck }))) return null;
      const ok = await sendJsonWebhook(fetchImpl, webhookUrl, {
        event: 'lattice.notification',
        id: notification.id,
        organizationId: notification.organizationId,
        recipientUserId: notification.recipientUserId,
        category: notification.category,
        severity: notification.severity,
        title: notification.title,
        body: notification.body,
        targetCollection: notification.targetCollection,
        targetRecordId: notification.targetRecordId,
        targetPath: notification.targetPath,
        createdAt: notification.createdAt,
      });
      return ok ? 'webhook' : null;
    })());
  }

  const tgToken = String(env.DX_TELEGRAM_BOT_TOKEN || '').trim();
  const tgChat = String(env.DX_TELEGRAM_CHAT_ID || '').trim();
  if (tgToken && tgChat && channelAllowed(notifyChannels, 'telegram') && TELEGRAM_TOKEN_RE.test(tgToken) && TELEGRAM_CHAT_RE.test(tgChat)) {
    const tgUrl = `https://api.telegram.org/bot${tgToken}/sendMessage`;
    tasks.push((async () => {
      if (!(await isSafeExternalWebhookUrlAsync(tgUrl, { lookupImpl, skipDnsCheck }))) return null;
      const ok = await sendJsonWebhook(fetchImpl, tgUrl, {
        chat_id: tgChat,
        text: `[${String(notification.severity || 'info').toUpperCase()}] ${notification.title}${notification.body ? `\n${notification.body}` : ''}`,
        disable_web_page_preview: true,
      });
      return ok ? 'telegram' : null;
    })());
  }

  if (!tasks.length) return [];
  const outcomes = await Promise.all(tasks);
  return outcomes.filter(Boolean);
}

async function dispatchNotification(
  db,
  payload = {},
  {
    env = process.env,
    fetchImpl = globalThis.fetch,
    lookupImpl,
    enforceDnsInMock = false,
    transaction = null,
  } = {},
) {
  const organizationId = typeof payload.organizationId === 'string' ? payload.organizationId.trim() : '';
  if (!ORG_RE.test(organizationId)) {
    throw failNotif('NOTIFICATION_ORG_REQUIRED', 400, 'Cần organizationId hợp lệ cho thông báo.');
  }
  const rawUserId = payload.recipientUserId;
  if (rawUserId == null || !/^[1-9]\d*$/.test(String(rawUserId))) {
    throw failNotif('NOTIFICATION_RECIPIENT_REQUIRED', 400, 'Cần recipientUserId hợp lệ cho thông báo.');
  }
  const recipientUserId = Number(rawUserId);
  const title = typeof payload.title === 'string' ? payload.title.trim().slice(0, 255) : '';
  if (!title) {
    throw failNotif('NOTIFICATION_TITLE_REQUIRED', 400, 'Cần tiêu đề thông báo.');
  }

  const repo = db?.getRepository?.('latticeNotifications');
  if (!repo || typeof repo.create !== 'function') return null;

  const dedupKey = typeof payload.dedupKey === 'string' && payload.dedupKey.trim()
    ? payload.dedupKey.trim().slice(0, 255)
    : null;

  if (dedupKey && typeof repo.find === 'function') {
    const cutoffMs = Date.now() - DEDUP_WINDOW_MS;
    const recent = (await repo.find({
      filter: { organizationId, recipientUserId, dedupKey },
      sort: ['-id'],
      limit: 10,
      ...(transaction ? { transaction } : {}),
    })) || [];
    const hit = recent.find((row) => {
      if (val(row, 'organizationId') !== organizationId) return false;
      if (Number(val(row, 'recipientUserId')) !== recipientUserId) return false;
      if (val(row, 'dedupKey') !== dedupKey) return false;
      const createdAtRaw = val(row, 'createdAt');
      const createdMs = createdAtRaw ? new Date(createdAtRaw).getTime() : Date.now();
      return Number.isFinite(createdMs) && createdMs > cutoffMs;
    });
    if (hit) {
      return { ...serializeNotification(hit), deduplicated: true, skipped: true };
    }
  }

  const rawCategory = String(payload.category || 'system').trim().toLowerCase();
  const category = VALID_CATEGORIES.has(rawCategory) ? rawCategory : 'system';
  const rawSeverity = String(payload.severity || 'info').trim().toLowerCase();
  const severity = VALID_SEVERITIES.has(rawSeverity) ? rawSeverity : 'info';
  const recipientEmployeeId = payload.recipientEmployeeId != null && /^[1-9]\d*$/.test(String(payload.recipientEmployeeId))
    ? Number(payload.recipientEmployeeId)
    : null;
  const targetCollection = payload.targetCollection ? String(payload.targetCollection).trim().slice(0, 255) : null;
  const targetRecordId = payload.targetRecordId != null && /^[1-9]\d*$/.test(String(payload.targetRecordId))
    ? Number(payload.targetRecordId)
    : null;
  const targetPath = payload.targetPath
    ? String(payload.targetPath).trim().slice(0, 512)
    : (targetCollection ? resolveNotificationTargetPath(targetCollection) : null);

  const values = {
    organizationId,
    recipientUserId,
    ...(recipientEmployeeId != null ? { recipientEmployeeId } : {}),
    category,
    severity,
    title,
    body: typeof payload.body === 'string' ? payload.body.slice(0, 4000) : '',
    targetCollection,
    ...(targetRecordId != null ? { targetRecordId } : {}),
    targetPath,
    dedupKey,
    readAt: null,
    channelsDispatched: ['in_app'],
    active: true,
  };

  const created = await repo.create({ values, ...(transaction ? { transaction } : {}) });
  const serialized = serializeNotification(created || values);
  const externalChannels = await dispatchExternalChannels({
    env,
    fetchImpl,
    lookupImpl,
    enforceDnsInMock,
    notification: serialized,
    notifyChannels: payload.notifyChannels,
  });

  const channelsDispatched = ['in_app', ...externalChannels];
  if (externalChannels.length > 0) {
    try {
      if (typeof created?.update === 'function') {
        await created.update({ channelsDispatched }, transaction ? { transaction } : undefined);
      } else if (typeof repo.update === 'function' && serialized.id != null) {
        await repo.update({ filterByTk: serialized.id, values: { channelsDispatched }, ...(transaction ? { transaction } : {}) });
      }
    } catch {}
  }

  return { ...serialized, channelsDispatched, deduplicated: false, skipped: false };
}

async function resolveEmployeeUsersForRoles(db, organizationId, roleNames) {
  const empRepo = db?.getRepository?.('latticeEmployees');
  if (!empRepo || typeof empRepo.find !== 'function') return [];
  const targetRoles = new Set(
    (Array.isArray(roleNames) ? roleNames : [roleNames])
      .map((r) => String(r || '').trim())
      .filter(Boolean),
  );
  if (!targetRoles.size) return [];

  const employees = (await empRepo.find({ filter: { organizationId, active: true }, limit: 1000 })) || [];
  const activeWithUser = [];
  for (const emp of employees) {
    if (val(emp, 'active') !== true || val(emp, 'organizationId') !== organizationId) continue;
    const uid = val(emp, 'userId');
    if (uid == null || !/^[1-9]\d*$/.test(String(uid))) continue;
    activeWithUser.push({
      employeeId: Number(val(emp, 'id')),
      userId: Number(uid),
    });
  }
  if (!activeWithUser.length) return [];

  const userIds = [...new Set(activeWithUser.map((e) => e.userId))];
  const allowedUserIds = new Set();
  const ruRepo = db.getRepository?.('rolesUsers');
  if (ruRepo && typeof ruRepo.find === 'function') {
    const bindings = (await ruRepo.find({
      filter: { userId: { $in: userIds }, roleName: { $in: [...targetRoles] } },
      limit: 2000,
    })) || [];
    for (const row of bindings) {
      const uid = Number(val(row, 'userId'));
      const rName = String(val(row, 'roleName') || '').trim();
      if (userIds.includes(uid) && targetRoles.has(rName)) {
        allowedUserIds.add(uid);
      }
    }
  } else {
    const usersRepo = db.getRepository?.('users');
    if (usersRepo && typeof usersRepo.find === 'function') {
      const users = (await usersRepo.find({
        filter: { id: { $in: userIds } },
        appends: ['roles'],
        limit: 1000,
      })) || [];
      for (const u of users) {
        const uid = Number(val(u, 'id'));
        const uRoles = Array.isArray(val(u, 'roles')) ? val(u, 'roles') : [];
        if (uRoles.some((r) => targetRoles.has(typeof r === 'string' ? r : val(r, 'name')))) {
          allowedUserIds.add(uid);
        }
      }
    }
  }

  const seenUsers = new Set();
  const targets = [];
  for (const item of activeWithUser) {
    if (!allowedUserIds.has(item.userId) || seenUsers.has(item.userId)) continue;
    seenUsers.add(item.userId);
    targets.push(item);
  }
  return targets;
}

async function dispatchRoleNotifications(db, { organizationId, roleNames = [], ...rest } = {}, options = {}) {
  if (!ORG_RE.test(String(organizationId || '').trim())) {
    throw failNotif('NOTIFICATION_ORG_REQUIRED', 400, 'Cần organizationId hợp lệ.');
  }
  const targets = await resolveEmployeeUsersForRoles(db, organizationId, roleNames);
  const results = [];
  let dispatchedCount = 0;
  let skippedCount = 0;

  for (const target of targets) {
    const res = await dispatchNotification(db, {
      ...rest,
      organizationId,
      recipientUserId: target.userId,
      recipientEmployeeId: target.employeeId,
    }, options);
    if (res) {
      results.push(res);
      if (res.deduplicated) skippedCount += 1;
      else dispatchedCount += 1;
    }
  }

  return {
    recipientCount: targets.length,
    dispatchedCount,
    skippedCount,
    results,
  };
}

function registerNotificationCenter(app) {
  const db = app.db;

  const DEDICATED_NOTIFICATION_ACTIONS = new Set(['listMine', 'unreadCount', 'markRead', 'markAllRead']);

  // Block non-dedicated collection, association, and chart queries on private notification/SLA tables for non-root roles.
  app.resourceManager?.use?.(async (ctx, next) => {
    if (ctx.state?.currentRole === 'root') return next();
    const fullResource = String(ctx.action?.resourceName || '');
    const baseResource = fullResource.split('.')[0];
    const actionName = ctx.action?.actionName;
    if (baseResource === 'latticeSlaPolicies') {
      throw failNotif('NOTIFICATION_DIRECT_CRUD_FORBIDDEN', 403, 'Vui lòng sử dụng API SLA chuyên dụng.');
    }
    if (baseResource === 'latticeNotifications') {
      if (fullResource !== 'latticeNotifications' || !DEDICATED_NOTIFICATION_ACTIONS.has(actionName)) {
        throw failNotif('NOTIFICATION_DIRECT_CRUD_FORBIDDEN', 403, 'Vui lòng sử dụng API thông báo chuyên dụng.');
      }
    }
    if (
      fullResource === 'charts'
      && actionName === 'queryData'
      && ['latticeNotifications', 'latticeSlaPolicies'].includes(ctx.action?.params?.values?.collection)
    ) {
      throw failNotif('NOTIFICATION_DIRECT_CRUD_FORBIDDEN', 403, 'Vui lòng sử dụng API thông báo chuyên dụng.');
    }
    return next();
  }, { tag: 'latticeNotificationScopeGuard', after: 'acl' });

  const isVerifiedRoot = async (ctx) => {
    const roles = callerRoles(ctx);
    if (!roles.includes('root')) return false;
    const uid = val(ctx?.state?.currentUser, 'id');
    const ruRepo = db?.getRepository?.('rolesUsers');
    if (ruRepo && typeof ruRepo.find === 'function' && uid != null) {
      const bindings = (await ruRepo.find({ filter: { userId: Number(uid) } })) || [];
      return bindings.some((b) => String(val(b, 'roleName') || '').trim() === 'root');
    }
    return true;
  };

  const resolveScopedUser = async (ctx, { allowRootWithoutEmployee = false } = {}) => {
    if (!ctx?.state?.currentUser) throw failNotif('NATIVE_LOGIN_REQUIRED', 401);
    const empRepo = db?.getRepository?.('latticeEmployees');
    if (!empRepo && allowRootWithoutEmployee && (await isVerifiedRoot(ctx))) {
      return {
        organizationId: null,
        userId: Number(val(ctx.state.currentUser, 'id')) || null,
        employeeId: null,
        rootWithoutOrg: true,
      };
    }
    try {
      const actor = await resolveNativeActor(db, ctx.state.currentUser);
      return {
        organizationId: actor.organizationId,
        userId: Number(actor.userId),
        employeeId: actor.employeeId,
        rootWithoutOrg: false,
      };
    } catch (err) {
      if (
        allowRootWithoutEmployee
        && ['NATIVE_EMPLOYEE_NOT_FOUND', 'NATIVE_MEMBERSHIP_REQUIRED', 'NATIVE_MEMBERSHIP_INVALID'].includes(err?.code)
        && (await isVerifiedRoot(ctx))
      ) {
        return {
          organizationId: null,
          userId: Number(val(ctx.state.currentUser, 'id')) || null,
          employeeId: null,
          rootWithoutOrg: true,
        };
      }
      throw err;
    }
  };

  app.resourceManager.define({
    name: 'latticeNotifications',
    actions: {
      listMine: async (ctx, next) => {
        if ((ctx.method || 'GET') !== 'GET') ctx.throw(405);
        const { organizationId, userId, rootWithoutOrg } = await resolveScopedUser(ctx, { allowRootWithoutEmployee: true });
        if (rootWithoutOrg) {
          ctx.body = { organizationId: null, total: 0, unreadCount: 0, items: [] };
          return next();
        }
        const params = readParams(ctx);
        const limit = Math.max(1, Math.min(100, Math.floor(Number(params.limit) || 30)));
        const page = Math.max(1, Math.min(10000, Math.floor(Number(params.page) || 1)));
        const unreadOnly = params.unreadOnly === true || params.unreadOnly === 'true';
        const rawCategory = typeof params.category === 'string' ? params.category.trim().toLowerCase() : '';
        const category = rawCategory && rawCategory !== 'all' && VALID_CATEGORIES.has(rawCategory) ? rawCategory : null;

        const repo = db.getRepository('latticeNotifications');
        if (!repo) {
          ctx.body = { organizationId, total: 0, unreadCount: 0, items: [] };
          return next();
        }
        const baseFilter = { organizationId, recipientUserId: userId, active: true };
        const listFilter = {
          ...baseFilter,
          ...(category ? { category } : {}),
          ...(unreadOnly ? { readAt: null } : {}),
        };
        const rows = (await repo.find({
          filter: listFilter,
          sort: ['-createdAt', '-id'],
          offset: (page - 1) * limit,
          limit,
        })) || [];
        const total = typeof repo.count === 'function' ? await repo.count({ filter: listFilter }) : rows.length;
        const unreadFilter = { ...baseFilter, readAt: null };
        const unreadCount = typeof repo.count === 'function'
          ? await repo.count({ filter: unreadFilter })
          : ((await repo.find({ filter: unreadFilter, limit: 500 })) || []).length;

        ctx.body = {
          organizationId,
          total,
          unreadCount,
          items: rows.map(serializeNotification),
        };
        return next();
      },

      unreadCount: async (ctx, next) => {
        if ((ctx.method || 'GET') !== 'GET') ctx.throw(405);
        const { organizationId, userId, rootWithoutOrg } = await resolveScopedUser(ctx, { allowRootWithoutEmployee: true });
        if (rootWithoutOrg) {
          ctx.body = { organizationId: null, unreadCount: 0 };
          return next();
        }
        const repo = db.getRepository('latticeNotifications');
        if (!repo) {
          ctx.body = { organizationId, unreadCount: 0 };
          return next();
        }
        const filter = { organizationId, recipientUserId: userId, active: true, readAt: null };
        const unreadCount = typeof repo.count === 'function'
          ? await repo.count({ filter })
          : ((await repo.find({ filter, limit: 500 })) || []).length;
        ctx.body = { organizationId, unreadCount };
        return next();
      },

      markRead: async (ctx, next) => {
        if ((ctx.method || 'POST') !== 'POST') ctx.throw(405);
        const { organizationId, userId } = await resolveScopedUser(ctx);
        const params = readParams(ctx);
        const id = Number(params.id ?? params.filterByTk ?? params.notificationId);
        if (!Number.isInteger(id) || id <= 0) {
          throw failNotif('NOTIFICATION_ID_REQUIRED', 400, 'Cần mã thông báo id hợp lệ.');
        }
        const repo = db.getRepository('latticeNotifications');
        if (!repo) throw failNotif('NOTIFICATION_NOT_FOUND', 404, 'Không tìm thấy thông báo.');
        const row = await repo.findOne({ filter: { id, organizationId, recipientUserId: userId } });
        if (!row || val(row, 'organizationId') !== organizationId || Number(val(row, 'recipientUserId')) !== userId) {
          throw failNotif('NOTIFICATION_NOT_FOUND', 404, 'Không tìm thấy thông báo trong phạm vi tài khoản.');
        }
        const now = val(row, 'readAt') || new Date();
        if (!val(row, 'readAt')) {
          if (typeof repo.update === 'function') {
            await repo.update({ filterByTk: id, filter: { organizationId, recipientUserId: userId }, values: { readAt: now } });
          } else if (typeof row.update === 'function') {
            await row.update({ readAt: now });
          }
        }
        ctx.body = { ...serializeNotification(row), readAt: now instanceof Date ? now.toISOString() : now };
        return next();
      },

      markAllRead: async (ctx, next) => {
        if ((ctx.method || 'POST') !== 'POST') ctx.throw(405);
        const { organizationId, userId } = await resolveScopedUser(ctx);
        const params = readParams(ctx);
        const rawCategory = typeof params.category === 'string' ? params.category.trim().toLowerCase() : '';
        const category = rawCategory && rawCategory !== 'all' && VALID_CATEGORIES.has(rawCategory) ? rawCategory : null;

        const repo = db.getRepository('latticeNotifications');
        if (!repo) {
          ctx.body = { organizationId, updatedCount: 0 };
          return next();
        }
        const filter = {
          organizationId,
          recipientUserId: userId,
          active: true,
          readAt: null,
          ...(category ? { category } : {}),
        };
        const unreadCount = typeof repo.count === 'function'
          ? await repo.count({ filter })
          : ((await repo.find({ filter, limit: 1000 })) || []).length;
        const now = new Date();
        if (unreadCount > 0) {
          if (typeof repo.update === 'function') {
            await repo.update({ filter, values: { readAt: now } });
          } else {
            const rows = (await repo.find({ filter, limit: 1000 })) || [];
            for (const row of rows) {
              if (typeof row.update === 'function') await row.update({ readAt: now });
            }
          }
        }
        ctx.body = { organizationId, updatedCount: unreadCount, readAt: now.toISOString() };
        return next();
      },
    },
  });

  app.acl.allow('latticeNotifications', ['listMine', 'unreadCount', 'markRead', 'markAllRead'], 'loggedIn');
}

module.exports = {
  VALID_CATEGORIES,
  VALID_SEVERITIES,
  DEDUP_WINDOW_MS,
  EXTERNAL_TIMEOUT_MS,
  isSafeExternalWebhookUrl,
  isSafeExternalWebhookUrlAsync,
  resolveNotificationTargetPath,
  dispatchNotification,
  dispatchRoleNotifications,
  registerNotificationCenter,
};
