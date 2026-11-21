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
const { installAiRoleGrants } = require('../ai-sync');

class DxosAiWorkforceInit extends Migration {
  on = 'afterSync';

  async up() {
    const db = this.context.db;
    const collections = db.getRepository('collections');
    if (collections && typeof collections.db2cm === 'function') {
      for (const name of ['latticeAiProfiles', 'latticeAiAuditLogs']) {
        if (db.hasCollection?.(name) && !(await collections.findOne({ filter: { name } }))) {
          await collections.db2cm(name);
        }
      }
    }
    await installAiRoleGrants(db);
  }
}

module.exports = DxosAiWorkforceInit;
module.exports.default = DxosAiWorkforceInit;
