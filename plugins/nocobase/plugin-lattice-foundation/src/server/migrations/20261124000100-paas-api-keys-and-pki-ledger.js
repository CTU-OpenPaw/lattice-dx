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

const TABLES = ['latticeApiKeys', 'latticePkiKeys', 'latticeCryptoLedger'];

class PaasApiKeysAndPkiLedgerMigration extends Migration {
  on = 'afterSync';

  async up() {
    const db = this.context.db;
    const { sequelize } = db;
    const isPostgres = typeof sequelize?.getDialect === 'function' && sequelize.getDialect() === 'postgres';

    await sequelize.transaction(async (transaction) => {
      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS "latticeApiKeys" (
          id BIGSERIAL PRIMARY KEY,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "organizationId" VARCHAR(255) NOT NULL,
          name VARCHAR(255) NOT NULL,
          "keyPrefix" VARCHAR(64) NOT NULL,
          "keyHash" VARCHAR(128) NOT NULL,
          "userId" BIGINT NOT NULL,
          "employeeId" BIGINT,
          "roleName" VARCHAR(128) NOT NULL,
          "scopesJson" JSONB,
          "expiresAt" TIMESTAMPTZ,
          "lastUsedAt" TIMESTAMPTZ,
          "revokedAt" TIMESTAMPTZ,
          "revokedBy" VARCHAR(255),
          "createdByUserId" BIGINT,
          active BOOLEAN NOT NULL DEFAULT TRUE
        );
      `, { transaction });

      await sequelize.query(
        'CREATE UNIQUE INDEX IF NOT EXISTS uidx_lattice_api_keys_hash ON "latticeApiKeys" ("keyHash");',
        { transaction },
      );
      await sequelize.query(
        'CREATE INDEX IF NOT EXISTS idx_lattice_api_keys_org_user ON "latticeApiKeys" ("organizationId", "userId", active);',
        { transaction },
      );
      await sequelize.query(
        'CREATE INDEX IF NOT EXISTS idx_lattice_api_keys_org_prefix ON "latticeApiKeys" ("organizationId", "keyPrefix");',
        { transaction },
      );

      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS "latticePkiKeys" (
          id BIGSERIAL PRIMARY KEY,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "organizationId" VARCHAR(255) NOT NULL,
          "keyId" VARCHAR(128) NOT NULL,
          algorithm VARCHAR(64) NOT NULL DEFAULT 'Ed25519',
          "publicKeyPem" TEXT NOT NULL,
          "encryptedPrivateKey" TEXT NOT NULL,
          "fingerprintSha256" VARCHAR(128) NOT NULL,
          active BOOLEAN NOT NULL DEFAULT TRUE
        );
      `, { transaction });

      await sequelize.query(
        'CREATE UNIQUE INDEX IF NOT EXISTS uidx_lattice_pki_keys_org ON "latticePkiKeys" ("organizationId");',
        { transaction },
      );
      await sequelize.query(
        'CREATE INDEX IF NOT EXISTS idx_lattice_pki_keys_key_id ON "latticePkiKeys" ("keyId");',
        { transaction },
      );

      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS "latticeCryptoLedger" (
          id BIGSERIAL PRIMARY KEY,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "organizationId" VARCHAR(255) NOT NULL,
          seq BIGINT NOT NULL,
          "eventType" VARCHAR(128) NOT NULL,
          "targetCollection" VARCHAR(255) NOT NULL,
          "targetRecordId" VARCHAR(255) NOT NULL,
          "actorUserId" VARCHAR(128),
          "actorName" VARCHAR(255),
          "payloadHash" VARCHAR(128) NOT NULL,
          "prevHash" VARCHAR(128) NOT NULL,
          "entryHash" VARCHAR(128) NOT NULL,
          "merkleRoot" VARCHAR(128) NOT NULL,
          "signatureBase64" TEXT NOT NULL,
          "keyId" VARCHAR(128) NOT NULL,
          "metadataJson" JSONB,
          "recordedAt" TIMESTAMPTZ NOT NULL
        );
      `, { transaction });

      await sequelize.query(
        'CREATE UNIQUE INDEX IF NOT EXISTS uidx_lattice_ledger_org_seq ON "latticeCryptoLedger" ("organizationId", seq);',
        { transaction },
      );
      await sequelize.query(
        'CREATE INDEX IF NOT EXISTS idx_lattice_ledger_org_target ON "latticeCryptoLedger" ("organizationId", "targetCollection", "targetRecordId");',
        { transaction },
      );
      await sequelize.query(
        'CREATE INDEX IF NOT EXISTS idx_lattice_ledger_org_recorded ON "latticeCryptoLedger" ("organizationId", "recordedAt");',
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

      await sequelize.query('DROP INDEX IF EXISTS idx_lattice_ledger_org_recorded;', { transaction });
      await sequelize.query('DROP INDEX IF EXISTS idx_lattice_ledger_org_target;', { transaction });
      await sequelize.query('DROP INDEX IF EXISTS uidx_lattice_ledger_org_seq;', { transaction });
      await sequelize.query('DROP TABLE IF EXISTS "latticeCryptoLedger";', { transaction });

      await sequelize.query('DROP INDEX IF EXISTS idx_lattice_pki_keys_key_id;', { transaction });
      await sequelize.query('DROP INDEX IF EXISTS uidx_lattice_pki_keys_org;', { transaction });
      await sequelize.query('DROP TABLE IF EXISTS "latticePkiKeys";', { transaction });

      await sequelize.query('DROP INDEX IF EXISTS idx_lattice_api_keys_org_prefix;', { transaction });
      await sequelize.query('DROP INDEX IF EXISTS idx_lattice_api_keys_org_user;', { transaction });
      await sequelize.query('DROP INDEX IF EXISTS uidx_lattice_api_keys_hash;', { transaction });
      await sequelize.query('DROP TABLE IF EXISTS "latticeApiKeys";', { transaction });
    });
  }
}

module.exports = PaasApiKeysAndPkiLedgerMigration;
module.exports.default = PaasApiKeysAndPkiLedgerMigration;
