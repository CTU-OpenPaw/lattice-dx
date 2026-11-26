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

const RULE_COLUMNS = [
  ['schemaVersion', 'INTEGER NOT NULL DEFAULT 1'],
  ['graphJson', 'JSONB'],
  ['draftGraphJson', 'JSONB'],
  ['publishedVersion', 'INTEGER NOT NULL DEFAULT 1'],
  ['triggerIndexJson', "JSONB NOT NULL DEFAULT '[]'::jsonb"],
];

const RUN_COLUMNS = [
  ['graphVersion', 'INTEGER NOT NULL DEFAULT 1'],
  ['nodeStatesJson', "JSONB NOT NULL DEFAULT '{}'::jsonb"],
  ['suspendedNodeId', 'VARCHAR(128)'],
  ['resumeTokenHash', 'VARCHAR(128)'],
  ['resumeAt', 'TIMESTAMPTZ'],
  ['approvalId', 'BIGINT'],
  ['triggerPayloadJson', 'JSONB'],
];

const RUN_RESUME_INDEX = 'idx_lattice_auto_runs_org_status_resume';

module.exports = class LatticeFlowV2DagAndDurableRunsMigration extends Migration {
  on = 'afterSync';

  async up() {
    const db = this.db || this.context?.db;
    const sequelize = db?.sequelize;
    if (!sequelize) return;

    const dialect = typeof sequelize.getDialect === 'function' ? sequelize.getDialect() : 'postgres';
    if (dialect !== 'postgres') return;

    const runUp = async (transaction) => {
      const txOpt = transaction ? { transaction } : undefined;
      for (const [col, def] of RULE_COLUMNS) {
        await sequelize.query(
          `ALTER TABLE "latticeAutomationRules" ADD COLUMN IF NOT EXISTS "${col}" ${def}`,
          txOpt,
        );
      }
      for (const [col, def] of RUN_COLUMNS) {
        await sequelize.query(
          `ALTER TABLE "latticeAutomationRuns" ADD COLUMN IF NOT EXISTS "${col}" ${def}`,
          txOpt,
        );
      }
      await sequelize.query(
        `CREATE INDEX IF NOT EXISTS "${RUN_RESUME_INDEX}" ON "latticeAutomationRuns" ("organizationId", "status", "resumeAt")`,
        txOpt,
      );
    };

    if (typeof sequelize.transaction === 'function') {
      await sequelize.transaction(runUp);
    } else {
      await runUp(undefined);
    }
  }

  async down() {
    const db = this.db || this.context?.db;
    const sequelize = db?.sequelize;
    if (!sequelize) return;

    const dialect = typeof sequelize.getDialect === 'function' ? sequelize.getDialect() : 'postgres';
    if (dialect !== 'postgres') return;

    const runDown = async (transaction) => {
      const txOpt = transaction ? { transaction } : undefined;
      await sequelize.query(`DROP INDEX IF EXISTS "${RUN_RESUME_INDEX}"`, txOpt);
      for (const [col] of [...RUN_COLUMNS].reverse()) {
        await sequelize.query(
          `ALTER TABLE IF EXISTS "latticeAutomationRuns" DROP COLUMN IF EXISTS "${col}"`,
          txOpt,
        );
      }
      for (const [col] of [...RULE_COLUMNS].reverse()) {
        await sequelize.query(
          `ALTER TABLE IF EXISTS "latticeAutomationRules" DROP COLUMN IF EXISTS "${col}"`,
          txOpt,
        );
      }
    };

    if (typeof sequelize.transaction === 'function') {
      await sequelize.transaction(runDown);
    } else {
      await runDown(undefined);
    }
  }
};
