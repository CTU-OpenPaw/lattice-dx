/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { WorkflowActor } from '@dx/contracts';
import { parseCreateKey } from '../create-command.js';
import { pageResult, type PageQuery } from '../pagination.js';
import { WorkflowError } from '../workflows/policy.js';
import { requireModuleAdmin, semver } from '../modules/policy.js';
import { slug } from '../entities/policy.js';
import type {
  EffectiveSystemAccess,
  PrincipalType,
  SystemAccessRepository,
  SystemGrant,
  SystemGrantAuditEntry,
  SystemGrantInput,
  SystemGrantRevokeInput,
  SystemGrantStatus,
  SystemGrantUpdateInput,
} from './access-types.js';

type Queryable = Pick<PoolClient, 'query'>;

const RESERVED_PLATFORM_ROLES = new Set([
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

interface GrantDbRow {
  systemId: string;
  systemVersion: string;
  principalType: PrincipalType;
  principalId: string;
  roles: string[];
  status: SystemGrantStatus;
  revision: number;
  createdBy: string;
  createdAt: Date;
  updatedBy: string;
  updatedAt: Date;
}

interface AuditDbRow {
  auditId: string;
  systemId: string;
  systemVersion: string;
  principalType: PrincipalType;
  principalId: string;
  revision: number;
  actorId: string;
  operation: 'grant' | 'update' | 'revoke';
  roles: string[];
  status: SystemGrantStatus;
  occurredAt: Date;
}

const GRANT_COLUMNS =
  'system_id AS "systemId", system_version AS "systemVersion", principal_type AS "principalType", principal_id AS "principalId", roles, status, revision, created_by AS "createdBy", created_at AS "createdAt", updated_by AS "updatedBy", updated_at AS "updatedAt"';

const AUDIT_COLUMNS =
  'audit_id AS "auditId", system_id AS "systemId", system_version AS "systemVersion", principal_type AS "principalType", principal_id AS "principalId", revision, actor_id AS "actorId", operation, roles, status, occurred_at AS "occurredAt"';

function serializeGrant(row: GrantDbRow): SystemGrant {
  return {
    systemId: row.systemId,
    systemVersion: row.systemVersion,
    principalType: row.principalType,
    principalId: row.principalId,
    roles: row.roles,
    status: row.status,
    revision: row.revision,
    createdBy: row.createdBy,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedBy: row.updatedBy,
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

function serializeAudit(row: AuditDbRow): SystemGrantAuditEntry {
  return {
    auditId: row.auditId,
    systemId: row.systemId,
    systemVersion: row.systemVersion,
    principalType: row.principalType,
    principalId: row.principalId,
    revision: row.revision,
    actorId: row.actorId,
    operation: row.operation,
    roles: row.roles,
    status: row.status,
    occurredAt: new Date(row.occurredAt).toISOString(),
  };
}

export async function initializeSystemAccessTables(pool: Queryable): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS studio_system_grants(
    organization_id text NOT NULL,
    system_id text NOT NULL,
    system_version text NOT NULL,
    principal_type text NOT NULL CHECK(principal_type IN ('person', 'department')),
    principal_id text NOT NULL,
    roles jsonb NOT NULL CHECK(jsonb_typeof(roles) = 'array'),
    status text NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'revoked')),
    revision integer NOT NULL DEFAULT 1,
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_by text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(organization_id, system_id, system_version, principal_type, principal_id)
  );
  CREATE INDEX IF NOT EXISTS studio_system_grants_lookup_idx
    ON studio_system_grants(organization_id, system_id, system_version, principal_id);
  CREATE TABLE IF NOT EXISTS studio_system_grant_audit(
    audit_id uuid PRIMARY KEY,
    organization_id text NOT NULL,
    system_id text NOT NULL,
    system_version text NOT NULL,
    principal_type text NOT NULL,
    principal_id text NOT NULL,
    revision integer NOT NULL,
    actor_id text NOT NULL,
    operation text NOT NULL CHECK(operation IN ('grant', 'update', 'revoke')),
    roles jsonb NOT NULL,
    status text NOT NULL,
    occurred_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS studio_system_grant_audit_idx
    ON studio_system_grant_audit(organization_id, system_id, system_version, occurred_at DESC, revision DESC, audit_id DESC);
  CREATE TABLE IF NOT EXISTS studio_system_grant_commands(
    organization_id text NOT NULL,
    actor_id text NOT NULL,
    key text NOT NULL,
    fingerprint text NOT NULL,
    result jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(organization_id, actor_id, key)
  );
  CREATE TABLE IF NOT EXISTS studio_system_policies(
    organization_id text NOT NULL,
    system_id text NOT NULL,
    system_version text NOT NULL,
    status text NOT NULL DEFAULT 'enforced' CHECK(status IN ('legacy', 'enforced')),
    revision integer NOT NULL DEFAULT 1,
    activated_by text NOT NULL,
    activated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(organization_id, system_id, system_version)
  );
  CREATE TABLE IF NOT EXISTS studio_system_policy_audit(
    audit_id uuid PRIMARY KEY,
    organization_id text NOT NULL,
    system_id text NOT NULL,
    system_version text NOT NULL,
    status text NOT NULL,
    revision integer NOT NULL,
    actor_id text NOT NULL,
    occurred_at timestamptz NOT NULL DEFAULT now()
  );`);
}

async function recordGrantAudit(
  client: Queryable,
  org: string,
  systemId: string,
  version: string,
  principalType: PrincipalType,
  principalId: string,
  revision: number,
  actorId: string,
  operation: 'grant' | 'update' | 'revoke',
  roles: string[],
  status: SystemGrantStatus
): Promise<void> {
  const auditId = randomUUID();
  await client.query(
    `INSERT INTO studio_system_grant_audit(audit_id, organization_id, system_id, system_version, principal_type, principal_id, revision, actor_id, operation, roles, status)
     VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)`,
    [auditId, org, systemId, version, principalType, principalId, revision, actorId, operation, JSON.stringify(roles), status]
  );
}

async function validateModuleInstalled(
  client: Queryable,
  org: string,
  systemId: string,
  version: string
): Promise<void> {
  const exists = (
    await client.query(
      'SELECT 1 FROM enterprise_module_versions WHERE organization_id=$1 AND id=$2 AND version=$3',
      [org, systemId, version]
    )
  ).rows.length > 0;
  if (!exists) throw new WorkflowError(404, 'System version not found or not installed.');
}

async function validateRoles(
  client: Queryable,
  org: string,
  systemId: string,
  version: string,
  roles: unknown
): Promise<string[]> {
  if (!Array.isArray(roles)) throw new WorkflowError(400, 'Roles must be an array.');
  const unique = new Set<string>();
  for (const r of roles) {
    if (typeof r !== 'string' || !/^[a-z][a-z0-9:_-]{0,79}$/.test(r)) {
      throw new WorkflowError(400, `Invalid role format: ${r}`);
    }
    if (RESERVED_PLATFORM_ROLES.has(r)) {
      throw new WorkflowError(400, 'Cannot grant reserved platform role in system scope.');
    }
    if (unique.has(r)) throw new WorkflowError(400, `Duplicate role: ${r}`);
    unique.add(r);
  }

  await validateModuleInstalled(client, org, systemId, version);

  // If roles array is empty (entity-only access), no workflow definition check is required
  if (unique.size === 0) return [];

  // Query persisted published workflow definitions owned by this installed module version
  const mappings = (
    await client.query(
      `SELECT w.definition_id AS "definitionId", w.definition_version AS "definitionVersion", v.definition
       FROM enterprise_module_workflows w
       LEFT JOIN workflow_definition_versions v
         ON v.organization_id = w.organization_id
         AND v.id = w.definition_id
         AND v.version = w.definition_version
       WHERE w.organization_id = $1 AND w.module_id = $2 AND w.module_version = $3`,
      [org, systemId, version]
    )
  ).rows;

  // Fail closed if module has workflows declared but unpublished/mismatched when nonempty roles requested
  if (mappings.length > 0 && mappings.some(m => !m.definitionVersion || !m.definition)) {
    throw new WorkflowError(409, 'Module workflow definitions are not published yet.');
  }

  const declared = new Set<string>();
  for (const m of mappings) {
    const d = m.definition;
    if (!d) continue;
    if (d.startRole) declared.add(d.startRole);
    if (Array.isArray(d.readerRoles)) for (const role of d.readerRoles) declared.add(role);
    if (d.assignedReader?.role) declared.add(d.assignedReader.role);
    if (Array.isArray(d.transitions)) {
      for (const t of d.transitions) {
        // Exclude service transitions from business grant whitelist
        if (t.role && t.execution !== 'service') declared.add(t.role);
      }
    }
  }

  for (const r of unique) {
    if (!declared.has(r)) {
      throw new WorkflowError(400, `Role '${r}' is not declared by this system version.`);
    }
  }

  return [...unique].sort();
}

async function validatePrincipal(
  client: Queryable,
  org: string,
  type: PrincipalType,
  id: string
): Promise<void> {
  if (typeof id !== 'string' || !id.trim() || id !== id.trim() || id.length > 100 || /[\x00-\x1f\x7f]/.test(id)) {
    throw new WorkflowError(400, 'Invalid principal ID.');
  }
  if (type === 'person') {
    const person = (
      await client.query(
        'SELECT subject FROM directory_people WHERE organization_id=$1 AND subject=$2 AND enabled=true FOR SHARE',
        [org, id]
      )
    ).rows[0];
    if (!person) throw new WorkflowError(400, 'Principal must be an active member of this organization.');
  } else if (type === 'department') {
    const dept = (
      await client.query(
        'SELECT id FROM organization_departments WHERE organization_id=$1 AND id=$2',
        [org, id]
      )
    ).rows[0];
    if (!dept) {
      const ref = (
        await client.query(
          "SELECT id FROM workflow_references WHERE organization_id=$1 AND kind='department' AND id=$2",
          [org, id]
        )
      ).rows[0];
      if (!ref) throw new WorkflowError(400, 'Department does not exist in this organization.');
    }
  } else {
    throw new WorkflowError(400, 'Invalid principal type.');
  }
}

export async function systemAccessDatabase(pool: Pool): Promise<SystemAccessRepository> {
  await initializeSystemAccessTables(pool);

  async function command<T>(
    actor: WorkflowActor,
    systemId: string,
    version: string,
    principalType: PrincipalType,
    principalId: string,
    action: 'grant' | 'update' | 'revoke',
    body: unknown,
    key: string,
    fn: (client: PoolClient) => Promise<T>
  ): Promise<T> {
    requireModuleAdmin(actor);
    if (!parseCreateKey(key)) throw new WorkflowError(400, 'Idempotency-Key required.');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Lock 1: Command identity serialization
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        JSON.stringify(['system-membership-cmd', actor.organizationId, actor.subject, key]),
      ]);

      const fingerprint = createHash('sha256')
        .update(
          JSON.stringify({
            organizationId: actor.organizationId,
            systemId,
            version,
            principalType,
            principalId,
            action,
            body: body ?? null,
          })
        )
        .digest('hex');

      const receipt = (
        await client.query(
          'SELECT fingerprint, result FROM studio_system_grant_commands WHERE organization_id=$1 AND actor_id=$2 AND key=$3',
          [actor.organizationId, actor.subject, key]
        )
      ).rows[0];
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) {
          throw new WorkflowError(409, 'Idempotency-Key reuse conflict.');
        }
        await client.query('COMMIT');
        return receipt.result;
      }

      // Lock 2: Target system resource serialization
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        JSON.stringify(['system-membership-res', actor.organizationId, systemId, version]),
      ]);

      const result = await fn(client);
      await client.query(
        'INSERT INTO studio_system_grant_commands(organization_id, actor_id, key, fingerprint, result) VALUES($1, $2, $3, $4, $5)',
        [actor.organizationId, actor.subject, key, fingerprint, JSON.stringify(result)]
      );
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
    async grant(systemId, version, input, actor, key) {
      const id = slug(systemId);
      const ver = semver(version);
      if (input.principalType !== 'person' && input.principalType !== 'department') {
        throw new WorkflowError(400, 'Invalid principal type.');
      }
      return command(
        actor,
        id,
        ver,
        input.principalType,
        input.principalId,
        'grant',
        input,
        key,
        async client => {
          await validatePrincipal(client, actor.organizationId, input.principalType, input.principalId);
          const validRoles = await validateRoles(client, actor.organizationId, id, ver, input.roles);

          const existing = (
            await client.query(
              'SELECT revision, status FROM studio_system_grants WHERE organization_id=$1 AND system_id=$2 AND system_version=$3 AND principal_type=$4 AND principal_id=$5 FOR UPDATE',
              [actor.organizationId, id, ver, input.principalType, input.principalId]
            )
          ).rows[0];

          let row: GrantDbRow;
          let newRevision = 1;
          if (existing) {
            if (existing.status === 'active') {
              throw new WorkflowError(409, 'Grant already exists; use update to modify roles.');
            }
            newRevision = existing.revision + 1;
            row = (
              await client.query(
                `UPDATE studio_system_grants SET status='active', roles=$1::jsonb, revision=$2, updated_by=$3, updated_at=now()
                 WHERE organization_id=$4 AND system_id=$5 AND system_version=$6 AND principal_type=$7 AND principal_id=$8
                 RETURNING ${GRANT_COLUMNS}`,
                [
                  JSON.stringify(validRoles),
                  newRevision,
                  actor.subject,
                  actor.organizationId,
                  id,
                  ver,
                  input.principalType,
                  input.principalId,
                ]
              )
            ).rows[0];
          } else {
            row = (
              await client.query(
                `INSERT INTO studio_system_grants(organization_id, system_id, system_version, principal_type, principal_id, roles, status, revision, created_by, updated_by)
                 VALUES($1, $2, $3, $4, $5, $6::jsonb, 'active', 1, $7, $7)
                 RETURNING ${GRANT_COLUMNS}`,
                [
                  actor.organizationId,
                  id,
                  ver,
                  input.principalType,
                  input.principalId,
                  JSON.stringify(validRoles),
                  actor.subject,
                ]
              )
            ).rows[0];
          }

          await recordGrantAudit(
            client,
            actor.organizationId,
            id,
            ver,
            input.principalType,
            input.principalId,
            newRevision,
            actor.subject,
            'grant',
            validRoles,
            'active'
          );

          return serializeGrant(row);
        }
      );
    },

    async update(systemId, version, principalType, principalId, input, actor, key) {
      const id = slug(systemId);
      const ver = semver(version);
      if (principalType !== 'person' && principalType !== 'department') {
        throw new WorkflowError(400, 'Invalid principal type.');
      }
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
        throw new WorkflowError(400, 'Invalid expected revision.');
      }

      return command(
        actor,
        id,
        ver,
        principalType,
        principalId,
        'update',
        input,
        key,
        async client => {
          // Revalidate principal active status under directory lock
          await validatePrincipal(client, actor.organizationId, principalType, principalId);
          const validRoles = await validateRoles(client, actor.organizationId, id, ver, input.roles);

          const existing = (
            await client.query(
              'SELECT revision, status FROM studio_system_grants WHERE organization_id=$1 AND system_id=$2 AND system_version=$3 AND principal_type=$4 AND principal_id=$5 FOR UPDATE',
              [actor.organizationId, id, ver, principalType, principalId]
            )
          ).rows[0];

          if (!existing || existing.status !== 'active') {
            throw new WorkflowError(404, 'System member grant not found.');
          }
          if (existing.revision !== input.expectedRevision) {
            throw new WorkflowError(409, 'Grant revision conflict; reload before saving.');
          }

          const newRevision = existing.revision + 1;
          const row: GrantDbRow = (
            await client.query(
              `UPDATE studio_system_grants SET roles=$1::jsonb, revision=$2, updated_by=$3, updated_at=now()
               WHERE organization_id=$4 AND system_id=$5 AND system_version=$6 AND principal_type=$7 AND principal_id=$8
               RETURNING ${GRANT_COLUMNS}`,
              [
                JSON.stringify(validRoles),
                newRevision,
                actor.subject,
                actor.organizationId,
                id,
                ver,
                principalType,
                principalId,
              ]
            )
          ).rows[0];

          await recordGrantAudit(
            client,
            actor.organizationId,
            id,
            ver,
            principalType,
            principalId,
            newRevision,
            actor.subject,
            'update',
            validRoles,
            'active'
          );

          return serializeGrant(row);
        }
      );
    },

    async revoke(systemId, version, principalType, principalId, input, actor, key) {
      const id = slug(systemId);
      const ver = semver(version);
      if (principalType !== 'person' && principalType !== 'department') {
        throw new WorkflowError(400, 'Invalid principal type.');
      }
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
        throw new WorkflowError(400, 'Invalid expected revision.');
      }

      return command(
        actor,
        id,
        ver,
        principalType,
        principalId,
        'revoke',
        input,
        key,
        async client => {
          const existing = (
            await client.query(
              'SELECT revision, status, roles FROM studio_system_grants WHERE organization_id=$1 AND system_id=$2 AND system_version=$3 AND principal_type=$4 AND principal_id=$5 FOR UPDATE',
              [actor.organizationId, id, ver, principalType, principalId]
            )
          ).rows[0];

          if (!existing || existing.status !== 'active') {
            throw new WorkflowError(404, 'System member grant not found.');
          }
          if (existing.revision !== input.expectedRevision) {
            throw new WorkflowError(409, 'Grant revision conflict; reload before revoking.');
          }

          const newRevision = existing.revision + 1;
          // Tombstone: increments revision while marking revoked
          await client.query(
            `UPDATE studio_system_grants SET status='revoked', revision=$1, updated_by=$2, updated_at=now()
             WHERE organization_id=$3 AND system_id=$4 AND system_version=$5 AND principal_type=$6 AND principal_id=$7`,
            [newRevision, actor.subject, actor.organizationId, id, ver, principalType, principalId]
          );

          await recordGrantAudit(
            client,
            actor.organizationId,
            id,
            ver,
            principalType,
            principalId,
            newRevision,
            actor.subject,
            'revoke',
            existing.roles,
            'revoked'
          );

          return {
            revoked: true,
            systemId: id,
            version: ver,
            principalType,
            principalId,
            revision: newRevision,
          };
        }
      );
    },

    async list(systemId, version, actor, page, principalType) {
      requireModuleAdmin(actor);
      const id = slug(systemId);
      const ver = semver(version);

      await validateModuleInstalled(pool, actor.organizationId, id, ver);

      const values: unknown[] = [actor.organizationId, id, ver];
      const where = ["organization_id=$1 AND system_id=$2 AND system_version=$3 AND status='active'"];

      if (principalType) {
        if (principalType !== 'person' && principalType !== 'department') {
          throw new WorkflowError(400, 'Invalid principal type filter.');
        }
        values.push(principalType);
        where.push(`principal_type=$${values.length}`);
      }

      // Safe strpos matching: immune to LIKE wildcards (% or _) and standard_conforming_strings differences
      if (page.q) {
        values.push(page.q.toLowerCase());
        where.push(`strpos(lower(principal_id), $${values.length}) > 0`);
      }

      values.push(page.limit + 1, page.offset);
      const rows = (
        await pool.query<GrantDbRow>(
          `SELECT ${GRANT_COLUMNS} FROM studio_system_grants
           WHERE ${where.join(' AND ')}
           ORDER BY principal_type, principal_id
           LIMIT $${values.length - 1} OFFSET $${values.length}`,
          values
        )
      ).rows;

      return pageResult(rows.map(serializeGrant), page);
    },

    async history(systemId, version, actor, page, principalType, principalId) {
      requireModuleAdmin(actor);
      const id = slug(systemId);
      const ver = semver(version);

      await validateModuleInstalled(pool, actor.organizationId, id, ver);

      const values: unknown[] = [actor.organizationId, id, ver];
      const where = ['organization_id=$1 AND system_id=$2 AND system_version=$3'];

      if (principalType) {
        if (principalType !== 'person' && principalType !== 'department') {
          throw new WorkflowError(400, 'Invalid principal type filter.');
        }
        values.push(principalType);
        where.push(`principal_type=$${values.length}`);
      }
      if (principalId) {
        if (typeof principalId !== 'string' || !principalId.trim() || principalId.length > 100) {
          throw new WorkflowError(400, 'Invalid principal ID filter.');
        }
        values.push(principalId);
        where.push(`principal_id=$${values.length}`);
      }
      if (page.q) {
        values.push(page.q.toLowerCase());
        where.push(`strpos(lower(principal_id), $${values.length}) > 0`);
      }

      values.push(page.limit + 1, page.offset);
      // Deterministic order: occurred_at DESC, revision DESC, audit_id DESC
      const rows = (
        await pool.query<AuditDbRow>(
          `SELECT ${AUDIT_COLUMNS} FROM studio_system_grant_audit
           WHERE ${where.join(' AND ')}
           ORDER BY occurred_at DESC, revision DESC, audit_id DESC
           LIMIT $${values.length - 1} OFFSET $${values.length}`,
          values
        )
      ).rows;

      return pageResult(rows.map(serializeAudit), page);
    },

    async effectiveAccess(systemId, version, actor) {
      const id = slug(systemId);
      const ver = semver(version);

      await validateModuleInstalled(pool, actor.organizationId, id, ver);

      // Single coherent query snapshot: reads caller directory state, person grant, and department grant atomically
      const result = (
        await pool.query<{
          enabled: boolean;
          departmentId: string | null;
          grants: Array<{ source: PrincipalType; principalId: string; roles: string[] }>;
        }>(
          `WITH caller AS (
             SELECT subject, department_id, enabled
             FROM directory_people
             WHERE organization_id = $1 AND subject = $2
           ),
           active_grants AS (
             SELECT g.principal_type, g.principal_id, g.roles
             FROM studio_system_grants g
             JOIN caller c ON c.enabled = true AND (
               (g.principal_type = 'person' AND g.principal_id = c.subject)
               OR (g.principal_type = 'department' AND c.department_id IS NOT NULL AND g.principal_id = c.department_id)
             )
             WHERE g.organization_id = $1 AND g.system_id = $3 AND g.system_version = $4 AND g.status = 'active'
           )
           SELECT
             c.enabled,
             c.department_id AS "departmentId",
             COALESCE(
               jsonb_agg(
                 jsonb_build_object(
                   'source', g.principal_type,
                   'principalId', g.principal_id,
                   'roles', g.roles
                 )
               ) FILTER (WHERE g.principal_id IS NOT NULL),
               '[]'::jsonb
             ) AS grants
           FROM caller c
           LEFT JOIN active_grants g ON true
           GROUP BY c.enabled, c.department_id`,
          [actor.organizationId, actor.subject, id, ver]
        )
      ).rows[0];

      const policyRow = (
        await pool.query<{ status: 'legacy' | 'enforced' }>(
          'SELECT status FROM studio_system_policies WHERE organization_id = $1 AND system_id = $2 AND system_version = $3',
          [actor.organizationId, id, ver]
        )
      ).rows[0];
      const enforcementStatus = policyRow ? policyRow.status : 'not_enforced';

      if (!result || !result.enabled) {
        return {
          systemId: id,
          version: ver,
          hasAccess: false,
          effectiveRoles: [],
          sources: [],
          enforcementStatus,
        };
      }

      const sources = result.grants ?? [];
      const roleSet = new Set<string>();
      for (const src of sources) {
        for (const r of src.roles) roleSet.add(r);
      }

      return {
        systemId: id,
        version: ver,
        hasAccess: sources.length > 0,
        effectiveRoles: [...roleSet].sort(),
        sources,
        enforcementStatus,
      };
    },

    async activatePolicy(systemId, version, input, actor, key) {
      const id = slug(systemId);
      const ver = semver(version);
      requireModuleAdmin(actor);
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
        throw new WorkflowError(400, 'Invalid expected revision.');
      }

      return command(
        actor,
        id,
        ver,
        'person',
        'policy',
        'update',
        { action: 'activate_policy', expectedRevision: input.expectedRevision },
        key,
        async client => {
          await validateModuleInstalled(client, actor.organizationId, id, ver);

          // Preflight: module workflows must be published
          const mappings = (
            await client.query(
              `SELECT w.definition_id AS "definitionId", w.definition_version AS "definitionVersion", v.definition
               FROM enterprise_module_workflows w
               LEFT JOIN workflow_definition_versions v
                 ON v.organization_id = w.organization_id
                 AND v.id = w.definition_id
                 AND v.version = w.definition_version
               WHERE w.organization_id = $1 AND w.module_id = $2 AND w.module_version = $3`,
              [actor.organizationId, id, ver]
            )
          ).rows;

          if (mappings.length > 0 && mappings.some(m => !m.definitionVersion || !m.definition)) {
            throw new WorkflowError(409, 'Cannot activate policy: module workflow definitions are not published yet.');
          }

          // Preflight: validate real directory readiness (at least one eligible enabled member in directory_people)
          const eligibleMember = (
            await client.query(
              `SELECT 1 FROM studio_system_grants g
               WHERE g.organization_id = $1 AND g.system_id = $2 AND g.system_version = $3 AND g.status = 'active'
                 AND EXISTS (
                   SELECT 1 FROM directory_people p
                   WHERE p.organization_id = g.organization_id
                     AND p.enabled = true
                     AND (
                       (g.principal_type = 'person' AND p.subject = g.principal_id)
                       OR (g.principal_type = 'department' AND p.department_id IS NOT NULL AND p.department_id = g.principal_id)
                     )
                 )
               LIMIT 1`,
              [actor.organizationId, id, ver]
            )
          ).rows[0];

          if (!eligibleMember) {
            throw new WorkflowError(409, 'Cannot activate policy: at least one active member grant is required.');
          }

          const existing = (
            await client.query<{ status: string; revision: number; activated_by: string; activated_at: Date }>(
              'SELECT status, revision, activated_by, activated_at FROM studio_system_policies WHERE organization_id = $1 AND system_id = $2 AND system_version = $3 FOR UPDATE',
              [actor.organizationId, id, ver]
            )
          ).rows[0];

          const currentRevision = existing ? existing.revision : 0;
          if (input.expectedRevision !== currentRevision) {
            throw new WorkflowError(409, 'Policy revision conflict; reload before activating.');
          }

          // Idempotent: avoid re-incrementing revision or duplicate audit row when policy is already enforced and unchanged
          if (existing && existing.status === 'enforced') {
            return {
              systemId: id,
              systemVersion: ver,
              status: 'enforced',
              revision: existing.revision,
              activatedBy: existing.activated_by,
              activatedAt: new Date(existing.activated_at).toISOString(),
            };
          }

          const revision = existing ? existing.revision + 1 : 1;
          if (existing) {
            await client.query(
              `UPDATE studio_system_policies SET status = 'enforced', revision = $1, activated_by = $2, activated_at = now()
               WHERE organization_id = $3 AND system_id = $4 AND system_version = $5`,
              [revision, actor.subject, actor.organizationId, id, ver]
            );
          } else {
            await client.query(
              `INSERT INTO studio_system_policies(organization_id, system_id, system_version, status, revision, activated_by)
               VALUES($1, $2, $3, 'enforced', 1, $4)`,
              [actor.organizationId, id, ver, actor.subject]
            );
          }

          const auditId = randomUUID();
          await client.query(
            `INSERT INTO studio_system_policy_audit(audit_id, organization_id, system_id, system_version, status, revision, actor_id)
             VALUES($1, $2, $3, $4, 'enforced', $5, $6)`,
            [auditId, actor.organizationId, id, ver, revision, actor.subject]
          );

          return {
            systemId: id,
            systemVersion: ver,
            status: 'enforced',
            revision,
            activatedBy: actor.subject,
            activatedAt: new Date().toISOString(),
          };
        }
      );
    },

    async getPolicy(systemId, version, actor) {
      const id = slug(systemId);
      const ver = semver(version);
      await validateModuleInstalled(pool, actor.organizationId, id, ver);

      const row = (
        await pool.query<{
          system_id: string;
          system_version: string;
          status: 'legacy' | 'enforced';
          revision: number;
          activated_by: string;
          activated_at: Date;
        }>(
          `SELECT system_id, system_version, status, revision, activated_by, activated_at
           FROM studio_system_policies
           WHERE organization_id = $1 AND system_id = $2 AND system_version = $3`,
          [actor.organizationId, id, ver]
        )
      ).rows[0];

      if (!row) {
        return {
          systemId: id,
          systemVersion: ver,
          status: 'legacy',
          revision: 0,
        };
      }

      return {
        systemId: row.system_id,
        systemVersion: row.system_version,
        status: row.status,
        revision: row.revision,
        activatedBy: row.activated_by,
        activatedAt: new Date(row.activated_at).toISOString(),
      };
    },
  };
}
