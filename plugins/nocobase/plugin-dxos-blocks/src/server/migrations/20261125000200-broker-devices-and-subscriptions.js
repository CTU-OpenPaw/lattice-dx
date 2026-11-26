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

class BrokerDevicesAndSubscriptionsMigration extends Migration {
  on = 'afterSync';

  async up() {
    const db = this.db || this.context?.db;
    const { sequelize } = db;
    const isPostgres = typeof sequelize?.getDialect === 'function' && sequelize.getDialect() === 'postgres';

    await sequelize.transaction(async (transaction) => {
      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS "latticeIotDevices" (
          id BIGSERIAL PRIMARY KEY,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "organizationId" VARCHAR(255) NOT NULL,
          "deviceKey" VARCHAR(128) NOT NULL,
          name VARCHAR(255) NOT NULL,
          "mqttUsername" VARCHAR(255) NOT NULL,
          "mqttClientId" VARCHAR(255) NOT NULL,
          "assetId" BIGINT,
          "assetEntityId" VARCHAR(255),
          "topicPrefix" VARCHAR(255) NOT NULL,
          status VARCHAR(32) NOT NULL DEFAULT 'provisioned',
          "lastSeenAt" TIMESTAMPTZ,
          "lastReason" VARCHAR(255),
          "metadataJson" JSONB NOT NULL DEFAULT '{}'::jsonb
        );
      `, { transaction });

      await sequelize.query(
        'CREATE UNIQUE INDEX IF NOT EXISTS uidx_lattice_iot_devices_org_key ON "latticeIotDevices" ("organizationId", "deviceKey");',
        { transaction },
      );
      await sequelize.query(
        'CREATE INDEX IF NOT EXISTS idx_lattice_iot_devices_org_status ON "latticeIotDevices" ("organizationId", status);',
        { transaction },
      );

      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS "latticeBrokerSubscriptions" (
          id BIGSERIAL PRIMARY KEY,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "organizationId" VARCHAR(255) NOT NULL,
          "subscriptionKey" VARCHAR(128) NOT NULL,
          "brokerType" VARCHAR(32) NOT NULL DEFAULT 'orion_ld',
          "externalSubscriptionId" VARCHAR(255),
          "entityType" VARCHAR(255) NOT NULL,
          "watchedAttributesJson" JSONB NOT NULL DEFAULT '[]'::jsonb,
          "notificationEndpoint" VARCHAR(512) NOT NULL,
          "throttlingSec" INTEGER NOT NULL DEFAULT 5,
          active BOOLEAN NOT NULL DEFAULT TRUE,
          "lastNotifiedAt" TIMESTAMPTZ,
          "lastError" TEXT
        );
      `, { transaction });

      await sequelize.query(
        'CREATE UNIQUE INDEX IF NOT EXISTS uidx_lattice_broker_subs_org_key ON "latticeBrokerSubscriptions" ("organizationId", "subscriptionKey");',
        { transaction },
      );
      await sequelize.query(
        'CREATE INDEX IF NOT EXISTS idx_lattice_broker_subs_org_active ON "latticeBrokerSubscriptions" ("organizationId", "brokerType", active);',
        { transaction },
      );

      if (isPostgres) {
        const tables = ['latticeIotDevices', 'latticeBrokerSubscriptions'];
        if (typeof db.attachLatticeRlsPolicy === 'function') {
          for (const tableName of tables) {
            await db.attachLatticeRlsPolicy(tableName, { transaction });
          }
        } else {
          const pgRls = loadPgRls();
          if (pgRls) {
            for (const tableName of tables) {
              await pgRls.attachRlsPolicyToTable(db, tableName, { transaction });
            }
          }
        }
      }
    });
  }

  async down() {
    const db = this.db || this.context?.db;
    const { sequelize } = db;
    const isPostgres = typeof sequelize?.getDialect === 'function' && sequelize.getDialect() === 'postgres';

    await sequelize.transaction(async (transaction) => {
      if (isPostgres) {
        const tables = ['latticeBrokerSubscriptions', 'latticeIotDevices'];
        if (typeof db.detachLatticeRlsPolicy === 'function') {
          for (const tableName of tables) {
            await db.detachLatticeRlsPolicy(tableName, { transaction });
          }
        } else {
          const pgRls = loadPgRls();
          if (pgRls && typeof pgRls.detachRlsPolicyFromTable === 'function') {
            for (const tableName of tables) {
              await pgRls.detachRlsPolicyFromTable(db, tableName, { transaction });
            }
          } else {
            for (const tableName of tables) {
              await sequelize.query(`DROP POLICY IF EXISTS lattice_tenant_isolation ON public."${tableName}";`, { transaction });
              await sequelize.query(`ALTER TABLE IF EXISTS public."${tableName}" DISABLE ROW LEVEL SECURITY;`, { transaction });
            }
          }
        }
      }

      await sequelize.query('DROP INDEX IF EXISTS idx_lattice_broker_subs_org_active;', { transaction });
      await sequelize.query('DROP INDEX IF EXISTS uidx_lattice_broker_subs_org_key;', { transaction });
      await sequelize.query('DROP TABLE IF EXISTS "latticeBrokerSubscriptions";', { transaction });

      await sequelize.query('DROP INDEX IF EXISTS idx_lattice_iot_devices_org_status;', { transaction });
      await sequelize.query('DROP INDEX IF EXISTS uidx_lattice_iot_devices_org_key;', { transaction });
      await sequelize.query('DROP TABLE IF EXISTS "latticeIotDevices";', { transaction });
    });
  }
}

module.exports = BrokerDevicesAndSubscriptionsMigration;
module.exports.default = BrokerDevicesAndSubscriptionsMigration;
