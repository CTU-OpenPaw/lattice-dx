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

const UI_SNAPSHOTS_TABLE = 'latticeUiSnapshots';
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

async function attachSnapshotsRls(db, transaction) {
  const opts = transaction ? { transaction } : {};
  if (typeof db?.attachLatticeRlsPolicy === 'function') {
    await db.attachLatticeRlsPolicy(UI_SNAPSHOTS_TABLE, opts);
    return;
  }
  const pgRls = loadPgRls();
  if (pgRls && typeof pgRls.attachRlsPolicyToTable === 'function') {
    await pgRls.attachRlsPolicyToTable(db, UI_SNAPSHOTS_TABLE, opts);
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
      `ALTER TABLE public."${UI_SNAPSHOTS_TABLE}" ENABLE ROW LEVEL SECURITY; ALTER TABLE public."${UI_SNAPSHOTS_TABLE}" FORCE ROW LEVEL SECURITY;`,
      queryOpts,
    );
    await sequelize.query(`DROP POLICY IF EXISTS ${RLS_POLICY_NAME} ON public."${UI_SNAPSHOTS_TABLE}";`, queryOpts);
    await sequelize.query(
      `CREATE POLICY ${RLS_POLICY_NAME} ON public."${UI_SNAPSHOTS_TABLE}" AS PERMISSIVE FOR ALL TO PUBLIC USING (${predicate}) WITH CHECK (${predicate});`,
      queryOpts,
    );
  }
}

async function detachSnapshotsRls(db, transaction) {
  const opts = transaction ? { transaction } : {};
  if (typeof db?.detachLatticeRlsPolicy === 'function') {
    await db.detachLatticeRlsPolicy(UI_SNAPSHOTS_TABLE, opts);
    return;
  }
  const pgRls = loadPgRls();
  if (pgRls && typeof pgRls.detachRlsPolicyFromTable === 'function') {
    await pgRls.detachRlsPolicyFromTable(db, UI_SNAPSHOTS_TABLE, opts);
    return;
  }
  const sequelize = db?.sequelize;
  if (typeof sequelize?.query === 'function') {
    const queryOpts = transaction ? { transaction } : undefined;
    await sequelize.query(`DROP POLICY IF EXISTS ${RLS_POLICY_NAME} ON public."${UI_SNAPSHOTS_TABLE}";`, queryOpts);
    await sequelize.query(`ALTER TABLE IF EXISTS public."${UI_SNAPSHOTS_TABLE}" NO FORCE ROW LEVEL SECURITY;`, queryOpts);
    await sequelize.query(`ALTER TABLE IF EXISTS public."${UI_SNAPSHOTS_TABLE}" DISABLE ROW LEVEL SECURITY;`, queryOpts);
  }
}

class UiSnapshotsForceRlsMigration extends Migration {
  on = 'afterSync';

  async up() {
    const db = this.context.db;
    const sequelize = db?.sequelize;
    if (!sequelize || typeof sequelize.transaction !== 'function') return;
    const isPostgres = typeof sequelize.getDialect === 'function' && sequelize.getDialect() === 'postgres';
    if (!isPostgres) return;
    await sequelize.transaction(async (transaction) => {
      await sequelize.query(
        `ALTER TABLE IF EXISTS "${UI_SNAPSHOTS_TABLE}" ADD COLUMN IF NOT EXISTS "organizationId" VARCHAR(80);`,
        { transaction },
      ).catch(() => {});
      await sequelize.query(
        `CREATE INDEX IF NOT EXISTS idx_lattice_ui_snapshots_org_portal_created ON "${UI_SNAPSHOTS_TABLE}" ("organizationId", "portalSlug", "createdAt");`,
        { transaction },
      ).catch(() => {});
      await attachSnapshotsRls(db, transaction);
    });
  }

  async down() {
    const db = this.context.db;
    const sequelize = db?.sequelize;
    if (!sequelize || typeof sequelize.transaction !== 'function') return;
    const isPostgres = typeof sequelize.getDialect === 'function' && sequelize.getDialect() === 'postgres';
    if (!isPostgres) return;
    await sequelize.transaction(async (transaction) => {
      await detachSnapshotsRls(db, transaction).catch(() => {});
    });
  }
}

module.exports = UiSnapshotsForceRlsMigration;
module.exports.default = UiSnapshotsForceRlsMigration;
