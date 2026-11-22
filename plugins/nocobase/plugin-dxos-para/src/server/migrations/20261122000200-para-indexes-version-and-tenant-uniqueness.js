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

const INDEXES = [
  ['uidx_lattice_para_org_code', ['organizationId', 'code'], true],
  ['idx_lattice_para_org_space_status', ['organizationId', 'paraSpace', 'status'], false],
  ['idx_lattice_para_org_owner_active', ['organizationId', 'ownerId', 'active'], false],
  ['idx_lattice_para_org_department', ['organizationId', 'departmentId'], false],
];

class ParaIndexesVersionAndTenantUniqueness extends Migration {
  on = 'afterSync';

  async up() {
    const { sequelize } = this.context.db;
    await sequelize.transaction(async (transaction) => {
      await sequelize.query('ALTER TABLE "latticeParaDocuments" DROP CONSTRAINT IF EXISTS "latticeParaDocuments_code_key";', { transaction });
      await sequelize.query('DROP INDEX IF EXISTS "latticeParaDocuments_code_key";', { transaction });
      await sequelize.query('ALTER TABLE "latticeParaDocuments" ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;', { transaction });
      for (const [name, cols, unique] of INDEXES) {
        const colSql = cols.map((c) => `"${c}"`).join(', ');
        await sequelize.query(`CREATE ${unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS "${name}" ON "latticeParaDocuments" (${colSql});`, { transaction });
      }
    });
  }

  async down() {
    const { sequelize } = this.context.db;
    await sequelize.transaction(async (transaction) => {
      for (const [name] of [...INDEXES].reverse()) {
        await sequelize.query(`DROP INDEX IF EXISTS "${name}";`, { transaction });
      }
      await sequelize.query('ALTER TABLE "latticeParaDocuments" DROP COLUMN IF EXISTS version;', { transaction });
      await sequelize.query(
        `DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"latticeParaDocuments"'::regclass AND conname = 'latticeParaDocuments_code_key') THEN
            ALTER TABLE "latticeParaDocuments" ADD CONSTRAINT "latticeParaDocuments_code_key" UNIQUE (code);
          END IF;
        EXCEPTION WHEN unique_violation THEN
          NULL;
        END $$;`,
        { transaction },
      );
    });
  }
}

module.exports = ParaIndexesVersionAndTenantUniqueness;
module.exports.default = ParaIndexesVersionAndTenantUniqueness;
