/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { randomUUID } = require('node:crypto');
const { runWithTenantRls } = require('./ai-rls');

const CHANNEL = 'latticedx:surface-updates';
const INSTANCE_ID = randomUUID();
const PORTAL_SLUG_RE = /^[a-z0-9_-]{1,64}$/;
const MAX_LISTENERS = 1000;
const FLOW_STUDIO_ROLES = new Set(['root', 'admin', 'ldx_admin', 'ldx_manager']);
const TRIAGE_SCAN_ROLES = new Set(['root', 'admin', 'ldx_admin', 'ldx_executive', 'ldx_manager', 'ldx_operator']);
const BUILTIN_APP_SLUGS = new Set(['mobile', 'workspace', 'admin']);

const listenersBySlug = new Map();
const attachedManagers = new WeakSet();
let activePubSub = null;

function normalizeSlug(slug) {
  return String(slug || '').trim().toLowerCase();
}

function normalizeOrg(organizationId) {
  return String(organizationId || '').trim();
}

function buildChannelKey(portalSlug, organizationId = '') {
  const slug = normalizeSlug(portalSlug);
  const org = normalizeOrg(organizationId);
  return org ? `${org}::${slug}` : slug;
}

function failEvent(code, status, message) {
  return Object.assign(new Error(message || code), { code, status });
}

function readVal(row, key) {
  if (!row || typeof row !== 'object') return undefined;
  return typeof row.get === 'function' ? row.get(key) : row[key];
}

function totalListeners() {
  let count = 0;
  for (const set of listenersBySlug.values()) count += set.size;
  return count;
}

function dispatchLocal(portalSlug, payload) {
  const slug = normalizeSlug(portalSlug);
  const org = normalizeOrg(payload?.organizationId);
  const targets = new Set();
  if (org) {
    targets.add(buildChannelKey(slug, org));
    targets.add(buildChannelKey('*', org));
    if (slug === '*') {
      const prefix = `${org}::`;
      for (const key of listenersBySlug.keys()) {
        if (key.startsWith(prefix)) targets.add(key);
      }
    }
    // Preserve 2-arg unscoped internal JS test subscribers (never HTTP SSE clients when targetDb is present)
    targets.add(slug);
    targets.add('*');
  } else {
    targets.add(slug);
    targets.add('*');
  }
  for (const key of targets) {
    const set = listenersBySlug.get(key);
    if (!set) continue;
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch {
        // Isolate failing SSE socket write
      }
    }
  }
}

function attachAppPubSub(app) {
  const pubSub = app?.pubSubManager;
  if (!pubSub || typeof pubSub.subscribe !== 'function') return false;
  activePubSub = pubSub;
  if (attachedManagers.has(pubSub)) return true;
  attachedManagers.add(pubSub);
  Promise.resolve(
    pubSub.subscribe(CHANNEL, (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.instanceId === INSTANCE_ID) return;
      if (!msg.portalSlug) return;
      dispatchLocal(msg.portalSlug, msg);
    }),
  ).catch(() => {});
  return true;
}

function subscribeSurfaceEvents(portalSlug, listener, options = {}) {
  const slug = normalizeSlug(portalSlug);
  const org = normalizeOrg(options?.organizationId);
  const key = buildChannelKey(slug, org);
  if (!slug || typeof listener !== 'function') return () => {};
  if (totalListeners() >= MAX_LISTENERS) {
    throw failEvent('SURFACE_EVENTS_CAPACITY', 503, 'Too many concurrent surface event subscribers');
  }
  let set = listenersBySlug.get(key);
  if (!set) {
    set = new Set();
    listenersBySlug.set(key, set);
  }
  set.add(listener);
  return () => {
    const cur = listenersBySlug.get(key);
    if (!cur) return;
    cur.delete(listener);
    if (cur.size === 0) listenersBySlug.delete(key);
  };
}

