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
const { installServiceRoleGrants } = require('../service-roles');

class DxosServiceTicketsInit extends Migration {
  on = 'afterSync';

  async up() {
    const db = this.context.db;
    const collections = db.getRepository('collections');
    if (collections && typeof collections.db2cm === 'function' && db.hasCollection?.('latticeServiceTickets')) {
      if (!(await collections.findOne({ filter: { name: 'latticeServiceTickets' } }))) {
        await collections.db2cm('latticeServiceTickets');
      }
    }
    await installServiceRoleGrants(db);
  }

  async down() {
    const db = this.context.db;
    await db.getRepository?.('rolesResources')?.destroy({
      filter: {
        name: 'latticeServiceTickets',
        roleName: { $in: ['ldx_employee', 'ldx_manager', 'ldx_warehouse', 'ldx_dispatcher', 'ldx_driver', 'ldx_director', 'ldx_admin'] },
      },
    });
    await db.getRepository?.('collections')?.destroy({ filter: { name: 'latticeServiceTickets' } });
  }
}

module.exports = DxosServiceTicketsInit;
module.exports.default = DxosServiceTicketsInit;
