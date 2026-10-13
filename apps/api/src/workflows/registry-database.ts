// SPDX-License-Identifier: Apache-2.0
import type { Pool, PoolClient } from 'pg';
import { workflowDefinitions, getDefinition } from '../../../../solutions/workflows/definitions.js';
import { pageResult } from '../pagination.js';
import { WorkflowError } from './policy.js';
import { definitionId, validateDefinition, type DefinitionRegistry, type WorkflowDraft } from './registry.js';

const columns = 'id,revision,definition,created_by AS "createdBy",updated_by AS "updatedBy",created_at AS "createdAt",updated_at AS "updatedAt"';

function serialize(row: WorkflowDraft): WorkflowDraft {
  return {
    ...row,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

export async function definitionDatabase(pool: Pool): Promise<DefinitionRegistry> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS workflow_definition_drafts (
      organization_id text NOT NULL,
      id text NOT NULL,
      revision integer NOT NULL DEFAULT 1,
      definition jsonb NOT NULL,
      created_by text NOT NULL,
      updated_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (organization_id,id)
    );
    CREATE TABLE IF NOT EXISTS workflow_definition_versions (
      organization_id text NOT NULL,
      id text NOT NULL,
      version integer NOT NULL,
      revision integer NOT NULL,
      definition jsonb NOT NULL,
      published_by text NOT NULL,
      published_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (organization_id,id,version),
      UNIQUE (organization_id,id,revision)
    );
  `);

  async function locked<T>(
    org: string,
    id: string,
    revision: number,
    fn: (client: PoolClient, row: WorkflowDraft) => Promise<T>,
  ): Promise<T> {
    if (!definitionId(id) || !Number.isSafeInteger(revision) || revision < 1) {
      throw new WorkflowError(400, 'ID/phiên bản nháp không hợp lệ.');
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const row = (await client.query(
        `SELECT ${columns} FROM workflow_definition_drafts WHERE organization_id=$1 AND id=$2 FOR UPDATE`,
        [org, id],
      )).rows[0];
      if (!row) {
        throw new WorkflowError(404, 'Không tìm thấy bản nháp.');
      }
      if (row.revision !== revision) {
        throw new WorkflowError(409, 'Bản nháp đã thay đổi.');
      }
      const result = await fn(client, row);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  return {
    async get(org, id, version, client) {
      const builtin = getDefinition(id, version);
      if (workflowDefinitions.some(definition => definition.id === id)) {
        return builtin;
      }
      const result = await (client ?? pool).query(
        'SELECT definition FROM workflow_definition_versions WHERE organization_id=$1 AND id=$2 AND ($3::integer IS NULL OR version=$3) ORDER BY version DESC LIMIT 1',
        [org, id, version ?? null],
      );
      return result.rows[0]?.definition;
    },

    async list(org) {
      const result = await pool.query(
        'SELECT definition FROM workflow_definition_versions WHERE organization_id=$1 ORDER BY id,version',
        [org],
      );
      return [...workflowDefinitions, ...result.rows.map(row => row.definition)];
    },

    async create(value, actor) {
      const definition = validateDefinition(value);
      const result = await pool.query(
        `INSERT INTO workflow_definition_drafts(organization_id,id,definition,created_by,updated_by)
         VALUES($1,$2,$3,$4,$4) ON CONFLICT DO NOTHING RETURNING ${columns}`,
        [actor.organizationId, definition.id, JSON.stringify(definition), actor.subject],
      );
      if (!result.rowCount) {
        throw new WorkflowError(409, 'Bản nháp đã tồn tại.');
      }
      return serialize(result.rows[0]);
    },

    async listDrafts(actor, page) {
      const result = await pool.query(
        `SELECT ${columns} FROM workflow_definition_drafts
         WHERE organization_id=$1 AND ($2='' OR strpos(lower(definition->>'title'),lower($2))>0)
         ORDER BY id LIMIT $3 OFFSET $4`,
        [actor.organizationId, page.q, page.limit + 1, page.offset],
      );
      return pageResult(result.rows.map(serialize), page);
    },

    async getDraft(id, actor) {
      if (!definitionId(id)) {
        throw new WorkflowError(400, 'ID bản nháp không hợp lệ.');
      }
      const row = (await pool.query(
        `SELECT ${columns} FROM workflow_definition_drafts WHERE organization_id=$1 AND id=$2`,
        [actor.organizationId, id],
      )).rows[0];
      if (!row) {
        throw new WorkflowError(404, 'Không tìm thấy bản nháp.');
      }
      return serialize(row);
    },

    async updateDraft(id, revision, value, actor) {
      const definition = validateDefinition(value);
      if (definition.id !== id) {
        throw new WorkflowError(400, 'Không được đổi ID bản nháp.');
      }
      return locked(actor.organizationId, id, revision, async client => {
        const result = await client.query(
          `UPDATE workflow_definition_drafts
           SET definition=$3,revision=revision+1,updated_by=$4,updated_at=now()
           WHERE organization_id=$1 AND id=$2 RETURNING ${columns}`,
          [actor.organizationId, id, JSON.stringify(definition), actor.subject],
        );
        return serialize(result.rows[0]);
      });
    },

    async publish(id, revision, actor) {
      return locked(actor.organizationId, id, revision, async (client, row) => {
        const old = (await client.query(
          'SELECT definition FROM workflow_definition_versions WHERE organization_id=$1 AND id=$2 AND revision=$3',
          [actor.organizationId, id, revision],
        )).rows[0];
        if (old) {
          return old.definition;
        }
        const definition = validateDefinition(row.definition);
        const version = Number((await client.query(
          'SELECT COALESCE(MAX(version),0)+1 AS version FROM workflow_definition_versions WHERE organization_id=$1 AND id=$2',
          [actor.organizationId, id],
        )).rows[0].version);
        const published = { ...definition, version };
        await client.query(
          'INSERT INTO workflow_definition_versions(organization_id,id,version,revision,definition,published_by) VALUES($1,$2,$3,$4,$5,$6)',
          [actor.organizationId, id, version, revision, JSON.stringify(published), actor.subject],
        );
        return published;
      });
    },
  };
}
