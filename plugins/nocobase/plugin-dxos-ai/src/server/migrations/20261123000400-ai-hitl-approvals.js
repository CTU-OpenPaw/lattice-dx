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

class AiHitlApprovalsMigration extends Migration {
  on = 'afterSync';

  async up() {
    const { sequelize } = this.context.db;
    await sequelize.transaction(async (transaction) => {
      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS "latticeAiApprovalQueue" (
          id BIGSERIAL PRIMARY KEY,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "organizationId" VARCHAR(255) NOT NULL DEFAULT 'native-ui-lab',
          "requesterUserId" BIGINT NOT NULL,
          "requesterUsername" VARCHAR(255),
          "aiEmployee" VARCHAR(255),
          "toolName" VARCHAR(255) NOT NULL,
          "targetCollection" VARCHAR(255) NOT NULL,
          "targetRecordId" BIGINT,
          operation VARCHAR(64) NOT NULL DEFAULT 'update',
          "proposedArgs" JSONB DEFAULT '{}'::jsonb,
          "diffPreview" JSONB DEFAULT '{}'::jsonb,
          "riskLevel" VARCHAR(32) NOT NULL DEFAULT 'medium',
          status VARCHAR(32) NOT NULL DEFAULT 'pending',
          "decidedByUserId" BIGINT,
          "decidedByUsername" VARCHAR(255),
          "decisionNote" VARCHAR(255),
          "decidedAt" TIMESTAMPTZ,
          "executionResult" JSONB,
          "expiresAt" TIMESTAMPTZ
        );
      `, { transaction });
      await sequelize.query(
        'CREATE INDEX IF NOT EXISTS idx_lattice_ai_hitl_org_status_created ON "latticeAiApprovalQueue" ("organizationId", status, "createdAt");',
        { transaction },
      );
    });
  }

  async down() {
    const { sequelize } = this.context.db;
    await sequelize.transaction(async (transaction) => {
      await sequelize.query('DROP INDEX IF EXISTS idx_lattice_ai_hitl_org_status_created;', { transaction });
      await sequelize.query('DROP TABLE IF EXISTS "latticeAiApprovalQueue";', { transaction });
    });
  }
}

module.exports = AiHitlApprovalsMigration;
module.exports.default = AiHitlApprovalsMigration;
