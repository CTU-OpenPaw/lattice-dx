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
  ['uidx_lattice_service_tickets_org_code', ['organizationId', 'code'], true],
  ['idx_lattice_service_tickets_org_status_priority', ['organizationId', 'status', 'priority'], false],
  ['idx_lattice_service_tickets_org_requester_status', ['organizationId', 'requesterId', 'status'], false],
  ['idx_lattice_service_tickets_org_assignee', ['organizationId', 'assigneeId'], false],
  ['idx_lattice_service_tickets_org_department', ['organizationId', 'departmentId'], false],
];

class StudioTicketsIndexesAndTenantUniqueness extends Migration {
  on = 'afterSync';

  async up() {
    const { sequelize } = this.context.db;
    await sequelize.transaction(async (transaction) => {
      await sequelize.query('ALTER TABLE "latticeServiceTickets" DROP CONSTRAINT IF EXISTS "latticeServiceTickets_code_key";', { transaction });
      await sequelize.query('DROP INDEX IF EXISTS "latticeServiceTickets_code_key";', { transaction });
      for (const [name, cols, unique] of INDEXES) {
        const colSql = cols.map((c) => `"${c}"`).join(', ');
        await sequelize.query(`CREATE ${unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS "${name}" ON "latticeServiceTickets" (${colSql});`, { transaction });
      }
    });
  }

  async down() {
    const { sequelize } = this.context.db;
    await sequelize.transaction(async (transaction) => {
      for (const [name] of [...INDEXES].reverse()) {
        await sequelize.query(`DROP INDEX IF EXISTS "${name}";`, { transaction });
      }
      await sequelize.query(
        `DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"latticeServiceTickets"'::regclass AND conname = 'latticeServiceTickets_code_key') THEN
            ALTER TABLE "latticeServiceTickets" ADD CONSTRAINT "latticeServiceTickets_code_key" UNIQUE (code);
          END IF;
        EXCEPTION WHEN unique_violation THEN
          NULL;
        END $$;`,
        { transaction },
      );
    });
  }
}

module.exports = StudioTicketsIndexesAndTenantUniqueness;
module.exports.default = StudioTicketsIndexesAndTenantUniqueness;
