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

class PkiKeyRotationSupportMigration extends Migration {
  on = 'afterSync';

  async up() {
    const db = this.context.db;
    const { sequelize } = db;
    const isPostgres = typeof sequelize?.getDialect === 'function' && sequelize.getDialect() === 'postgres';

    await sequelize.transaction(async (transaction) => {
      if (isPostgres) {
        await sequelize.query(`
          DO $$
          BEGIN
            IF to_regclass('"latticePkiKeys"') IS NOT NULL THEN
              ALTER TABLE "latticePkiKeys" ADD COLUMN IF NOT EXISTS status VARCHAR(32) NOT NULL DEFAULT 'active';
              ALTER TABLE "latticePkiKeys" ADD COLUMN IF NOT EXISTS "retiredAt" TIMESTAMPTZ;
            END IF;
          END
          $$;
        `, { transaction });

        await sequelize.query('DROP INDEX IF EXISTS uidx_lattice_pki_keys_org;', { transaction });
        await sequelize.query(
          'CREATE UNIQUE INDEX IF NOT EXISTS uidx_lattice_pki_keys_org_key ON "latticePkiKeys" ("organizationId", "keyId");',
          { transaction },
        );
        await sequelize.query(
          'CREATE UNIQUE INDEX IF NOT EXISTS uidx_lattice_pki_keys_org_active ON "latticePkiKeys" ("organizationId") WHERE active = true;',
          { transaction },
        );
        await sequelize.query(
          'CREATE INDEX IF NOT EXISTS idx_lattice_pki_keys_org_active ON "latticePkiKeys" ("organizationId", active);',
          { transaction },
        );
      } else {
        await sequelize.query('DROP INDEX IF EXISTS uidx_lattice_pki_keys_org;', { transaction });
        await sequelize.query(
          'CREATE UNIQUE INDEX IF NOT EXISTS uidx_lattice_pki_keys_org_key ON "latticePkiKeys" ("organizationId", "keyId");',
          { transaction },
        );
        await sequelize.query(
          'CREATE INDEX IF NOT EXISTS idx_lattice_pki_keys_org_active ON "latticePkiKeys" ("organizationId", active);',
          { transaction },
        );
      }
    });
  }

  async down() {
    const db = this.context.db;
    const { sequelize } = db;
    const isPostgres = typeof sequelize?.getDialect === 'function' && sequelize.getDialect() === 'postgres';

    await sequelize.transaction(async (transaction) => {
      await sequelize.query('DROP INDEX IF EXISTS idx_lattice_pki_keys_org_active;', { transaction });
      if (isPostgres) {
        await sequelize.query('DROP INDEX IF EXISTS uidx_lattice_pki_keys_org_active;', { transaction });
      }
      await sequelize.query('DROP INDEX IF EXISTS uidx_lattice_pki_keys_org_key;', { transaction });

      if (isPostgres) {
        await sequelize.query('ALTER TABLE IF EXISTS "latticePkiKeys" DROP COLUMN IF EXISTS "retiredAt";', { transaction });
        await sequelize.query('ALTER TABLE IF EXISTS "latticePkiKeys" DROP COLUMN IF EXISTS status;', { transaction });
      }
    });
  }
}

module.exports = PkiKeyRotationSupportMigration;
module.exports.default = PkiKeyRotationSupportMigration;
