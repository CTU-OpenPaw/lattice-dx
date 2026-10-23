// SPDX-License-Identifier: Apache-2.0
import type {SchemaDefinition,SchemaPublication} from "../entities/types.js";
import type { Pool } from "pg";
import type { WorkflowActor, WorkflowDefinition } from "@dx/contracts";
import { parseRecipe, type SystemRecipe } from "./policy.js";
import { requireModuleAdmin, manifestHash } from "../modules/policy.js";
import { WorkflowError } from "../workflows/policy.js";
import { pageResult, type PageQuery, type Page } from "../pagination.js";
import type { SystemPresentation } from "./presentation.js";
import { parseCreateKey } from "../create-command.js";
export type SystemDraft = {
  id: string;
  revision: number;
  recipe: SystemRecipe;
};
type RuntimeDefinition = Pick<
  WorkflowDefinition,
  | "id"
  | "version"
  | "title"
  | "startRole"
  | "startFields"
  | "optionalStartFields"
  | "readerRoles"
  | "assignedReader"
> & {
  canStart: boolean;
  transitions: Pick<
    WorkflowDefinition["transitions"][number],
    "id" | "from" | "to" | "role" | "fields"
  >[];
};
type SystemApp = {
  id: string;
  version: string;
  title: string;
  enabled: boolean;
  presentation: SystemPresentation;
  definitions: RuntimeDefinition[];
  schemas?:SchemaPublication[];
};
type SystemRow = Omit<SystemApp, "definitions"|"schemas"> & {
  schemas?:SchemaDefinition[];
  definitions: WorkflowDefinition[] | null;
};
export interface SystemRepository {
  save(
    recipe: unknown,
    expectedRevision: number | undefined,
    actor: WorkflowActor,
    key: string,
  ): Promise<SystemDraft>;
  list(actor: WorkflowActor, page: PageQuery): Promise<Page<SystemDraft>>;
  get(id: string, actor: WorkflowActor): Promise<SystemDraft>;
  runtime(
    actor: WorkflowActor,
    page: PageQuery,
    id?: string,
    version?: string,
  ): Promise<Page<SystemApp>>;
}
export async function systemDatabase(pool: Pool): Promise<SystemRepository> {
  await pool.query(`CREATE TABLE IF NOT EXISTS studio_system_drafts(
 organization_id text NOT NULL,id text NOT NULL,revision integer NOT NULL DEFAULT 1,recipe jsonb NOT NULL,
 updated_by text NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(organization_id,id));
 CREATE TABLE IF NOT EXISTS studio_system_commands(
 organization_id text NOT NULL,actor_id text NOT NULL,key text NOT NULL,fingerprint text NOT NULL,result jsonb NOT NULL,
 PRIMARY KEY(organization_id,actor_id,key))`);
  return {
    async save(value, expectedRevision, actor, key) {
      requireModuleAdmin(actor);
      const recipe = parseRecipe(value);
      if (!parseCreateKey(key))
        throw new WorkflowError(400, "Idempotency-Key required");
      if (
        expectedRevision !== undefined &&
        (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
      )
        throw new WorkflowError(400, "Invalid draft revision");
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        // Serialize command receipts before a resource lock; cross-draft key reuse cannot execute twice.
        await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          JSON.stringify([
            "system-command",
            actor.organizationId,
            actor.subject,
            key,
          ]),
        ]);
        const hash = manifestHash({
          recipe,
          expectedRevision: expectedRevision ?? null,
        });
        const receipt = (
          await c.query(
            "SELECT fingerprint,result FROM studio_system_commands WHERE organization_id=$1 AND actor_id=$2 AND key=$3",
            [actor.organizationId, actor.subject, key],
          )
        ).rows[0];
        if (receipt) {
          if (receipt.fingerprint !== hash)
            throw new WorkflowError(409, "Draft command content conflict");
          await c.query("COMMIT");
          return receipt.result;
        }
        await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          JSON.stringify(["system-draft", actor.organizationId, recipe.id]),
        ]);
        const previous = (
          await c.query(
            "SELECT revision FROM studio_system_drafts WHERE organization_id=$1 AND id=$2 FOR UPDATE",
            [actor.organizationId, recipe.id],
          )
        ).rows[0];
        if (
          previous
            ? previous.revision !== expectedRevision
            : expectedRevision !== undefined
        )
          throw new WorkflowError(409, "Draft changed; reload before saving");
        const result = (
          await c.query(
            `INSERT INTO studio_system_drafts(organization_id,id,recipe,updated_by) VALUES($1,$2,$3,$4)
     ON CONFLICT(organization_id,id) DO UPDATE SET recipe=EXCLUDED.recipe,revision=studio_system_drafts.revision+1,updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING id,revision,recipe`,
            [
              actor.organizationId,
              recipe.id,
              JSON.stringify(recipe),
              actor.subject,
            ],
          )
        ).rows[0];
        await c.query(
          "INSERT INTO studio_system_commands VALUES($1,$2,$3,$4,$5)",
          [
            actor.organizationId,
            actor.subject,
            key,
            hash,
            JSON.stringify(result),
          ],
        );
        await c.query("COMMIT");
        return result;
      } catch (error) {
        await c.query("ROLLBACK");
        throw error;
      } finally {
        c.release();
      }
    },
    async list(actor, page) {
      requireModuleAdmin(actor);
      const rows = (
        await pool.query(
          "SELECT id,revision,recipe FROM studio_system_drafts WHERE organization_id=$1 AND ($2='' OR strpos(lower(recipe->>'title'),lower($2))>0) ORDER BY updated_at DESC,id LIMIT $3 OFFSET $4",
          [actor.organizationId, page.q, page.limit + 1, page.offset],
        )
      ).rows;
      return pageResult(rows, page);
    },
    async get(id, actor) {
      requireModuleAdmin(actor);
      const row = (
        await pool.query(
          "SELECT id,revision,recipe FROM studio_system_drafts WHERE organization_id=$1 AND id=$2",
          [actor.organizationId, id],
        )
      ).rows[0];
      if (!row) throw new WorkflowError(404, "System draft not found");
      return row;
    },
    async runtime(actor, page, id, version) {
      const rows = (
        await pool.query<SystemRow>(
          `SELECT m.id,m.version,m.title,m.enabled,m.manifest->'presentation' AS presentation,m.manifest->'schemas' AS schemas,
    (SELECT jsonb_agg(v.definition ORDER BY w.definition_id) FROM enterprise_module_workflows w JOIN workflow_definition_versions v ON v.organization_id=w.organization_id AND v.id=w.definition_id AND v.version=w.definition_version
     WHERE w.organization_id=m.organization_id AND w.module_id=m.id AND w.module_version=m.version) AS definitions
    FROM enterprise_module_versions m WHERE m.organization_id=$1 AND m.manifest ? 'presentation'
    AND (m.enabled OR EXISTS(SELECT 1 FROM enterprise_module_audit a WHERE a.organization_id=m.organization_id AND a.module_id=m.id AND a.module_version=m.version AND a.enabled))
    AND ($5::text IS NULL OR m.id=$5) AND ($6::text IS NULL OR m.version=$6) AND ($7='' OR strpos(lower(m.title),lower($7))>0)
    AND ((('data:read'=ANY($2::text[])) AND jsonb_array_length(COALESCE(m.manifest->'presentation'->'entityPages','[]'::jsonb))>0) OR EXISTS(SELECT 1 FROM jsonb_array_elements(m.manifest->'bundle'->'definitions') d WHERE d->>'startRole'=ANY($2::text[]) OR (d->'readerRoles') ?| $2::text[] OR d->'assignedReader'->>'role'=ANY($2::text[])))
    ORDER BY m.id,m.version LIMIT $3 OFFSET $4`,
          [
            actor.organizationId,
            actor.roles,
            page.limit + 1,
            page.offset,
            id ?? null,
            version ?? null,
            page.q,
          ],
        )
      ).rows;
      const visible = (d: WorkflowDefinition) =>
        actor.roles.includes(d.startRole) ||
        d.readerRoles.some((r) => actor.roles.includes(r)) ||
        (!!d.assignedReader && actor.roles.includes(d.assignedReader.role));
      return pageResult(
        rows.map((row) => {
          const definitions = (row.definitions ?? [])
            .filter(visible)
            .map((d: WorkflowDefinition) => ({
              id: d.id,
              version: d.version,
              title: d.title,
              canStart:
                actor.roles.includes("workflow:start") &&
                actor.roles.includes(d.startRole),
              startRole: d.startRole,
              startFields: d.startFields,
              optionalStartFields: d.optionalStartFields,
              readerRoles: d.readerRoles,
              assignedReader: d.assignedReader,
              transitions: d.transitions.map((t) => ({
                id: t.id,
                from: t.from,
                to: t.to,
                role: t.role,
                fields: t.fields,
              })),
            }));
          const ids = new Set(definitions.map((d) => d.id));
          const entityPages=actor.roles.includes('data:read')?(row.presentation.entityPages??[]):[];
          const schemaIds=new Set(entityPages.map(p=>p.schemaId));
          const {schemas:rawSchemas,...base}=row;
          return {
            ...base,
            ...(row.presentation.entityPages?{schemas:(rawSchemas??[]).filter(s=>schemaIds.has(s.id)).map(s=>({...s,version:1}))}:{}),
            presentation: {
              ...row.presentation,
              ...(row.presentation.entityPages?{entityPages}:{}),
              pages: row.presentation.pages.filter(
                (p: { definitionId: string }) => ids.has(p.definitionId),
              ),
            },
            definitions,
          };
        }),
        page,
      );
    },
  };
}
