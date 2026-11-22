/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const { Migration } = require('@nocobase/server');

class AssetOrganization extends Migration {
  on = 'afterSync';

  async up() {
    const { sequelize } = this.context.db;
    await sequelize.transaction(async transaction => {
      await sequelize.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS lattice_departments_id_org
          ON "latticeDepartments" ("id", "organizationId");
        CREATE UNIQUE INDEX IF NOT EXISTS lattice_employees_id_org
          ON "latticeEmployees" ("id", "organizationId");

        DO $$
        BEGIN
          IF NOT EXISTS (SELECT FROM pg_constraint
            WHERE conrelid = '"latticeAssets"'::regclass AND conname = 'lattice_assets_department_org') THEN
            ALTER TABLE "latticeAssets" ADD CONSTRAINT lattice_assets_department_org
              FOREIGN KEY ("departmentId", "organizationId")
              REFERENCES "latticeDepartments" ("id", "organizationId");
          END IF;
          IF NOT EXISTS (SELECT FROM pg_constraint
            WHERE conrelid = '"latticeAssets"'::regclass AND conname = 'lattice_assets_custodian_org') THEN
            ALTER TABLE "latticeAssets" ADD CONSTRAINT lattice_assets_custodian_org
              FOREIGN KEY ("custodianId", "organizationId")
              REFERENCES "latticeEmployees" ("id", "organizationId");
          END IF;
        END $$;
      `, { transaction });
    });
  }

  async down() {
    const { sequelize } = this.context.db;
    await sequelize.transaction(async transaction => {
      await sequelize.query(`
        ALTER TABLE "latticeAssets" DROP CONSTRAINT IF EXISTS lattice_assets_department_org;
        ALTER TABLE "latticeAssets" DROP CONSTRAINT IF EXISTS lattice_assets_custodian_org;
        DROP INDEX IF EXISTS lattice_departments_id_org;
        DROP INDEX IF EXISTS lattice_employees_id_org;
      `, { transaction });
    });
  }
}

module.exports = AssetOrganization;
module.exports.default = AssetOrganization;