function publishSurfaceUpdate(portalSlug, payload = {}) {
  const slug = normalizeSlug(portalSlug);
  if (!slug) return;
  const event = { ...payload, portalSlug: slug, instanceId: INSTANCE_ID };
  dispatchLocal(slug, event);
  if (activePubSub && typeof activePubSub.publish === 'function') {
    Promise.resolve(activePubSub.publish(CHANNEL, event)).catch(() => {});
  }
}

function formatSseFrame(eventName, data) {
  return `event: ${String(eventName || 'message')}\ndata: ${JSON.stringify(data ?? {})}\n\n`;
}

async function assertPortalSseAcl(targetDb, actor, portalSlug, organizationId) {
  if (!targetDb || !actor) return;
  const { isRootActor } = require('./ai-hitl');
  if (actor.isAdmin || isRootActor(actor)) return;
  const roleNames = Array.isArray(actor.roleNames) ? actor.roleNames : [];

  if (portalSlug === 'flow-studio') {
    if (!roleNames.some((r) => FLOW_STUDIO_ROLES.has(r))) {
      throw failEvent('PORTAL_ACL_FORBIDDEN', 403, 'Chỉ Quản trị viên hoặc Quản lý mới được theo dõi sự kiện Flow Studio.');
    }
    return;
  }
  if (portalSlug === 'admin-studio') {
    if (!roleNames.some((r) => TRIAGE_SCAN_ROLES.has(r))) {
      throw failEvent('PORTAL_ACL_FORBIDDEN', 403, 'Không có quyền theo dõi sự kiện Admin Studio.');
    }
    return;
  }
  if (BUILTIN_APP_SLUGS.has(portalSlug)) {
    return;
  }

  const layoutUid = `ldx-portal-${portalSlug}`;
  await runWithTenantRls(targetDb, organizationId, async () => {
    const layoutsRepo = targetDb.getRepository?.('uiLayouts');
    const layoutRow = layoutsRepo && typeof layoutsRepo.findOne === 'function'
      ? await layoutsRepo.findOne({ filter: { uid: layoutUid } }).catch(() => null)
      : null;
    if (layoutRow && readVal(layoutRow, 'enabled') === false) {
      throw failEvent('PORTAL_ACL_FORBIDDEN', 403, `Cổng "${portalSlug}" đang bị tắt.`);
    }

    const linksRepo = targetDb.getRepository?.('desktopRoutesUiLayouts');
    const rolesRoutesRepo = targetDb.getRepository?.('rolesDesktopRoutes');
    let checkedRouteGrants = false;
    if (linksRepo && typeof linksRepo.find === 'function' && rolesRoutesRepo && typeof rolesRoutesRepo.find === 'function') {
      const links = (await linksRepo.find({ filter: { uiLayoutUid: layoutUid }, limit: 400 }).catch(() => [])) || [];
      const routeIds = links.map((l) => readVal(l, 'desktopRouteId')).filter((id) => id != null);
      if (routeIds.length) {
        const grants = (await rolesRoutesRepo.find({ filter: { desktopRouteId: { $in: routeIds } }, limit: 500 }).catch(() => [])) || [];
        if (grants.length) {
          checkedRouteGrants = true;
          const allowedRoles = new Set(grants.map((g) => String(readVal(g, 'roleName') || '').trim()).filter(Boolean));
          if (!roleNames.some((r) => allowedRoles.has(r))) {
            throw failEvent('PORTAL_ACL_FORBIDDEN', 403, `Vai trò hiện tại không có quyền truy cập portal "${portalSlug}".`);
          }
        }
      }
    }

    if (!checkedRouteGrants && layoutRow) {
      const explicitRoles = readVal(layoutRow, 'roles') || readVal(layoutRow, 'allowedRoles');
      if (Array.isArray(explicitRoles) && explicitRoles.length) {
        const allowedSet = new Set(explicitRoles.map((r) => String(r || '').trim()).filter(Boolean));
        if (!roleNames.some((r) => allowedSet.has(r))) {
          throw failEvent('PORTAL_ACL_FORBIDDEN', 403, `Vai trò hiện tại không có quyền truy cập portal "${portalSlug}".`);
        }
      }
    }
  });
}

