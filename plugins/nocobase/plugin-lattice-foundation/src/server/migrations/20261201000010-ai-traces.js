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

const TABLE_NAME = 'latticeAiTraces';

class AiTracesMigration extends Migration {
  on = 'afterSync';

  async up() {
    const db = this.context?.db;
    const sequelize = db?.sequelize;
    if (!sequelize || typeof sequelize.transaction !== 'function') return;
    const isPostgres = typeof sequelize.getDialect === 'function' && sequelize.getDialect() === 'postgres';

    await sequelize.transaction(async (transaction) => {
      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS "latticeAiTraces" (
          id BIGSERIAL PRIMARY KEY,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          uid VARCHAR(128) NOT NULL,
          "organizationId" VARCHAR(255) NOT NULL,
          "traceId" VARCHAR(64) NOT NULL,
          "spanId" VARCHAR(32) NOT NULL,
          "parentSpanId" VARCHAR(32),
          "runUid" VARCHAR(128),
          "operationName" VARCHAR(64) NOT NULL DEFAULT 'chat',
          "genAiSystem" VARCHAR(64) DEFAULT 'latticedx',
          model VARCHAR(160),
          "agentName" VARCHAR(160),
          "toolName" VARCHAR(160),
          status VARCHAR(32) NOT NULL DEFAULT 'ok',
          "durationMs" INTEGER NOT NULL DEFAULT 0,
          "inputTokens" INTEGER NOT NULL DEFAULT 0,
          "outputTokens" INTEGER NOT NULL DEFAULT 0,
          "totalTokens" INTEGER NOT NULL DEFAULT 0,
          "piiRedactedCount" INTEGER NOT NULL DEFAULT 0,
          "attributesJson" JSONB DEFAULT '{}'::jsonb,
          "startedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "endedAt" TIMESTAMPTZ,
          "errorMessage" TEXT
        );
      `, { transaction });

      await sequelize.query(
        'CREATE UNIQUE INDEX IF NOT EXISTS uidx_lattice_ai_traces_org_uid ON "latticeAiTraces" ("organizationId", uid);',
        { transaction },
      );
      await sequelize.query(
        'CREATE INDEX IF NOT EXISTS idx_lattice_ai_traces_org_started ON "latticeAiTraces" ("organizationId", "startedAt");',
        { transaction },
      );
      await sequelize.query(
        'CREATE INDEX IF NOT EXISTS idx_lattice_ai_traces_org_trace ON "latticeAiTraces" ("organizationId", "traceId", "startedAt");',
        { transaction },
      );
      await sequelize.query(
        'CREATE INDEX IF NOT EXISTS idx_lattice_ai_traces_org_run ON "latticeAiTraces" ("organizationId", "runUid", "startedAt");',
        { transaction },
      );
      await sequelize.query(
        'CREATE INDEX IF NOT EXISTS idx_lattice_ai_traces_org_op_status ON "latticeAiTraces" ("organizationId", "operationName", status);',
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
    const db = this.context?.db;
    const sequelize = db?.sequelize;
    if (!sequelize || typeof sequelize.transaction !== 'function') return;
    const isPostgres = typeof sequelize.getDialect === 'function' && sequelize.getDialect() === 'postgres';

    await sequelize.transaction(async (transaction) => {
      if (isPostgres) {
        await detachRlsPolicyFromTable(db, TABLE_NAME, { transaction });
      }

      await sequelize.query('DROP INDEX IF EXISTS idx_lattice_ai_traces_org_op_status;', { transaction });
      await sequelize.query('DROP INDEX IF EXISTS idx_lattice_ai_traces_org_run;', { transaction });
      await sequelize.query('DROP INDEX IF EXISTS idx_lattice_ai_traces_org_trace;', { transaction });
      await sequelize.query('DROP INDEX IF EXISTS idx_lattice_ai_traces_org_started;', { transaction });
      await sequelize.query('DROP INDEX IF EXISTS uidx_lattice_ai_traces_org_uid;', { transaction });
      await sequelize.query('DROP TABLE IF EXISTS "latticeAiTraces";', { transaction });
    });
  }
}

module.exports = AiTracesMigration;
module.exports.default = AiTracesMigration;