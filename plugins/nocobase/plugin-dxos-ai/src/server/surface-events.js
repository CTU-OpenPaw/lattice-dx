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

const CHANNEL = 'latticedx:surface-updates';
const INSTANCE_ID = randomUUID();
const PORTAL_SLUG_RE = /^[a-z0-9_-]{1,64}$/;
const MAX_LISTENERS = 1000;

const listenersBySlug = new Map();
const attachedManagers = new WeakSet();
let activePubSub = null;

function normalizeSlug(slug) {
  return String(slug || '').trim().toLowerCase();
}

function failEvent(code, status, message) {
  return Object.assign(new Error(message || code), { code, status });
}

function totalListeners() {
  let count = 0;
  for (const set of listenersBySlug.values()) count += set.size;
  return count;
}

function dispatchLocal(portalSlug, payload) {
  const targets = [normalizeSlug(portalSlug), '*'];
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

function subscribeSurfaceEvents(portalSlug, listener) {
  const key = normalizeSlug(portalSlug);
  if (!key || typeof listener !== 'function') return () => {};
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

function createSurfaceEventsHandler({ getInitialState } = {}) {
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

    const res = ctx.res;
    if (!res || typeof res.write !== 'function') {
      ctx.body = typeof getInitialState === 'function'
        ? await getInitialState(ctx, portalSlug, pageTitle)
        : { portalSlug, revision: 1 };
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
      ? await getInitialState(ctx, portalSlug, pageTitle)
      : { portalSlug, pageTitle: pageTitle || null, revision: 1, blockCount: 0, layoutSignature: '' };
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
      try {
        res.write(formatSseFrame('update', ev));
      } catch {
        cleanup();
      }
    });

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
  attachAppPubSub,
  subscribeSurfaceEvents,
  publishSurfaceUpdate,
  formatSseFrame,
  createSurfaceEventsHandler,
};
