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
        '@latticedx/plugin-lattice-foundation/dist/server/pg-rls',
        '@latticedx/plugin-lattice-foundation/src/server/pg-rls',
        '../../../../plugin-lattice-foundation/dist/server/pg-rls',
        '../../../../plugin-lattice-foundation/src/server/pg-rls',
      ]
    : [
        '@latticedx/plugin-lattice-foundation/src/server/pg-rls',
        '../../../../plugin-lattice-foundation/src/server/pg-rls',
        '@latticedx/plugin-lattice-foundation/dist/server/pg-rls',
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

async function attachTableRls(db, tableName, transaction) {
  const opts = transaction ? { transaction } : {};
  if (typeof db?.attachLatticeRlsPolicy === 'function') {
    await db.attachLatticeRlsPolicy(tableName, opts);
    return;
  }
  const pgRls = loadPgRls();
  if (pgRls && typeof pgRls.attachRlsPolicyToTable === 'function') {
    await pgRls.attachRlsPolicyToTable(db, tableName, opts);
  }
}

async function detachTableRls(db, tableName, transaction) {
  const opts = transaction ? { transaction } : {};
  if (typeof db?.detachLatticeRlsPolicy === 'function') {
    await db.detachLatticeRlsPolicy(tableName, opts);
    return;
  }
  const pgRls = loadPgRls();
  if (pgRls && typeof pgRls.detachRlsPolicyFromTable === 'function') {
    await pgRls.detachRlsPolicyFromTable(db, tableName, opts);
    return;
  }
  const sequelize = db?.sequelize;
  if (typeof sequelize?.query === 'function') {
    const queryOpts = transaction ? { transaction } : undefined;
    await sequelize.query(`DROP POLICY IF EXISTS lattice_tenant_isolation ON public."${tableName}";`, queryOpts);
    await sequelize.query(`ALTER TABLE IF EXISTS public."${tableName}" DISABLE ROW LEVEL SECURITY;`, queryOpts);
  }
}

class DxosTelemetryTimeseriesMigration extends Migration {
  on = 'afterSync';

  async up() {
    const db = this.context.db;
    const sequelize = db?.sequelize;
    if (!sequelize || typeof sequelize.transaction !== 'function') return;
    const isPostgres = typeof sequelize.getDialect === 'function' && sequelize.getDialect() === 'postgres';

    await sequelize.transaction(async (transaction) => {
      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS "latticeTelemetryPoints" (
          id BIGSERIAL NOT NULL,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "organizationId" VARCHAR(255) NOT NULL,
          "assetId" BIGINT,
          "assetEntityId" VARCHAR(255) NOT NULL,
          "metricName" VARCHAR(128) NOT NULL DEFAULT 'temperature',
          "numericValue" DOUBLE PRECISION NOT NULL,
          unit VARCHAR(64) NOT NULL DEFAULT 'CEL',
          quality VARCHAR(64) NOT NULL DEFAULT 'good',
          "sourceProtocol" VARCHAR(64) NOT NULL DEFAULT 'http',
          "observedAt" TIMESTAMPTZ NOT NULL,
          PRIMARY KEY (id, "observedAt")
        );
      `, { transaction });

      await sequelize.query(
        'CREATE INDEX IF NOT EXISTS idx_lattice_telemetry_org_entity_metric_obs ON "latticeTelemetryPoints" ("organizationId", "assetEntityId", "metricName", "observedAt" DESC);',
        { transaction },
      );

      const [availRows] = await sequelize.query(
        "SELECT 1 FROM pg_available_extensions WHERE name = 'timescaledb';",
        { transaction },
      );
      let [extRows] = await sequelize.query(
        "SELECT 1 FROM pg_extension WHERE extname = 'timescaledb';",
        { transaction },
      );

      if (Array.isArray(availRows) && availRows.length > 0 && (!Array.isArray(extRows) || extRows.length === 0)) {
        await sequelize.query(`
          DO $$ BEGIN
            CREATE EXTENSION IF NOT EXISTS timescaledb;
          EXCEPTION WHEN OTHERS THEN
            NULL;
          END $$;
        `, { transaction });
        [extRows] = await sequelize.query(
          "SELECT 1 FROM pg_extension WHERE extname = 'timescaledb';",
          { transaction },
        );
      }

      if (Array.isArray(extRows) && extRows.length > 0) {
        // If Sequelize db.sync() pre-created a single-column PRIMARY KEY (id) before afterSync,
        // upgrade it to composite PRIMARY KEY (id, "observedAt") so TimescaleDB hypertable partitioning succeeds.
        await sequelize.query(`
          DO $$
          DECLARE
            pk_name text;
            has_obs boolean;
          BEGIN
            SELECT c.conname,
                   EXISTS (
                     SELECT 1
                     FROM unnest(c.conkey) AS k(attnum)
                     JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
                     WHERE a.attname = 'observedAt'
                   )
            INTO pk_name, has_obs
            FROM pg_constraint c
            WHERE c.conrelid = '"latticeTelemetryPoints"'::regclass
              AND c.contype = 'p'
            LIMIT 1;

            IF pk_name IS NOT NULL AND NOT COALESCE(has_obs, FALSE) THEN
              EXECUTE format('ALTER TABLE "latticeTelemetryPoints" DROP CONSTRAINT %I', pk_name);
              ALTER TABLE "latticeTelemetryPoints" ADD PRIMARY KEY (id, "observedAt");
            END IF;
          END $$;
        `, { transaction });

        await sequelize.query(
          `SELECT create_hypertable('"latticeTelemetryPoints"', 'observedAt', if_not_exists => TRUE, migrate_data => TRUE);`,
          { transaction },
        );
      }

      if (isPostgres) {
        await attachTableRls(db, 'latticeTelemetryPoints', transaction);
      }
    });
  }

  async down() {
    const db = this.context.db;
    const sequelize = db?.sequelize;
    if (!sequelize || typeof sequelize.transaction !== 'function') return;
    const isPostgres = typeof sequelize.getDialect === 'function' && sequelize.getDialect() === 'postgres';
    await sequelize.transaction(async (transaction) => {
      if (isPostgres) {
        await detachTableRls(db, 'latticeTelemetryPoints', transaction);
      }
      await sequelize.query('DROP INDEX IF EXISTS idx_lattice_telemetry_org_entity_metric_obs;', { transaction });
      await sequelize.query('DROP TABLE IF EXISTS "latticeTelemetryPoints";', { transaction });
    });
  }
}

module.exports = DxosTelemetryTimeseriesMigration;
module.exports.default = DxosTelemetryTimeseriesMigration;
