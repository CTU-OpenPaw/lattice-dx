/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const { Migration } = require('@nocobase/server');
const { installIncidentPortalReadGrants } = require('../native-roles');

class IncidentPortalReadGrants extends Migration {
  on = 'afterSync';
  async up() {
    await installIncidentPortalReadGrants(this.context.db);
  }
}

module.exports = IncidentPortalReadGrants;
module.exports.default = IncidentPortalReadGrants;
