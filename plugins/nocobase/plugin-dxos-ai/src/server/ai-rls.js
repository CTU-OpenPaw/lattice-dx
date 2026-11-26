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

const ORG_ID_RE = /^[a-zA-Z0-9_-]{1,80}$/;

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

async function runWithTenantRls(db, organizationId, fn, pgRls = loadFoundationPgRls()) {
  if (typeof fn !== 'function') throw new TypeError('runWithTenantRls requires a callback function.');
  if (!pgRls || typeof pgRls.canUsePgRlsSession !== 'function' || !pgRls.canUsePgRlsSession(db)) {
    return fn(null);
  }
  const org = String(organizationId || '').trim();
  const active = pgRls.getActiveRlsContext?.();
  if (active?.transaction && active.sequelize === db?.sequelize) {
    if (active.systemRlsBypass === true || (org && active.organizationId === org)) {
      return fn(active.transaction);
    }
  }
  if (!ORG_ID_RE.test(org)) {
    return pgRls.withSystemRlsBypass(db, fn);
  }
  return pgRls.withTenantRlsContext(db, org, fn);
}

async function runWithSystemRlsBypass(db, fn, pgRls = loadFoundationPgRls()) {
  if (typeof fn !== 'function') throw new TypeError('runWithSystemRlsBypass requires a callback function.');
  if (!pgRls || typeof pgRls.canUsePgRlsSession !== 'function' || !pgRls.canUsePgRlsSession(db)) {
    return fn(null);
  }
  const active = pgRls.getActiveRlsContext?.();
  if (active?.transaction && active.sequelize === db?.sequelize && active.systemRlsBypass === true) {
    return fn(active.transaction);
  }
  return pgRls.withSystemRlsBypass(db, fn);
}

async function runInRlsSavepoint(db, fn, pgRls = loadFoundationPgRls()) {
  if (typeof fn !== 'function') throw new TypeError('runInRlsSavepoint requires a callback function.');
  if (pgRls && typeof pgRls.runInRlsSavepoint === 'function') {
    return pgRls.runInRlsSavepoint(db, fn);
  }
  return fn(null);
}

module.exports = {
  loadFoundationPgRls,
  runWithTenantRls,
  runWithSystemRlsBypass,
  runInRlsSavepoint,
};
