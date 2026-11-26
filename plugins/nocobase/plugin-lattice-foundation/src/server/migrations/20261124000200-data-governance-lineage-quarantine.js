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

const TABLES = ['latticeFrozenSnapshots', 'latticeDataLineage', 'latticeDataQuarantine'];

class DataGovernanceLineageQuarantineMigration extends Migration {
  on = 'afterSync';

  async up() {
    const db = this.context.db;
    const { sequelize } = db;
    const isPostgres = typeof sequelize?.getDialect === 'function' && sequelize.getDialect() === 'postgres';

    await sequelize.transaction(async (transaction) => {
      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS "latticeFrozenSnapshots" (
          id BIGSERIAL PRIMARY KEY,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "organizationId" VARCHAR(255) NOT NULL,
          "snapshotUid" VARCHAR(128) NOT NULL,
          tier VARCHAR(32) NOT NULL DEFAULT 'cold',
          "sourceCollection" VARCHAR(255) NOT NULL,
          "filterSummary" JSONB,
          "recordCount" INTEGER NOT NULL,
          "payloadJson" JSONB NOT NULL,
          "payloadHash" VARCHAR(128) NOT NULL,
          "ledgerEntrySeq" BIGINT,
          "signatureBase64" TEXT,
          "keyId" VARCHAR(128),
          "frozenAt" TIMESTAMPTZ NOT NULL,
          "frozenBy" VARCHAR(255),
          "retentionDays" INTEGER NOT NULL DEFAULT 1825,
          "expiresAt" TIMESTAMPTZ,
          "coldStorageUri" VARCHAR(512),
          status VARCHAR(64) NOT NULL DEFAULT 'sealed',
          active BOOLEAN NOT NULL DEFAULT TRUE
        );
      `, { transaction });

      await sequelize.query(
        'CREATE UNIQUE INDEX IF NOT EXISTS uidx_lattice_frozen_org_uid ON "latticeFrozenSnapshots" ("organizationId", "snapshotUid");',
        { transaction },
      );
      await sequelize.query(
        'CREATE INDEX IF NOT EXISTS idx_lattice_frozen_org_col_tier ON "latticeFrozenSnapshots" ("organizationId", "sourceCollection", tier, "frozenAt");',
        { transaction },
      );

      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS "latticeDataLineage" (
          id BIGSERIAL PRIMARY KEY,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "organizationId" VARCHAR(255) NOT NULL,
          "edgeUid" VARCHAR(128) NOT NULL,
          "sourceCollection" VARCHAR(255) NOT NULL,
          "sourceRecordId" VARCHAR(255) NOT NULL,
          "targetCollection" VARCHAR(255) NOT NULL,
          "targetRecordId" VARCHAR(255) NOT NULL,
          "relationType" VARCHAR(128) NOT NULL,
          "actorName" VARCHAR(255),
          "metadataJson" JSONB,
          "observedAt" TIMESTAMPTZ NOT NULL
        );
      `, { transaction });

      await sequelize.query(
        'CREATE UNIQUE INDEX IF NOT EXISTS uidx_lattice_lineage_org_edge ON "latticeDataLineage" ("organizationId", "edgeUid");',
        { transaction },
      );
      await sequelize.query(
        'CREATE INDEX IF NOT EXISTS idx_lattice_lineage_org_source ON "latticeDataLineage" ("organizationId", "sourceCollection", "sourceRecordId");',
        { transaction },
      );
      await sequelize.query(
        'CREATE INDEX IF NOT EXISTS idx_lattice_lineage_org_target ON "latticeDataLineage" ("organizationId", "targetCollection", "targetRecordId");',
        { transaction },
      );

      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS "latticeDataQuarantine" (
          id BIGSERIAL PRIMARY KEY,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "organizationId" VARCHAR(255) NOT NULL,
          "quarantineUid" VARCHAR(128) NOT NULL,
          "sourceSystem" VARCHAR(64) NOT NULL DEFAULT 'iiot',
          "assetEntityId" VARCHAR(255),
          "metricName" VARCHAR(128),
          "numericValue" DOUBLE PRECISION,
          unit VARCHAR(64),
          "reasonCode" VARCHAR(128) NOT NULL,
          severity VARCHAR(32) NOT NULL DEFAULT 'medium',
          "rawPayload" JSONB NOT NULL,
          status VARCHAR(64) NOT NULL DEFAULT 'quarantined',
          "resolvedBy" VARCHAR(255),
          "resolvedAt" TIMESTAMPTZ,
          "resolutionNote" VARCHAR(512),
          active BOOLEAN NOT NULL DEFAULT TRUE
        );
      `, { transaction });

      await sequelize.query(
        'CREATE UNIQUE INDEX IF NOT EXISTS uidx_lattice_quarantine_org_uid ON "latticeDataQuarantine" ("organizationId", "quarantineUid");',
        { transaction },
      );
      await sequelize.query(
        'CREATE INDEX IF NOT EXISTS idx_lattice_quarantine_org_status ON "latticeDataQuarantine" ("organizationId", status, "createdAt");',
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
    const db = this.context.db;
    const { sequelize } = db;
    const isPostgres = typeof sequelize?.getDialect === 'function' && sequelize.getDialect() === 'postgres';

    await sequelize.transaction(async (transaction) => {
      if (isPostgres) {
        for (const tableName of [...TABLES].reverse()) {
          await detachRlsPolicyFromTable(db, tableName, { transaction });
        }
      }

      await sequelize.query('DROP INDEX IF EXISTS idx_lattice_quarantine_org_status;', { transaction });
      await sequelize.query('DROP INDEX IF EXISTS uidx_lattice_quarantine_org_uid;', { transaction });
      await sequelize.query('DROP TABLE IF EXISTS "latticeDataQuarantine";', { transaction });

      await sequelize.query('DROP INDEX IF EXISTS idx_lattice_lineage_org_target;', { transaction });
      await sequelize.query('DROP INDEX IF EXISTS idx_lattice_lineage_org_source;', { transaction });
      await sequelize.query('DROP INDEX IF EXISTS uidx_lattice_lineage_org_edge;', { transaction });
      await sequelize.query('DROP TABLE IF EXISTS "latticeDataLineage";', { transaction });

      await sequelize.query('DROP INDEX IF EXISTS idx_lattice_frozen_org_col_tier;', { transaction });
      await sequelize.query('DROP INDEX IF EXISTS uidx_lattice_frozen_org_uid;', { transaction });
      await sequelize.query('DROP TABLE IF EXISTS "latticeFrozenSnapshots";', { transaction });
    });
  }
}

module.exports = DataGovernanceLineageQuarantineMigration;
module.exports.default = DataGovernanceLineageQuarantineMigration;
