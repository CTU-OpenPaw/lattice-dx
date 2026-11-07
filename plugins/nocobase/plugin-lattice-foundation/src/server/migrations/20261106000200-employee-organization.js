// SPDX-License-Identifier: Apache-2.0
const { Migration } = require('@nocobase/server');

class EmployeeOrganization extends Migration {
  on = 'afterSync';

  async up() {
    await this.context.db.sequelize.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_constraint
          WHERE conrelid = '"latticeEmployees"'::regclass AND conname = 'lattice_employees_department_org') THEN
          ALTER TABLE "latticeEmployees" ADD CONSTRAINT lattice_employees_department_org
            FOREIGN KEY ("departmentId", "organizationId")
            REFERENCES "latticeDepartments" ("id", "organizationId");
        END IF;
      END $$;
    `);
  }
}

module.exports = EmployeeOrganization;
module.exports.default = EmployeeOrganization;
