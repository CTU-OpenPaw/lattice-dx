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

const TARGETS = [
  { table: 'latticeRequests', idx: 'idx_lattice_requests_org_amended' },
  { table: 'latticeOrders', idx: 'idx_lattice_orders_org_amended' },
];

class VoucherLifecycleColumnsMigration extends Migration {
  on = 'afterSync';

  async up() {
    const { sequelize } = this.context.db;
    await sequelize.transaction(async (transaction) => {
      for (const { table, idx } of TARGETS) {
        await sequelize.query(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "submittedAt" TIMESTAMPTZ;`, { transaction });
        await sequelize.query(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "submittedBy" VARCHAR(255);`, { transaction });
        await sequelize.query(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "cancelledAt" TIMESTAMPTZ;`, { transaction });
        await sequelize.query(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "cancelledBy" VARCHAR(255);`, { transaction });
        await sequelize.query(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "cancelReason" VARCHAR(255);`, { transaction });
        await sequelize.query(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "amendedFromId" BIGINT;`, { transaction });
        await sequelize.query(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "amendmentNo" INTEGER NOT NULL DEFAULT 0;`, { transaction });
        await sequelize.query(`CREATE INDEX IF NOT EXISTS ${idx} ON "${table}" ("organizationId", "amendedFromId");`, { transaction });
      }
    });
  }

  async down() {
    const { sequelize } = this.context.db;
    await sequelize.transaction(async (transaction) => {
      for (const { table, idx } of TARGETS) {
        await sequelize.query(`DROP INDEX IF EXISTS ${idx};`, { transaction });
        await sequelize.query(`ALTER TABLE "${table}" DROP COLUMN IF EXISTS "amendmentNo";`, { transaction });
        await sequelize.query(`ALTER TABLE "${table}" DROP COLUMN IF EXISTS "amendedFromId";`, { transaction });
        await sequelize.query(`ALTER TABLE "${table}" DROP COLUMN IF EXISTS "cancelReason";`, { transaction });
        await sequelize.query(`ALTER TABLE "${table}" DROP COLUMN IF EXISTS "cancelledBy";`, { transaction });
        await sequelize.query(`ALTER TABLE "${table}" DROP COLUMN IF EXISTS "cancelledAt";`, { transaction });
        await sequelize.query(`ALTER TABLE "${table}" DROP COLUMN IF EXISTS "submittedBy";`, { transaction });
        await sequelize.query(`ALTER TABLE "${table}" DROP COLUMN IF EXISTS "submittedAt";`, { transaction });
      }
    });
  }
}

module.exports = VoucherLifecycleColumnsMigration;
module.exports.default = VoucherLifecycleColumnsMigration;
