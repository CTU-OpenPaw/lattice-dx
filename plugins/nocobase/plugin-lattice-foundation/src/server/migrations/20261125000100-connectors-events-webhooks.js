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
const { attachRlsPolicyToTable, detachRlsPolicyFromTable } = require('../pg-rls');

const TABLES = [
  'latticeConnectors',
  'latticeEventBus',
  'latticeWebhookSubscriptions',
  'latticeWebhookDeliveries',
];

class ConnectorsEventsWebhooksMigration extends Migration {
  on = 'afterSync';

  async up() {
    const db = this.context.db;
    const { sequelize } = db;
    const isPostgres = typeof sequelize?.getDialect === 'function' && sequelize.getDialect() === 'postgres';

    await sequelize.transaction(async (transaction) => {
      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS "latticeConnectors" (
          id BIGSERIAL PRIMARY KEY,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "organizationId" VARCHAR(255) NOT NULL,
          "connectorKey" VARCHAR(128) NOT NULL,
          name VARCHAR(255) NOT NULL,
          "connectorType" VARCHAR(64) NOT NULL DEFAULT 'webhook',
          "baseUrl" VARCHAR(1024),
          "authType" VARCHAR(64) NOT NULL DEFAULT 'none',
          "encryptedSecretsJson" TEXT,
          "secretVersion" INTEGER NOT NULL DEFAULT 1,
          "lastTestedAt" TIMESTAMPTZ,
          "lastTestStatus" VARCHAR(64),
          active BOOLEAN NOT NULL DEFAULT TRUE
        );
      `, { transaction });

      await sequelize.query(
        'CREATE UNIQUE INDEX IF NOT EXISTS uidx_lattice_connectors_org_key ON "latticeConnectors" ("organizationId", "connectorKey");',
        { transaction },
      );
      await sequelize.query(
        'CREATE INDEX IF NOT EXISTS idx_lattice_connectors_org_type ON "latticeConnectors" ("organizationId", "connectorType", active);',
        { transaction },
      );

      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS "latticeEventBus" (
          id BIGSERIAL PRIMARY KEY,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "organizationId" VARCHAR(255) NOT NULL,
          "eventId" VARCHAR(128) NOT NULL,
          "eventType" VARCHAR(255) NOT NULL,
          source VARCHAR(255) NOT NULL,
          subject VARCHAR(255),
          "specVersion" VARCHAR(16) NOT NULL DEFAULT '1.0',
          "correlationId" VARCHAR(128),
          "causationId" VARCHAR(128),
          depth INTEGER NOT NULL DEFAULT 0,
          "payloadJson" JSONB NOT NULL,
          "occurredAt" TIMESTAMPTZ NOT NULL,
          status VARCHAR(64) NOT NULL DEFAULT 'queued'
        );
      `, { transaction });

      await sequelize.query(
        'CREATE UNIQUE INDEX IF NOT EXISTS uidx_lattice_events_event_id ON "latticeEventBus" ("eventId");',
        { transaction },
      );
      await sequelize.query(
        'CREATE INDEX IF NOT EXISTS idx_lattice_events_org_occurred ON "latticeEventBus" ("organizationId", "occurredAt");',
        { transaction },
      );
      await sequelize.query(
        'CREATE INDEX IF NOT EXISTS idx_lattice_events_org_type ON "latticeEventBus" ("organizationId", "eventType", "occurredAt");',
        { transaction },
      );

      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS "latticeWebhookSubscriptions" (
          id BIGSERIAL PRIMARY KEY,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "organizationId" VARCHAR(255) NOT NULL,
          "subscriptionKey" VARCHAR(128) NOT NULL,
          name VARCHAR(255) NOT NULL,
          "targetUrl" VARCHAR(1024) NOT NULL,
          "eventPattern" VARCHAR(255) NOT NULL DEFAULT '*',
          "encryptedSigningSecret" TEXT,
          "connectorId" BIGINT,
          active BOOLEAN NOT NULL DEFAULT TRUE,
          "failureCount" INTEGER NOT NULL DEFAULT 0,
          "circuitState" VARCHAR(32) NOT NULL DEFAULT 'closed',
          "circuitOpenUntil" TIMESTAMPTZ,
          "lastError" TEXT
        );
      `, { transaction });

      await sequelize.query(
        'CREATE UNIQUE INDEX IF NOT EXISTS uidx_lattice_wh_sub_org_key ON "latticeWebhookSubscriptions" ("organizationId", "subscriptionKey");',
        { transaction },
      );
      await sequelize.query(
        'CREATE INDEX IF NOT EXISTS idx_lattice_wh_sub_org_active ON "latticeWebhookSubscriptions" ("organizationId", active, "circuitState");',
        { transaction },
      );

      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS "latticeWebhookDeliveries" (
          id BIGSERIAL PRIMARY KEY,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "organizationId" VARCHAR(255) NOT NULL,
          "eventId" VARCHAR(128) NOT NULL,
          "subscriptionId" BIGINT NOT NULL,
          "eventType" VARCHAR(255) NOT NULL,
          attempt INTEGER NOT NULL DEFAULT 0,
          "maxAttempts" INTEGER NOT NULL DEFAULT 5,
          status VARCHAR(32) NOT NULL DEFAULT 'pending',
          "nextAttemptAt" TIMESTAMPTZ,
          "lockedAt" TIMESTAMPTZ,
          "lockedBy" VARCHAR(128),
          "httpStatus" INTEGER,
          "lastError" TEXT,
          "payloadSnapshotJson" JSONB NOT NULL,
          "deliveredAt" TIMESTAMPTZ
        );
      `, { transaction });

      await sequelize.query(
        'CREATE INDEX IF NOT EXISTS idx_lattice_wh_del_status_next ON "latticeWebhookDeliveries" (status, "nextAttemptAt");',
        { transaction },
      );
      await sequelize.query(
        'CREATE INDEX IF NOT EXISTS idx_lattice_wh_del_org_status ON "latticeWebhookDeliveries" ("organizationId", status, "createdAt");',
        { transaction },
      );
      await sequelize.query(
        'CREATE INDEX IF NOT EXISTS idx_lattice_wh_del_sub_event ON "latticeWebhookDeliveries" ("subscriptionId", "eventId");',
        { transaction },
      );

      if (isPostgres) {
        for (const tableName of TABLES) {
          if (typeof db.attachLatticeRlsPolicy === 'function') {
            await db.attachLatticeRlsPolicy(tableName, { transaction });
          } else {
            await attachRlsPolicyToTable(db, tableName, { transaction });
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
        for (const tableName of [...TABLES].reverse()) {
          await detachRlsPolicyFromTable(db, tableName, { transaction });
        }
      }

      await sequelize.query('DROP INDEX IF EXISTS idx_lattice_wh_del_sub_event;', { transaction });
      await sequelize.query('DROP INDEX IF EXISTS idx_lattice_wh_del_org_status;', { transaction });
      await sequelize.query('DROP INDEX IF EXISTS idx_lattice_wh_del_status_next;', { transaction });
      await sequelize.query('DROP TABLE IF EXISTS "latticeWebhookDeliveries";', { transaction });

      await sequelize.query('DROP INDEX IF EXISTS idx_lattice_wh_sub_org_active;', { transaction });
      await sequelize.query('DROP INDEX IF EXISTS uidx_lattice_wh_sub_org_key;', { transaction });
      await sequelize.query('DROP TABLE IF EXISTS "latticeWebhookSubscriptions";', { transaction });

      await sequelize.query('DROP INDEX IF EXISTS idx_lattice_events_org_type;', { transaction });
      await sequelize.query('DROP INDEX IF EXISTS idx_lattice_events_org_occurred;', { transaction });
      await sequelize.query('DROP INDEX IF EXISTS uidx_lattice_events_event_id;', { transaction });
      await sequelize.query('DROP TABLE IF EXISTS "latticeEventBus";', { transaction });

      await sequelize.query('DROP INDEX IF EXISTS idx_lattice_connectors_org_type;', { transaction });
      await sequelize.query('DROP INDEX IF EXISTS uidx_lattice_connectors_org_key;', { transaction });
      await sequelize.query('DROP TABLE IF EXISTS "latticeConnectors";', { transaction });
    });
  }
}

module.exports = ConnectorsEventsWebhooksMigration;
module.exports.default = ConnectorsEventsWebhooksMigration;
