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
const { attachRlsPolicyToTable, detachRlsPolicyFromTable } = require('../pg-rls');

const TABLES = ['latticePublicForms', 'latticePublicFormSubmissions'];

class PublicFormsRlsMigration extends Migration {
  on = 'afterSync';

  async up() {
    const db = this.context?.db;
    const sequelize = db?.sequelize;
    if (!sequelize || typeof sequelize.transaction !== 'function') return;
    const isPostgres = typeof sequelize.getDialect === 'function' && sequelize.getDialect() === 'postgres';

    await sequelize.transaction(async (transaction) => {
      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS "latticePublicForms" (
          id BIGSERIAL PRIMARY KEY,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "organizationId" VARCHAR(255) NOT NULL,
          slug VARCHAR(128) NOT NULL,
          title VARCHAR(255) NOT NULL,
          description TEXT,
          "targetCollection" VARCHAR(128) NOT NULL,
          "allowedFieldsJson" JSONB NOT NULL,
          "defaultValuesJson" JSONB,
          "requireAccessToken" BOOLEAN NOT NULL DEFAULT FALSE,
          "accessTokenHash" VARCHAR(128),
          "honeypotField" VARCHAR(64) DEFAULT '_hp_website',
          "rateLimitPerMinute" INTEGER NOT NULL DEFAULT 20,
          "workflowRuleKey" VARCHAR(128),
          active BOOLEAN NOT NULL DEFAULT TRUE,
          "createdByUserId" BIGINT
        );
      `, { transaction });

      await sequelize.query(
        'CREATE UNIQUE INDEX IF NOT EXISTS uidx_lattice_public_forms_slug ON "latticePublicForms" (slug);',
        { transaction },
      );
      await sequelize.query(
        'CREATE INDEX IF NOT EXISTS idx_lattice_public_forms_org_active ON "latticePublicForms" ("organizationId", active);',
        { transaction },
      );

      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS "latticePublicFormSubmissions" (
          id BIGSERIAL PRIMARY KEY,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "organizationId" VARCHAR(255) NOT NULL,
          "formId" BIGINT NOT NULL,
          slug VARCHAR(128) NOT NULL,
          "submissionCode" VARCHAR(64) NOT NULL,
          "statusTokenHash" VARCHAR(128) NOT NULL,
          "targetCollection" VARCHAR(128) NOT NULL,
          "targetRecordId" VARCHAR(128) NOT NULL,
          status VARCHAR(64) NOT NULL DEFAULT 'submitted',
          "submittedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `, { transaction });

      await sequelize.query(
        'CREATE UNIQUE INDEX IF NOT EXISTS uidx_lattice_pfs_org_code ON "latticePublicFormSubmissions" ("organizationId", "submissionCode");',
        { transaction },
      );
      await sequelize.query(
        'CREATE INDEX IF NOT EXISTS idx_lattice_pfs_slug_code ON "latticePublicFormSubmissions" (slug, "submissionCode");',
        { transaction },
      );
      await sequelize.query(
        'CREATE INDEX IF NOT EXISTS idx_lattice_pfs_org_form ON "latticePublicFormSubmissions" ("organizationId", "formId", "submittedAt");',
        { transaction },
      );

      if (isPostgres) {
        for (const tableName of TABLES) {
          if (typeof db.attachLatticeRlsPolicy === 'function') {
            await db.attachLatticeRlsPolicy(tableName, { transaction });
          } else {
            await attachRlsPolicyToTable(db, tableName, { transaction });
          }
        }
      }
    });
  }

  async down() {
    const db = this.context?.db;
    const sequelize = db?.sequelize;
    if (!sequelize || typeof sequelize.transaction !== 'function') return;
    const isPostgres = typeof sequelize.getDialect === 'function' && sequelize.getDialect() === 'postgres';

    await sequelize.transaction(async (transaction) => {
      if (isPostgres) {
        for (const tableName of [...TABLES].reverse()) {
          await detachRlsPolicyFromTable(db, tableName, { transaction });
        }
      }

      await sequelize.query('DROP INDEX IF EXISTS idx_lattice_pfs_org_form;', { transaction });
      await sequelize.query('DROP INDEX IF EXISTS idx_lattice_pfs_slug_code;', { transaction });
      await sequelize.query('DROP INDEX IF EXISTS uidx_lattice_pfs_org_code;', { transaction });
      await sequelize.query('DROP TABLE IF EXISTS "latticePublicFormSubmissions";', { transaction });

      await sequelize.query('DROP INDEX IF EXISTS idx_lattice_public_forms_org_active;', { transaction });
      await sequelize.query('DROP INDEX IF EXISTS uidx_lattice_public_forms_slug;', { transaction });
      await sequelize.query('DROP TABLE IF EXISTS "latticePublicForms";', { transaction });
    });
  }
}

module.exports = PublicFormsRlsMigration;
module.exports.default = PublicFormsRlsMigration;
