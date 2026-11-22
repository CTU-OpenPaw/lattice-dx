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

class RecordChatterTableMigration extends Migration {
  on = 'afterSync';

  async up() {
    const { sequelize } = this.context.db;
    await sequelize.transaction(async (transaction) => {
      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS "latticeRecordChatter" (
          id BIGSERIAL PRIMARY KEY,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "organizationId" VARCHAR(255) NOT NULL,
          "targetCollection" VARCHAR(255) NOT NULL,
          "targetRecordId" BIGINT NOT NULL,
          "entryType" VARCHAR(255) NOT NULL DEFAULT 'comment',
          body TEXT NOT NULL,
          "mentionsJson" JSON,
          "diffJson" JSON,
          "authorUserId" BIGINT,
          "authorEmployeeId" BIGINT,
          "authorName" VARCHAR(255) NOT NULL
        );
      `, { transaction });
      await sequelize.query(
        'CREATE INDEX IF NOT EXISTS idx_lattice_chatter_org_target ON "latticeRecordChatter" ("organizationId", "targetCollection", "targetRecordId", "createdAt");',
        { transaction },
      );
      await sequelize.query(
        'CREATE INDEX IF NOT EXISTS idx_lattice_chatter_org_type ON "latticeRecordChatter" ("organizationId", "entryType", "createdAt");',
        { transaction },
      );
      await sequelize.query(
        'CREATE INDEX IF NOT EXISTS idx_lattice_chatter_org_author ON "latticeRecordChatter" ("organizationId", "authorUserId", "createdAt");',
        { transaction },
      );
    });
  }

  async down() {
    const { sequelize } = this.context.db;
    await sequelize.transaction(async (transaction) => {
      await sequelize.query('DROP INDEX IF EXISTS idx_lattice_chatter_org_author;', { transaction });
      await sequelize.query('DROP INDEX IF EXISTS idx_lattice_chatter_org_type;', { transaction });
      await sequelize.query('DROP INDEX IF EXISTS idx_lattice_chatter_org_target;', { transaction });
      await sequelize.query('DROP TABLE IF EXISTS "latticeRecordChatter";', { transaction });
    });
  }
}

module.exports = RecordChatterTableMigration;
module.exports.default = RecordChatterTableMigration;
