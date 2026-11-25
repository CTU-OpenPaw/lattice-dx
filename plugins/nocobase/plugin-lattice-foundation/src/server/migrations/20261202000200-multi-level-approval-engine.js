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
  'latticeApprovalPolicies',
  'latticeApprovalRequests',
];

class MultiLevelApprovalEngineMigration extends Migration {
  on = 'afterSync';

  async up() {
    const db = this.context.db;
    const { sequelize } = db;
    const isPostgres = typeof sequelize?.getDialect === 'function' && sequelize.getDialect() === 'postgres';

    await sequelize.transaction(async (transaction) => {
      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS "latticeApprovalPolicies" (
          id BIGSERIAL PRIMARY KEY,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "organizationId" VARCHAR(255) NOT NULL,
          "policyKey" VARCHAR(128) NOT NULL,
          name VARCHAR(255) NOT NULL,
          description TEXT,
          "targetCollection" VARCHAR(255) NOT NULL,
          "triggerOperation" VARCHAR(64) NOT NULL DEFAULT 'submit',
          "conditionJson" JSONB,
          "stagesJson" JSONB NOT NULL DEFAULT '[]'::jsonb,
          "allowSelfApproval" BOOLEAN NOT NULL DEFAULT FALSE,
          "slaMinutes" INTEGER NOT NULL DEFAULT 1440,
          "escalateToRole" VARCHAR(128) DEFAULT 'ldx_director',
          "notifyChannels" JSONB,
          priority INTEGER NOT NULL DEFAULT 100,
          active BOOLEAN NOT NULL DEFAULT TRUE
        );
      `, { transaction });

      await sequelize.query(
        'CREATE UNIQUE INDEX IF NOT EXISTS uidx_lattice_approval_policies_org_key ON "latticeApprovalPolicies" ("organizationId", "policyKey");',
        { transaction },
      );
      await sequelize.query(
        'CREATE INDEX IF NOT EXISTS idx_lattice_approval_policies_org_col ON "latticeApprovalPolicies" ("organizationId", "targetCollection", active);',
        { transaction },
      );

      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS "latticeApprovalRequests" (
          id BIGSERIAL PRIMARY KEY,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "organizationId" VARCHAR(255) NOT NULL,
          "requestUid" VARCHAR(128) NOT NULL,
          "policyId" BIGINT,
          "policyKey" VARCHAR(128),
          "targetCollection" VARCHAR(255) NOT NULL,
          "targetRecordId" BIGINT,
          "targetCode" VARCHAR(128),
          title VARCHAR(255) NOT NULL,
          summary TEXT,
          "riskLevel" VARCHAR(32) NOT NULL DEFAULT 'medium',
          status VARCHAR(32) NOT NULL DEFAULT 'pending',
          "currentStageIndex" INTEGER NOT NULL DEFAULT 0,
          "totalStages" INTEGER NOT NULL DEFAULT 1,
          "stagesStateJson" JSONB NOT NULL DEFAULT '[]'::jsonb,
          "requesterUserId" BIGINT NOT NULL,
          "requesterEmployeeId" BIGINT,
          "requesterUsername" VARCHAR(255),
          "payloadJson" JSONB,
          "dueAt" TIMESTAMPTZ,
          "escalatedAt" TIMESTAMPTZ,
          "decidedAt" TIMESTAMPTZ,
          "finalDecisionByUserId" BIGINT,
          "finalDecisionByUsername" VARCHAR(255),
          "finalDecisionNote" TEXT,
          active BOOLEAN NOT NULL DEFAULT TRUE
        );
      `, { transaction });

      await sequelize.query(
        'CREATE UNIQUE INDEX IF NOT EXISTS uidx_lattice_approval_reqs_org_uid ON "latticeApprovalRequests" ("organizationId", "requestUid");',
        { transaction },
      );
      await sequelize.query(
        'CREATE INDEX IF NOT EXISTS idx_lattice_approval_reqs_org_status ON "latticeApprovalRequests" ("organizationId", status, "dueAt");',
        { transaction },
      );
      await sequelize.query(
        'CREATE INDEX IF NOT EXISTS idx_lattice_approval_reqs_org_target ON "latticeApprovalRequests" ("organizationId", "targetCollection", "targetRecordId");',
        { transaction },
      );
      await sequelize.query(
        'CREATE INDEX IF NOT EXISTS idx_lattice_approval_reqs_org_req ON "latticeApprovalRequests" ("organizationId", "requesterUserId", status);',
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

      await sequelize.query('DROP INDEX IF EXISTS idx_lattice_approval_reqs_org_req;', { transaction });
      await sequelize.query('DROP INDEX IF EXISTS idx_lattice_approval_reqs_org_target;', { transaction });
      await sequelize.query('DROP INDEX IF EXISTS idx_lattice_approval_reqs_org_status;', { transaction });
      await sequelize.query('DROP INDEX IF EXISTS uidx_lattice_approval_reqs_org_uid;', { transaction });
      await sequelize.query('DROP TABLE IF EXISTS "latticeApprovalRequests";', { transaction });

      await sequelize.query('DROP INDEX IF EXISTS idx_lattice_approval_policies_org_col;', { transaction });
      await sequelize.query('DROP INDEX IF EXISTS uidx_lattice_approval_policies_org_key;', { transaction });
      await sequelize.query('DROP TABLE IF EXISTS "latticeApprovalPolicies";', { transaction });
    });
  }
}

module.exports = MultiLevelApprovalEngineMigration;
module.exports.default = MultiLevelApprovalEngineMigration;
