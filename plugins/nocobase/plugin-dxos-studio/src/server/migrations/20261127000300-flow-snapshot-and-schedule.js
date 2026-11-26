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

const RUN_SNAPSHOT_COLUMNS = [
  ['graphSnapshotJson', 'JSONB'],
  ['triggerPayloadJson', 'JSONB'],
];

const RULE_SCHEDULE_COLUMNS = [
  ['cronExpression', 'VARCHAR(120)'],
  ['nextRunAt', 'TIMESTAMPTZ'],
];

const RULE_SCHEDULE_INDEX = 'idx_lattice_auto_rules_active_next_run';

class FlowSnapshotAndScheduleMigration extends Migration {
  on = 'afterSync';

  async up() {
    const db = this.db || this.context?.db;
    const sequelize = db?.sequelize;
    if (!sequelize) return;

    const dialect = typeof sequelize.getDialect === 'function' ? sequelize.getDialect() : 'postgres';
    if (dialect !== 'postgres') return;

    const runUp = async (transaction) => {
      const txOpt = transaction ? { transaction } : undefined;
      for (const [col, def] of RUN_SNAPSHOT_COLUMNS) {
        await sequelize.query(
          `ALTER TABLE IF EXISTS "latticeAutomationRuns" ADD COLUMN IF NOT EXISTS "${col}" ${def};`,
          txOpt,
        );
      }
      for (const [col, def] of RULE_SCHEDULE_COLUMNS) {
        await sequelize.query(
          `ALTER TABLE IF EXISTS "latticeAutomationRules" ADD COLUMN IF NOT EXISTS "${col}" ${def};`,
          txOpt,
        );
      }
      await sequelize.query(
        `CREATE INDEX IF NOT EXISTS "${RULE_SCHEDULE_INDEX}" ON "latticeAutomationRules" ("active", "nextRunAt");`,
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
      await sequelize.query(`DROP INDEX IF EXISTS "${RULE_SCHEDULE_INDEX}";`, txOpt);
      for (const [col] of [...RULE_SCHEDULE_COLUMNS].reverse()) {
        await sequelize.query(
          `ALTER TABLE IF EXISTS "latticeAutomationRules" DROP COLUMN IF EXISTS "${col}";`,
          txOpt,
        );
      }
      for (const [col] of [...RUN_SNAPSHOT_COLUMNS].reverse()) {
        await sequelize.query(
          `ALTER TABLE IF EXISTS "latticeAutomationRuns" DROP COLUMN IF EXISTS "${col}";`,
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
}

module.exports = FlowSnapshotAndScheduleMigration;
module.exports.default = FlowSnapshotAndScheduleMigration;
