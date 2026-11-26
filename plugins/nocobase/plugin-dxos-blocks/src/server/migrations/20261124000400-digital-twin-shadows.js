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
      if (mod && typeof mod.attachRlsPolicyToTable === 'function') return mod;
    } catch (err) {
      const isDirectMissing = err?.code === 'MODULE_NOT_FOUND'
        && (!Array.isArray(err.requireStack) || err.requireStack.length === 0 || err.requireStack[0] === __filename);
      if (!isDirectMissing) throw err;
    }
  }
  return null;
}

class DigitalTwinShadowsMigration extends Migration {
  on = 'afterSync';

  async up() {
    const db = this.context.db;
    const { sequelize } = db;
    const isPostgres = typeof sequelize?.getDialect === 'function' && sequelize.getDialect() === 'postgres';

    await sequelize.transaction(async (transaction) => {
      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS "latticeTwinShadows" (
          id BIGSERIAL PRIMARY KEY,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "organizationId" VARCHAR(255) NOT NULL,
          "assetId" BIGINT,
          "assetEntityId" VARCHAR(255) NOT NULL,
          "desiredJson" JSONB NOT NULL DEFAULT '{}'::jsonb,
          "reportedJson" JSONB NOT NULL DEFAULT '{}'::jsonb,
          "lastDeltaJson" JSONB NOT NULL DEFAULT '{}'::jsonb,
          "pendingCommandId" VARCHAR(128),
          "commandStatus" VARCHAR(32) NOT NULL DEFAULT 'synced',
          "lastDispatchedAt" TIMESTAMPTZ,
          "lastAckedAt" TIMESTAMPTZ,
          "lastReportedAt" TIMESTAMPTZ,
          version INTEGER NOT NULL DEFAULT 1,
          "updatedBy" VARCHAR(255)
        );
      `, { transaction });

      await sequelize.query(
        'CREATE UNIQUE INDEX IF NOT EXISTS uidx_lattice_twin_org_entity ON "latticeTwinShadows" ("organizationId", "assetEntityId");',
        { transaction },
      );
      await sequelize.query(
        'CREATE INDEX IF NOT EXISTS idx_lattice_twin_org_status ON "latticeTwinShadows" ("organizationId", "commandStatus");',
        { transaction },
      );

      if (isPostgres) {
        if (typeof db.attachLatticeRlsPolicy === 'function') {
          await db.attachLatticeRlsPolicy('latticeTwinShadows', { transaction });
        } else {
          const pgRls = loadPgRls();
          if (pgRls) {
            await pgRls.attachRlsPolicyToTable(db, 'latticeTwinShadows', { transaction });
          }
        }
      }
    });
  }

  async down() {
    const db = this.context.db;
    const { sequelize } = db;
    const isPostgres = typeof sequelize?.getDialect === 'function' && sequelize.getDialect() === 'postgres';

    await sequelize.transaction(async (transaction) => {
      if (isPostgres) {
        if (typeof db.detachLatticeRlsPolicy === 'function') {
          await db.detachLatticeRlsPolicy('latticeTwinShadows', { transaction });
        } else {
          const pgRls = loadPgRls();
          if (pgRls && typeof pgRls.detachRlsPolicyFromTable === 'function') {
            await pgRls.detachRlsPolicyFromTable(db, 'latticeTwinShadows', { transaction });
          } else {
            await sequelize.query('DROP POLICY IF EXISTS lattice_tenant_isolation ON public."latticeTwinShadows";', { transaction });
            await sequelize.query('ALTER TABLE IF EXISTS public."latticeTwinShadows" DISABLE ROW LEVEL SECURITY;', { transaction });
          }
        }
      }

      await sequelize.query('DROP INDEX IF EXISTS idx_lattice_twin_org_status;', { transaction });
      await sequelize.query('DROP INDEX IF EXISTS uidx_lattice_twin_org_entity;', { transaction });
      await sequelize.query('DROP TABLE IF EXISTS "latticeTwinShadows";', { transaction });
    });
  }
}

module.exports = DigitalTwinShadowsMigration;
module.exports.default = DigitalTwinShadowsMigration;
