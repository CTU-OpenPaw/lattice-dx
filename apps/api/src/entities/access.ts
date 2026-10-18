// SPDX-License-Identifier: Apache-2.0
import type { Scope } from './types.js';
import type { PoolClient } from 'pg';
import { EntityError } from './policy.js';
export type AccessMode='read'|'edit'|'owner';
function grantMatch(mode:AccessMode):string {
 return `(g.kind='person' AND g.principal_id=p.subject OR g.kind='department' AND p.department_id=g.principal_id)${mode==='edit'?" AND g.permission='edit'":''}`;
}
export function accessPredicate(alias:string,actor:string,org:string,mode:AccessMode):string {
 return `${alias}.organization_id=${org} AND (${alias}.owner_id=${actor}${mode==='owner'?'':` OR EXISTS (SELECT 1 FROM enterprise_entity_shares g JOIN directory_people p ON p.organization_id=g.organization_id WHERE g.entity_id=${alias}.id AND g.organization_id=${org} AND p.subject=${actor} AND p.enabled=true AND ${grantMatch(mode)})`})`;
}
export async function checkAccess(db:Pick<PoolClient,'query'>,scope:Scope,row:{id?:string;ownerId:string;organizationId:string},mode:AccessMode):Promise<void>{
 if(row.organizationId!==scope.organizationId) throw new EntityError(404,'Entity or schema not found.');
 if(row.ownerId===scope.actorId) return;
 if(mode==='owner') throw new EntityError(404,'Entity or schema not found.');
 const result=await db.query(`SELECT p.subject FROM directory_people p WHERE p.organization_id=$1 AND p.subject=$2 AND p.enabled=true AND EXISTS (SELECT 1 FROM enterprise_entity_shares g WHERE g.entity_id=$3 AND g.organization_id=$1 AND ${grantMatch(mode)}) FOR SHARE OF p`,[scope.organizationId,scope.actorId,row.id]);
 if(!result.rows.length) throw new EntityError(404,'Entity or schema not found.');
}
