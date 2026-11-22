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

class DxosTelemetryTimeseriesMigration extends Migration {
  on = 'afterSync';

  async up() {
    const { sequelize } = this.context.db;
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
    });
  }

  async down() {
    const { sequelize } = this.context.db;
    await sequelize.transaction(async (transaction) => {
      await sequelize.query('DROP INDEX IF EXISTS idx_lattice_telemetry_org_entity_metric_obs;', { transaction });
      await sequelize.query('DROP TABLE IF EXISTS "latticeTelemetryPoints";', { transaction });
    });
  }
}

module.exports = DxosTelemetryTimeseriesMigration;
module.exports.default = DxosTelemetryTimeseriesMigration;
