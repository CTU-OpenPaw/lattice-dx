/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const path = require('node:path');
const { Migration } = require('@nocobase/server');

function loadPgRls() {
  const inDist = __dirname.includes(`${path.sep}dist${path.sep}`);
  const candidates = inDist
    ? [
        '../../../../plugin-lattice-foundation/dist/server/pg-rls',
        '../../../../plugin-lattice-foundation/src/server/pg-rls',
      ]
    : [
        '../../../../plugin-lattice-foundation/src/server/pg-rls',
        '../../../../plugin-lattice-foundation/dist/server/pg-rls',
      ];
  for (const modPath of candidates) {
    try {
      const mod = require(modPath);
      if (mod && typeof mod.attachRlsPolicyToTable === 'function') return mod;
    } catch (err) {
      const isDirectMissing = err?.code === 'MODULE_NOT_FOUND'
        && (!Array.isArray(err.requireStack) || err.requireStack.length === 0 || err.requireStack[0] === __filename);
      if (!isDirectMissing) throw err;
    }
  }
  return null;
}

const TABLES = [
  'latticeOrderLines',
  'latticeStockLots',
  'latticeEpodRecords',
  'latticeDecisionTables',
  'latticeDelegations',
];

const INDEXES = [
  'idx_lattice_delegation_org_delegate',
  'uidx_lattice_delegation_org_uid',
  'uidx_lattice_dmn_org_key',
  'idx_lattice_epod_org_order',
  'uidx_lattice_epod_tracking_code',
  'uidx_lattice_epod_org_uid',
  'idx_lattice_stock_lots_org_fefo',
  'uidx_lattice_stock_lots_org_code',
  'idx_lattice_order_lines_org_sku',
  'uidx_lattice_order_lines_org_order_line',
];

class WmsEpodDmnDelegationsMigration extends Migration {
  on = 'afterSync';

