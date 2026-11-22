/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import type { PoolClient } from 'pg';
import type { WorkflowActor, WorkflowDefinition, WorkflowRun } from '@dx/contracts';
import { canReadRun, WorkflowError } from './policy.js';

export type DbQueryable = {
  query: <R = any>(sql: string, values?: unknown[]) => Promise<{ rows: R[]; rowCount?: number }>;
};

export type RunAuthorityResult = {
  run: WorkflowRun;
  definition: WorkflowDefinition;
  isManaged: boolean;
  effectiveRoles: string[];
};

export async function resolveRunEffectiveRoles(
  db: DbQueryable,
  organizationId: string,
  actorSubject: string,
  run: { definitionId: string; binding?: { moduleId: string; moduleVersion: string } | null }
): Promise<{ isManaged: boolean; effectiveRoles: string[] | null }> {
  const runOwnership = run.binding?.moduleId
    ? { module_id: run.binding.moduleId, module_version: run.binding.moduleVersion }
    : (
        await db.query<{ module_id: string; module_version: string }>(
          'SELECT module_id, module_version FROM enterprise_module_workflows WHERE organization_id = $1 AND definition_id = $2',
          [organizationId, run.definitionId]
        )
      ).rows[0];

  if (!runOwnership) {
    return { isManaged: false, effectiveRoles: null };
  }

  const pol = (
    await db.query<{ status: string }>(
      'SELECT status FROM studio_system_policies WHERE organization_id = $1 AND system_id = $2 AND system_version = $3',
      [organizationId, runOwnership.module_id, runOwnership.module_version]
    )
  ).rows[0];

  if (!pol || pol.status !== 'enforced') {
    return { isManaged: false, effectiveRoles: null };
  }

  const grants = (
    await db.query<{ roles: string[] }>(
      `SELECT g.roles FROM studio_system_grants g
       JOIN directory_people p ON p.organization_id = g.organization_id AND p.subject = $1 AND p.enabled = true
       WHERE g.organization_id = $2 AND g.system_id = $3 AND g.system_version = $4 AND g.status = 'active'
       AND (
         (g.principal_type = 'person' AND g.principal_id = p.subject)
         OR (g.principal_type = 'department' AND p.department_id IS NOT NULL AND g.principal_id = p.department_id)
       )`,
      [actorSubject, organizationId, runOwnership.module_id, runOwnership.module_version]
    )
  ).rows;

  if (!grants.length) {
    return { isManaged: true, effectiveRoles: [] };
  }

  const rSet = new Set<string>();
  for (const gr of grants) {
    for (const r of (gr.roles ?? [])) rSet.add(r);
  }
  return { isManaged: true, effectiveRoles: Array.from(rSet) };
}

export async function authorizeRunAccess(
  db: DbQueryable,
  run: WorkflowRun,
  actor: WorkflowActor,
  resolveDef: (run: WorkflowRun, client?: PoolClient) => Promise<WorkflowDefinition>
): Promise<RunAuthorityResult> {
  const { isManaged, effectiveRoles } = await resolveRunEffectiveRoles(
    db,
    actor.organizationId,
    actor.subject,
    run
  );

  if (isManaged && (!effectiveRoles || effectiveRoles.length === 0)) {
    throw new WorkflowError(404, 'Không tìm thấy quy trình.');
  }

  const def = await resolveDef(run);
  const rolesForRead = isManaged ? effectiveRoles! : actor.roles;
  if (!canReadRun(def, run, actor, rolesForRead)) {
    throw new WorkflowError(404, 'Không tìm thấy quy trình.');
  }

  return {
    run,
    definition: def,
    isManaged,
    effectiveRoles: rolesForRead,
  };
}
