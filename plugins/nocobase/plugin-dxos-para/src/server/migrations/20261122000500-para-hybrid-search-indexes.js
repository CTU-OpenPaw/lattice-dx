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

class ParaHybridSearchIndexes extends Migration {
  on = 'afterSync';

  async up() {
    const { sequelize } = this.context.db;
    await sequelize.transaction(async (transaction) => {
      await sequelize.query('ALTER TABLE "latticeParaDocuments" ADD COLUMN IF NOT EXISTS "searchText" text;', { transaction });
      await sequelize.query('ALTER TABLE "latticeParaDocuments" ADD COLUMN IF NOT EXISTS "searchVector" tsvector;', { transaction });
      await sequelize.query('ALTER TABLE "latticeParaDocuments" ADD COLUMN IF NOT EXISTS "embeddingJson" jsonb DEFAULT \'[]\'::jsonb;', { transaction });
      await sequelize.query(
        `UPDATE "latticeParaDocuments"
         SET "searchText" = COALESCE(NULLIF("searchText", ''), trim(concat_ws(' ', code, title, summary, tags, "contentMarkdown"))),
             "searchVector" = to_tsvector('simple', coalesce(code, '') || ' ' || coalesce(title, '') || ' ' || coalesce(summary, '') || ' ' || coalesce(tags, '') || ' ' || coalesce("contentMarkdown", '') || ' ' || coalesce("searchText", ''));`,
        { transaction },
      );
      await sequelize.query(
        'CREATE INDEX IF NOT EXISTS idx_lattice_para_search_tsv ON "latticeParaDocuments" USING gin ("searchVector");',
        { transaction },
      );
      await sequelize.query(
        `DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
            CREATE EXTENSION IF NOT EXISTS vector;
            ALTER TABLE "latticeParaDocuments" ADD COLUMN IF NOT EXISTS embedding vector(256);
            CREATE INDEX IF NOT EXISTS idx_lattice_para_embedding_hnsw
              ON "latticeParaDocuments" USING hnsw (embedding vector_cosine_ops);
          END IF;
        END $$;`,
        { transaction },
      );
    });
  }

  async down() {
    const { sequelize } = this.context.db;
    await sequelize.transaction(async (transaction) => {
      await sequelize.query('DROP INDEX IF EXISTS idx_lattice_para_embedding_hnsw;', { transaction });
      await sequelize.query('DROP INDEX IF EXISTS idx_lattice_para_search_tsv;', { transaction });
      await sequelize.query('ALTER TABLE "latticeParaDocuments" DROP COLUMN IF EXISTS embedding;', { transaction });
      await sequelize.query('ALTER TABLE "latticeParaDocuments" DROP COLUMN IF EXISTS "embeddingJson";', { transaction });
      await sequelize.query('ALTER TABLE "latticeParaDocuments" DROP COLUMN IF EXISTS "searchVector";', { transaction });
      await sequelize.query('ALTER TABLE "latticeParaDocuments" DROP COLUMN IF EXISTS "searchText";', { transaction });
    });
  }
}

module.exports = ParaHybridSearchIndexes;
module.exports.default = ParaHybridSearchIndexes;
