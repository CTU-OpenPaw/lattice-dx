/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
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
export type AdminSystemItem = {
  id: string;
  version: string;
  title: string;
  enabled: boolean;
  policyStatus: string;
  policyRevision: number;
  publishedWorkflowsCount: number;
  totalWorkflowsCount: number;
  schemasCount: number;
};
export type AdminSystemDefinition = {
  id: string;
  title?: string;
  published: boolean;
  definitionVersion?: number;
  startRole?: string;
  readerRoles?: string[];
  assignedReader?: { field: string; role: string; states: string[] };
  transitions?: Array<{ id?: string; from?: string; to?: string; role?: string }>;
};
export type AdminSystemDetail = {
  id: string;
  version: string;
  title: string;
  enabled: boolean;
  policyStatus: string;
  policyRevision: number;
  presentation: SystemPresentation;
  schemas: SchemaPublication[];
  definitions: AdminSystemDefinition[];
  permittedBusinessRoles: string[];
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
  adminList(actor: WorkflowActor, page: PageQuery): Promise<Page<AdminSystemItem>>;
  adminGet(id: string, version: string, actor: WorkflowActor): Promise<AdminSystemDetail>;
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
        await pool.query<SystemRow & { enforcement_status?: string; effective_roles?: string[]; member_access?: boolean }>(
          `WITH policies AS (
             SELECT system_id, system_version, status FROM studio_system_policies WHERE organization_id = $1
           ),
           caller_person AS (
             SELECT subject, department_id, enabled FROM directory_people WHERE organization_id = $1 AND subject = $8
           ),
           caller_grants AS (
             SELECT g.system_id, g.system_version, g.roles
             FROM studio_system_grants g
             JOIN caller_person c ON c.enabled = true AND (
               (g.principal_type = 'person' AND g.principal_id = c.subject)
               OR (g.principal_type = 'department' AND c.department_id IS NOT NULL AND g.principal_id = c.department_id)
             )
             WHERE g.organization_id = $1 AND g.status = 'active'
           ),
           member_effective AS (
             SELECT
               system_id,
               system_version,
               jsonb_agg(roles) AS grant_roles
             FROM caller_grants
             GROUP BY system_id, system_version
           )
           SELECT m.id,m.version,m.title,m.enabled,m.manifest->'presentation' AS presentation,m.manifest->'schemas' AS schemas,
     pol.status AS enforcement_status,
     CASE WHEN pol.status = 'enforced' THEN
       (SELECT array_agg(DISTINCT r) FROM caller_grants cg, jsonb_array_elements_text(cg.roles) r WHERE cg.system_id = m.id AND cg.system_version = m.version)
     ELSE NULL END AS effective_roles,
     CASE WHEN pol.status = 'enforced' THEN
       EXISTS(SELECT 1 FROM caller_grants cg WHERE cg.system_id = m.id AND cg.system_version = m.version)
     ELSE true END AS member_access,
     (SELECT jsonb_agg(v.definition ORDER BY w.definition_id) FROM enterprise_module_workflows w JOIN workflow_definition_versions v ON v.organization_id=w.organization_id AND v.id=w.definition_id AND v.version=w.definition_version
      WHERE w.organization_id=m.organization_id AND w.module_id=m.id AND w.module_version=m.version) AS definitions
     FROM enterprise_module_versions m
     LEFT JOIN policies pol ON pol.system_id = m.id AND pol.system_version = m.version
     WHERE m.organization_id=$1 AND m.manifest ? 'presentation'
     AND (m.enabled OR EXISTS(SELECT 1 FROM enterprise_module_audit a WHERE a.organization_id=m.organization_id AND a.module_id=m.id AND a.module_version=m.version AND a.enabled))
     AND ($5::text IS NULL OR m.id=$5) AND ($6::text IS NULL OR m.version=$6) AND ($7='' OR strpos(lower(m.title),lower($7))>0)
     AND (
       pol.status = 'enforced' AND EXISTS(SELECT 1 FROM caller_grants cg WHERE cg.system_id = m.id AND cg.system_version = m.version)
       OR (pol.status IS NULL OR pol.status = 'legacy') AND ((('data:read'=ANY($2::text[])) AND jsonb_array_length(COALESCE(m.manifest->'presentation'->'entityPages','[]'::jsonb))>0) OR EXISTS(SELECT 1 FROM jsonb_array_elements(m.manifest->'bundle'->'definitions') d WHERE d->>'startRole'=ANY($2::text[]) OR (d->'readerRoles') ?| $2::text[] OR d->'assignedReader'->>'role'=ANY($2::text[])))
     )
     ORDER BY m.id,m.version LIMIT $3 OFFSET $4`,
          [
            actor.organizationId,
            actor.roles,
            page.limit + 1,
            page.offset,
            id ?? null,
            version ?? null,
            page.q,
            actor.subject,
          ],
        )
      ).rows;
      return pageResult(
        rows.map((row) => {
          const isEnforced = row.enforcement_status === 'enforced';
          const scopedRoles = isEnforced ? (row.effective_roles ?? []) : actor.roles;
          const visible = (d: WorkflowDefinition) =>
            scopedRoles.includes(d.startRole) ||
            d.readerRoles.some((r) => scopedRoles.includes(r)) ||
            (!!d.assignedReader && scopedRoles.includes(d.assignedReader.role));
          const definitions = (row.definitions ?? [])
            .filter(visible)
            .map((d: WorkflowDefinition) => ({
              id: d.id,
              version: d.version,
              title: d.title,
              canStart:
                actor.roles.includes("workflow:start") &&
                scopedRoles.includes(d.startRole),
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
              pages: (row.presentation.pages ?? []).filter(
                (p: { definitionId: string }) => ids.has(p.definitionId),
              ),
            },
            definitions,
          };
        }),
        page,
      );
    },
    async adminList(actor, page) {
      requireModuleAdmin(actor);
      const rows = (
        await pool.query<{
          id: string;
          version: string;
          title: string;
          enabled: boolean;
          policy_status: string;
          policy_revision: number;
          schemas_count: number;
          total_workflows_count: number;
          published_workflows_count: number;
        }>(
          `SELECT
            m.id, m.version, m.title, m.enabled,
            COALESCE(pol.status, 'legacy') AS policy_status,
            COALESCE(pol.revision, 0) AS policy_revision,
            jsonb_array_length(COALESCE(m.manifest->'schemas', '[]'::jsonb)) AS schemas_count,
            GREATEST(
              jsonb_array_length(COALESCE(m.manifest->'bundle'->'definitions', '[]'::jsonb)),
              (
                SELECT count(*)::int
                FROM enterprise_module_workflows w
                WHERE w.organization_id = m.organization_id AND w.module_id = m.id AND w.module_version = m.version
              )
            ) AS total_workflows_count,
            (
              SELECT count(*)::int
              FROM enterprise_module_workflows w
              JOIN workflow_definition_versions v ON v.organization_id = w.organization_id AND v.id = w.definition_id AND v.version = w.definition_version
              WHERE w.organization_id = m.organization_id AND w.module_id = m.id AND w.module_version = m.version
            ) AS published_workflows_count
          FROM enterprise_module_versions m
          LEFT JOIN studio_system_policies pol ON pol.organization_id = m.organization_id AND pol.system_id = m.id AND pol.system_version = m.version
          WHERE m.organization_id = $1 AND m.manifest ? 'presentation'
            AND ($2 = '' OR strpos(lower(m.title), lower($2)) > 0)
          ORDER BY m.id, m.version
          LIMIT $3 OFFSET $4`,
          [actor.organizationId, page.q, page.limit + 1, page.offset],
        )
      ).rows;
      return pageResult(
        rows.map((r) => ({
          id: r.id,
          version: r.version,
          title: r.title,
          enabled: r.enabled,
          policyStatus: r.policy_status,
          policyRevision: r.policy_revision,
          schemasCount: r.schemas_count,
          totalWorkflowsCount: r.total_workflows_count,
          publishedWorkflowsCount: r.published_workflows_count,
        })),
        page,
      );
    },
    async adminGet(id, version, actor) {
      requireModuleAdmin(actor);
      const row = (
        await pool.query<{
          id: string;
          version: string;
          title: string;
          enabled: boolean;
          policy_status: string;
          policy_revision: number;
          presentation: SystemPresentation;
          schemas: SchemaDefinition[];
          declared_definitions: WorkflowDefinition[];
          published_workflows: Array<{
            definition_id: string;
            definition_version: number;
            definition: WorkflowDefinition;
          }> | null;
        }>(
          `SELECT
            m.id, m.version, m.title, m.enabled,
            COALESCE(pol.status, 'legacy') AS policy_status,
            COALESCE(pol.revision, 0) AS policy_revision,
            m.manifest->'presentation' AS presentation,
            m.manifest->'schemas' AS schemas,
            m.manifest->'bundle'->'definitions' AS declared_definitions,
            (
              SELECT jsonb_agg(
                jsonb_build_object(
                  'definition_id', w.definition_id,
                  'definition_version', w.definition_version,
                  'definition', v.definition
                ) ORDER BY w.definition_id
              )
              FROM enterprise_module_workflows w
              JOIN workflow_definition_versions v ON v.organization_id = w.organization_id AND v.id = w.definition_id AND v.version = w.definition_version
              WHERE w.organization_id = m.organization_id AND w.module_id = m.id AND w.module_version = m.version
            ) AS published_workflows
          FROM enterprise_module_versions m
          LEFT JOIN studio_system_policies pol ON pol.organization_id = m.organization_id AND pol.system_id = m.id AND pol.system_version = m.version
          WHERE m.organization_id = $1 AND m.manifest ? 'presentation'
            AND m.id = $2 AND m.version = $3`,
          [actor.organizationId, id, version],
        )
      ).rows[0];
      if (!row) throw new WorkflowError(404, "Installed system not found");

      const pubMap = new Map<string, { definition_version: number; definition: WorkflowDefinition }>();
      (row.published_workflows ?? []).forEach((pw) => {
        pubMap.set(pw.definition_id, pw);
      });

      const RESERVED = new Set([
        'workflow:design',
        'data:design',
        'workflow:start',
        'data:read',
        'data:write',
        'data:share',
        'directory:read',
        'directory:manage',
        'platform:operate',
        'tasks:read',
        'tasks:assign',
        'records:write',
      ]);

      const permittedRoles = new Set<string>();
      const definitionsMap = new Map<string, AdminSystemDefinition>();

      const addRolesFromDef = (d: WorkflowDefinition) => {
        if (d.startRole && !RESERVED.has(d.startRole) && !d.startRole.startsWith('platform:') && d.startRole !== 'admin') {
          permittedRoles.add(d.startRole);
        }
        (d.readerRoles ?? []).forEach((r) => {
          if (r && !RESERVED.has(r) && !r.startsWith('platform:') && r !== 'admin') {
            permittedRoles.add(r);
          }
        });
        if (d.assignedReader?.role && !RESERVED.has(d.assignedReader.role) && !d.assignedReader.role.startsWith('platform:') && d.assignedReader.role !== 'admin') {
          permittedRoles.add(d.assignedReader.role);
        }
        (d.transitions ?? []).forEach((t: any) => {
          if (t.role && !t.execution && !RESERVED.has(t.role) && !t.role.startsWith('platform:') && t.role !== 'admin') {
            permittedRoles.add(t.role);
          }
        });
      };

      (row.declared_definitions ?? []).forEach((declared) => {
        const published = pubMap.get(declared.id);
        if (published) {
          const d = published.definition;
          addRolesFromDef(d);
          definitionsMap.set(declared.id, {
            id: d.id,
            title: d.title,
            published: true,
            definitionVersion: published.definition_version,
            startRole: d.startRole,
            readerRoles: d.readerRoles,
            assignedReader: d.assignedReader,
            transitions: d.transitions?.map((t: any) => ({
              id: t.id,
              from: t.from,
              to: t.to,
              role: t.role,
            })),
          });
        } else {
          definitionsMap.set(declared.id, {
            id: declared.id,
            title: declared.title,
            published: false,
          });
        }
      });

      (row.published_workflows ?? []).forEach((pw) => {
        if (!definitionsMap.has(pw.definition_id)) {
          const d = pw.definition;
          addRolesFromDef(d);
          definitionsMap.set(pw.definition_id, {
            id: d.id,
            title: d.title,
            published: true,
            definitionVersion: pw.definition_version,
            startRole: d.startRole,
            readerRoles: d.readerRoles,
            assignedReader: d.assignedReader,
            transitions: d.transitions?.map((t: any) => ({
              id: t.id,
              from: t.from,
              to: t.to,
              role: t.role,
            })),
          });
        }
      });

      const definitions = Array.from(definitionsMap.values());

      return {
        id: row.id,
        version: row.version,
        title: row.title,
        enabled: row.enabled,
        policyStatus: row.policy_status,
        policyRevision: row.policy_revision,
        presentation: row.presentation,
        schemas: (row.schemas ?? []).map((s) => ({ ...s, version: 1 })),
        definitions,
        permittedBusinessRoles: Array.from(permittedRoles).sort(),
      };
    },
  };
}
