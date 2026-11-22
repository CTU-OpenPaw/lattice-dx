/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { WorkflowActor, WorkflowBusinessBinding } from "@dx/contracts";
import { workflowDefinitions } from "../../../../solutions/workflows/definitions.js";
import { insertDraft } from "../workflows/registry-database.js";
import { bundlePreview } from "../workflows/bundles.js";
import { WorkflowError } from "../workflows/policy.js";
import type { WorkflowRepository } from "../workflows/types.js";
import { parseCreateKey } from "../create-command.js";
import { pageResult, type PageQuery } from "../pagination.js";
import { slug } from "../entities/policy.js";
import { findBlock } from "../blocks/registry.js";
import {
  manifestHash,
  parseManifest,
  requireModuleAdmin,
  requireModuleDesigner,
  semver,
} from "./policy.js";
import type {
  ModuleManifest,
  ModulePreview,
  ModuleRepository,
  ModuleVersion,
} from "./types.js";
type Queryable = Pick<PoolClient, "query">;
type ModuleBindingPlan = {schemaId: string; schemaVersion: number; binding: WorkflowBusinessBinding};
export async function initializeModuleTables(pool: Queryable): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS enterprise_module_versions(
 organization_id text NOT NULL,id text NOT NULL,version text NOT NULL,title text NOT NULL,hash text NOT NULL,manifest jsonb NOT NULL,
 revision integer NOT NULL DEFAULT 1,enabled boolean NOT NULL DEFAULT false,created_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,id,version));
 CREATE TABLE IF NOT EXISTS enterprise_module_workflows(
 organization_id text NOT NULL,module_id text NOT NULL,module_version text NOT NULL,definition_id text NOT NULL,definition_version integer,
 PRIMARY KEY(organization_id,definition_id),FOREIGN KEY(organization_id,module_id,module_version) REFERENCES enterprise_module_versions(organization_id,id,version));
 CREATE TABLE IF NOT EXISTS enterprise_module_commands(
 organization_id text NOT NULL,actor_id text NOT NULL,operation text NOT NULL,key text NOT NULL,fingerprint text NOT NULL,result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(organization_id,actor_id,operation,key));
 CREATE TABLE IF NOT EXISTS enterprise_module_audit(
 audit_id uuid PRIMARY KEY,organization_id text NOT NULL,module_id text NOT NULL,module_version text NOT NULL,actor_id text NOT NULL,
 operation text NOT NULL,revision integer NOT NULL,enabled boolean NOT NULL,occurred_at timestamptz NOT NULL DEFAULT now());`);
}
export async function assertModuleStartEligible(
  client: Queryable,
  org: string,
  id: string,
  version: number,
): Promise<ModuleBindingPlan | undefined> {
  const rows = (
    await client.query(
      `WITH ownership AS (
 SELECT owner.id,owner.version,owner.manifest,w.definition_version
 FROM enterprise_module_versions owner JOIN enterprise_module_workflows w
 ON w.organization_id=owner.organization_id AND w.module_id=owner.id AND w.module_version=owner.version
 WHERE w.organization_id=$1 AND w.definition_id=$2
 ) SELECT m.enabled,m.id,m.version,m.manifest,o.definition_version AS "definitionVersion",
 (m.id=o.id AND m.version=o.version) AS "isOwner"
 FROM enterprise_module_versions m CROSS JOIN ownership o
 WHERE m.organization_id=$1 AND ((m.id=o.id AND m.version=o.version) OR EXISTS (
 SELECT 1 FROM jsonb_array_elements(o.manifest->'dependencies') dep
 WHERE dep->>'id'=m.id AND dep->>'version'=m.version))
 ORDER BY m.id COLLATE "C",m.version COLLATE "C" FOR SHARE OF m`,
      [org, id],
    )
  ).rows;
  const row = rows.find(candidate => candidate.isOwner);
  if (row && (!row.enabled || row.definitionVersion !== version))
    throw new WorkflowError(
      409,
      "Module workflow is disabled or publication is outside the active mapping.",
    );
  const binding = row?.manifest?.bindings?.find(
    (candidate: {definitionId: string}) => candidate.definitionId === id,
  );
  if (!binding) return;
  if (!row.manifest.schemas.some((schema: {id: string}) => schema.id === binding.schemaId) &&
      !rows.some(dependency => dependency.enabled &&
        row.manifest.dependencies.some((dep: {id: string; version: string}) => dep.id === dependency.id && dep.version === dependency.version) &&
        dependency.manifest.schemas.some((schema: {id: string}) => schema.id === binding.schemaId)))
    throw new WorkflowError(409, "Binding schema must belong to an exact enabled dependency.");
  return {
    schemaId: binding.schemaId,
    schemaVersion: binding.schemaVersion,
    binding: {
      moduleId: row.id,
      moduleVersion: row.version,
      bindingId: binding.id,
      allowedTransitions: [...binding.allowedTransitions],
    },
  };
}
function identity(id: string, version: string) {
  slug(id);
  semver(version);
}
const columns = "id,version,title,hash,revision,enabled,manifest";
async function detail(
  db: Queryable,
  org: string,
  id: string,
  version: string,
  lock = "",
): Promise<ModuleVersion> {
  const row = (
    await db.query(
      `SELECT ${columns} FROM enterprise_module_versions WHERE organization_id=$1 AND id=$2 AND version=$3 ${lock}`,
      [org, id, version],
    )
  ).rows[0];
  if (!row) throw new WorkflowError(404, "Module version not found.");
  const mappings = (
    await db.query(
      'SELECT definition_id AS "definitionId",definition_version AS "definitionVersion" FROM enterprise_module_workflows WHERE organization_id=$1 AND module_id=$2 AND module_version=$3 ORDER BY definition_id',
      [org, id, version],
    )
  ).rows;
  return {
    ...row,
    manifest: undefined,
    schemas: row.manifest.schemas.map((s: { id: string }) => s.id),
    workflows: mappings.map((w) => ({
      ...w,
      definitionVersion: w.definitionVersion ?? undefined,
    })),
    blocks: row.manifest.blocks,
    dependencies: row.manifest.dependencies,
    ...(row.manifest.bindings ? {bindings:row.manifest.bindings.map((b: {definitionId:string})=>({...b,definitionVersion:mappings.find(w=>w.definitionId===b.definitionId)?.definitionVersion??undefined}))} : {}),
  };
}
async function dependencies(
  db: Queryable,
  org: string,
  manifest: ModuleManifest,
): Promise<string[]> {
  const installed = (
    await db.query(
      "SELECT id,version,enabled,manifest FROM enterprise_module_versions WHERE organization_id=$1",
      [org],
    )
  ).rows;
  const errors: string[] = [];
  for (const dep of manifest.dependencies) {
    const found = installed.find(
      (r) => r.id === dep.id && r.version === dep.version,
    );
    if (!found || !found.enabled)
      errors.push(
        `Dependency ${dep.id}@${dep.version} must be installed and enabled.`,
      );
  }
  function cycle(id: string, version: string, path: Set<string>): boolean {
    if (id === manifest.id) return true;
    const key = id + "@" + version;
    if (path.has(key)) return true;
    const row = installed.find((r) => r.id === id && r.version === version);
    return (row?.manifest.dependencies ?? []).some(
      (d: { id: string; version: string }) =>
        cycle(d.id, d.version, new Set([...path, key])),
    );
  }
  if (manifest.dependencies.some((d) => cycle(d.id, d.version, new Set())))
    errors.push("Module dependency cycle.");
  return errors;
}
async function schemaPublicationExists(
  db: Queryable, org: string, schemaId: string, version: number,
): Promise<boolean> {
  const publication = await db.query(
    "SELECT 1 FROM enterprise_schema_versions WHERE organization_id=$1 AND schema_id=$2 AND version=$3",
    [org, schemaId, version],
  );
  return !!publication.rowCount;
}
async function bindingErrors(
  db: Queryable, org: string, manifest: ModuleManifest,
): Promise<string[]> {
  const errors: string[] = [];
  const external = (manifest.bindings ?? []).filter(
    binding => !manifest.schemas.some(schema => schema.id === binding.schemaId),
  );
  const owners = external.length ? (await db.query(
    "SELECT id,version,enabled,manifest FROM enterprise_module_versions WHERE organization_id=$1",
    [org],
  )).rows : [];
  for (const binding of external) {
    const declaredOwner = owners.some(row =>
      row.enabled &&
      manifest.dependencies.some(dep => dep.id === row.id && dep.version === row.version) &&
      row.manifest.schemas.some((schema: {id: string}) => schema.id === binding.schemaId),
    );
    if (!declaredOwner)
      errors.push(`Binding ${binding.id} schema must belong to an exact enabled dependency.`);
    if (!await schemaPublicationExists(db, org, binding.schemaId, binding.schemaVersion))
      errors.push(`Binding ${binding.id} schema publication is unavailable.`);
  }
  return errors;
}
async function validatePublishedBindings(
  db: Queryable, org: string, manifest: ModuleManifest,
  workflows: ModuleVersion["workflows"],
): Promise<void> {
  const errors = await bindingErrors(db, org, manifest);
  for (const binding of manifest.bindings ?? []) {
    const mapping = workflows.find(workflow => workflow.definitionId === binding.definitionId);
    const row = (await db.query(
      "SELECT definition FROM workflow_definition_versions WHERE organization_id=$1 AND id=$2 AND version=$3",
      [org, binding.definitionId, mapping?.definitionVersion],
    )).rows[0];
    if (!row || binding.allowedTransitions.some(id =>
      !row.definition.transitions.some((transition: {id: string}) => transition.id === id),
    )) errors.push(`Binding ${binding.id} workflow publication or transition is unavailable.`);
    if (!await schemaPublicationExists(db, org, binding.schemaId, binding.schemaVersion))
      errors.push(`Binding ${binding.id} schema publication is unavailable.`);
  }
  if (errors.length) throw new WorkflowError(409, errors.join(" "));
}
async function preview(
  db: Queryable,
  manifest: ModuleManifest,
  actor: WorkflowActor,
): Promise<ModulePreview> {
  const conflicts: string[] = [];
  const schemas = (
    await db.query(
      "SELECT id FROM enterprise_schemas WHERE organization_id=$1 AND id=ANY($2::text[])",
      [actor.organizationId, manifest.schemas.map((s) => s.id)],
    )
  ).rows;
  for (const row of schemas) conflicts.push(`Schema ${row.id} already exists.`);
  const ids = manifest.bundle.definitions.map((d) => d.id);
  const drafts = (
    await db.query(
      "SELECT id FROM workflow_definition_drafts WHERE organization_id=$1 AND id=ANY($2::text[])",
      [actor.organizationId, ids],
    )
  ).rows;
  for (const id of ids)
    if (
      workflowDefinitions.some((d) => d.id === id) ||
      drafts.some((d) => d.id === id)
    )
      conflicts.push(`Workflow ${id} is reserved or already exists.`);
  const published = (
    await db.query(
      "SELECT DISTINCT schema_id FROM enterprise_schema_versions WHERE organization_id=$1",
      [actor.organizationId],
    )
  ).rows.map((r) => r.schema_id);
  for (const schema of manifest.schemas)
    for (const relation of Object.values(schema.relations))
      if (
        !manifest.schemas.some((s) => s.id === relation.targetSchemaId) &&
        !published.includes(relation.targetSchemaId)
      )
        conflicts.push(
          `Relation target ${relation.targetSchemaId} is not published in this organization.`,
        );
  const summaries = bundlePreview(manifest.bundle).definitions;
  return {
    hash: manifestHash(manifest),
    resources: {
      schemas: manifest.schemas.map((s) => s.id),
      workflows: ids,
      blocks: manifest.blocks.map((b) => b.id),
    },
    requiredRoles: [
      ...new Set([
        ...summaries.flatMap((d) => d.requiredRoles),
        ...manifest.blocks.map((b) => findBlock(b.id)!.requiredRole),
      ]),
    ].sort(),
    connectors: [...new Set(summaries.flatMap((d) => d.connectors))].sort(),
    conflicts,
    dependencyErrors: [...await dependencies(db, actor.organizationId, manifest), ...await bindingErrors(db,actor.organizationId,manifest)],
    ...(manifest.bindings ? {bindings:manifest.bindings} : {}),
  };
}
export async function modulesDatabase(
  pool: Pool,
  workflows: WorkflowRepository,
): Promise<ModuleRepository> {
  await initializeModuleTables(pool);
  async function transaction<T>(
    actor: WorkflowActor,
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        ["enterprise-modules:" + actor.organizationId],
      );
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "23505"
      )
        throw new WorkflowError(409, "Module resource already exists.");
      throw error;
    } finally {
      client.release();
    }
  }
  async function command<T>(
    actor: WorkflowActor,
    operation: string,
    key: string,
    input: unknown,
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    requireModuleAdmin(actor);
    if (!parseCreateKey(key))
      throw new WorkflowError(400, "Idempotency-Key required.");
    return transaction(actor, async (client) => {
      const tuple = [actor.organizationId, actor.subject, operation, key];
      const hash = manifestHash(input);
      const receipt = (
        await client.query(
          "SELECT fingerprint,result FROM enterprise_module_commands WHERE organization_id=$1 AND actor_id=$2 AND operation=$3 AND key=$4",
          tuple,
        )
      ).rows[0];
      if (receipt) {
        if (receipt.fingerprint !== hash)
          throw new WorkflowError(409, "Idempotency-Key input conflict.");
        return receipt.result;
      }
      const result = await work(client);
      await client.query(
        "INSERT INTO enterprise_module_commands(organization_id,actor_id,operation,key,fingerprint,result) VALUES($1,$2,$3,$4,$5,$6)",
        [...tuple, hash, JSON.stringify(result)],
      );
      return result;
    });
  }
  async function audit(
    db: Queryable,
    actor: WorkflowActor,
    module: ModuleVersion,
    operation: string,
  ) {
    await db.query(
      "INSERT INTO enterprise_module_audit(audit_id,organization_id,module_id,module_version,actor_id,operation,revision,enabled) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        randomUUID(),
        actor.organizationId,
        module.id,
        module.version,
        actor.subject,
        operation,
        module.revision,
        module.enabled,
      ],
    );
  }
  return {
    async preview(value, actor) {
      requireModuleAdmin(actor);
      return {
        ...(await preview(pool, parseManifest(value), actor)),
        hash: manifestHash(value),
      };
    },
    async install(value, actor, key) {
      const manifest = parseManifest(value);
      const hash = manifestHash(value);
      return command(actor, "install", key, value, async (client) => {
        const old = (
          await client.query(
            "SELECT hash FROM enterprise_module_versions WHERE organization_id=$1 AND id=$2 AND version=$3",
            [actor.organizationId, manifest.id, manifest.version],
          )
        ).rows[0];
        if (old) {
          if (old.hash !== hash)
            throw new WorkflowError(
              409,
              "Immutable module version hash conflict.",
            );
          return detail(
            client,
            actor.organizationId,
            manifest.id,
            manifest.version,
          );
        }
        const check = await preview(client, manifest, actor);
        check.hash = hash;
        if (check.conflicts.length || check.dependencyErrors.length)
          throw new WorkflowError(
            409,
            [...check.conflicts, ...check.dependencyErrors].join(" "),
          );
        await client.query(
          "INSERT INTO enterprise_module_versions(organization_id,id,version,title,hash,manifest,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [
            actor.organizationId,
            manifest.id,
            manifest.version,
            manifest.title,
            check.hash,
            JSON.stringify(manifest),
            actor.subject,
          ],
        );
        // Match registry batch imports so concurrent inserts acquire unique-key locks
        // in the same order, regardless of the manifest's resource ordering.
        const schemas = [...manifest.schemas].sort((a, b) => a.id.localeCompare(b.id));
        for (const schema of schemas) {
          await client.query(
            "INSERT INTO enterprise_schemas(organization_id,id,definition,published_version,published_revision) VALUES($1,$2,$3,1,1)",
            [actor.organizationId, schema.id, JSON.stringify(schema)],
          );
          await client.query(
            "INSERT INTO enterprise_schema_versions(organization_id,schema_id,version,definition) VALUES($1,$2,1,$3)",
            [actor.organizationId, schema.id, JSON.stringify(schema)],
          );
        }
        const definitions = [...manifest.bundle.definitions].sort((a, b) => a.id.localeCompare(b.id));
        for (const definition of definitions) {
          await insertDraft(client, definition, actor);
          await client.query(
            "INSERT INTO enterprise_module_workflows(organization_id,module_id,module_version,definition_id) VALUES($1,$2,$3,$4)",
            [
              actor.organizationId,
              manifest.id,
              manifest.version,
              definition.id,
            ],
          );
        }
        const result: ModuleVersion = {
          id: manifest.id,
          version: manifest.version,
          title: manifest.title,
          hash: check.hash,
          revision: 1,
          enabled: false,
          schemas: [...check.resources.schemas].sort(),
          workflows: [...check.resources.workflows].sort().map((definitionId) => ({
            definitionId,
          })),
          blocks: manifest.blocks,
          dependencies: manifest.dependencies,
          ...(manifest.bindings ? {bindings:manifest.bindings} : {}),
        };
        await audit(client, actor, result, "install");
        return result;
      });
    },
    async get(id, version, actor) {
      requireModuleDesigner(actor);
      identity(id, version);
      return detail(pool, actor.organizationId, id, version);
    },
    async list(actor, page) {
      requireModuleDesigner(actor);
      const rows = (
        await pool.query(
          "SELECT id,version FROM enterprise_module_versions WHERE organization_id=$1 AND ($2='' OR strpos(lower(title),lower($2))>0) ORDER BY id,version LIMIT $3 OFFSET $4",
          [actor.organizationId, page.q, page.limit + 1, page.offset],
        )
      ).rows;
      return pageResult(
        await Promise.all(
          rows.map((r) => detail(pool, actor.organizationId, r.id, r.version)),
        ),
        page,
      );
    },
    async audit(id, version, actor, page) {
      requireModuleDesigner(actor);
      identity(id, version);
      await detail(pool, actor.organizationId, id, version);
      const rows = (
        await pool.query(
          'SELECT audit_id AS id,actor_id AS "actorId",operation,revision,enabled,occurred_at AS "occurredAt" FROM enterprise_module_audit WHERE organization_id=$1 AND module_id=$2 AND module_version=$3 ORDER BY occurred_at,audit_id LIMIT $4 OFFSET $5',
          [actor.organizationId, id, version, page.limit + 1, page.offset],
        )
      ).rows;
      return pageResult(rows, page);
    },
    async setEnabled(id, version, input, actor, key) {
      identity(id, version);
      return command(
        actor,
        "enabled",
        key,
        { id, version, ...input },
        async (client) => {
          // Acquire owner and exact dependency row locks in deterministic order.
          const owner = (await client.query("SELECT manifest FROM enterprise_module_versions WHERE organization_id=$1 AND id=$2 AND version=$3",[actor.organizationId,id,version])).rows[0];
          if (!owner) throw new WorkflowError(404,"Module version not found.");
          const locks = [{id,version},...owner.manifest.dependencies].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:a.version<b.version?-1:a.version>b.version?1:0);
          for(const lock of locks)await client.query("SELECT id FROM enterprise_module_versions WHERE organization_id=$1 AND id=$2 AND version=$3 FOR UPDATE",[actor.organizationId,lock.id,lock.version]);
          const module = await detail(
            client,
            actor.organizationId,
            id,
            version,
            "FOR UPDATE",
          );
          if (module.revision !== input.expectedRevision)
            throw new WorkflowError(409, "Module revision conflict.");
          if (input.enabled) {
            const manifest = (
              await client.query(
                "SELECT manifest FROM enterprise_module_versions WHERE organization_id=$1 AND id=$2 AND version=$3",
                [actor.organizationId, id, version],
              )
            ).rows[0].manifest;
            const errors = await dependencies(
              client,
              actor.organizationId,
              manifest,
            );
            if (errors.length) throw new WorkflowError(409, errors.join(" "));
            if (
              module.workflows.some((w) => w.definitionVersion === undefined)
            ) {
              const chosen: {
                definitionId: string;
                definitionVersion: number;
              }[] = [];
              for (const workflow of module.workflows) {
                const row = (
                  await client.query(
                    "SELECT version FROM workflow_definition_versions WHERE organization_id=$1 AND id=$2 ORDER BY version DESC LIMIT 1",
                    [actor.organizationId, workflow.definitionId],
                  )
                ).rows[0];
                if (!row)
                  throw new WorkflowError(
                    409,
                    "All module workflows must be published before enabling.",
                  );
                chosen.push({
                  definitionId: workflow.definitionId,
                  definitionVersion: row.version,
                });
              }
              for (const w of chosen)
                await client.query(
                  "UPDATE enterprise_module_workflows SET definition_version=$4 WHERE organization_id=$1 AND module_id=$2 AND module_version=$3 AND definition_id=$5",
                  [
                    actor.organizationId,
                    id,
                    version,
                    w.definitionVersion,
                    w.definitionId,
                  ],
                );
              module.workflows = chosen;
            }
            await validatePublishedBindings(client,actor.organizationId,manifest,module.workflows);
            if(module.bindings)module.bindings=module.bindings.map(b=>({...b,definitionVersion:module.workflows.find(w=>w.definitionId===b.definitionId)?.definitionVersion}));
          }
          await client.query(
            "UPDATE enterprise_module_versions SET enabled=$4,revision=revision+1 WHERE organization_id=$1 AND id=$2 AND version=$3",
            [actor.organizationId, id, version, input.enabled],
          );
          const result = {
            ...module,
            enabled: input.enabled,
            revision: module.revision + 1,
          };
          await audit(
            client,
            actor,
            result,
            input.enabled ? "enable" : "disable",
          );
          return result;
        },
      );
    },
    async startBinding(id, version, bindingId, input, actor, key) {
      identity(id, version);
      slug(bindingId);
      if (!actor.roles.includes("workflow:start"))
        throw new WorkflowError(403, "workflow:start required.");
      if (!parseCreateKey(key))
        throw new WorkflowError(400, "Idempotency-Key required.");
      return transaction(actor, async client => {
        const module = await detail(client, actor.organizationId, id, version);
        const binding = module.bindings?.find(candidate => candidate.id === bindingId);
        if (!binding) throw new WorkflowError(404, "Module binding not found.");
        const mapping = module.workflows.find(workflow => workflow.definitionId === binding.definitionId);
        if (!module.enabled || !mapping?.definitionVersion)
          throw new WorkflowError(409, "Module workflow is not enabled.");
        return workflows.createWithClient!(
          client,
          {
            definitionId: binding.definitionId,
            definitionVersion: mapping.definitionVersion,
            title: input.title,
            input: input.input,
            entityContext: {entityId: input.entityId},
          },
          actor,
          "module-binding:" + id + ":" + version + ":" + bindingId + ":" + key,
        );
      });
    },
    async start(id, version, input, actor, key) {
      identity(id, version);
      if (!actor.roles.includes("workflow:start"))
        throw new WorkflowError(403, "workflow:start required.");
      if (!parseCreateKey(key))
        throw new WorkflowError(400, "Idempotency-Key required.");
      return transaction(actor, async (client) => {
        const module = await detail(
          client,
          actor.organizationId,
          id,
          version,
          "",
        );
        const mapping = module.workflows.find(
          (w) => w.definitionId === input.definitionId,
        );
        if (!module.enabled || !mapping?.definitionVersion)
          throw new WorkflowError(409, "Module workflow is not enabled.");
        return workflows.createWithClient!(
          client,
          { ...input, definitionVersion: mapping.definitionVersion },
          actor,
          "module:" + id + ":" + version + ":" + key,
        );
      });
    },
  };
}
