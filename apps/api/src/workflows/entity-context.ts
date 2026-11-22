/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import type {PoolClient} from 'pg';
import type {WorkflowActor,EntityWorkflowContext} from '@dx/contracts';
import {checkAccess} from '../entities/access.js';
import {EntityError} from '../entities/policy.js';
import {WorkflowError} from './policy.js';
export const contextColumns='entity_id AS "entityId",schema_id AS "schemaId",schema_version AS "schemaVersion",entity_version AS "entityVersion"';
export function requireEntityRead(actor:WorkflowActor){if(!actor.roles.includes('data:read'))throw new WorkflowError(403,'Entity read permission required.');}
export async function readContext(client:PoolClient,runId:string,organizationId:string):Promise<EntityWorkflowContext|undefined>{return (await client.query(`SELECT ${contextColumns} FROM workflow_entity_contexts WHERE run_id=$1 AND organization_id=$2`,[runId,organizationId])).rows[0];}
export async function lockContextEntity(client:PoolClient,id:string,actor:WorkflowActor,start=false){
 requireEntityRead(actor);
 const row=(await client.query('SELECT id,schema_id AS "schemaId",schema_version AS "schemaVersion",version,archived_at AS "archivedAt",owner_id AS "ownerId",organization_id AS "organizationId" FROM enterprise_entities WHERE id=$1 AND organization_id=$2 FOR SHARE',[id,actor.organizationId])).rows[0];
 if(!row)throw new WorkflowError(404,'Entity or schema not found.');
 try{await checkAccess(client,{actorId:actor.subject,organizationId:actor.organizationId},row,'read');}catch(error){if(error instanceof EntityError)throw new WorkflowError(error.statusCode as 404,error.message);throw error;}
 if(row.archivedAt){if(row.ownerId!==actor.subject)throw new WorkflowError(404,'Entity or schema not found.');if(start)throw new WorkflowError(409,'Archived source entity cannot start workflow.');}
 return {id:row.id,schemaId:row.schemaId,schemaVersion:row.schemaVersion,version:row.version,archivedAt:row.archivedAt?new Date(row.archivedAt).toISOString():null};
}
