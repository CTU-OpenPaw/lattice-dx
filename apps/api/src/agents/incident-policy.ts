// SPDX-License-Identifier: Apache-2.0
import type {PoolClient} from 'pg';
import type {WorkflowActor,WorkflowRun,TransitionCommand} from '@dx/contracts';
import {assertHuman,assertAssetSchema,bad,parseProposal} from './policy.js';
import {lockContextEntity} from '../workflows/entity-context.js';
import {applyEntityUpdateWithClient,scopedEntity} from '../entities/client.js';
export async function assertIncidentActor(client:PoolClient,run:Pick<WorkflowRun,'definitionId'>,actor:WorkflowActor,requiredRole?:string|string[]){
  if(run.definitionId!=='incident-response')return;
  assertHuman(actor);
  const p=(await client.query('SELECT roles FROM directory_people WHERE organization_id=$1 AND subject=$2 AND enabled=true FOR SHARE',[actor.organizationId,actor.subject])).rows[0];
  if(!p)bad(403,'Active incident actor required.');
  assertHuman({
    ...actor,roles:p.roles
  });
  const required=typeof requiredRole==='string'?[requiredRole]:requiredRole??[];
  if(required.some(role=>!actor.roles.includes(role)||!p.roles.includes(role)))bad(403,'Current incident authority required.');
}
/** Called under the workflow run lock after transition/version validation, before any mutation. */
export async function assertIncidentTransition(client:PoolClient,run:WorkflowRun,actor:WorkflowActor,command:TransitionCommand){
  if(run.definitionId!=='incident-response')return;
  await assertIncidentActor(client,run,actor);
  const roles=(await client.query('SELECT roles FROM directory_people WHERE organization_id=$1 AND subject=$2 AND enabled=true FOR SHARE',[actor.organizationId,actor.subject])).rows[0]?.roles??[];
  if(!['approve','reject','close'].includes(command.action))return;
  if(!roles.includes('incident:manager'))bad(403,'Current incident manager authority required.');
  await client.query('SELECT id FROM workflow_waits WHERE id=$1 AND run_id=$2 FOR UPDATE',[run.data.agentJobId,run.id]);
  const job=(await client.query('SELECT * FROM agent_jobs WHERE id=$1 AND run_id=$2 AND organization_id=$3 FOR UPDATE',[run.data.agentJobId,run.id,actor.organizationId])).rows[0];
  if(!job||job.status!=='completed'||job.proposal_id!==run.data.proposalId||job.asset_id!==run.data.assetEntityId||job.notification_id!==run.data.notificationId)bad(409,'A current immutable incident proposal is required.');
  if(!actor.roles.includes('data:read')||!roles.includes('data:read'))bad(403,'Asset read authority required.');
  if(command.action==='close'){
    if(!actor.roles.includes('data:write')||!roles.includes('data:write'))bad(403,'Asset write authority required.');
    const approval=(await client.query("SELECT 1 FROM incident_agent_decisions WHERE run_id=$1 AND job_id=$2 AND proposal_id=$3 AND decision='approve'",[run.id,job.id,job.proposal_id])).rows[0];
    if(!approval)bad(409,'Approved proposal required.');
    const scope={
      actorId:actor.subject,organizationId:actor.organizationId
    };
    const asset=await scopedEntity(client,scope,job.asset_id,true,'edit');
    if(!asset)bad(404,'Asset unavailable.');
    assertAssetSchema(asset);
    const proposal=parseProposal(job.proposal);
    await applyEntityUpdateWithClient(client,scope,asset,{
      expectedVersion:job.asset_version,title:asset.title,attributes:{
        ...asset.attributes,status:proposal.suggestedStatus
      }
    });
  }
  else{
    const asset=await lockContextEntity(client,job.asset_id,actor,true);
    assertAssetSchema(asset);
    if(asset.version!==job.asset_version)bad(409,'Incident proposal Asset version is stale.');
    await client.query('INSERT INTO incident_agent_decisions(run_id,job_id,proposal_id,decision,actor_id,run_version,reason) VALUES($1,$2,$3,$4,$5,$6,$7)',[run.id,job.id,job.proposal_id,command.action,actor.subject,run.version,command.input.reviewNote??command.input.reason??'']);
  }
}
