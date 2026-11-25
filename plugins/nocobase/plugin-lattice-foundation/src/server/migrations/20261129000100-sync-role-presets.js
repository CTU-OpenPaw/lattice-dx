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
const { installRolePresets } = require('../native-roles');

class SyncRolePresets extends Migration {
  on = 'afterSync';

  async up() {
    await installRolePresets(this.context.db);
  }

  async down() {}
}

module.exports = SyncRolePresets;
module.exports.default = SyncRolePresets;
