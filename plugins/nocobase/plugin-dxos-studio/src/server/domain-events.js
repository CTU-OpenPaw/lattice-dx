/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { loadFoundationModule } = require('./wms-dmn-shared');

/**
 * Best-effort cross-plugin domain event publisher.
 * Never throws or blocks primary business transactions when event-bus storage is absent.
 */
async function emitDomainEventSafely(db, ctxOrMeta, payload) {
  try {
    const app = ctxOrMeta?.app || db?.app || null;
    if (typeof app?.latticeEvents?.publishDomainEvent === 'function') {
      if (db && typeof db.getRepository === 'function') {
        await app.latticeEvents.publishDomainEvent(db, {
          ...payload,
          app,
        });
      } else {
        await app.latticeEvents.publishDomainEvent({
          ...payload,
          app,
        });
      }
      return true;
    }
    const eventBus = loadFoundationModule('event-bus');
    if (eventBus && typeof eventBus.publishDomainEvent === 'function') {
      const busRepo = typeof db?.getRepository === 'function' ? db.getRepository('latticeEventBus') : null;
      if (!busRepo) return false;
      await eventBus.publishDomainEvent(db, {
        ...payload,
        app,
      });
      return true;
    }
  } catch {
    // Non-blocking domain event emission for isolated unit test mocks.
  }
  return false;
}

module.exports = {
  emitDomainEventSafely,
};