function createSurfaceEventsHandler({ db = null, resolveDb = null, getInitialState } = {}) {
  return async function surfaceEventsHandler(ctx) {
    const user = ctx?.state?.currentUser || ctx?.auth?.user;
    const uid = typeof user?.get === 'function' ? user.get('id') : user?.id;
    if (!uid) throw failEvent('NATIVE_LOGIN_REQUIRED', 401, 'Yêu cầu đăng nhập.');

    const rawSlug = ctx?.action?.params?.portalSlug ?? ctx?.query?.portalSlug ?? '';
    const portalSlug = normalizeSlug(rawSlug);
    if (!PORTAL_SLUG_RE.test(portalSlug)) {
      throw failEvent('PORTAL_SLUG_INVALID', 400, 'Mã portalSlug không hợp lệ.');
    }
    const pageTitle = String(ctx?.action?.params?.pageTitle ?? ctx?.query?.pageTitle ?? '').trim();

    const targetDb = typeof resolveDb === 'function' ? resolveDb(ctx) : (db || ctx?.db || ctx?.app?.db || null);
    let organizationId = '';
    if (targetDb) {
      const { resolveActorScope } = require('./ai-tools-core');
      const { isRootActor } = require('./ai-hitl');
      const actor = await resolveActorScope(ctx, targetDb);
      const requestedOrg = String(ctx?.action?.params?.organizationId ?? ctx?.query?.organizationId ?? '').trim();
      if (!isRootActor(actor) && requestedOrg && requestedOrg !== actor.organizationId) {
        throw failEvent('DXOS_ORG_MISMATCH', 403, 'Không được phép đăng ký sự kiện bề mặt của tổ chức khác.');
      }
      organizationId = (isRootActor(actor) && requestedOrg) ? requestedOrg : actor.organizationId;
      await assertPortalSseAcl(targetDb, actor, portalSlug, organizationId);
    }

    const res = ctx.res;
    if (!res || typeof res.write !== 'function') {
      ctx.body = typeof getInitialState === 'function'
        ? await getInitialState(ctx, portalSlug, pageTitle, organizationId)
        : { ...(organizationId ? { organizationId } : {}), portalSlug, revision: 1 };
      return;
    }

    ctx.respond = false;
    if (typeof res.writeHead === 'function') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
    } else if (typeof res.setHeader === 'function') {
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
    }
    res.flushHeaders?.();

    const initial = typeof getInitialState === 'function'
      ? await getInitialState(ctx, portalSlug, pageTitle, organizationId)
      : { ...(organizationId ? { organizationId } : {}), portalSlug, pageTitle: pageTitle || null, revision: 1, blockCount: 0, layoutSignature: '' };
    res.write(formatSseFrame('snapshot', initial));

    let closed = false;
    let unsubscribe = () => {};
    let keepaliveTimer = null;

    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (keepaliveTimer) {
        clearInterval(keepaliveTimer);
        keepaliveTimer = null;
      }
      unsubscribe();
      try { res.end?.(); } catch {}
    };

    unsubscribe = subscribeSurfaceEvents(portalSlug, (ev) => {
      if (closed) return;
      if (ev?.recipientUserId != null && String(ev.recipientUserId) !== String(uid)) {
        return;
      }
      try {
        res.write(formatSseFrame('update', ev));
      } catch {
        cleanup();
      }
    }, { organizationId });

    keepaliveTimer = setInterval(() => {
      if (closed) return;
      try {
        res.write(': keepalive\n\n');
      } catch {
        cleanup();
      }
    }, 25000);
    keepaliveTimer.unref?.();

    ctx.req?.on?.('close', cleanup);
    ctx.req?.on?.('aborted', cleanup);
    res.on?.('close', cleanup);
  };
}

module.exports = {
  CHANNEL,
  INSTANCE_ID,
  buildChannelKey,
  attachAppPubSub,
  subscribeSurfaceEvents,
  publishSurfaceUpdate,
  formatSseFrame,
  createSurfaceEventsHandler,
};
