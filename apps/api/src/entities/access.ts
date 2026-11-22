/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Scope } from './types.js';
import type { PoolClient } from 'pg';
import { EntityError } from './policy.js';
export type AccessMode='read'|'edit'|'owner';
function grantMatch(mode:AccessMode):string {
 return `(g.kind='person' AND g.principal_id=p.subject OR g.kind='department' AND p.department_id=g.principal_id)${mode==='edit'?" AND g.permission='edit'":''}`;
}
export function accessPredicate(alias:string,actor:string,org:string,mode:AccessMode):string {
  return `${alias}.organization_id=${org} AND (
    (${alias}.owner_id=${actor}${mode==='owner'?'':` OR EXISTS (SELECT 1 FROM enterprise_entity_shares g JOIN directory_people p ON p.organization_id=g.organization_id WHERE g.entity_id=${alias}.id AND g.organization_id=${org} AND p.subject=${actor} AND p.enabled=true AND ${grantMatch(mode)})`})
    AND (
      NOT EXISTS (
        SELECT 1 FROM enterprise_module_versions emv1
        JOIN enterprise_module_versions emv2
          ON emv2.organization_id = emv1.organization_id
          AND emv2.id <> emv1.id
        JOIN studio_system_policies ssp1
          ON ssp1.organization_id = emv1.organization_id AND ssp1.system_id = emv1.id AND ssp1.system_version = emv1.version
        WHERE emv1.organization_id = ${org}
          AND ssp1.status = 'enforced'
          AND EXISTS (SELECT 1 FROM jsonb_array_elements(emv1.manifest->'schemas') ms1 WHERE ms1->>'id' = ${alias}.schema_id)
          AND EXISTS (SELECT 1 FROM jsonb_array_elements(emv2.manifest->'schemas') ms2 WHERE ms2->>'id' = ${alias}.schema_id)
      )
    )
    AND (
      NOT EXISTS (
        SELECT 1 FROM enterprise_module_versions emv
        JOIN studio_system_policies ssp ON ssp.organization_id = emv.organization_id AND ssp.system_id = emv.id AND ssp.system_version = emv.version
        WHERE emv.organization_id = ${org} AND ssp.status = 'enforced'
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(emv.manifest->'schemas') ms WHERE ms->>'id' = ${alias}.schema_id)
      )
      OR EXISTS (
        SELECT 1 FROM enterprise_module_versions emv
        JOIN studio_system_policies ssp ON ssp.organization_id = emv.organization_id AND ssp.system_id = emv.id AND ssp.system_version = emv.version
        JOIN studio_system_grants ssg ON ssg.organization_id = emv.organization_id AND ssg.system_id = emv.id AND ssg.system_version = emv.version
        JOIN directory_people dp ON dp.organization_id = emv.organization_id AND dp.subject = ${actor} AND dp.enabled = true
        WHERE emv.organization_id = ${org} AND ssp.status = 'enforced' AND ssg.status = 'active'
        AND (
          (ssg.principal_type = 'person' AND ssg.principal_id = dp.subject)
          OR (ssg.principal_type = 'department' AND dp.department_id IS NOT NULL AND ssg.principal_id = dp.department_id)
        )
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(emv.manifest->'schemas') ms WHERE ms->>'id' = ${alias}.schema_id)
      )
    )
  )`;
}
export async function checkAccess(db:Pick<PoolClient,'query'>,scope:Scope,row:{id?:string;ownerId:string;organizationId:string;schemaId?:string},mode:AccessMode):Promise<void>{
  if(row.organizationId!==scope.organizationId) throw new EntityError(404,'Entity or schema not found.');

  if(row.schemaId) {
    const policyResult = await db.query(
      `SELECT emv.id AS "systemId", emv.version AS "systemVersion"
       FROM enterprise_module_versions emv
       JOIN studio_system_policies ssp ON ssp.organization_id = emv.organization_id AND ssp.system_id = emv.id AND ssp.system_version = emv.version
       WHERE emv.organization_id = $1 AND ssp.status = 'enforced'
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(emv.manifest->'schemas') ms WHERE ms->>'id' = $2)`,
      [scope.organizationId, row.schemaId]
    );

    const activePolicies = (policyResult?.rows ?? []).filter(r => r && r.systemId);
    if (activePolicies.length > 0) {
      const distinctSystemIds = new Set(activePolicies.map(p => p.systemId));
      if (distinctSystemIds.size > 1) {
        throw new EntityError(404, 'Entity or schema not found.');
      }

      const activeVersions = new Set(activePolicies.map(p => p.systemVersion));
      const grantResult = await db.query(
        `SELECT DISTINCT g.system_version FROM directory_people p
         JOIN studio_system_grants g ON g.organization_id = p.organization_id
         WHERE p.organization_id = $1 AND p.subject = $2 AND p.enabled = true
         AND g.system_id = $3 AND g.status = 'active'
         AND (
           (g.principal_type = 'person' AND g.principal_id = p.subject)
           OR (g.principal_type = 'department' AND p.department_id IS NOT NULL AND g.principal_id = p.department_id)
         )`,
        [scope.organizationId, scope.actorId, activePolicies[0].systemId]
      );

      const grantedVersions = new Set((grantResult?.rows ?? []).map(r => r.system_version));
      let hasIntersection = false;
      for (const v of activeVersions) {
        if (grantedVersions.has(v)) { hasIntersection = true; break; }
      }
      if (!hasIntersection) {
        throw new EntityError(404, 'Entity or schema not found.');
      }
    }
  }

  if(row.ownerId===scope.actorId) return;
  if(mode==='owner') throw new EntityError(404,'Entity or schema not found.');
  const result=await db.query(`SELECT p.subject FROM directory_people p WHERE p.organization_id=$1 AND p.subject=$2 AND p.enabled=true AND EXISTS (SELECT 1 FROM enterprise_entity_shares g WHERE g.entity_id=$3 AND g.organization_id=$1 AND ${grantMatch(mode)}) FOR SHARE OF p`,[scope.organizationId,scope.actorId,row.id]);
  if(!result.rows.length) throw new EntityError(404,'Entity or schema not found.');
}
