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

class AiQuotaBucketsMigration extends Migration {
  on = 'afterSync';

  async up() {
    const { sequelize } = this.context.db;
    await sequelize.transaction(async (transaction) => {
      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS "latticeAiQuotaUsage" (
          id BIGSERIAL PRIMARY KEY,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "organizationId" VARCHAR(255) NOT NULL DEFAULT 'native-ui-lab',
          "dayKey" VARCHAR(32) NOT NULL,
          "userId" VARCHAR(255) NOT NULL,
          calls INTEGER NOT NULL DEFAULT 0,
          "promptTokens" BIGINT NOT NULL DEFAULT 0,
          "completionTokens" BIGINT NOT NULL DEFAULT 0,
          "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
          "piiRedacted" INTEGER NOT NULL DEFAULT 0
        );
      `, { transaction });
      await sequelize.query(
        'CREATE UNIQUE INDEX IF NOT EXISTS uidx_lattice_ai_quota_org_day_user ON "latticeAiQuotaUsage" ("organizationId", "dayKey", "userId");',
        { transaction },
      );
      await sequelize.query(
        'CREATE INDEX IF NOT EXISTS idx_lattice_ai_quota_org_day ON "latticeAiQuotaUsage" ("organizationId", "dayKey");',
        { transaction },
      );
    });
  }

  async down() {
    const { sequelize } = this.context.db;
    await sequelize.transaction(async (transaction) => {
      await sequelize.query('DROP INDEX IF EXISTS idx_lattice_ai_quota_org_day;', { transaction });
      await sequelize.query('DROP INDEX IF EXISTS uidx_lattice_ai_quota_org_day_user;', { transaction });
      await sequelize.query('DROP TABLE IF EXISTS "latticeAiQuotaUsage";', { transaction });
    });
  }
}

module.exports = AiQuotaBucketsMigration;
module.exports.default = AiQuotaBucketsMigration;
