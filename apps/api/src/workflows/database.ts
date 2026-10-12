// SPDX-License-Identifier: Apache-2.0
import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { isRecordId, type CreateWorkflow, type TransitionCommand, type WorkflowActor, type WorkflowDefinition, type WorkflowField, type WorkflowRun, type WorkflowEvent } from '@dx/contracts';
import { getDefinition, workflowDefinitions } from '../../../../solutions/workflows/definitions.js';
import { authorizeTransition, availableTransitions, canReadRun, canUseEvidence, planTransition, validateInput, WorkflowError } from './policy.js';
import { createWorkflowTables } from './schema.js';
import type { WorkflowRepository } from './types.js';

const runColumns='id,id AS "recordId",definition_id AS "definitionId",definition_version AS "definitionVersion",title,owner_id AS "ownerId",organization_id AS "organizationId",state,version,data,created_at AS "createdAt",updated_at AS "updatedAt"';
function serializeRun(row:WorkflowRun):WorkflowRun {
  return {...row,createdAt:new Date(row.createdAt).toISOString(),updatedAt:new Date(row.updatedAt).toISOString()};
}
function definition(run:WorkflowRun):WorkflowDefinition {
  const def=getDefinition(run.definitionId,run.definitionVersion);
  if(!def) throw new WorkflowError(503,'Phiên bản quy trình không khả dụng.');
  return def;
}
function fingerprint(value:CreateWorkflow|TransitionCommand):string {
  const sortedInput=Object.fromEntries(Object.entries(value.input).sort(([a],[b])=>a.localeCompare(b)));
  return createHash('sha256').update(JSON.stringify({...value,input:sortedInput})).digest('hex');
}
async function transaction<T>(pool:Pool,fn:(client:PoolClient)=>Promise<T>):Promise<T> {
  const client=await pool.connect();
  try {await client.query('BEGIN');const result=await fn(client);await client.query('COMMIT');return result;}
  catch(error){await client.query('ROLLBACK');throw error;}
  finally{client.release();}
}
async function validateReferences(client:PoolClient,fields:Record<string,WorkflowField>,input:Record<string,string>,actor:WorkflowActor) {
  for(const [name,kind] of Object.entries(fields)) {
    let found=true;
    if(kind==='subject') found=!!(await client.query('SELECT 1 FROM workflow_members WHERE organization_id=$1 AND subject=$2',[actor.organizationId,input[name]])).rowCount;
    if(kind==='department'||kind==='location') found=!!(await client.query('SELECT 1 FROM workflow_references WHERE organization_id=$1 AND kind=$2 AND id=$3',[actor.organizationId,kind,input[name]])).rowCount;
    if(kind==='file') {
      const file=(await client.query('SELECT owner_id AS "ownerId",organization_id AS "organizationId",scan_status AS "scanStatus" FROM foundation_files WHERE id=$1 AND organization_id=$2',[input[name],actor.organizationId])).rows[0];
      const linkedRuns=(await client.query(`SELECT ${runColumns.split(',').map(c=>'r.'+c).join(',')} FROM workflow_runs r JOIN workflow_files wf ON wf.run_id=r.id WHERE wf.file_id=$1 AND r.organization_id=$2`,[input[name],actor.organizationId])).rows;
      found=!!file&&canUseEvidence(file,actor,linkedRuns.map(run=>({definition:definition(run),run})));
    }
    if(!found) throw new WorkflowError(400,`Tham chiếu ${name} không khả dụng hoặc chưa được phép.`);
  }
}
async function attachFiles(client:PoolClient,runId:string,fields:Record<string,WorkflowField>,input:Record<string,string>) {
  for(const [name,kind] of Object.entries(fields)) {
    if(kind==='file') await client.query('INSERT INTO workflow_files(run_id,file_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[runId,input[name]]);
  }
}

export async function workflowDatabase(pool:Pool):Promise<WorkflowRepository> {
  await createWorkflowTables(pool);
  async function get(id:string,actor:WorkflowActor):Promise<WorkflowRun> {
    const result=await pool.query(`SELECT ${runColumns} FROM workflow_runs WHERE id=$1 AND organization_id=$2`,[id,actor.organizationId]);
    if(!result.rows[0]) throw new WorkflowError(404,'Không tìm thấy quy trình.');
    const run=serializeRun(result.rows[0]);
    if(!canReadRun(definition(run),run,actor)) throw new WorkflowError(404,'Không tìm thấy quy trình.');
    return run;
  }
  return {
    get,
    async create(value,actor,key) {
      const def=getDefinition(value.definitionId);
      if(!def) throw new WorkflowError(400,'Quy trình không tồn tại.');
      if(!actor.roles.includes('workflow:start')||!actor.roles.includes(def.startRole)) throw new WorkflowError(403,'Không có quyền tạo quy trình.');
      const input=validateInput(def.startFields,value.input),hash=fingerprint({...value,input});
      return transaction(pool,async client=>{
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify([actor.organizationId,actor.subject,key])]);
        const replay=(await client.query('SELECT fingerprint,result FROM workflow_starts WHERE organization_id=$1 AND actor_id=$2 AND key=$3',[actor.organizationId,actor.subject,key])).rows[0];
        if(replay){if(replay.fingerprint!==hash)throw new WorkflowError(409,'Idempotency-Key đã dùng với dữ liệu khác.');return replay.result;}
        await validateReferences(client,def.startFields,input,actor);
        const id=randomUUID();
        await client.query('INSERT INTO records(id,title,owner_id,organization_id) VALUES($1,$2,$3,$4)',[id,value.title,actor.subject,actor.organizationId]);
        const row=(await client.query(`INSERT INTO workflow_runs(id,definition_id,definition_version,title,owner_id,organization_id,state,data) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${runColumns}`,[id,def.id,def.version,value.title,actor.subject,actor.organizationId,def.initialState,JSON.stringify(input)])).rows[0];
        const run=serializeRun(row);
        await client.query('INSERT INTO workflow_audit(id,run_id,actor_id,action,to_state,version) VALUES($1,$2,$3,$4,$5,1)',[randomUUID(),id,actor.subject,'create',def.initialState]);
        await attachFiles(client,id,def.startFields,input);
        await client.query('INSERT INTO workflow_starts(organization_id,actor_id,key,fingerprint,run_id,result) VALUES($1,$2,$3,$4,$5,$6)',[actor.organizationId,actor.subject,key,hash,id,JSON.stringify(run)]);
        return run;
      });
    },
    async transition(id,value,actor,key) {
      return transaction(pool,async client=>{
        const row=(await client.query(`SELECT ${runColumns} FROM workflow_runs WHERE id=$1 AND organization_id=$2 FOR UPDATE`,[id,actor.organizationId])).rows[0];
        if(!row)throw new WorkflowError(404,'Không tìm thấy quy trình.');
        const run=serializeRun(row),def=definition(run);
        if(!canReadRun(def,run,actor))throw new WorkflowError(404,'Không tìm thấy quy trình.');
        const transition=def.transitions.find(t=>t.id===value.action);
        if(!transition)throw new WorkflowError(400,'Bước không tồn tại.');
        authorizeTransition(transition,run,actor);
        const input=validateInput(transition.fields,value.input),hash=fingerprint({...value,input});
        const replay=(await client.query('SELECT actor_id,fingerprint,result FROM workflow_commands WHERE run_id=$1 AND key=$2',[id,key])).rows[0];
        if(replay){if(replay.actor_id!==actor.subject||replay.fingerprint!==hash)throw new WorkflowError(409,'Idempotency-Key đã dùng với dữ liệu khác.');return replay.result;}
        planTransition(def,run,actor,{...value,input});
        await validateReferences(client,transition.fields,input,actor);
        const next=serializeRun((await client.query(`UPDATE workflow_runs SET state=$1,version=version+1,data=data||$2::jsonb,updated_at=now() WHERE id=$3 RETURNING ${runColumns}`,[transition.to,JSON.stringify(input),id])).rows[0]);
        const eventId=randomUUID();
        await client.query('INSERT INTO workflow_audit(id,run_id,actor_id,action,from_state,to_state,version) VALUES($1,$2,$3,$4,$5,$6,$7)',[eventId,id,actor.subject,transition.id,run.state,next.state,next.version]);
        await attachFiles(client,id,transition.fields,input);
        if(transition.eventType) {
          const event:WorkflowEvent={eventId,eventType:transition.eventType,organizationId:actor.organizationId,runId:id,recordId:id,definitionId:def.id,version:next.version,occurredAt:next.updatedAt,data:next.data};
          await client.query('INSERT INTO workflow_jobs(id,run_id,organization_id,payload) VALUES($1,$2,$3,$4)',[eventId,id,actor.organizationId,JSON.stringify(event)]);
        }
        await client.query('INSERT INTO workflow_commands(run_id,key,actor_id,fingerprint,result) VALUES($1,$2,$3,$4,$5)',[id,key,actor.subject,hash,JSON.stringify(next)]);
        return next;
      });
    },
    async list(actor,inbox) {
      const readable=workflowDefinitions.filter(d=>d.readerRoles.some(r=>actor.roles.includes(r))).map(d=>`${d.id}:${d.version}`);
      const anyStates:string[]=[],ownStates:string[]=[];
      for(const d of workflowDefinitions)for(const t of d.transitions)if(actor.roles.includes(t.role))(t.ownerOnly?ownStates:anyStates).push(`${d.id}:${d.version}:${t.from}`);
      const filter=inbox?" AND ((definition_id||':'||definition_version||':'||state)=ANY($4::text[]) OR (owner_id=$2 AND (definition_id||':'||definition_version||':'||state)=ANY($5::text[])))":'';
      const params:unknown[]=[actor.organizationId,actor.subject,readable];if(inbox)params.push(anyStates,ownStates);
      const rows=(await pool.query(`SELECT ${runColumns} FROM workflow_runs WHERE organization_id=$1 AND (owner_id=$2 OR (definition_id||':'||definition_version)=ANY($3::text[]))${filter} ORDER BY updated_at DESC LIMIT 100`,params)).rows;
      return rows.map(serializeRun).filter(r=>!inbox||availableTransitions(definition(r),r,actor).length>0);
    },
    async history(id,actor) {
      await get(id,actor);
      const rows=(await pool.query('SELECT id,actor_id AS "actorId",action,from_state AS "fromState",to_state AS "toState",version,occurred_at AS "occurredAt" FROM workflow_audit WHERE run_id=$1 ORDER BY version LIMIT 100',[id])).rows;
      return rows.map(row=>({...row,occurredAt:new Date(row.occurredAt).toISOString()}));
    },
    async jobs(id,actor) {await get(id,actor);return (await pool.query('SELECT id,status,attempts,last_error AS "lastError" FROM workflow_jobs WHERE run_id=$1 ORDER BY created_at LIMIT 100',[id])).rows;},
    async retryJobs(id,actor,key) {
      return transaction(pool,async client=>{
        const row=(await client.query(`SELECT ${runColumns} FROM workflow_runs WHERE id=$1 AND organization_id=$2 FOR UPDATE`,[id,actor.organizationId])).rows[0];
        if(!row||!canReadRun(definition(row),row,actor))throw new WorkflowError(404,'Không tìm thấy quy trình.');
        if(!actor.roles.includes('workflow:sync'))throw new WorkflowError(403,'Không có quyền chạy lại đồng bộ.');
        const hash=fingerprint({action:'sync.retry',expectedVersion:0,input:{}});
        const replay=(await client.query('SELECT actor_id,fingerprint,result FROM workflow_commands WHERE run_id=$1 AND key=$2',[id,key])).rows[0];
        if(replay){if(replay.actor_id!==actor.subject||replay.fingerprint!==hash)throw new WorkflowError(409,'Idempotency-Key đã dùng với dữ liệu khác.');return replay.result.retried;}
        const count=(await client.query("UPDATE workflow_jobs SET status='pending',attempts=0,available_at=now(),lease_until=NULL,lease_token=NULL,last_error=NULL WHERE run_id=$1 AND organization_id=$2 AND status='failed'",[id,actor.organizationId])).rowCount??0;
        await client.query('INSERT INTO workflow_commands(run_id,key,actor_id,fingerprint,result) VALUES($1,$2,$3,$4,$5)',[id,key,actor.subject,hash,JSON.stringify({retried:count})]);
        return count;
      });
    },
    async registerMember(actor) {await pool.query('INSERT INTO workflow_members(organization_id,subject) VALUES($1,$2) ON CONFLICT DO NOTHING',[actor.organizationId,actor.subject]);},
    async references(actor) {return (await pool.query('SELECT kind,id,name FROM workflow_references WHERE organization_id=$1 ORDER BY kind,id LIMIT 100',[actor.organizationId])).rows;},
    async readSharedFile(id,actor) {
      if(!isRecordId(id))return;
      const rows=(await pool.query(`SELECT ${runColumns.split(',').map(c=>'r.'+c).join(',')} FROM workflow_runs r JOIN workflow_files wf ON wf.run_id=r.id WHERE wf.file_id=$1 AND r.organization_id=$2`,[id,actor.organizationId])).rows;
      if(!rows.some(row=>canReadRun(definition(row),row,actor)))return;
      return (await pool.query('SELECT id,filename,owner_id AS "ownerId",organization_id AS "organizationId",record_id AS "recordId",size,scan_status AS "scanStatus",content FROM foundation_files WHERE id=$1 AND organization_id=$2',[id,actor.organizationId])).rows[0];
    },
  };
}
