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
const { Migration } = require('@nocobase/server');

function loadPgRls() {
  const inDist = __dirname.includes(`${path.sep}dist${path.sep}`);
  const candidates = inDist
    ? [
        '@latticedx/plugin-lattice-foundation/dist/server/pg-rls',
        '@latticedx/plugin-lattice-foundation/src/server/pg-rls',
        '../../../../plugin-lattice-foundation/dist/server/pg-rls',
        '../../../../plugin-lattice-foundation/src/server/pg-rls',
      ]
    : [
        '@latticedx/plugin-lattice-foundation/src/server/pg-rls',
        '../../../../plugin-lattice-foundation/src/server/pg-rls',
        '@latticedx/plugin-lattice-foundation/dist/server/pg-rls',
        '../../../../plugin-lattice-foundation/dist/server/pg-rls',
      ];
  for (const modPath of candidates) {
    try {
      const mod = require(modPath);
      if (
        mod
        && typeof mod.discoverTenantRlsTables === 'function'
        && typeof mod.attachRlsPolicyToTable === 'function'
      ) {
        return mod;
      }
    } catch (err) {
      const isDirectMissing = err?.code === 'MODULE_NOT_FOUND'
        && (!Array.isArray(err.requireStack) || err.requireStack.length === 0 || err.requireStack[0] === __filename);
      if (!isDirectMissing) throw err;
    }
  }
  return null;
}

class ReconcileSiblingRlsMigration extends Migration {
  on = 'afterSync';

  async up() {
    const db = this.context.db;
    const sequelize = db?.sequelize;
    if (!sequelize || typeof sequelize.getDialect !== 'function' || sequelize.getDialect() !== 'postgres') {
      return;
    }
    const pgRls = loadPgRls();
    if (!pgRls) {
      return;
    }
    const reconcile = async (transaction) => {
      const txOpts = transaction ? { transaction } : {};
      const tables = await pgRls.discoverTenantRlsTables(db, txOpts);
      for (const tableName of tables) {
        if (typeof db.attachLatticeRlsPolicy === 'function') {
          await db.attachLatticeRlsPolicy(tableName, txOpts);
        } else {
          await pgRls.attachRlsPolicyToTable(db, tableName, txOpts);
        }
      }
    };
    if (typeof sequelize.transaction === 'function') {
      await sequelize.transaction(reconcile);
    } else {
      await reconcile(undefined);
    }
  }

  async down() {
    // Intentional safe no-op: rolling back the reconciliation pass must not strip
    // active PostgreSQL RLS policies owned by foundation and Wave 1/2 migrations.
    return undefined;
  }
}

module.exports = ReconcileSiblingRlsMigration;
module.exports.default = ReconcileSiblingRlsMigration;
