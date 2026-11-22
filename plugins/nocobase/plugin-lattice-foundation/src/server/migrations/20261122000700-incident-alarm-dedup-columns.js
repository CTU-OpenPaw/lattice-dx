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

class IncidentAlarmDedupColumns extends Migration {
  on = 'afterSync';

  async up() {
    const { sequelize } = this.context.db;
    await sequelize.transaction(async (transaction) => {
      await sequelize.query('ALTER TABLE "latticeIncidentCases" ADD COLUMN IF NOT EXISTS fingerprint varchar(255);', { transaction });
      await sequelize.query('ALTER TABLE "latticeIncidentCases" ADD COLUMN IF NOT EXISTS "occurrenceCount" integer NOT NULL DEFAULT 1;', { transaction });
      await sequelize.query('ALTER TABLE "latticeIncidentCases" ADD COLUMN IF NOT EXISTS "firstSeenAt" timestamptz;', { transaction });
      await sequelize.query('ALTER TABLE "latticeIncidentCases" ADD COLUMN IF NOT EXISTS "lastSeenAt" timestamptz;', { transaction });
      await sequelize.query('ALTER TABLE "latticeIncidentCases" ADD COLUMN IF NOT EXISTS "acknowledgedAt" timestamptz;', { transaction });
      await sequelize.query('ALTER TABLE "latticeIncidentCases" ADD COLUMN IF NOT EXISTS "acknowledgedBy" varchar(255);', { transaction });
      await sequelize.query('ALTER TABLE "latticeIncidentCases" ADD COLUMN IF NOT EXISTS "clearedAt" timestamptz;', { transaction });
      await sequelize.query('ALTER TABLE "latticeIncidentCases" ADD COLUMN IF NOT EXISTS "clearedBy" varchar(255);', { transaction });
      await sequelize.query(
        'CREATE INDEX IF NOT EXISTS idx_lattice_incident_cases_dedup ON "latticeIncidentCases" ("organizationId", "assetEntityId", fingerprint, status);',
        { transaction },
      );
    });
  }

  async down() {
    const { sequelize } = this.context.db;
    await sequelize.transaction(async (transaction) => {
      await sequelize.query('DROP INDEX IF EXISTS idx_lattice_incident_cases_dedup;', { transaction });
      await sequelize.query('ALTER TABLE "latticeIncidentCases" DROP COLUMN IF EXISTS "clearedBy";', { transaction });
      await sequelize.query('ALTER TABLE "latticeIncidentCases" DROP COLUMN IF EXISTS "clearedAt";', { transaction });
      await sequelize.query('ALTER TABLE "latticeIncidentCases" DROP COLUMN IF EXISTS "acknowledgedBy";', { transaction });
      await sequelize.query('ALTER TABLE "latticeIncidentCases" DROP COLUMN IF EXISTS "acknowledgedAt";', { transaction });
      await sequelize.query('ALTER TABLE "latticeIncidentCases" DROP COLUMN IF EXISTS "lastSeenAt";', { transaction });
      await sequelize.query('ALTER TABLE "latticeIncidentCases" DROP COLUMN IF EXISTS "firstSeenAt";', { transaction });
      await sequelize.query('ALTER TABLE "latticeIncidentCases" DROP COLUMN IF EXISTS "occurrenceCount";', { transaction });
      await sequelize.query('ALTER TABLE "latticeIncidentCases" DROP COLUMN IF EXISTS fingerprint;', { transaction });
    });
  }
}

module.exports = IncidentAlarmDedupColumns;
module.exports.default = IncidentAlarmDedupColumns;
