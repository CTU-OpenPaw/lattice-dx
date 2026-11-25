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

const TABLE_NAME = 'latticeNotificationDeliveries';

class OmnichannelNotificationDeliveriesMigration extends Migration {
  on = 'afterSync';

  async up() {
    const db = this.context.db;
    const { sequelize } = db;
    if (!sequelize) return;
    const isPostgres = typeof sequelize.getDialect === 'function' && sequelize.getDialect() === 'postgres';

    await sequelize.transaction(async (transaction) => {
      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS "latticeNotificationDeliveries" (
          id BIGSERIAL PRIMARY KEY,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "organizationId" VARCHAR(255) NOT NULL,
          "deliveryUid" VARCHAR(128) NOT NULL,
          "notificationId" BIGINT,
          channel VARCHAR(64) NOT NULL,
          "connectorKey" VARCHAR(128),
          "targetMasked" VARCHAR(512),
          "templateKey" VARCHAR(128),
          "eventType" VARCHAR(255),
          status VARCHAR(32) NOT NULL DEFAULT 'pending',
          attempt INTEGER NOT NULL DEFAULT 0,
          "maxAttempts" INTEGER NOT NULL DEFAULT 3,
          "httpStatus" INTEGER,
          "providerMessageId" VARCHAR(255),
          "errorCode" VARCHAR(128),
          "errorMessage" TEXT,
          "payloadPreviewJson" JSONB,
          "dryRun" BOOLEAN NOT NULL DEFAULT FALSE,
          "sentAt" TIMESTAMPTZ
        );
      `, { transaction });

      await sequelize.query(
        'CREATE UNIQUE INDEX IF NOT EXISTS uidx_lattice_notif_del_org_uid ON "latticeNotificationDeliveries" ("organizationId", "deliveryUid");',
        { transaction },
      );
      await sequelize.query(
        'CREATE INDEX IF NOT EXISTS idx_lattice_notif_del_org_status ON "latticeNotificationDeliveries" ("organizationId", status, "createdAt");',
        { transaction },
      );
      await sequelize.query(
        'CREATE INDEX IF NOT EXISTS idx_lattice_notif_del_org_channel ON "latticeNotificationDeliveries" ("organizationId", channel, "createdAt");',
        { transaction },
      );

      if (isPostgres) {
        if (typeof db.attachLatticeRlsPolicy === 'function') {
          await db.attachLatticeRlsPolicy(TABLE_NAME, { transaction });
        } else {
          await attachRlsPolicyToTable(db, TABLE_NAME, { transaction });
        }
      }
    });
  }

  async down() {
    const db = this.context.db;
    const { sequelize } = db;
    if (!sequelize) return;
    const isPostgres = typeof sequelize.getDialect === 'function' && sequelize.getDialect() === 'postgres';

    await sequelize.transaction(async (transaction) => {
      if (isPostgres) {
        await detachRlsPolicyFromTable(db, TABLE_NAME, { transaction });
      }

      await sequelize.query('DROP INDEX IF EXISTS idx_lattice_notif_del_org_channel;', { transaction });
      await sequelize.query('DROP INDEX IF EXISTS idx_lattice_notif_del_org_status;', { transaction });
      await sequelize.query('DROP INDEX IF EXISTS uidx_lattice_notif_del_org_uid;', { transaction });
      await sequelize.query('DROP TABLE IF EXISTS "latticeNotificationDeliveries";', { transaction });
    });
  }
}

module.exports = OmnichannelNotificationDeliveriesMigration;
module.exports.default = OmnichannelNotificationDeliveriesMigration;
