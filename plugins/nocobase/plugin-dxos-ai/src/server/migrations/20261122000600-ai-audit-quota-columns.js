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

class AiAuditQuotaColumns extends Migration {
  on = 'afterSync';

  async up() {
    const { sequelize } = this.context.db;
    await sequelize.transaction(async (transaction) => {
      await sequelize.query('ALTER TABLE "latticeAiAuditLogs" ADD COLUMN IF NOT EXISTS "promptTokens" integer NOT NULL DEFAULT 0;', { transaction });
      await sequelize.query('ALTER TABLE "latticeAiAuditLogs" ADD COLUMN IF NOT EXISTS "completionTokens" integer NOT NULL DEFAULT 0;', { transaction });
      await sequelize.query('ALTER TABLE "latticeAiAuditLogs" ADD COLUMN IF NOT EXISTS "estimatedCostUsd" double precision NOT NULL DEFAULT 0;', { transaction });
      await sequelize.query('ALTER TABLE "latticeAiAuditLogs" ADD COLUMN IF NOT EXISTS "piiRedactedCount" integer NOT NULL DEFAULT 0;', { transaction });
    });
  }

  async down() {
    const { sequelize } = this.context.db;
    await sequelize.transaction(async (transaction) => {
      await sequelize.query('ALTER TABLE "latticeAiAuditLogs" DROP COLUMN IF EXISTS "piiRedactedCount";', { transaction });
      await sequelize.query('ALTER TABLE "latticeAiAuditLogs" DROP COLUMN IF EXISTS "estimatedCostUsd";', { transaction });
      await sequelize.query('ALTER TABLE "latticeAiAuditLogs" DROP COLUMN IF EXISTS "completionTokens";', { transaction });
      await sequelize.query('ALTER TABLE "latticeAiAuditLogs" DROP COLUMN IF EXISTS "promptTokens";', { transaction });
    });
  }
}

module.exports = AiAuditQuotaColumns;
module.exports.default = AiAuditQuotaColumns;
