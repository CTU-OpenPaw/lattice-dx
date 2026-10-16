import {isRecordId} from '@dx/contracts';
// SPDX-License-Identifier: Apache-2.0
import type {PoolClient} from 'pg';
import type {WorkflowActor,WorkflowRun,WorkflowWaitConfig} from '@dx/contracts';
import {assertHuman,bad,incidentContract} from './policy.js';
import {lockContextEntity} from '../workflows/entity-context.js';
export async function enqueueIncident(client:PoolClient,run:WorkflowRun,actor:WorkflowActor,id:string,config:WorkflowWaitConfig,event:unknown){
  if(run.definitionId!=='incident-response')return;
  if(!incidentContract({
    definition_id:run.definitionId,definition_version:run.definitionVersion,state:run.state
  },{
    kind:'connector',connector_id:'agent',config
  },event))bad(409,'Incident agent contract mismatch.');
  assertHuman(actor);
  const current=(await client.query('SELECT roles FROM directory_people WHERE organization_id=$1 AND subject=$2 AND enabled=true FOR SHARE',[actor.organizationId,actor.subject])).rows[0];
  if(!current||!['workflow:integrate','data:read'].every(r=>actor.roles.includes(r)&&current.roles.includes(r)))bad(403,'Current human integration authority required.');
  if(current.roles.includes('connector:agent')||current.roles.includes('agent:worker'))bad(403,'Human requester required.');
  if(!isRecordId(run.data.assetEntityId))bad(400,'Incident Asset ID must be UUID.');
  const asset=await lockContextEntity(client,run.data.assetEntityId,actor,true);
  await client.query(`INSERT INTO agent_jobs(id,organization_id,run_id,requester_id,asset_id,asset_version,notification_id,attachment_id,run_version,deadline)
 SELECT id,organization_id,run_id,$2,$3,$4,$5,$6,version,deadline FROM workflow_waits WHERE id=$1 ON CONFLICT(id) DO NOTHING`,[id,actor.subject,asset.id,asset.version,run.data.notificationId,run.data.attachmentId??null]);
  // Existing outbox delivers the event ID to the connector. Execution requires a fenced claim.
}
