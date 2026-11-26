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

class NormalizeSlaEscalateRoleMigration extends Migration {
  on = 'afterSync';

  async up() {
    const db = this.db || this.context?.db;
    const sequelize = db?.sequelize;
    if (!sequelize) return;

    const dialect = typeof sequelize.getDialect === 'function' ? sequelize.getDialect() : 'postgres';
    if (dialect !== 'postgres') return;

    const runUp = async (transaction) => {
      const txOpt = transaction ? { transaction } : undefined;
      await sequelize.query("SELECT set_config('app.current_org', '*', true)", txOpt).catch(() => {});
      const [rows] = await sequelize.query('SELECT to_regclass(\'"latticeSlaPolicies"\') AS tbl', txOpt);
      if (!rows?.[0]?.tbl) return;
      await sequelize.query(
        'UPDATE "latticeSlaPolicies" SET "escalateToRole" = \'ldx_manager\', "updatedAt" = NOW() WHERE "escalateToRole" IN (\'ldx_admin\', \'root\', \'admin\')',
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
    // Irreversible data normalization (legacy forbidden SLA role -> ldx_manager)
  }
}

module.exports = NormalizeSlaEscalateRoleMigration;
module.exports.default = NormalizeSlaEscalateRoleMigration;
