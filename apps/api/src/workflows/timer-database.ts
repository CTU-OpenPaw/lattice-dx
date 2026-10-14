// SPDX-License-Identifier: Apache-2.0
import {createHash,randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import type {WorkflowActor,WorkflowRun,WorkflowDefinition,WorkflowStep,WorkflowTimer,TransitionCommand} from '@dx/contracts';
import {canReadRun,authorizeTransition,validateInput,WorkflowError} from './policy.js';
import {TimerError,classifyTimerError} from './timer-policy.js';
import {pageResult,type PageQuery} from '../pagination.js';

const timerColumns=`id,run_id AS "runId",definition_id AS "definitionId",definition_version AS "definitionVersion",run_version AS "runVersion",step_id AS "stepId",service_id AS "serviceId",transition_id AS "transitionId",status,attempts,last_error_code AS "lastErrorCode",due_at AS "dueAt",available_at AS "availableAt",created_at AS "createdAt",completed_at AS "completedAt",receipt`;
function serialize(row:WorkflowTimer):WorkflowTimer {
  return {...row,dueAt:new Date(row.dueAt).toISOString(),availableAt:new Date(row.availableAt).toISOString(),createdAt:new Date(row.createdAt).toISOString(),completedAt:row.completedAt?new Date(row.completedAt).toISOString():null};
}
/** Directory and deployment mapping are read on the caller's transaction connection. */
export async function resolveServiceActor(client:PoolClient,organizationId:string,serviceId:string):Promise<WorkflowActor> {
  const profile=(await client.query('SELECT subject FROM workflow_services WHERE organization_id=$1 AND id=$2 AND enabled=true FOR SHARE',[organizationId,serviceId])).rows[0];
  if(!profile)throw new TimerError('service_unavailable',403);
  const person=(await client.query('SELECT subject,roles FROM directory_people WHERE organization_id=$1 AND subject=$2 AND enabled=true FOR SHARE',[organizationId,profile.subject])).rows[0];
  if(!person)throw new TimerError('service_unavailable',403);
  if(!Array.isArray(person.roles)||person.roles.length>200||!person.roles.every((r:unknown)=>typeof r==='string'&&r.length<=100&&/^[a-zA-Z][a-zA-Z0-9_.:-]*$/.test(r))||!person.roles.includes('workflow:service'))throw new TimerError('authority_denied',403);
  return {subject:person.subject,organizationId,roles:person.roles};
}
export async function scheduleTimer(client:PoolClient,run:WorkflowRun,step:Extract<WorkflowStep,{action:'timers.schedule'}>,input:Record<string,string>,definition:WorkflowDefinition):Promise<{id:string}> {
  const target=definition.transitions.find(t=>t.id===step.input.transitionId);
  if(!target||target.execution!=='service'||target.from!==run.state||target.ownerOnly||target.assigneeField)throw new TimerError('validation_failed',400);
  input=validateInput(target.fields,input);
  const profile=await client.query('SELECT 1 FROM workflow_services WHERE organization_id=$1 AND id=$2 AND enabled=true FOR SHARE',[run.organizationId,step.input.serviceId]);
  if(!profile.rowCount)throw new TimerError('service_unavailable',400);
  const id=randomUUID();
  await client.query(`INSERT INTO workflow_timers(id,run_id,organization_id,definition_id,definition_version,run_version,step_id,service_id,transition_id,input,due_at,available_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now()+$11*interval '1 second',now()+$11*interval '1 second')`,[id,run.id,run.organizationId,run.definitionId,run.definitionVersion,run.version,step.id,step.input.serviceId,step.input.transitionId,JSON.stringify(input),step.input.afterSeconds]);
  return {id};
}
type Services={pool:Pool;transaction:<T>(fn:(client:PoolClient)=>Promise<T>)=>Promise<T>;get:(id:string,actor:WorkflowActor)=>Promise<WorkflowRun>;definition:(run:WorkflowRun,client:PoolClient)=>Promise<WorkflowDefinition>;columns:string;serialize:(run:WorkflowRun)=>WorkflowRun;transitionWithClient:(client:PoolClient,id:string,command:TransitionCommand,actor:WorkflowActor,key:string,internal?:{timerId:string})=>Promise<WorkflowRun>};
export function timerDatabase(s:Services) {
  async function lockedRun(client:PoolClient,id:string,actor:WorkflowActor) {
    const row=(await client.query(`SELECT ${s.columns} FROM workflow_runs WHERE id=$1 AND organization_id=$2 FOR UPDATE`,[id,actor.organizationId])).rows[0];
    if(!row||!canReadRun(await s.definition(row,client),row,actor))throw new WorkflowError(404,'Workflow not found.');
    return s.serialize(row);
  }
  async function tickOne():Promise<{timerId:string;status:WorkflowTimer['status']}|undefined> {
    // Candidate query releases its pool connection before acquiring an execution connection.
    const candidates=(await s.pool.query("SELECT id,run_id FROM workflow_timers WHERE status='pending' AND available_at<=clock_timestamp() ORDER BY available_at,id LIMIT 20")).rows;
    for(const candidate of candidates) {
      const result=await s.transaction(async client=>{
        await client.query("SET LOCAL statement_timeout='15s'");await client.query("SET LOCAL lock_timeout='2s'");
        const row=(await client.query(`SELECT ${s.columns} FROM workflow_runs WHERE id=$1 FOR UPDATE SKIP LOCKED`,[candidate.run_id])).rows[0];
        if(!row)return;
        const timer=(await client.query("SELECT *,due_at<=clock_timestamp() AND available_at<=clock_timestamp() AS due FROM workflow_timers WHERE id=$1 FOR UPDATE",[candidate.id])).rows[0];
        if(!timer||timer.status!=='pending'||!timer.due)return;
        await client.query('SAVEPOINT timer_attempt');
        let status:WorkflowTimer['status']='succeeded';
        try {
          if(row.status!=='active'||timer.organization_id!==row.organizationId||timer.definition_id!==row.definitionId||timer.definition_version!==row.definitionVersion||timer.run_version!==row.version)throw new TimerError('state_conflict');
          const run=s.serialize(row),def=await s.definition(run,client),transition=def.transitions.find(t=>t.id===timer.transition_id);
          if(!transition||transition.execution!=='service'||transition.ownerOnly||transition.assigneeField||transition.from!==run.state)throw new TimerError('state_conflict');
          const actor=await resolveServiceActor(client,run.organizationId,timer.service_id);
          if(!canReadRun(def,run,actor))throw new TimerError('authority_denied',403);
          authorizeTransition(transition,run,actor,true);
          const receipt=await s.transitionWithClient(client,run.id,{action:timer.transition_id,expectedVersion:timer.run_version,input:timer.input},actor,`timer:${timer.id}`,{timerId:timer.id});
          await client.query("UPDATE workflow_timers SET status='succeeded',attempts=attempts+1,last_error_code=NULL,completed_at=now(),receipt=$2 WHERE id=$1",[timer.id,JSON.stringify(receipt)]);
        }catch(error) {
          await client.query('ROLLBACK TO SAVEPOINT timer_attempt');
          const classified=classifyTimerError(error),attempts=timer.attempts+1;
          status=classified.transient&&attempts<3?'pending':'failed';
          await client.query("UPDATE workflow_timers SET status=$2,attempts=$3,last_error_code=$4,available_at=now()+$5*interval '1 second',completed_at=CASE WHEN $2='failed' THEN now() ELSE NULL END WHERE id=$1",[timer.id,status,attempts,classified.code,5*2**(attempts-1)]);
        }
        return {timerId:timer.id,status};
      });
      if(result)return result;
    }
  }
  return {
    tickOne,
    async listTimers(id:string,actor:WorkflowActor,page:PageQuery) {
      await s.get(id,actor);
      const rows=(await s.pool.query(`SELECT ${timerColumns} FROM workflow_timers WHERE run_id=$1 AND organization_id=$2 ORDER BY created_at,id LIMIT $3 OFFSET $4`,[id,actor.organizationId,page.limit+1,page.offset])).rows;
      return pageResult(rows.map(serialize),page);
    },
    async listServices(actor:WorkflowActor) {
      if(!actor.roles.includes('workflow:design'))throw new WorkflowError(403,'Workflow design authority required.');
      return (await s.pool.query('SELECT id,enabled FROM workflow_services WHERE organization_id=$1 ORDER BY id LIMIT 100',[actor.organizationId])).rows as {id:string;enabled:boolean}[];
    },
    async retryTimer(id:string,timerId:string,expectedVersion:number,actor:WorkflowActor,key:string):Promise<WorkflowTimer> {
      if(!actor.roles.includes('workflow:sync'))throw new WorkflowError(403,'Workflow sync authority required.');
      if(!Number.isSafeInteger(expectedVersion)||expectedVersion<1||!/^[A-Za-z0-9._:-]{1,128}$/.test(key))throw new WorkflowError(400,'Invalid timer retry.');
      return s.transaction(async client=>{
        const run=await lockedRun(client,id,actor);
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify([actor.organizationId,actor.subject,'timer.retry',key])]);
        const hash=createHash('sha256').update(JSON.stringify({id,timerId,expectedVersion})).digest('hex');
        const replay=(await client.query("SELECT fingerprint,result FROM workflow_timer_commands WHERE organization_id=$1 AND actor_id=$2 AND operation='retry' AND key=$3",[actor.organizationId,actor.subject,key])).rows[0];
        if(replay){if(replay.fingerprint!==hash)throw new WorkflowError(409,'Idempotency-Key conflict.');return replay.result;}
        const timer=(await client.query('SELECT * FROM workflow_timers WHERE id=$1 AND run_id=$2 AND organization_id=$3 FOR UPDATE',[timerId,id,actor.organizationId])).rows[0];
        if(!timer)throw new WorkflowError(404,'Timer not found.');
        const def=await s.definition(run,client),target=def.transitions.find(t=>t.id===timer.transition_id);
        if(timer.status!=='failed'||run.status!=='active'||expectedVersion!==run.version||timer.run_version!==run.version||timer.definition_id!==def.id||timer.definition_version!==def.version||target?.from!==run.state||target.execution!=='service')throw new WorkflowError(409,'Timer state or version conflict.');
        const service=await resolveServiceActor(client,run.organizationId,timer.service_id);
        if(!canReadRun(def,run,service))throw new TimerError('authority_denied',403);
        authorizeTransition(target,run,service,true);validateInput(target.fields,timer.input);
        if((await client.query("SELECT 1 FROM workflow_timers WHERE run_id=$1 AND status='pending' UNION ALL SELECT 1 FROM workflow_waits WHERE run_id=$1 AND status='pending'",[id])).rowCount)throw new WorkflowError(409,'Workflow is waiting.');
        const result=serialize((await client.query(`UPDATE workflow_timers SET status='pending',attempts=0,last_error_code=NULL,completed_at=NULL,available_at=now() WHERE id=$1 RETURNING ${timerColumns}`,[timerId])).rows[0]);
        await client.query("INSERT INTO workflow_timer_commands(organization_id,actor_id,operation,key,fingerprint,result) VALUES($1,$2,'retry',$3,$4,$5)",[actor.organizationId,actor.subject,key,hash,JSON.stringify(result)]);
        return result;
      });
    },
  };
}
