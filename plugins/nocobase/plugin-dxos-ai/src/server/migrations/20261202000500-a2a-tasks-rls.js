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

const TABLE_NAME = 'latticeA2aTasks';
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

class A2aTasksRlsMigration extends Migration {
  on = 'afterSync';

  async up() {
    const db = this.context.db;
    const sequelize = db?.sequelize;
    if (!sequelize || typeof sequelize.transaction !== 'function') return;
    const isPostgres = typeof sequelize.getDialect === 'function' && sequelize.getDialect() === 'postgres';
    await sequelize.transaction(async (transaction) => {
      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS "${TABLE_NAME}" (
          id BIGSERIAL PRIMARY KEY,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "taskId" VARCHAR(128) NOT NULL,
          "organizationId" VARCHAR(255) NOT NULL,
          "sourceAgentId" VARCHAR(128),
          "targetAgentId" VARCHAR(128),
          "peerUrl" VARCHAR(2048),
          status VARCHAR(32) NOT NULL DEFAULT 'submitted',
          "messagesJson" JSONB NOT NULL DEFAULT '[]'::jsonb,
          "artifactsJson" JSONB NOT NULL DEFAULT '[]'::jsonb,
          "metadataJson" JSONB NOT NULL DEFAULT '{}'::jsonb,
          "errorJson" JSONB,
          "createdById" VARCHAR(128),
          "idempotencyKey" VARCHAR(255)
        );
      `, { transaction });
      await sequelize.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS uidx_lattice_a2a_tasks_org_task ON "${TABLE_NAME}" ("organizationId", "taskId");`,
        { transaction },
      );
      await sequelize.query(
        `CREATE INDEX IF NOT EXISTS idx_lattice_a2a_tasks_task_id ON "${TABLE_NAME}" ("taskId");`,
        { transaction },
      );
      await sequelize.query(
        `CREATE INDEX IF NOT EXISTS idx_lattice_a2a_tasks_org_target_status ON "${TABLE_NAME}" ("organizationId", "targetAgentId", status);`,
        { transaction },
      );
      await sequelize.query(
        `CREATE INDEX IF NOT EXISTS idx_lattice_a2a_tasks_org_idem ON "${TABLE_NAME}" ("organizationId", "idempotencyKey");`,
        { transaction },
      );
      if (isPostgres) {
        await attachTableRls(db, TABLE_NAME, transaction);
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
        await detachTableRls(db, TABLE_NAME, transaction);
      }
      await sequelize.query('DROP INDEX IF EXISTS idx_lattice_a2a_tasks_org_idem;', { transaction });
      await sequelize.query('DROP INDEX IF EXISTS idx_lattice_a2a_tasks_org_target_status;', { transaction });
      await sequelize.query('DROP INDEX IF EXISTS idx_lattice_a2a_tasks_task_id;', { transaction });
      await sequelize.query('DROP INDEX IF EXISTS uidx_lattice_a2a_tasks_org_task;', { transaction });
      await sequelize.query(`DROP TABLE IF EXISTS "${TABLE_NAME}";`, { transaction });
    });
  }
}

module.exports = A2aTasksRlsMigration;
module.exports.default = A2aTasksRlsMigration;
