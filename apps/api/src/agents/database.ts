/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import {createHash,randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {pageResult,parsePage,type PageQuery} from '../pagination.js';
import type {WorkflowActor,WorkflowRun} from '@dx/contracts';
import type {DefinitionRegistry} from '../workflows/registry.js';
import {canReadRun} from '../workflows/policy.js';
import {lockContextEntity} from '../workflows/entity-context.js';
import {loadFileContentWithClient,readFileMetadataWithClient} from '../files/content.js';
import type {ObjectStore} from '../files/object-store.js';
import {lockedWait,settle} from '../workflows/waits-database.js';
import {assertHuman,assertAssetSchema,bad,incidentContract,isWorker,parseProposal,worker,type Proposal} from './policy.js';
import {enqueueIncident} from './enqueue.js';
import type {StoredAgentJob,StoredIncidentRun} from './types.js';
import type {StoredWait} from '../workflows/waits-database.js';
export function publicJob(j:StoredAgentJob){
  return {
    id:j.id,runId:j.run_id,requesterId:j.requester_id,assetId:j.asset_id,notificationId:j.notification_id,status:j.status!=='completed'&&new Date(j.deadline).getTime()<=Date.now()?'timed_out':j.status==='running'&&new Date(j.lease_until??0).getTime()<=Date.now()?'failed':j.status,version:j.version,attempts:j.attempts,deadline:new Date(j.deadline).toISOString(),leaseUntil:j.lease_until?new Date(j.lease_until).toISOString():null,proposalId:j.proposal_id,proposal:j.proposal,errorCode:j.error_code
  };
}
export function agentDatabase(pool:Pool,registry:Pick<DefinitionRegistry,'get'>,store?:ObjectStore){
  async function tx<T>(fn:(c:PoolClient)=>Promise<T>){
    const c=await pool.connect();
    try{
      await c.query('BEGIN');
      const r=await fn(c);
      await c.query('COMMIT');
      return r;
    }
    catch(e){
      await c.query('ROLLBACK');
      throw e;
    }
    finally{
      c.release();
    }
  }
  async function current(c:PoolClient,a:WorkflowActor,kind:'human'|'worker'){
    const p=(await c.query('SELECT roles FROM directory_people WHERE organization_id=$1 AND subject=$2 AND enabled=true FOR SHARE',[a.organizationId,a.subject])).rows[0];
    if(!p)bad(403,'Active directory identity required.');
    const actor={
      ...a,roles:a.roles.filter(r=>p.roles.includes(r))
    };
    if(kind==='worker')worker(actor);
    else {
      assertHuman(a);
      if(p.roles.includes('connector:agent')||p.roles.includes('agent:worker'))bad(403,'Human authority required.');
    }
    return actor;
  }
  async function caseAccess(c:PoolClient,run:StoredIncidentRun,a:WorkflowActor){
    const def=await registry.get(a.organizationId,run.definition_id,run.definition_version,c);
    const shaped={
      ...run,recordId:run.id,createdAt:new Date(run.created_at).toISOString(),updatedAt:new Date(run.updated_at).toISOString(),definitionId:run.definition_id,definitionVersion:run.definition_version,organizationId:run.organization_id,ownerId:run.owner_id
    }as WorkflowRun;
    if(!def||!canReadRun(def,shaped,a))bad(404,'Incident not found.');
    return shaped;
  }
  async function bound(c:PoolClient,run:StoredIncidentRun,j:StoredAgentJob){
    const requester=await current(c,{
      subject:j.requester_id,organizationId:j.organization_id,roles:(await c.query('SELECT roles FROM directory_people WHERE organization_id=$1 AND subject=$2',[j.organization_id,j.requester_id])).rows[0]?.roles??[]
    },'human');
    if(!['workflow:integrate','data:read'].every(r=>requester.roles.includes(r)))bad(403,'Requester authority revoked.');
    await caseAccess(c,run,requester);
    if(run.data.assetEntityId!==j.asset_id||run.data.notificationId!==j.notification_id||(run.data.attachmentId??null)!==j.attachment_id)bad(409,'Incident binding changed.');
    const asset=await lockContextEntity(c,j.asset_id,requester,true);
    assertAssetSchema(asset);
    if(j.attachment_id){
      if(!requester.roles.includes('files:read')||!(await c.query('SELECT 1 FROM workflow_files WHERE run_id=$1 AND file_id=$2 FOR SHARE',[run.id,j.attachment_id])).rowCount)bad(403,'Requester attachment authority revoked.');
      const file=await readFileMetadataWithClient(c,requester,j.attachment_id,{
        kind:'foundation'
      },(client,r)=>registry.get(r.organizationId,r.definitionId,r.definitionVersion,client));
      if(!file||file.scanStatus!=='clean')bad(403,'Requester attachment unavailable.');
    }
    return {
      requester,asset
    };
  }
  async function locked(c:PoolClient,id:string,a:WorkflowActor){
    const {
      run:partial,wait
    }
    =await lockedWait(c,id,a.organizationId);
    const run=(await c.query<StoredIncidentRun>('SELECT * FROM workflow_runs WHERE id=$1',[partial.id])).rows[0];
    const j=(await c.query<StoredAgentJob>('SELECT *,lease_until>clock_timestamp() AS lease_live FROM agent_jobs WHERE id=$1 AND organization_id=$2 FOR UPDATE',[id,a.organizationId])).rows[0];
    if(!j)bad(404,'Agent job not found.');
    return {
      run,wait,j
    };
  }
  function active(run:StoredIncidentRun,w:StoredWait,j:StoredAgentJob){
    if(!incidentContract(run,w,{eventType:'connector.dispatch',connectorId:'agent',operation:'incident.analyze'})||run.status!=='active'||w.status!=='pending'||w.expired||run.version!==w.version||j.run_version!==run.version||run.state!=='analyzing')bad(409,'Incident wait is no longer active.');
  }
  function lease(j:StoredAgentJob,a:WorkflowActor,token:string){
    if(j.status!=='running'||j.worker_id!==a.subject||j.lease_token!==token||!j.lease_live)bad(409,'Stale agent lease.');
  }
  // Authority/resource locks and storage reads can outlive a sampled lease.
  // Re-read the clock only after those operations, while run/wait/job stay locked.
  async function fresh(c:PoolClient,run:StoredIncidentRun,wait:StoredWait,j:StoredAgentJob,a?:WorkflowActor,token?:string){
    const clock=(await c.query('SELECT w.deadline<=clock_timestamp() AS expired,j.lease_until>clock_timestamp() AS lease_live,j.deadline>clock_timestamp() AS job_live FROM workflow_waits w JOIN agent_jobs j ON j.id=w.id WHERE w.id=$1',[j.id])).rows[0];
    wait.expired=clock.expired;
    j.lease_live=clock.lease_live;
    active(run,wait,j);
    if(!clock.job_live)bad(409,'Agent deadline elapsed.');
    if(a&&token)lease(j,a,token);
  }
  async function read(c:PoolClient,id:string,a:WorkflowActor){
    const state=await locked(c,id,a);
    const actor=await current(c,a,isWorker(a)?'worker':'human');
    if(isWorker(a)){
      if(state.j.worker_id!==a.subject)bad(403,'Worker job mismatch.');
      await bound(c,state.run,state.j);
    }
    else await caseAccess(c,state.run,actor);
    return state;
  }
  return {
    async create(runId:string,id:string,a:WorkflowActor,key:string){
      return tx(async c=>{
        const {
          run,wait
        }
        =await lockedWait(c,id,a.organizationId);
        if(run.id!==runId)bad(404,'Incident wait not found.');
        const row=(await c.query('SELECT * FROM workflow_runs WHERE id=$1',[run.id])).rows[0];
        const actor=await current(c,a,'human');
        if(!['workflow:integrate','data:read'].every(r=>actor.roles.includes(r)))bad(403,'Integration authority required.');
        const shaped=await caseAccess(c,row,actor);
        const audit=(await c.query("SELECT actor_id FROM workflow_audit WHERE run_id=$1 AND version=$2 AND action IN ('request_analysis','retry_analysis')",[run.id,wait.version])).rows[0];
        if(!audit||audit.actor_id!==actor.subject)bad(403,'Only the analysis requester can enqueue.');
        const event=(await c.query('SELECT payload FROM workflow_jobs WHERE id=$1',[id])).rows[0]?.payload;
        if(!incidentContract(row,wait,event)||wait.status!=='pending'||wait.expired||row.version!==wait.version||row.status!=='active')bad(409,'Invalid incident wait.');
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify([a.organizationId,a.subject,key])]);
        const previous=(await c.query('SELECT input FROM agent_commands WHERE organization_id=$1 AND actor_id=$2 AND key=$3',[a.organizationId,a.subject,key])).rows[0];
        if(previous&&(previous.input.operation!=='create'||previous.input.id!==id||previous.input.runId!==runId))bad(409,'Agent key conflict.');
        await enqueueIncident(c,shaped,actor,id,wait.config,event);
        const result=publicJob((await c.query('SELECT * FROM agent_jobs WHERE id=$1',[id])).rows[0]);
        if(!previous)await c.query('INSERT INTO agent_commands(organization_id,actor_id,key,input,result) VALUES($1,$2,$3,$4,$5)',[a.organizationId,a.subject,key,JSON.stringify({
          operation:'create',id,runId
        }),JSON.stringify(result)]);
        return result;
      });
    },
    async get(id:string,a:WorkflowActor){
      return tx(async c=>publicJob((await read(c,id,a)).j));
    },
    async list(runId:string,a:WorkflowActor,page:PageQuery=parsePage({})){
      return tx(async c=>{
        const actor=await current(c,a,'human');
        const run=(await c.query('SELECT * FROM workflow_runs WHERE id=$1 AND organization_id=$2 FOR SHARE',[runId,a.organizationId])).rows[0];
        if(!run)bad(404,'Incident not found.');
        await caseAccess(c,run,actor);
        return pageResult((await c.query('SELECT * FROM agent_jobs WHERE run_id=$1 AND organization_id=$2 ORDER BY created_at DESC,id DESC LIMIT $3 OFFSET $4',[runId,a.organizationId,page.limit+1,page.offset])).rows.map(publicJob),page);
      });
    },
    async claim(id:string,a:WorkflowActor){
      return tx(async c=>{
        const {
          run,wait,j
        }
        =await locked(c,id,a);
        await current(c,a,'worker');
        active(run,wait,j);
        await bound(c,run,j);
        await fresh(c,run,wait,j);
        if(j.attempts>=3||!(j.status==='queued'||j.status==='running'&&!j.lease_live))bad(409,'Agent job cannot be claimed.');
        if(j.status==='running')await c.query("UPDATE agent_attempts SET finished_at=now(),outcome='lease_expired' WHERE job_id=$1 AND attempt=$2",[id,j.attempts]);
        const token=randomUUID();
        const next=(await c.query("UPDATE agent_jobs SET status='running',version=version+1,attempts=attempts+1,worker_id=$2,lease_token=$3,lease_until=LEAST(deadline,clock_timestamp()+interval '60 seconds'),updated_at=now(),error_code=NULL WHERE id=$1 AND deadline>clock_timestamp() AND EXISTS(SELECT 1 FROM workflow_waits w WHERE w.id=$1 AND w.status='pending' AND w.deadline>clock_timestamp()) RETURNING *",[id,a.subject,token])).rows[0];
        if(!next)bad(409,'Agent claim deadline elapsed.');
        await c.query('INSERT INTO agent_attempts(job_id,attempt,worker_id,lease_token) VALUES($1,$2,$3,$4)',[id,next.attempts,a.subject,token]);
        await fresh(c,run,wait,next,a,token);
        return {
          ...publicJob(next),leaseToken:token
        };
      });
    },
    async context(id:string,a:WorkflowActor,token:string){
      return tx(async c=>{
        const {
          run,wait,j
        }
        =await locked(c,id,a);
        await current(c,a,'worker');
        active(run,wait,j);
        lease(j,a,token);
        const {
          requester
        }
        =await bound(c,run,j);
        const asset=(await c.query('SELECT id,title,attributes,version FROM enterprise_entities WHERE id=$1',[j.asset_id])).rows[0];
        let attachment;
        if(j.attachment_id){
          if(!requester.roles.includes('files:read'))bad(403,'Requester file authority revoked.');
          if(!(await c.query('SELECT 1 FROM workflow_files WHERE run_id=$1 AND file_id=$2 FOR SHARE',[run.id,j.attachment_id])).rowCount)bad(403,'Attachment no longer bound.');
          const file=await loadFileContentWithClient(c,requester,j.attachment_id,{
            kind:'foundation'
          },store,(client,r)=>registry.get(r.organizationId,r.definitionId,r.definitionVersion,client));
          if(!file)bad(403,'Attachment unavailable.');
          attachment={
            id:j.attachment_id,filename:file.filename,contentBase64:file.content.toString('base64')
          };
        }
        await fresh(c,run,wait,j,a,token);
        return {
          case:{
            id:run.id,title:run.title,state:run.state,notificationId:j.notification_id
          },asset,...(attachment?{
            attachment
          }
          :{
          })
        };
      });
    },
    async result(id:string,a:WorkflowActor,token:string,input:Proposal){
      const proposal=parseProposal(input),hash=createHash('sha256').update(JSON.stringify(proposal)).digest('hex');
      return tx(async c=>{
        const {
          run,wait,j
        }
        =await locked(c,id,a);
        await current(c,a,'worker');
        await bound(c,run,j);
        if(j.status==='completed'){
          if(j.worker_id!==a.subject||j.lease_token!==token||j.result_hash!==hash)bad(409,'Conflicting agent result.');
          return publicJob(j);
        }
        await fresh(c,run,wait,j,a,token);
        const proposalId=randomUUID();
        const completed=await c.query("UPDATE agent_jobs SET status='completed',version=version+1,proposal_id=$2,proposal=$3,result_hash=$4,completed_at=now(),updated_at=now() WHERE id=$1 AND status='running' AND worker_id=$5 AND lease_token=$6 AND lease_until>clock_timestamp() AND deadline>clock_timestamp() AND EXISTS(SELECT 1 FROM workflow_waits w WHERE w.id=$1 AND w.status='pending' AND w.deadline>clock_timestamp())",[id,proposalId,JSON.stringify(proposal),hash,a.subject,token]);
        if(!completed.rowCount)bad(409,'Agent result lease or deadline elapsed.');
        await c.query("UPDATE agent_attempts SET outcome='completed',finished_at=now() WHERE job_id=$1 AND attempt=$2",[id,j.attempts]);
        await fresh(c,run,wait,j,a,token);
        await settle(c,run,wait,'succeeded',{
          proposalId,agentJobId:id
        },a.subject,`agent:${id}`,hash);
        return publicJob((await c.query('SELECT * FROM agent_jobs WHERE id=$1',[id])).rows[0]);
      });
    },
    async fail(id:string,a:WorkflowActor,token:string,code:string){
      return tx(async c=>{
        const {
          run,wait,j
        }
        =await locked(c,id,a);
        await current(c,a,'worker');
        await fresh(c,run,wait,j,a,token);
        await c.query("UPDATE agent_attempts SET outcome=$3,finished_at=now() WHERE job_id=$1 AND attempt=$2",[id,j.attempts,code]);
        const next=(await c.query("UPDATE agent_jobs SET status='failed',version=version+1,error_code=$2,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND lease_until>clock_timestamp() AND deadline>clock_timestamp() AND EXISTS(SELECT 1 FROM workflow_waits w WHERE w.id=$1 AND w.status='pending' AND w.deadline>clock_timestamp()) RETURNING *",[id,code])).rows[0];
        if(!next)bad(409,'Agent failure lease or deadline elapsed.');
        return publicJob(next);
      });
    },
    async retry(id:string,a:WorkflowActor,expectedVersion:number,key:string){
      return tx(async c=>{
        const {
          run,wait,j
        }
        =await locked(c,id,a);
        const actor=await current(c,a,'human');
        if(!actor.roles.includes('workflow:integrate'))bad(403,'Integration authority required.');
        await caseAccess(c,run,actor);
        await bound(c,run,j);
        const command={
          operation:'retry',id,expectedVersion
        };
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify([a.organizationId,a.subject,key])]);
        const previous=(await c.query('SELECT input,result FROM agent_commands WHERE organization_id=$1 AND actor_id=$2 AND key=$3',[a.organizationId,a.subject,key])).rows[0];
        if(previous){
          if(previous.input.operation!=='retry'||previous.input.id!==id||previous.input.expectedVersion!==expectedVersion)bad(409,'Agent key conflict.');
          return previous.result;
        }
        await fresh(c,run,wait,j);
        if(j.version!==expectedVersion||j.attempts>=3||!(j.status==='failed'||j.status==='running'&&!j.lease_live))bad(409,'Agent retry unavailable.');
        await c.query("UPDATE agent_attempts SET outcome=coalesce(outcome,'lease_expired'),finished_at=coalesce(finished_at,now()) WHERE job_id=$1 AND attempt=$2",[id,j.attempts]);
        const retried=(await c.query("UPDATE agent_jobs SET status='queued',version=version+1,lease_token=NULL,lease_until=NULL,worker_id=NULL,updated_at=now() WHERE id=$1 AND deadline>clock_timestamp() AND EXISTS(SELECT 1 FROM workflow_waits w WHERE w.id=$1 AND w.status='pending' AND w.deadline>clock_timestamp()) RETURNING *",[id])).rows[0];
        if(!retried)bad(409,'Agent retry deadline elapsed.');
        const result=publicJob(retried);
        await c.query('INSERT INTO agent_commands(organization_id,actor_id,key,input,result) VALUES($1,$2,$3,$4,$5)',[a.organizationId,a.subject,key,JSON.stringify(command),JSON.stringify(result)]);
        return result;
      });
    },
  };
}
export type AgentRepository=ReturnType<typeof agentDatabase>;
