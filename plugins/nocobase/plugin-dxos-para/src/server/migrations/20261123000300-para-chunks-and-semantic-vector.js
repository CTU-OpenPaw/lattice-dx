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

const VN_ACCENTED = 'áàảãạăắằẳẵặâấầẩẫậđéèẻẽẹêếềểễệíìỉĩịóòỏõọôốồổỗộơớờởỡợúùủũụưứừửữựýỳỷỹỵ';
const VN_FOLDED = 'aaaaaaaaaaaaaaaaadeeeeeeeeeeeiiiiiooooooooooooooooouuuuuuuuuuuyyyyy';

const CHUNK_TSV_NEW = `to_tsvector(
  'simple',
  coalesce(NEW.code, '') || ' ' || coalesce(NEW.title, '') || ' ' || coalesce(NEW."sectionTitle", '') || ' ' || coalesce(NEW.content, '') || ' ' ||
  translate(
    lower(coalesce(NEW.code, '') || ' ' || coalesce(NEW.title, '') || ' ' || coalesce(NEW."sectionTitle", '') || ' ' || coalesce(NEW.content, '')),
    '${VN_ACCENTED}',
    '${VN_FOLDED}'
  )
)`;

const CHUNK_TSV_ROW = `to_tsvector(
  'simple',
  coalesce(code, '') || ' ' || coalesce(title, '') || ' ' || coalesce("sectionTitle", '') || ' ' || coalesce(content, '') || ' ' ||
  translate(
    lower(coalesce(code, '') || ' ' || coalesce(title, '') || ' ' || coalesce("sectionTitle", '') || ' ' || coalesce(content, '')),
    '${VN_ACCENTED}',
    '${VN_FOLDED}'
  )
)`;

class ParaChunksAndSemanticVector extends Migration {
  on = 'afterSync';

  async up() {
    const { sequelize } = this.context.db;
    await sequelize.transaction(async (transaction) => {
      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS "latticeParaChunks" (
          id BIGSERIAL PRIMARY KEY,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "documentId" BIGINT NOT NULL,
          "organizationId" VARCHAR(255) NOT NULL,
          code VARCHAR(255),
          title VARCHAR(255),
          "paraSpace" VARCHAR(64) NOT NULL DEFAULT 'resources',
          "sourceType" VARCHAR(32) NOT NULL DEFAULT 'document',
          "chunkIndex" INTEGER NOT NULL DEFAULT 0,
          "sectionTitle" VARCHAR(255),
          "pageNumber" INTEGER NOT NULL DEFAULT 1,
          content TEXT NOT NULL,
          "tokenCount" INTEGER NOT NULL DEFAULT 0,
          "embeddingModel" VARCHAR(128) NOT NULL DEFAULT 'hash-256',
          "embeddingEngine" VARCHAR(64) NOT NULL DEFAULT 'deterministic-fallback',
          "embeddingDim" INTEGER NOT NULL DEFAULT 256,
          "embeddingJson" JSONB NOT NULL DEFAULT '[]'::jsonb,
          active BOOLEAN NOT NULL DEFAULT TRUE,
          "searchVector" tsvector
        );
      `, { transaction });

      await sequelize.query(
        'ALTER TABLE "latticeParaChunks" ADD COLUMN IF NOT EXISTS "sourceType" VARCHAR(32) NOT NULL DEFAULT \'document\';',
        { transaction },
      );
      await sequelize.query(
        'ALTER TABLE "latticeParaChunks" ADD COLUMN IF NOT EXISTS "embeddingEngine" VARCHAR(64) NOT NULL DEFAULT \'deterministic-fallback\';',
        { transaction },
      );
      await sequelize.query(
        'ALTER TABLE "latticeParaChunks" ADD COLUMN IF NOT EXISTS "searchVector" tsvector;',
        { transaction },
      );

      await sequelize.query(
        `UPDATE "latticeParaChunks"
         SET "searchVector" = ${CHUNK_TSV_ROW};`,
        { transaction },
      );

      await sequelize.query(`
        CREATE OR REPLACE FUNCTION lattice_para_chunks_tsv_update() RETURNS trigger AS $$
        BEGIN
          NEW."searchVector" := ${CHUNK_TSV_NEW};
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
      `, { transaction });

      await sequelize.query(
        'DROP TRIGGER IF EXISTS trg_lattice_para_chunks_tsv ON "latticeParaChunks";',
        { transaction },
      );
      await sequelize.query(
        `CREATE TRIGGER trg_lattice_para_chunks_tsv
         BEFORE INSERT OR UPDATE OF code, title, "sectionTitle", content ON "latticeParaChunks"
         FOR EACH ROW EXECUTE FUNCTION lattice_para_chunks_tsv_update();`,
        { transaction },
      );

      await sequelize.query(
        'CREATE INDEX IF NOT EXISTS idx_lattice_para_chunks_org_doc ON "latticeParaChunks" ("organizationId", "documentId");',
        { transaction },
      );
      await sequelize.query(
        'CREATE INDEX IF NOT EXISTS idx_lattice_para_chunks_org_space ON "latticeParaChunks" ("organizationId", "paraSpace", active);',
        { transaction },
      );
      await sequelize.query(
        'CREATE INDEX IF NOT EXISTS idx_lattice_para_chunks_tsv ON "latticeParaChunks" USING gin ("searchVector");',
        { transaction },
      );

      await sequelize.query(`
        DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
            ALTER TABLE "latticeParaChunks" ADD COLUMN IF NOT EXISTS embedding vector(1536);
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
        END $$;
      `, { transaction });
    });
  }

  async down() {
    const { sequelize } = this.context.db;
    await sequelize.transaction(async (transaction) => {
      await sequelize.query('DROP INDEX IF EXISTS idx_lattice_para_chunks_emb_ivf;', { transaction });
      await sequelize.query('DROP INDEX IF EXISTS idx_lattice_para_chunks_emb_hnsw;', { transaction });
      await sequelize.query('DROP INDEX IF EXISTS idx_lattice_para_chunks_tsv;', { transaction });
      await sequelize.query('DROP INDEX IF EXISTS idx_lattice_para_chunks_org_space;', { transaction });
      await sequelize.query('DROP INDEX IF EXISTS idx_lattice_para_chunks_org_doc;', { transaction });
      await sequelize.query(`
        DO $$
        BEGIN
          IF to_regclass('"latticeParaChunks"') IS NOT NULL THEN
            DROP TRIGGER IF EXISTS trg_lattice_para_chunks_tsv ON "latticeParaChunks";
          END IF;
        END $$;
      `, { transaction });
      await sequelize.query('DROP FUNCTION IF EXISTS lattice_para_chunks_tsv_update();', { transaction });
      await sequelize.query('ALTER TABLE IF EXISTS "latticeParaChunks" DROP COLUMN IF EXISTS embedding;', { transaction });
      await sequelize.query('DROP TABLE IF EXISTS "latticeParaChunks";', { transaction });
    });
  }
}

module.exports = ParaChunksAndSemanticVector;
module.exports.default = ParaChunksAndSemanticVector;
