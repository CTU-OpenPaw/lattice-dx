/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { Migration } = require('@nocobase/server');
const {
  attachRlsPolicyToTable,
  detachRlsPolicyFromTable,
  discoverTenantRlsTables,
} = require('../pg-rls');

class PostgresqlRlsPoliciesMigration extends Migration {
  on = 'afterSync';

  async up() {
    const db = this.context.db;
    const sequelize = db?.sequelize;
    if (!sequelize || typeof sequelize.getDialect !== 'function' || sequelize.getDialect() !== 'postgres') {
      return;
    }
    await sequelize.transaction(async (transaction) => {
      const tables = await discoverTenantRlsTables(db, { transaction });
      for (const tableName of tables) {
        await attachRlsPolicyToTable(db, tableName, { transaction });
      }
    });
  }

  async down() {
    const db = this.context.db;
    const sequelize = db?.sequelize;
    if (!sequelize || typeof sequelize.getDialect !== 'function' || sequelize.getDialect() !== 'postgres') {
      return;
    }
    await sequelize.transaction(async (transaction) => {
      const tables = await discoverTenantRlsTables(db, { transaction });
      for (const tableName of [...tables].reverse()) {
        await detachRlsPolicyFromTable(db, tableName, { transaction });
      }
    });
  }
}

module.exports = PostgresqlRlsPoliciesMigration;
module.exports.default = PostgresqlRlsPoliciesMigration;
