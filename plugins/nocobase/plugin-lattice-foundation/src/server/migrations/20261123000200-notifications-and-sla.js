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

class NotificationsAndSlaMigration extends Migration {
  on = 'afterSync';

  async up() {
    const { sequelize } = this.context.db;
    await sequelize.transaction(async (transaction) => {
      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS "latticeNotifications" (
          id BIGSERIAL PRIMARY KEY,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "organizationId" VARCHAR(255) NOT NULL,
          "recipientUserId" BIGINT NOT NULL,
          "recipientEmployeeId" BIGINT,
          category VARCHAR(64) NOT NULL DEFAULT 'system',
          severity VARCHAR(64) NOT NULL DEFAULT 'info',
          title VARCHAR(255) NOT NULL,
          body TEXT,
          "targetCollection" VARCHAR(255),
          "targetRecordId" BIGINT,
          "targetPath" VARCHAR(512),
          "dedupKey" VARCHAR(255),
          "readAt" TIMESTAMPTZ,
          "channelsDispatched" JSON,
          active BOOLEAN NOT NULL DEFAULT TRUE
        );
      `, { transaction });

      await sequelize.query(
        'CREATE INDEX IF NOT EXISTS idx_lattice_notif_org_user_read ON "latticeNotifications" ("organizationId", "recipientUserId", "readAt", "createdAt");',
        { transaction },
      );
      await sequelize.query(
        'CREATE INDEX IF NOT EXISTS idx_lattice_notif_org_dedup ON "latticeNotifications" ("organizationId", "recipientUserId", "dedupKey", "createdAt");',
        { transaction },
      );

      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS "latticeSlaPolicies" (
          id BIGSERIAL PRIMARY KEY,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "organizationId" VARCHAR(255) NOT NULL,
          "targetCollection" VARCHAR(255) NOT NULL,
          priority VARCHAR(64) NOT NULL DEFAULT 'normal',
          "warnAfterMinutes" INTEGER NOT NULL DEFAULT 240,
          "breachAfterMinutes" INTEGER NOT NULL DEFAULT 1440,
          "escalateToRole" VARCHAR(128) NOT NULL DEFAULT 'ldx_manager',
          "notifyChannels" JSON,
          active BOOLEAN NOT NULL DEFAULT TRUE
        );
      `, { transaction });

      await sequelize.query(
        'CREATE UNIQUE INDEX IF NOT EXISTS uidx_lattice_sla_org_col_prio ON "latticeSlaPolicies" ("organizationId", "targetCollection", priority);',
        { transaction },
      );

      await sequelize.query(`
        DO $$ BEGIN
          IF to_regclass('"latticeServiceTickets"') IS NOT NULL THEN
            ALTER TABLE "latticeServiceTickets" ADD COLUMN IF NOT EXISTS "submittedAt" TIMESTAMPTZ;
            ALTER TABLE "latticeServiceTickets" ADD COLUMN IF NOT EXISTS "submittedBy" VARCHAR(255);
            ALTER TABLE "latticeServiceTickets" ADD COLUMN IF NOT EXISTS "cancelledAt" TIMESTAMPTZ;
            ALTER TABLE "latticeServiceTickets" ADD COLUMN IF NOT EXISTS "cancelledBy" VARCHAR(255);
            ALTER TABLE "latticeServiceTickets" ADD COLUMN IF NOT EXISTS "cancelReason" VARCHAR(255);
            ALTER TABLE "latticeServiceTickets" ADD COLUMN IF NOT EXISTS "amendedFromId" BIGINT;
            ALTER TABLE "latticeServiceTickets" ADD COLUMN IF NOT EXISTS "amendmentNo" INTEGER NOT NULL DEFAULT 0;
            CREATE INDEX IF NOT EXISTS idx_lattice_tickets_org_amended ON "latticeServiceTickets" ("organizationId", "amendedFromId");
          END IF;
        END $$;
      `, { transaction });
    });
  }

  async down() {
    const { sequelize } = this.context.db;
    await sequelize.transaction(async (transaction) => {
      await sequelize.query('DROP INDEX IF EXISTS idx_lattice_tickets_org_amended;', { transaction });
      await sequelize.query('ALTER TABLE IF EXISTS "latticeServiceTickets" DROP COLUMN IF EXISTS "amendmentNo";', { transaction });
      await sequelize.query('ALTER TABLE IF EXISTS "latticeServiceTickets" DROP COLUMN IF EXISTS "amendedFromId";', { transaction });
      await sequelize.query('ALTER TABLE IF EXISTS "latticeServiceTickets" DROP COLUMN IF EXISTS "cancelReason";', { transaction });
      await sequelize.query('ALTER TABLE IF EXISTS "latticeServiceTickets" DROP COLUMN IF EXISTS "cancelledBy";', { transaction });
      await sequelize.query('ALTER TABLE IF EXISTS "latticeServiceTickets" DROP COLUMN IF EXISTS "cancelledAt";', { transaction });
      await sequelize.query('ALTER TABLE IF EXISTS "latticeServiceTickets" DROP COLUMN IF EXISTS "submittedBy";', { transaction });
      await sequelize.query('ALTER TABLE IF EXISTS "latticeServiceTickets" DROP COLUMN IF EXISTS "submittedAt";', { transaction });
      await sequelize.query('DROP INDEX IF EXISTS uidx_lattice_sla_org_col_prio;', { transaction });
      await sequelize.query('DROP TABLE IF EXISTS "latticeSlaPolicies";', { transaction });
      await sequelize.query('DROP INDEX IF EXISTS idx_lattice_notif_org_dedup;', { transaction });
      await sequelize.query('DROP INDEX IF EXISTS idx_lattice_notif_org_user_read;', { transaction });
      await sequelize.query('DROP TABLE IF EXISTS "latticeNotifications";', { transaction });
    });
  }
}

module.exports = NotificationsAndSlaMigration;
module.exports.default = NotificationsAndSlaMigration;
