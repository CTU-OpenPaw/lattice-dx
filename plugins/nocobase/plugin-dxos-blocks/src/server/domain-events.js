/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const path = require('node:path');

function loadFoundationEventBus() {
  const inDist = __dirname.includes(`${path.sep}dist${path.sep}`);
  const candidates = inDist
    ? [
        '@latticedx/plugin-lattice-foundation/dist/server/event-bus',
        '@latticedx/plugin-lattice-foundation/src/server/event-bus',
        '../../../plugin-lattice-foundation/dist/server/event-bus',
        '../../../plugin-lattice-foundation/src/server/event-bus',
      ]
    : [
        '@latticedx/plugin-lattice-foundation/src/server/event-bus',
        '../../../plugin-lattice-foundation/src/server/event-bus',
        '@latticedx/plugin-lattice-foundation/dist/server/event-bus',
        '../../../plugin-lattice-foundation/dist/server/event-bus',
      ];
  for (const modPath of candidates) {
    try {
      const mod = require(modPath);
      if (mod && typeof mod.publishDomainEvent === 'function') return mod;
    } catch {
      // Standalone unit tests or partial plugin setups must never fail when event-bus is absent.
    }
  }
  return null;
}

function resolvePublishDomainEvent(db, ctx, opts = {}) {
  if (typeof opts?.publishDomainEvent === 'function') {
    return { fn: opts.publishDomainEvent, fromModule: false };
  }
  const appFromCtx = ctx?.app?.latticeEvents?.publishDomainEvent;
  if (typeof appFromCtx === 'function') {
    return { fn: appFromCtx, fromModule: false };
  }
  const appFromOpt = opts?.app?.latticeEvents?.publishDomainEvent;
  if (typeof appFromOpt === 'function') {
    return { fn: appFromOpt, fromModule: false };
  }
  const appFromDb = db?.app?.latticeEvents?.publishDomainEvent;
  if (typeof appFromDb === 'function') {
    return { fn: appFromDb, fromModule: false };
  }
  const mod = loadFoundationEventBus();
  if (mod && typeof mod.publishDomainEvent === 'function') {
    return { fn: mod.publishDomainEvent, fromModule: true };
  }
  return null;
}

function inferExpectsDbFirstArg(fn) {
  try {
    const src = Function.prototype.toString.call(fn).replace(/\s+/g, ' ').trim();
    const header = src.slice(0, 120);
    if (/^(?:async\s+)?(?:function\s*[^(]*\(\s*|\(\s*)(?:db|_db|database)\b/.test(header)) {
      return true;
    }
    if (/^(?:async\s+)?(?:function\s*[^(]*\(\s*|\(\s*)(?:event|ev|payload|input|opts|options|msg)\b/.test(header)) {
      return false;
    }
  } catch {
    // Ignore native/bound function introspection failures
  }
  return null;
}

/**
 * Safely resolves and invokes the cross-plugin domain event publisher without
 * failing when plugin-lattice-foundation's event-bus is absent in unit tests.
 */
async function emitDomainEventSafely(db, eventInput, opts = {}) {
  try {
    const resolved = resolvePublishDomainEvent(db, opts.ctx || null, opts);
    if (!resolved) return null;
    const { fn, fromModule } = resolved;

    const payload = {
      ...(eventInput || {}),
      eventType: eventInput?.eventType || eventInput?.type,
      type: eventInput?.type || eventInput?.eventType,
    };
    const callOpts = opts.transaction ? { transaction: opts.transaction } : undefined;

    if (fromModule) {
      return callOpts ? await fn(db, payload, callOpts) : await fn(db, payload);
    }

    const mod = loadFoundationEventBus();
    if (mod && fn === mod.publishDomainEvent) {
      return callOpts ? await fn(db, payload, callOpts) : await fn(db, payload);
    }

    const expectsDb = inferExpectsDbFirstArg(fn);
    if (expectsDb === false) {
      return callOpts ? await fn(payload, callOpts) : await fn(payload);
    }
    if (expectsDb === true) {
      return callOpts ? await fn(db, payload, callOpts) : await fn(db, payload);
    }

    try {
      return callOpts ? await fn(db, payload, callOpts) : await fn(db, payload);
    } catch {
      return callOpts ? await fn(payload, callOpts) : await fn(payload);
    }
  } catch {
    return null;
  }
}

module.exports = {
  loadFoundationEventBus,
  resolvePublishDomainEvent,
  emitDomainEventSafely,
};
