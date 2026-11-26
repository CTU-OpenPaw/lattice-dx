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
const { installServiceRoleGrants } = require('../service-roles');

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
      if (mod && typeof mod.attachRlsPolicyToTable === 'function') return mod;
    } catch (err) {
      const isDirectMissing = err?.code === 'MODULE_NOT_FOUND'
        && (!Array.isArray(err.requireStack) || err.requireStack.length === 0 || err.requireStack[0] === __filename);
      if (!isDirectMissing) throw err;
    }
  }
  return null;
}

async function resolveExistingPgTables(db, tableNames, transaction) {
  const sequelize = db?.sequelize;
  if (typeof sequelize?.query !== 'function') {
    return typeof db?.attachLatticeRlsPolicy === 'function'
      ? tableNames.filter((t) => (typeof db.hasCollection === 'function' ? db.hasCollection(t) : true))
      : [];
  }
  const quoted = tableNames.map((t) => `'${t}'`).join(', ');
  const queryOpts = transaction ? { transaction } : undefined;
  const raw = await sequelize.query(
    `SELECT table_name\n     FROM information_schema.columns\n     WHERE table_schema = 'public'\n       AND column_name = 'organizationId'\n       AND table_name IN (${quoted})\n     ORDER BY table_name;`,
    queryOpts,
  );
  const rows = Array.isArray(raw?.[0]) ? raw[0] : (Array.isArray(raw) ? raw : []);
  const present = new Set(rows.map((r) => r?.table_name ?? r?.TABLE_NAME).filter((n) => typeof n === 'string'));
  return tableNames.filter((t) => present.has(t));
}

async function attachTableRls(db, tableName, transaction) {
  const opts = transaction ? { transaction } : {};
  if (typeof db?.attachLatticeRlsPolicy === 'function') {
    await db.attachLatticeRlsPolicy(tableName, opts);
    return;
  }
  const pgRls = loadPgRls();
  if (pgRls && typeof pgRls.attachRlsPolicyToTable === 'function') {
    await pgRls.attachRlsPolicyToTable(db, tableName, opts);
  }
}

async function detachTableRls(db, tableName, transaction) {
  const opts = transaction ? { transaction } : {};
  if (typeof db?.detachLatticeRlsPolicy === 'function') {
    await db.detachLatticeRlsPolicy(tableName, opts);
    return;
  }
  const pgRls = loadPgRls();
  if (pgRls && typeof pgRls.detachRlsPolicyFromTable === 'function') {
    await pgRls.detachRlsPolicyFromTable(db, tableName, opts);
    return;
  }
  const sequelize = db?.sequelize;
  if (typeof sequelize?.query === 'function') {
    const queryOpts = transaction ? { transaction } : undefined;
    await sequelize.query(`DROP POLICY IF EXISTS lattice_tenant_isolation ON public."${tableName}";`, queryOpts);
    await sequelize.query(`ALTER TABLE IF EXISTS public."${tableName}" DISABLE ROW LEVEL SECURITY;`, queryOpts);
  }
}

class DxosServiceTicketsInit extends Migration {
  on = 'afterSync';

  async up() {
    const db = this.context.db;
    const collections = db.getRepository('collections');
    if (collections && typeof collections.db2cm === 'function' && db.hasCollection?.('latticeServiceTickets')) {
      if (!(await collections.findOne({ filter: { name: 'latticeServiceTickets' } }))) {
        await collections.db2cm('latticeServiceTickets');
      }
    }
    await installServiceRoleGrants(db);

    const sequelize = db?.sequelize;
    const isPostgres = typeof sequelize?.getDialect === 'function' && sequelize.getDialect() === 'postgres';
    if (isPostgres) {
      const attach = async (transaction) => {
        const tables = await resolveExistingPgTables(db, ['latticeServiceTickets'], transaction);
        for (const tableName of tables) {
          await attachTableRls(db, tableName, transaction);
        }
      };
      if (typeof sequelize.transaction === 'function') {
        await sequelize.transaction(attach);
      } else {
        await attach(undefined);
      }
    }
  }

  async down() {
    const db = this.context.db;
    const sequelize = db?.sequelize;
    const isPostgres = typeof sequelize?.getDialect === 'function' && sequelize.getDialect() === 'postgres';
    if (isPostgres) {
      const detach = async (transaction) => {
        const tables = await resolveExistingPgTables(db, ['latticeServiceTickets'], transaction);
        for (const tableName of tables) {
          await detachTableRls(db, tableName, transaction);
        }
      };
      if (typeof sequelize.transaction === 'function') {
        await sequelize.transaction(detach);
      } else {
        await detach(undefined);
      }
    }
    await db.getRepository?.('rolesResources')?.destroy({
      filter: {
        name: 'latticeServiceTickets',
        roleName: { $in: ['ldx_employee', 'ldx_manager', 'ldx_warehouse', 'ldx_dispatcher', 'ldx_driver', 'ldx_director', 'ldx_admin'] },
      },
    });
    await db.getRepository?.('collections')?.destroy({ filter: { name: 'latticeServiceTickets' } });
  }
}

module.exports = DxosServiceTicketsInit;
module.exports.default = DxosServiceTicketsInit;
