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

function loadFoundationPgRls() {
  const inDist = __dirname.includes(`${path.sep}dist${path.sep}`);
  const candidates = inDist
    ? [
        '@latticedx/plugin-lattice-foundation/dist/server/pg-rls',
        '@latticedx/plugin-lattice-foundation/src/server/pg-rls',
        '../../../plugin-lattice-foundation/dist/server/pg-rls',
        '../../../plugin-lattice-foundation/src/server/pg-rls',
      ]
    : [
        '@latticedx/plugin-lattice-foundation/src/server/pg-rls',
        '../../../plugin-lattice-foundation/src/server/pg-rls',
        '@latticedx/plugin-lattice-foundation/dist/server/pg-rls',
        '../../../plugin-lattice-foundation/dist/server/pg-rls',
      ];
  for (const modPath of candidates) {
    try {
      const mod = require(modPath);
      if (mod && typeof mod.withTenantRlsContext === 'function') return mod;
    } catch (err) {
      const isDirectMissing = err?.code === 'MODULE_NOT_FOUND'
        && (!Array.isArray(err.requireStack) || err.requireStack.length === 0 || err.requireStack[0] === __filename);
      if (!isDirectMissing) throw err;
    }
  }
  return null;
}

function runWithOptionalRls(db, organizationId, fn, pgRls = loadFoundationPgRls()) {
  if (typeof fn !== 'function') {
    throw new TypeError('runWithOptionalRls requires a callback function.');
  }
  if (!pgRls || typeof pgRls.canUsePgRlsSession !== 'function' || !pgRls.canUsePgRlsSession(db)) {
    return fn(null);
  }
  const active = typeof pgRls.getActiveRlsContext === 'function' ? pgRls.getActiveRlsContext() : null;
  const cleanOrg = typeof organizationId === 'string' ? organizationId.trim() : '';
  if (active?.transaction && active.sequelize === db?.sequelize) {
    if (active.systemRlsBypass === true || (cleanOrg && active.organizationId === cleanOrg)) {
      return fn(active.transaction);
    }
  }
  if (cleanOrg) {
    return pgRls.withTenantRlsContext(db, cleanOrg, (transaction) => fn(transaction));
  }
  if (typeof pgRls.withSystemRlsBypass === 'function') {
    return pgRls.withSystemRlsBypass(db, (transaction) => fn(transaction));
  }
  return fn(null);
}

module.exports = {
  loadFoundationPgRls,
  runWithOptionalRls,
};
