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
  discoverTenantRlsTables,
  quoteIdentifier,
} = require('../pg-rls');

const CONNECTOR_OAUTH2_COLUMNS = Object.freeze([
  { name: 'appType', sqlType: 'VARCHAR(64)' },
  { name: 'capabilitiesJson', sqlType: 'JSONB' },
  { name: 'oauthConfigJson', sqlType: 'JSONB' },
  { name: 'oauthAccessTokenEnc', sqlType: 'TEXT' },
  { name: 'oauthRefreshTokenEnc', sqlType: 'TEXT' },
  { name: 'oauthTokenExpiresAt', sqlType: 'TIMESTAMPTZ' },
  { name: 'oauthScope', sqlType: 'VARCHAR(512)' },
  { name: 'oauthStateNonce', sqlType: 'VARCHAR(128)' },
  { name: 'n8nCredentialId', sqlType: 'VARCHAR(128)' },
]);

class ForceRlsAndOauth2ConnectorsMigration extends Migration {
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
      for (const col of CONNECTOR_OAUTH2_COLUMNS) {
        await sequelize.query(
          `ALTER TABLE IF EXISTS "latticeConnectors" ADD COLUMN IF NOT EXISTS "${col.name}" ${col.sqlType};`,
          { transaction },
        );
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
      for (const col of [...CONNECTOR_OAUTH2_COLUMNS].reverse()) {
        await sequelize.query(
          `ALTER TABLE IF EXISTS "latticeConnectors" DROP COLUMN IF EXISTS "${col.name}";`,
          { transaction },
        );
      }
      const tables = await discoverTenantRlsTables(db, { transaction });
      for (const tableName of [...tables].reverse()) {
        const quoted = quoteIdentifier(tableName);
        await sequelize.query(
          `ALTER TABLE IF EXISTS public.${quoted} NO FORCE ROW LEVEL SECURITY;`,
          { transaction },
        );
      }
    });
  }
}

module.exports = ForceRlsAndOauth2ConnectorsMigration;
module.exports.default = ForceRlsAndOauth2ConnectorsMigration;
