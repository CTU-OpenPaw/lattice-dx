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

class ParaFlexibleVectorDimension extends Migration {
  on = 'afterSync';

  async up() {
    const db = this.context.db;
    const sequelize = db?.sequelize;
    if (!sequelize || typeof sequelize.transaction !== 'function') return;
    const isPostgres = typeof sequelize.getDialect === 'function' && sequelize.getDialect() === 'postgres';

    await sequelize.transaction(async (transaction) => {
      await sequelize.query('DROP INDEX IF EXISTS idx_lattice_para_chunks_emb_ivf;', { transaction });
      await sequelize.query('DROP INDEX IF EXISTS idx_lattice_para_chunks_emb_hnsw;', { transaction });
      await sequelize.query('DROP INDEX IF EXISTS idx_lattice_para_embedding_hnsw;', { transaction });

      await sequelize.query(`
        DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
            IF to_regclass('"latticeParaChunks"') IS NOT NULL THEN
              IF EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'latticeParaChunks' AND column_name = 'embedding'
              ) THEN
                ALTER TABLE "latticeParaChunks" ALTER COLUMN embedding TYPE vector USING embedding::vector;
              ELSE
                ALTER TABLE "latticeParaChunks" ADD COLUMN IF NOT EXISTS embedding vector;
              END IF;
            END IF;

            IF to_regclass('"latticeParaDocuments"') IS NOT NULL THEN
              IF EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'latticeParaDocuments' AND column_name = 'embedding'
              ) THEN
                ALTER TABLE "latticeParaDocuments" ALTER COLUMN embedding TYPE vector USING embedding::vector;
              END IF;
            END IF;
          END IF;
        END $$;
      `, { transaction });

      if (isPostgres) {
        await attachTableRls(db, 'latticeParaChunks', transaction);
        await attachTableRls(db, 'latticeParaDocuments', transaction);
      }
    });
  }

  async down() {
    const db = this.context.db;
    const sequelize = db?.sequelize;
    if (!sequelize || typeof sequelize.transaction !== 'function') return;

    await sequelize.transaction(async (transaction) => {
      await sequelize.query(`
        DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
            IF to_regclass('"latticeParaChunks"') IS NOT NULL AND EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'latticeParaChunks' AND column_name = 'embedding'
            ) THEN
              UPDATE "latticeParaChunks" SET embedding = NULL WHERE embedding IS NOT NULL AND vector_dims(embedding) <> 1536;
              ALTER TABLE "latticeParaChunks" ALTER COLUMN embedding TYPE vector(1536) USING embedding::vector(1536);
              BEGIN
                CREATE INDEX IF NOT EXISTS idx_lattice_para_chunks_emb_hnsw
                  ON "latticeParaChunks" USING hnsw (embedding vector_cosine_ops);
              EXCEPTION WHEN undefined_object OR feature_not_supported OR OTHERS THEN
                BEGIN
                  CREATE INDEX IF NOT EXISTS idx_lattice_para_chunks_emb_ivf
                    ON "latticeParaChunks" USING ivfflat (embedding vector_cosine_ops);
                EXCEPTION WHEN OTHERS THEN
                  NULL;
                END;
              END;
            END IF;

            IF to_regclass('"latticeParaDocuments"') IS NOT NULL AND EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'latticeParaDocuments' AND column_name = 'embedding'
            ) THEN
              UPDATE "latticeParaDocuments" SET embedding = NULL WHERE embedding IS NOT NULL AND vector_dims(embedding) <> 256;
              ALTER TABLE "latticeParaDocuments" ALTER COLUMN embedding TYPE vector(256) USING embedding::vector(256);
              BEGIN
                CREATE INDEX IF NOT EXISTS idx_lattice_para_embedding_hnsw
                  ON "latticeParaDocuments" USING hnsw (embedding vector_cosine_ops);
              EXCEPTION WHEN OTHERS THEN
                NULL;
              END;
            END IF;
          END IF;
        END $$;
      `, { transaction });
    });
  }
}

module.exports = ParaFlexibleVectorDimension;
module.exports.default = ParaFlexibleVectorDimension;
