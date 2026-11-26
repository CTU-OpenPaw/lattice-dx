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

const QUOTA_POLICY_TABLE = 'latticeAiQuotaPolicies';
const RLS_POLICY_NAME = 'lattice_tenant_isolation';

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
    return;
  }
  const sequelize = db?.sequelize;
  if (typeof sequelize?.query === 'function') {
    const queryOpts = transaction ? { transaction } : undefined;
    const predicate = [
      "current_setting('app.rls_bypass', true) = 'on'",
      "current_setting('app.current_org', true) = '*'",
      '"organizationId" = nullif(current_setting(\'app.current_org\', true), \'\')',
    ].join(' OR ');
    await sequelize.query(
      `ALTER TABLE public."${tableName}" ENABLE ROW LEVEL SECURITY; ALTER TABLE public."${tableName}" FORCE ROW LEVEL SECURITY;`,
      queryOpts,
    );
    await sequelize.query(`DROP POLICY IF EXISTS ${RLS_POLICY_NAME} ON public."${tableName}";`, queryOpts);
    await sequelize.query(
      `CREATE POLICY ${RLS_POLICY_NAME} ON public."${tableName}" AS PERMISSIVE FOR ALL TO PUBLIC USING (${predicate}) WITH CHECK (${predicate});`,
      queryOpts,
    );
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
    await sequelize.query(`DROP POLICY IF EXISTS ${RLS_POLICY_NAME} ON public."${tableName}";`, queryOpts);
    await sequelize.query(`ALTER TABLE IF EXISTS public."${tableName}" NO FORCE ROW LEVEL SECURITY;`, queryOpts);
    await sequelize.query(`ALTER TABLE IF EXISTS public."${tableName}" DISABLE ROW LEVEL SECURITY;`, queryOpts);
  }
}

class UiSnapshotsOrgAndQuotaPoliciesMigration extends Migration {
  on = 'afterSync';

  async up() {
    const db = this.context.db;
    const sequelize = db?.sequelize;
    if (!sequelize || typeof sequelize.transaction !== 'function') return;
    const isPostgres = typeof sequelize.getDialect === 'function' && sequelize.getDialect() === 'postgres';
    await sequelize.transaction(async (transaction) => {
      // 1. Add organizationId + index to latticeUiSnapshots and attach PG FORCE RLS
      await sequelize.query(
        'ALTER TABLE IF EXISTS "latticeUiSnapshots" ADD COLUMN IF NOT EXISTS "organizationId" VARCHAR(80);',
        { transaction },
      ).catch(() => {});
      await sequelize.query(
        'CREATE INDEX IF NOT EXISTS idx_lattice_ui_snapshots_org_portal_created ON "latticeUiSnapshots" ("organizationId", "portalSlug", "createdAt");',
        { transaction },
      ).catch(() => {});
      if (isPostgres) {
        await attachTableRls(db, 'latticeUiSnapshots', transaction);
      }

      // 2. Create per-org AI quota policies table with FORCE RLS
      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS "${QUOTA_POLICY_TABLE}" (
          id BIGSERIAL PRIMARY KEY,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "organizationId" VARCHAR(80) NOT NULL,
          "orgDailyCalls" INTEGER NOT NULL DEFAULT 5000,
          "userDailyCalls" INTEGER NOT NULL DEFAULT 500,
          "orgDailyTokens" BIGINT NOT NULL DEFAULT 5000000,
          "orgDailyUsd" DOUBLE PRECISION NOT NULL DEFAULT 50,
          "updatedByUsername" VARCHAR(120)
        );
      `, { transaction });
      await sequelize.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS uidx_lattice_ai_quota_policies_org ON "${QUOTA_POLICY_TABLE}" ("organizationId");`,
        { transaction },
      );
      if (isPostgres) {
        await attachTableRls(db, QUOTA_POLICY_TABLE, transaction);
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
        await detachTableRls(db, 'latticeUiSnapshots', transaction).catch(() => {});
        await detachTableRls(db, QUOTA_POLICY_TABLE, transaction);
      }
      await sequelize.query('DROP INDEX IF EXISTS uidx_lattice_ai_quota_policies_org;', { transaction });
      await sequelize.query(`DROP TABLE IF EXISTS "${QUOTA_POLICY_TABLE}";`, { transaction });
      await sequelize.query('DROP INDEX IF EXISTS idx_lattice_ui_snapshots_org_portal_created;', { transaction }).catch(() => {});
    });
  }
}

module.exports = UiSnapshotsOrgAndQuotaPoliciesMigration;
module.exports.default = UiSnapshotsOrgAndQuotaPoliciesMigration;
