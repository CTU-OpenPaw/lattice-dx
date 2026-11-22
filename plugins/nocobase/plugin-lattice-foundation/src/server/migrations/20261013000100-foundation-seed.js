/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const { Migration } = require('@nocobase/server');
const { seedFoundation } = require('../seed');
class FoundationSeed extends Migration {
  on = 'afterSync';
  async up() {
    const db = this.context.db;
    await db.sequelize.transaction((transaction) => seedFoundation(db, transaction));
  }
  async down() {
    const db = this.context.db;
    const targets = [
      ['latticeAssets', ['DEMO-ASSET-01', 'DEMO-ASSET-02']],
      ['latticeLocations', ['DEMO-LOC-01', 'DEMO-LOC-02']],
      ['latticeEmployees', ['DEMO-EMP-01', 'DEMO-EMP-02']],
      ['latticeDepartments', ['DEMO-UNIT-01', 'DEMO-UNIT-02']],
    ];
    await db.sequelize.transaction(async (transaction) => {
      for (const [collection, codes] of targets) {
        if (!db.hasCollection?.(collection)) continue;
        await db.getRepository(collection)?.destroy({ filter: { code: { $in: codes } }, transaction });
      }
    });
  }
}
module.exports = FoundationSeed;
module.exports.default = FoundationSeed;
