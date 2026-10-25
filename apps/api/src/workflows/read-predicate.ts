// SPDX-License-Identifier: Apache-2.0
import type { WorkflowActor, WorkflowDefinition } from '@dx/contracts';

export function workflowReadPredicate(
  definitions: WorkflowDefinition[],
  actor: WorkflowActor,
  bind: (value: unknown) => string,
  alias = '',
  subject = '$2',
  getEffectiveRoles?: (def: WorkflowDefinition) => string[] | null
) {
  const runAlias = alias || 'workflow_runs';
  const prefix = runAlias + '.';

  const ownerClause = `(${prefix}owner_id=${subject} AND (
    NOT EXISTS (
      SELECT 1 FROM studio_system_policies ssp
      WHERE ssp.organization_id = ${prefix}organization_id AND ssp.status = 'enforced'
      AND (
        (${prefix}binding IS NOT NULL AND ssp.system_id = ${prefix}binding->>'moduleId' AND ssp.system_version = ${prefix}binding->>'moduleVersion')
        OR (${prefix}binding IS NULL AND EXISTS (
          SELECT 1 FROM enterprise_module_workflows emw
          WHERE emw.organization_id = ${prefix}organization_id AND emw.definition_id = ${prefix}definition_id
            AND emw.module_id = ssp.system_id AND emw.module_version = ssp.system_version
        ))
      )
    )
    OR EXISTS (
      SELECT 1 FROM studio_system_policies ssp
      JOIN studio_system_grants ssg ON ssg.organization_id = ssp.organization_id AND ssg.system_id = ssp.system_id AND ssg.system_version = ssp.system_version
      JOIN directory_people dp ON dp.organization_id = ssp.organization_id AND dp.subject = ${subject} AND dp.enabled = true
      WHERE ssp.organization_id = ${prefix}organization_id AND ssp.status = 'enforced' AND ssg.status = 'active'
      AND (
        (${prefix}binding IS NOT NULL AND ssp.system_id = ${prefix}binding->>'moduleId' AND ssp.system_version = ${prefix}binding->>'moduleVersion')
        OR (${prefix}binding IS NULL AND EXISTS (
          SELECT 1 FROM enterprise_module_workflows emw
          WHERE emw.organization_id = ${prefix}organization_id AND emw.definition_id = ${prefix}definition_id
            AND emw.module_id = ssp.system_id AND emw.module_version = ssp.system_version
        ))
      )
      AND (
        (ssg.principal_type = 'person' AND ssg.principal_id = dp.subject)
        OR (ssg.principal_type = 'department' AND dp.department_id IS NOT NULL AND ssg.principal_id = dp.department_id)
      )
    )
  ))`;

  const readers: string[] = [ownerClause];

  const readableDefs: string[] = [];
  for (const d of definitions) {
    const roles = getEffectiveRoles ? getEffectiveRoles(d) : actor.roles;
    if (!roles) continue;

    if (d.readerRoles.some(r => roles.includes(r))) {
      readableDefs.push(`${d.id}:${d.version}`);
    }

    const a = d.assignedReader;
    if (a && roles.includes(a.role)) {
      readers.push(
        `(${prefix}definition_id=${bind(d.id)} AND ${prefix}definition_version=${bind(d.version)} AND ${prefix}state=ANY(${bind(a.states)}::text[]) AND ${prefix}data->>${bind(a.field)}=${subject})`
      );
    }
  }

  readers.push(`(${prefix}definition_id||':'||${prefix}definition_version)=ANY(${bind(readableDefs)}::text[])`);

  return `(${readers.join(' OR ')})`;
}
