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

class DxosUiSnapshotsInit extends Migration {
  on = 'afterSync';

  async up() {
    const db = this.context.db;
    const collections = db.getRepository?.('collections');
    if (collections && typeof collections.db2cm === 'function') {
      if (db.hasCollection?.('latticeUiSnapshots') && !(await collections.findOne({ filter: { name: 'latticeUiSnapshots' } }))) {
        await collections.db2cm('latticeUiSnapshots');
      }
    }
  }
}

module.exports = DxosUiSnapshotsInit;
module.exports.default = DxosUiSnapshotsInit;
