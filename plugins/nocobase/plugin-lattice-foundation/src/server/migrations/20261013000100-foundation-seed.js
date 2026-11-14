/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
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
}
module.exports = FoundationSeed;
module.exports.default = FoundationSeed;
