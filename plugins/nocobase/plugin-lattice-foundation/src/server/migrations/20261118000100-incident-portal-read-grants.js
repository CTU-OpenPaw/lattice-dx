// SPDX-License-Identifier: Apache-2.0
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
