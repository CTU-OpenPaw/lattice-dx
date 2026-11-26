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

class AiHitlApprovalsMigration extends Migration {
  on = 'afterSync';

  async up() {
    const db = this.context.db;
    const sequelize = db?.sequelize;
    if (!sequelize || typeof sequelize.transaction !== 'function') return;
    const isPostgres = typeof sequelize.getDialect === 'function' && sequelize.getDialect() === 'postgres';
    await sequelize.transaction(async (transaction) => {
      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS "latticeAiApprovalQueue" (
          id BIGSERIAL PRIMARY KEY,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "organizationId" VARCHAR(255) NOT NULL DEFAULT 'native-ui-lab',
          "requesterUserId" BIGINT NOT NULL,
          "requesterUsername" VARCHAR(255),
          "aiEmployee" VARCHAR(255),
          "toolName" VARCHAR(255) NOT NULL,
          "targetCollection" VARCHAR(255) NOT NULL,
          "targetRecordId" BIGINT,
          operation VARCHAR(64) NOT NULL DEFAULT 'update',
          "proposedArgs" JSONB DEFAULT '{}'::jsonb,
          "diffPreview" JSONB DEFAULT '{}'::jsonb,
          "riskLevel" VARCHAR(32) NOT NULL DEFAULT 'medium',
          status VARCHAR(32) NOT NULL DEFAULT 'pending',
          "decidedByUserId" BIGINT,
          "decidedByUsername" VARCHAR(255),
          "decisionNote" VARCHAR(255),
          "decidedAt" TIMESTAMPTZ,
          "executionResult" JSONB,
          "expiresAt" TIMESTAMPTZ
        );
      `, { transaction });
      await sequelize.query(
        'CREATE INDEX IF NOT EXISTS idx_lattice_ai_hitl_org_status_created ON "latticeAiApprovalQueue" ("organizationId", status, "createdAt");',
        { transaction },
      );
      if (isPostgres) {
        await attachTableRls(db, 'latticeAiApprovalQueue', transaction);
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
        await detachTableRls(db, 'latticeAiApprovalQueue', transaction);
      }
      await sequelize.query('DROP INDEX IF EXISTS idx_lattice_ai_hitl_org_status_created;', { transaction });
      await sequelize.query('DROP TABLE IF EXISTS "latticeAiApprovalQueue";', { transaction });
    });
  }
}

module.exports = AiHitlApprovalsMigration;
module.exports.default = AiHitlApprovalsMigration;