  async up() {
    const db = this.context.db;
    const { sequelize } = db;
    const isPostgres = typeof sequelize?.getDialect === 'function' && sequelize.getDialect() === 'postgres';
    const pgRls = loadPgRls();

    await sequelize.transaction(async (transaction) => {
      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS "latticeOrderLines" (
          id BIGSERIAL PRIMARY KEY,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "organizationId" VARCHAR(255) NOT NULL,
          "orderId" BIGINT,
          "orderCode" VARCHAR(255),
          "lineNo" INTEGER NOT NULL DEFAULT 1,
          sku VARCHAR(255) NOT NULL,
          "productName" VARCHAR(255) NOT NULL,
          "lotId" BIGINT,
          "lotCode" VARCHAR(255),
          "requestedQty" DOUBLE PRECISION NOT NULL,
          "allocatedQty" DOUBLE PRECISION NOT NULL DEFAULT 0,
          unit VARCHAR(64) DEFAULT 'UNIT',
          "targetTempMinC" DOUBLE PRECISION,
          "targetTempMaxC" DOUBLE PRECISION,
          status VARCHAR(64) DEFAULT 'pending',
          notes TEXT
        );
      `, { transaction });

      await sequelize.query(
        'CREATE UNIQUE INDEX IF NOT EXISTS uidx_lattice_order_lines_org_order_line ON "latticeOrderLines" ("organizationId", "orderCode", "lineNo");',
        { transaction },
      );
      await sequelize.query(
        'CREATE INDEX IF NOT EXISTS idx_lattice_order_lines_org_sku ON "latticeOrderLines" ("organizationId", sku, status);',
        { transaction },
      );

      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS "latticeStockLots" (
          id BIGSERIAL PRIMARY KEY,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "organizationId" VARCHAR(255) NOT NULL,
          "lotCode" VARCHAR(255) NOT NULL,
          sku VARCHAR(255) NOT NULL,
          "productName" VARCHAR(255) NOT NULL,
          "warehouseLocationId" BIGINT,
          "warehouseCode" VARCHAR(128),
          "assetEntityId" VARCHAR(255),
          "qtyOnHand" DOUBLE PRECISION NOT NULL DEFAULT 0,
          "qtyReserved" DOUBLE PRECISION NOT NULL DEFAULT 0,
          unit VARCHAR(64) DEFAULT 'UNIT',
          "expiryDate" TIMESTAMPTZ NOT NULL,
          "manufacturedAt" TIMESTAMPTZ,
          "targetTempMinC" DOUBLE PRECISION,
          "targetTempMaxC" DOUBLE PRECISION,
          "mktCelsius" DOUBLE PRECISION,
          status VARCHAR(64) DEFAULT 'available',
          "holdReason" TEXT,
          "heldAt" TIMESTAMPTZ,
          "heldBy" VARCHAR(255),
          active BOOLEAN NOT NULL DEFAULT TRUE
        );
      `, { transaction });

      await sequelize.query(
        'CREATE UNIQUE INDEX IF NOT EXISTS uidx_lattice_stock_lots_org_code ON "latticeStockLots" ("organizationId", "lotCode");',
        { transaction },
      );
      await sequelize.query(
        'CREATE INDEX IF NOT EXISTS idx_lattice_stock_lots_org_fefo ON "latticeStockLots" ("organizationId", sku, status, "expiryDate");',
        { transaction },
      );

      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS "latticeEpodRecords" (
          id BIGSERIAL PRIMARY KEY,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "organizationId" VARCHAR(255) NOT NULL,
          "epodUid" VARCHAR(255) NOT NULL,
          "trackingCode" VARCHAR(255) NOT NULL,
          "trackingTokenHash" VARCHAR(128) NOT NULL,
          "orderId" BIGINT,
          "orderCode" VARCHAR(255),
          "driverUserId" BIGINT,
          "driverEmployeeId" BIGINT,
          "recipientName" VARCHAR(255) NOT NULL,
          "recipientPhoneMasked" VARCHAR(64),
          "deliveredQty" DOUBLE PRECISION DEFAULT 0,
          "signatureDataUrl" TEXT,
          "signatureSha256" VARCHAR(128) NOT NULL,
          "gpsLat" DOUBLE PRECISION,
          "gpsLng" DOUBLE PRECISION,
          "gpsAccuracyM" DOUBLE PRECISION,
          "photoHashesJson" JSONB,
          "tempSummaryJson" JSONB,
          "ledgerSeq" BIGINT,
          "ledgerSignatureBase64" TEXT,
          "keyId" VARCHAR(128),
          status VARCHAR(64) DEFAULT 'delivered',
          "deliveredAt" TIMESTAMPTZ NOT NULL,
          notes TEXT
        );
      `, { transaction });

      await sequelize.query(
        'CREATE UNIQUE INDEX IF NOT EXISTS uidx_lattice_epod_org_uid ON "latticeEpodRecords" ("organizationId", "epodUid");',
        { transaction },
      );
      await sequelize.query(
        'CREATE UNIQUE INDEX IF NOT EXISTS uidx_lattice_epod_tracking_code ON "latticeEpodRecords" ("trackingCode");',
        { transaction },
      );
      await sequelize.query(
        'CREATE INDEX IF NOT EXISTS idx_lattice_epod_org_order ON "latticeEpodRecords" ("organizationId", "orderCode");',
        { transaction },
      );

      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS "latticeDecisionTables" (
          id BIGSERIAL PRIMARY KEY,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "organizationId" VARCHAR(255) NOT NULL,
          "tableKey" VARCHAR(128) NOT NULL,
          name VARCHAR(255) NOT NULL,
          description TEXT,
          "hitPolicy" VARCHAR(32) DEFAULT 'FIRST',
          "inputsJson" JSONB NOT NULL,
          "outputsJson" JSONB NOT NULL,
          "rulesJson" JSONB NOT NULL,
          version INTEGER DEFAULT 1,
          published BOOLEAN DEFAULT TRUE,
          "updatedBy" VARCHAR(255),
          active BOOLEAN NOT NULL DEFAULT TRUE
        );
      `, { transaction });

      await sequelize.query(
        'CREATE UNIQUE INDEX IF NOT EXISTS uidx_lattice_dmn_org_key ON "latticeDecisionTables" ("organizationId", "tableKey");',
        { transaction },
      );

      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS "latticeDelegations" (
          id BIGSERIAL PRIMARY KEY,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "organizationId" VARCHAR(255) NOT NULL,
          "delegationUid" VARCHAR(255) NOT NULL,
          "delegatorUserId" BIGINT NOT NULL,
          "delegatorEmployeeId" BIGINT,
          "delegateUserId" BIGINT NOT NULL,
          "delegateEmployeeId" BIGINT,
          "roleName" VARCHAR(128) NOT NULL,
          "scopeCollection" VARCHAR(128),
          reason TEXT,
          "startsAt" TIMESTAMPTZ NOT NULL,
          "endsAt" TIMESTAMPTZ NOT NULL,
          status VARCHAR(64) DEFAULT 'active',
          "revokedBy" VARCHAR(255),
          "revokedAt" TIMESTAMPTZ,
          active BOOLEAN NOT NULL DEFAULT TRUE
        );
      `, { transaction });

      await sequelize.query(
        'CREATE UNIQUE INDEX IF NOT EXISTS uidx_lattice_delegation_org_uid ON "latticeDelegations" ("organizationId", "delegationUid");',
        { transaction },
      );
      await sequelize.query(
        'CREATE INDEX IF NOT EXISTS idx_lattice_delegation_org_delegate ON "latticeDelegations" ("organizationId", "delegateUserId", status);',
        { transaction },
      );

      if (isPostgres) {
        for (const tableName of TABLES) {
          if (typeof db.attachLatticeRlsPolicy === 'function') {
            await db.attachLatticeRlsPolicy(tableName, { transaction });
          } else if (pgRls && typeof pgRls.attachRlsPolicyToTable === 'function') {
            await pgRls.attachRlsPolicyToTable(db, tableName, { transaction });
          }
        }
      }
    });
  }

  async down() {
    const db = this.context.db;
    const { sequelize } = db;
    const isPostgres = typeof sequelize?.getDialect === 'function' && sequelize.getDialect() === 'postgres';
    const pgRls = loadPgRls();

    await sequelize.transaction(async (transaction) => {
      if (isPostgres) {
        for (const tableName of [...TABLES].reverse()) {
          if (typeof db.detachLatticeRlsPolicy === 'function') {
            await db.detachLatticeRlsPolicy(tableName, { transaction });
          } else if (pgRls && typeof pgRls.detachRlsPolicyFromTable === 'function') {
            await pgRls.detachRlsPolicyFromTable(db, tableName, { transaction });
          } else {
            await sequelize.query(`DROP POLICY IF EXISTS lattice_tenant_isolation ON public."${tableName}";`, { transaction });
            await sequelize.query(`ALTER TABLE IF EXISTS public."${tableName}" DISABLE ROW LEVEL SECURITY;`, { transaction });
          }
        }
      }

      for (const indexName of INDEXES) {
        await sequelize.query(`DROP INDEX IF EXISTS ${indexName};`, { transaction });
      }
      for (const tableName of [...TABLES].reverse()) {
        await sequelize.query(`DROP TABLE IF EXISTS "${tableName}";`, { transaction });
      }
    });
  }
}

module.exports = WmsEpodDmnDelegationsMigration;
module.exports.default = WmsEpodDmnDelegationsMigration;
