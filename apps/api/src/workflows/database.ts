// SPDX-License-Identifier: Apache-2.0
import {readFileMetadataWithClient} from '../files/content.js';
import type {ObjectStore} from '../files/object-store.js';
import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { isRecordId, type CreateWorkflow, type TransitionCommand, type WorkflowActor, type WorkflowDefinition, type WorkflowField, type WorkflowRun, type WorkflowEvent } from '@dx/contracts';
import { sourceRegistry,type DefinitionRegistry } from './registry.js';
import { authorizeTransition, parseEntityContext, canReadRun, canUseEvidence, planTransition, validateInput, WorkflowError } from './policy.js';
import { timerDatabase,resolveServiceActor } from './timer-database.js';
import { executeBlocks } from './block-database.js';
import { authorizeBlock } from './block-policy.js';
import { createWorkflowTables } from './schema.js';
import { waitDatabase } from './waits-database.js';
import { compileCondition } from './conditions.js';
import {lifecycleDatabase} from './lifecycle-database.js';
import type { WorkflowRepository } from './types.js';
import { pageResult, type PageQuery } from '../pagination.js';
import {workflowReadPredicate} from './read-predicate.js';
import {contextColumns,readContext,lockContextEntity,requireEntityRead} from './entity-context.js';
import {initializeModuleTables,assertModuleStartEligible} from '../modules/database.js';

const runColumns='id,id AS "recordId",definition_id AS "definitionId",definition_version AS "definitionVersion",title,owner_id AS "ownerId",organization_id AS "organizationId",state,version,data,status,cancellation,binding,created_at AS "createdAt",updated_at AS "updatedAt"';
function serializeRun(row:WorkflowRun):WorkflowRun {
  const {binding,...rest}=row;
  return {...rest,...(binding?{binding}:{}),createdAt:new Date(row.createdAt).toISOString(),updatedAt:new Date(row.updatedAt).toISOString()};
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
export async function validateReferences(client:PoolClient,fields:Record<string,WorkflowField>,input:Record<string,string>,actor:WorkflowActor,definition:(run:WorkflowRun)=>Promise<WorkflowDefinition>) {
  for(const [name,kind] of Object.entries(fields)) {
    if(input[name]===undefined)continue;
    let found=true;
    if(kind==='subject') found=!!(await client.query('SELECT 1 FROM workflow_members WHERE organization_id=$1 AND subject=$2',[actor.organizationId,input[name]])).rowCount;
    if(kind==='department'||kind==='location') found=!!(await client.query('SELECT 1 FROM workflow_references WHERE organization_id=$1 AND kind=$2 AND id=$3',[actor.organizationId,kind,input[name]])).rowCount;
    if(kind==='file') {
      const file=(await client.query('SELECT owner_id AS "ownerId",organization_id AS "organizationId",scan_status AS "scanStatus" FROM foundation_files WHERE id=$1 AND organization_id=$2',[input[name],actor.organizationId])).rows[0];
      const linkedRuns=(await client.query(`SELECT ${runColumns.split(',').map(c=>'r.'+c).join(',')} FROM workflow_runs r JOIN workflow_files wf ON wf.run_id=r.id WHERE wf.file_id=$1 AND r.organization_id=$2`,[input[name],actor.organizationId])).rows;
      found=!!file&&canUseEvidence(file,actor,await Promise.all(linkedRuns.map(async run=>({definition:await definition(run),run}))));
    }
    if(!found) throw new WorkflowError(400,`Tham chiếu ${name} không khả dụng hoặc chưa được phép.`);
  }
}
async function attachFiles(client:PoolClient,runId:string,fields:Record<string,WorkflowField>,input:Record<string,string>) {
  for(const [name,kind] of Object.entries(fields)) {
    if(kind==='file'&&input[name]!==undefined) await client.query('INSERT INTO workflow_files(run_id,file_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[runId,input[name]]);
  }
}

export async function workflowDatabase(pool:Pool,registry:Pick<DefinitionRegistry,'get'|'list'>=sourceRegistry,store?:ObjectStore):Promise<WorkflowRepository> {
  await createWorkflowTables(pool);
  await initializeModuleTables(pool);
  async function definition(run:WorkflowRun,client?:PoolClient):Promise<WorkflowDefinition>{const def=await registry.get(run.organizationId,run.definitionId,run.definitionVersion,client);if(!def)throw new WorkflowError(503,'Phiên bản quy trình không khả dụng.');return def;}
  async function taskIds(runs:WorkflowRun[],client:Pool|PoolClient=pool) {
    if(!runs.length)return runs;
    const links=(await client.query('SELECT run_id,task_id FROM workflow_task_links WHERE run_id=ANY($1::uuid[])',[runs.map(r=>r.id)])).rows;
    const waits=(await client.query("SELECT run_id FROM workflow_waits WHERE run_id=ANY($1::uuid[]) AND status='pending'",[runs.map(r=>r.id)])).rows;
    const timers=(await client.query("SELECT run_id FROM workflow_timers WHERE run_id=ANY($1::uuid[]) AND status='pending'",[runs.map(r=>r.id)])).rows;
    const contexts=(await client.query(`SELECT run_id,${contextColumns} FROM workflow_entity_contexts WHERE run_id=ANY($1::uuid[])`,[runs.map(r=>r.id)])).rows;
    const byRun=new Map(contexts.map(({run_id,...context})=>[run_id,context]));
    return runs.map(r=>({...r,...(byRun.has(r.id)?{entityContext:byRun.get(r.id)}:{}),waiting:waits.some(w=>w.run_id===r.id)||timers.some(t=>t.run_id===r.id),...(links.find(l=>l.run_id===r.id)?{taskId:links.find(l=>l.run_id===r.id).task_id}:{})}));
  }
  async function checkAssigned(client:PoolClient,def:WorkflowDefinition,data:Record<string,string>,actor:WorkflowActor) {
    if(!def.assignedReader)return;
    const {field,role}=def.assignedReader;
    const found=await client.query('SELECT 1 FROM directory_people WHERE subject=$1 AND organization_id=$2 AND enabled=true AND roles @> $3::jsonb FOR SHARE',[data[field],actor.organizationId,JSON.stringify([role])]);
    if(!found.rowCount)throw new WorkflowError(400,'Người được giao không tồn tại, đã tắt hoặc không có vai trò phù hợp trong đơn vị.');
  }
  async function listPage(actor:WorkflowActor,inbox:boolean,query:PageQuery&{state?:string;definitionId?:string}) {
    const workflowDefinitions=await registry.list(actor.organizationId);
    const values:unknown[]=[actor.organizationId,actor.subject];
    const bind=(value:unknown)=>{values.push(value);return '$'+values.length;};
    const where=['organization_id=$1',workflowReadPredicate(workflowDefinitions,actor,bind)];
    if(inbox){
      where.push("status='active'");
      const choices:string[]=[];
      for(const d of workflowDefinitions)for(const t of d.transitions)if(t.execution!=='service'&&actor.roles.includes(t.role)) {
        let guard='';
        if(t.condition) guard=` AND ${compileCondition(t.condition,bind)}`;
        choices.push(`((binding IS NULL OR binding->'allowedTransitions' ? ${bind(t.id)}) AND definition_id=${bind(d.id)} AND definition_version=${bind(d.version)} AND state=${bind(t.from)}${t.ownerOnly?' AND owner_id=$2':''}${t.assigneeField?` AND data->>${bind(t.assigneeField)}=$2`:''}${guard})`);
      }
      where.push("NOT EXISTS(SELECT 1 FROM workflow_waits w WHERE w.run_id=workflow_runs.id AND w.status='pending')");
      where.push("NOT EXISTS(SELECT 1 FROM workflow_timers t WHERE t.run_id=workflow_runs.id AND t.status='pending')");
      where.push(choices.length?`(${choices.join(' OR ')})`:'false');
    }
    if(query.definitionId)where.push(`definition_id=${bind(query.definitionId)}`);
    if(query.state)where.push(`state=${bind(query.state)}`);
    if(query.q)where.push(`strpos(lower(title),lower(${bind(query.q)}))>0`);
    const rows=(await pool.query(`SELECT ${runColumns} FROM workflow_runs WHERE ${where.join(' AND ')} ORDER BY updated_at DESC,id DESC LIMIT ${bind(query.limit+1)} OFFSET ${bind(query.offset)}`,values)).rows.map(serializeRun);
    return pageResult(await taskIds(rows),query);
  }
  async function get(id:string,actor:WorkflowActor):Promise<WorkflowRun> {
    const result=await pool.query(`SELECT ${runColumns} FROM workflow_runs WHERE id=$1 AND organization_id=$2`,[id,actor.organizationId]);
    if(!result.rows[0]) throw new WorkflowError(404,'Không tìm thấy quy trình.');
    const run=serializeRun(result.rows[0]);
    if(!canReadRun(await definition(run),run,actor)) throw new WorkflowError(404,'Không tìm thấy quy trình.');
    return (await taskIds([run]))[0];
  }
  async function createWithClient(client:PoolClient,value:CreateWorkflow & {definitionVersion?:number},actor:WorkflowActor,key:string):Promise<WorkflowRun> {
    const contextInput=parseEntityContext(value.entityContext);
    if(value.entityContext!==undefined&&!contextInput)throw new WorkflowError(400,'Invalid entity context.');
    if(contextInput){requireEntityRead(actor);value={...value,entityContext:contextInput};}
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify([actor.organizationId,actor.subject,key])]);
    const replay=(await client.query('SELECT fingerprint,result FROM workflow_starts WHERE organization_id=$1 AND actor_id=$2 AND key=$3',[actor.organizationId,actor.subject,key])).rows[0];
    const def=replay?await definition(replay.result,client):await registry.get(actor.organizationId,value.definitionId,value.definitionVersion,client);
    if(!def)throw new WorkflowError(400,'Phiên bản quy trình không khả dụng.');
    if(!actor.roles.includes('workflow:start')||!actor.roles.includes(def.startRole))throw new WorkflowError(403,'Không có quyền tạo quy trình.');
    if(replay){
      await client.query('SELECT id FROM workflow_runs WHERE id=$1 AND organization_id=$2 FOR SHARE',[replay.result.id,actor.organizationId]);
      const stored=await readContext(client,replay.result.id,actor.organizationId);
      if(stored)await lockContextEntity(client,stored.entityId,actor);
    }
    const input=validateInput(def.startFields,value.input,def.optionalStartFields),hash=fingerprint({...value,input});
    if(replay){if(replay.fingerprint!==hash)throw new WorkflowError(409,'Idempotency-Key đã dùng với dữ liệu khác.');return replay.result;}
    const bindingPlan=await assertModuleStartEligible(client,actor.organizationId,def.id,def.version);
    if(bindingPlan&&!contextInput)throw new WorkflowError(409,"Bound workflow requires entity context.");
    const referenceFields={...def.startFields,...def.optionalStartFields};
    if(def.assignedReader)delete referenceFields[def.assignedReader.field];
    await validateReferences(client,referenceFields,input,actor,run=>definition(run,client));
    await checkAssigned(client,def,input,actor);
    const source=contextInput?await lockContextEntity(client,contextInput.entityId,actor,true):undefined;
    if(bindingPlan&&(!source||source.schemaId!==bindingPlan.schemaId||source.schemaVersion!==bindingPlan.schemaVersion))throw new WorkflowError(409,"Entity schema does not match business binding.");
    const id=randomUUID();
    await client.query('INSERT INTO records(id,title,owner_id,organization_id) VALUES($1,$2,$3,$4)',[id,value.title,actor.subject,actor.organizationId]);
    const row=(await client.query(`INSERT INTO workflow_runs(id,definition_id,definition_version,title,owner_id,organization_id,state,data,binding) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${runColumns}`,[id,def.id,def.version,value.title,actor.subject,actor.organizationId,def.initialState,JSON.stringify(input),bindingPlan?JSON.stringify(bindingPlan.binding):null])).rows[0];
    const run=serializeRun(row);
    if(bindingPlan)run.binding=bindingPlan.binding;
    if(source){
      run.entityContext={entityId:source.id,schemaId:source.schemaId,schemaVersion:source.schemaVersion,entityVersion:source.version};
      await client.query('INSERT INTO workflow_entity_contexts(run_id,organization_id,entity_id,schema_id,schema_version,entity_version) VALUES($1,$2,$3,$4,$5,$6)',[id,actor.organizationId,source.id,source.schemaId,source.schemaVersion,source.version]);
    }
    await client.query('INSERT INTO workflow_audit(id,run_id,actor_id,action,to_state,version,metadata) VALUES($1,$2,$3,$4,$5,1,$6)',[randomUUID(),id,actor.subject,'create',def.initialState,run.entityContext?JSON.stringify({entityContext:run.entityContext,...(run.binding?{binding:run.binding}:{})}):null]);
    await attachFiles(client,id,{...def.startFields,...def.optionalStartFields},input);
    await client.query('INSERT INTO workflow_starts(organization_id,actor_id,key,fingerprint,run_id,result) VALUES($1,$2,$3,$4,$5,$6)',[actor.organizationId,actor.subject,key,hash,id,JSON.stringify(run)]);
    return run;
  }
  async function transitionWithClient(client:PoolClient,id:string,value:TransitionCommand,actor:WorkflowActor,key:string,internal?:{timerId:string}):Promise<WorkflowRun> {
        const row=(await client.query(`SELECT ${runColumns} FROM workflow_runs WHERE id=$1 AND organization_id=$2 FOR UPDATE`,[id,actor.organizationId])).rows[0];
        if(!row)throw new WorkflowError(404,'Không tìm thấy quy trình.');
        const run=serializeRun(row),def=await definition(run,client);
        if(!canReadRun(def,run,actor))throw new WorkflowError(404,'Không tìm thấy quy trình.');
        if(run.status==='cancelled')throw new WorkflowError(409,'Quy trình đã huỷ.');
        const transition=def.transitions.find(t=>t.id===value.action);
        if(!transition)throw new WorkflowError(400,'Bước không tồn tại.');
        authorizeTransition(transition,run,actor,!!internal);
        for(const step of transition.steps??[])authorizeBlock(step,actor);
        const input=validateInput(transition.fields,value.input),hash=fingerprint({...value,input});
        const replay=(await client.query('SELECT actor_id,fingerprint,result FROM workflow_commands WHERE run_id=$1 AND key=$2',[id,key])).rows[0];
        if(replay){if(replay.actor_id!==actor.subject||replay.fingerprint!==hash)throw new WorkflowError(409,'Idempotency-Key đã dùng với dữ liệu khác.');return replay.result;}
        if(internal) {
          const timer=(await client.query("SELECT *,due_at<=clock_timestamp() AND available_at<=clock_timestamp() AS due FROM workflow_timers WHERE id=$1 AND run_id=$2 AND status='pending' FOR UPDATE",[internal.timerId,id])).rows[0];
          if(!timer || !timer.due || timer.organization_id!==run.organizationId || timer.run_version!==run.version || timer.definition_id!==def.id || timer.definition_version!==def.version || timer.transition_id!==value.action || transition.execution!=='service' || key!==`timer:${timer.id}` || fingerprint({action:value.action,expectedVersion:run.version,input:timer.input})!==hash)throw new WorkflowError(403,'Invalid timer execution context.');
          const current=await resolveServiceActor(client,run.organizationId,timer.service_id);
          if(current.subject!==actor.subject || JSON.stringify(current.roles)!==JSON.stringify(actor.roles))throw new WorkflowError(403,'Timer authority changed.');
        }
        run.waiting=!!(await client.query("SELECT 1 FROM workflow_waits WHERE run_id=$1 AND status='pending'",[id])).rowCount;
        run.waiting=run.waiting || !!(await client.query("SELECT 1 FROM workflow_timers WHERE run_id=$1 AND status='pending' AND ($2::uuid IS NULL OR id<>$2)",[id,internal?.timerId??null])).rowCount;
        planTransition(def,run,actor,{...value,input},!!internal);
        await validateReferences(client,transition.fields,input,actor,run=>definition(run,client));
        for(const step of transition.steps??[])if(step.action==='timers.schedule') {
          const target=def.transitions.find(t=>t.id===step.input.transitionId);
          if(!target||target.execution!=='service'||target.from!==transition.to||target.ownerOnly||target.assigneeField||transition.wait||transition.task)throw new WorkflowError(400,'Invalid timer target.');
        }
        if(transition.task)await checkAssigned(client,def,run.data,actor);
        const next=serializeRun((await client.query(`UPDATE workflow_runs SET state=$1,version=version+1,data=data||$2::jsonb,updated_at=now() WHERE id=$3 RETURNING ${runColumns}`,[transition.to,JSON.stringify(input),id])).rows[0]);
        const eventId=randomUUID();
        await client.query('INSERT INTO workflow_audit(id,run_id,actor_id,action,from_state,to_state,version) VALUES($1,$2,$3,$4,$5,$6,$7)',[eventId,id,actor.subject,transition.id,run.state,next.state,next.version]);
        await attachFiles(client,id,transition.fields,input);
        if(transition.task==='assign') {
          const assigned=def.assignedReader!;
          const taskId=randomUUID();
          await client.query('INSERT INTO foundation_tasks(id,title,organization_id,assignee_id,created_by,record_id) VALUES($1,$2,$3,$4,$5,$6)',[taskId,next.title,actor.organizationId,next.data[assigned.field],next.ownerId,id]);
          await client.query('INSERT INTO workflow_task_links(run_id,task_id) VALUES($1,$2)',[id,taskId]);
          next.taskId=taskId;
        }
        if(transition.task==='complete') {
          const task=(await client.query("UPDATE foundation_tasks SET status='completed',version=version+1,reason=$1,decided_by=$2,decided_at=now() WHERE id=(SELECT task_id FROM workflow_task_links WHERE run_id=$3) AND organization_id=$4 AND assignee_id=$2 AND status='pending' RETURNING id",[input.receiptNote??'',actor.subject,id,actor.organizationId])).rows[0];
          if(!task)throw new WorkflowError(409,'Việc liên kết không khả dụng.');
          next.taskId=task.id;
        }
        if(transition.eventType) {
          const event:WorkflowEvent={eventId,eventType:transition.eventType,organizationId:actor.organizationId,runId:id,recordId:id,definitionId:def.id,version:next.version,occurredAt:next.updatedAt,data:next.data};
          await client.query('INSERT INTO workflow_jobs(id,run_id,organization_id,payload) VALUES($1,$2,$3,$4)',[eventId,id,actor.organizationId,JSON.stringify(event)]);
        }
        if(internal)await client.query("UPDATE workflow_timers SET status='succeeded',completed_at=now() WHERE id=$1",[internal.timerId]);
        await executeBlocks(client,transition.steps ?? [],next,input,actor,transition.wait,def);
        await client.query('INSERT INTO workflow_commands(run_id,key,actor_id,fingerprint,result) VALUES($1,$2,$3,$4,$5)',[id,key,actor.subject,hash,JSON.stringify(next)]);
        return next;
  }
  return {
    ...timerDatabase({pool,transaction:fn=>transaction(pool,fn),get,definition,transitionWithClient,columns:runColumns,serialize:serializeRun}),
    get,listPage,...waitDatabase(pool,get),...lifecycleDatabase({transaction:fn=>transaction(pool,fn),columns:runColumns,serialize:serializeRun,definition}),
    async entityContext(id,actor){
      requireEntityRead(actor);
      if(!isRecordId(id))throw new WorkflowError(400,'Invalid workflow ID.');
      return transaction(pool,async client=>{
        const row=(await client.query(`SELECT ${runColumns} FROM workflow_runs WHERE id=$1 AND organization_id=$2 FOR SHARE`,[id,actor.organizationId])).rows[0];
        if(!row||!canReadRun(await definition(row,client),row,actor))throw new WorkflowError(404,'Không tìm thấy quy trình.');
        const context=await readContext(client,id,actor.organizationId);
        if(!context)throw new WorkflowError(404,'Workflow entity context not found.');
        return {context,current:await lockContextEntity(client,context.entityId,actor)};
      });
    },
    async listEntityWorkflows(id,actor,query){
      requireEntityRead(actor);
      if(!isRecordId(id))throw new WorkflowError(400,'Invalid entity ID.');
      if(!Number.isSafeInteger(query.limit)||query.limit<1||query.limit>100||!Number.isSafeInteger(query.offset)||query.offset<0||query.offset>Number.MAX_SAFE_INTEGER-101||typeof query.q!=='string'||Array.from(query.q).length>200)throw new WorkflowError(400,'Invalid page.');
      return transaction(pool,async client=>{
        await lockContextEntity(client,id,actor);
        const definitions=await registry.list(actor.organizationId,client);
        const values:unknown[]=[actor.organizationId,actor.subject,id];
        const bind=(value:unknown)=>{values.push(value);return '$'+values.length;};
        const where=['r.organization_id=$1','c.organization_id=$1','c.entity_id=$3',workflowReadPredicate(definitions,actor,bind,'r')];
        if(query.q)where.push(`strpos(lower(r.title),lower(${bind(query.q)}))>0`);
        const rows=(await client.query(`SELECT ${runColumns.split(',').map(c=>'r.'+c).join(',')} FROM workflow_runs r JOIN workflow_entity_contexts c ON c.run_id=r.id WHERE ${where.join(' AND ')} ORDER BY r.updated_at DESC,r.id DESC LIMIT ${bind(query.limit+1)} OFFSET ${bind(query.offset)}`,values)).rows.map(serializeRun);
        return pageResult(await taskIds(rows,client),query);
      });
    },
    createWithClient,
    async create(value,actor,key) {
      return transaction(pool,client=>createWithClient(client,value,actor,key));
    },
    transitionWithClient,
    async transition(id,value,actor,key) {return transaction(pool,client=>transitionWithClient(client,id,value,actor,key));},
    async list(actor,inbox) {return (await listPage(actor,inbox,{limit:100,offset:0,q:''})).items;},
    async history(id,actor) {
      await get(id,actor);
      const rows=(await pool.query('SELECT id,actor_id AS "actorId",action,from_state AS "fromState",to_state AS "toState",version,metadata,occurred_at AS "occurredAt" FROM workflow_audit WHERE run_id=$1 ORDER BY version LIMIT 100',[id])).rows;
      return rows.map(row=>({...row,occurredAt:new Date(row.occurredAt).toISOString()}));
    },
    async executions(id,actor,query) {
      await get(id,actor);
      const rows=(await pool.query('SELECT run_id AS "runId",version,step_id AS "stepId",step_index AS "stepIndex",actor_id AS "actorId",action,input,result,occurred_at AS "occurredAt" FROM workflow_action_results WHERE run_id=$1 ORDER BY version,step_index,step_id LIMIT $2 OFFSET $3',[id,query?query.limit+1:100,query?.offset??0])).rows;
      return rows.map(row=>({...row,occurredAt:new Date(row.occurredAt).toISOString()}));
    },
    async jobs(id,actor) {await get(id,actor);return (await pool.query('SELECT id,status,attempts,last_error AS "lastError" FROM workflow_jobs WHERE run_id=$1 ORDER BY created_at LIMIT 100',[id])).rows;},
    async retryJobs(id,actor,key) {
      return transaction(pool,async client=>{
        const row=(await client.query(`SELECT ${runColumns} FROM workflow_runs WHERE id=$1 AND organization_id=$2 FOR UPDATE`,[id,actor.organizationId])).rows[0];
        if(!row||!canReadRun(await definition(row,client),row,actor))throw new WorkflowError(404,'Không tìm thấy quy trình.');
        if(!actor.roles.includes('workflow:sync'))throw new WorkflowError(403,'Không có quyền chạy lại đồng bộ.');
        if(row.status==='cancelled')throw new WorkflowError(409,'Quy trình đã huỷ.');
        const hash=fingerprint({action:'sync.retry',expectedVersion:0,input:{}});
        const replay=(await client.query('SELECT actor_id,fingerprint,result FROM workflow_commands WHERE run_id=$1 AND key=$2',[id,key])).rows[0];
        if(replay){if(replay.actor_id!==actor.subject||replay.fingerprint!==hash)throw new WorkflowError(409,'Idempotency-Key đã dùng với dữ liệu khác.');return replay.result.retried;}
        const count=(await client.query("UPDATE workflow_jobs SET status='pending',attempts=0,available_at=now(),lease_until=NULL,lease_token=NULL,last_error=NULL WHERE run_id=$1 AND organization_id=$2 AND status='failed' AND NOT EXISTS(SELECT 1 FROM workflow_waits w WHERE w.id=workflow_jobs.id AND w.status<>'pending')",[id,actor.organizationId])).rowCount??0;
        await client.query('INSERT INTO workflow_commands(run_id,key,actor_id,fingerprint,result) VALUES($1,$2,$3,$4,$5)',[id,key,actor.subject,hash,JSON.stringify({retried:count})]);
        return count;
      });
    },
    async registerMember(actor) {await pool.query('INSERT INTO workflow_members(organization_id,subject) VALUES($1,$2) ON CONFLICT DO NOTHING',[actor.organizationId,actor.subject]);},
    async references(actor) {return (await pool.query('SELECT kind,id,name FROM workflow_references WHERE organization_id=$1 ORDER BY kind,id LIMIT 100',[actor.organizationId])).rows;},
    async readSharedFile(id,actor) {
      return transaction(pool,client=>readFileMetadataWithClient(client,actor,id,{kind:'foundation'}));
    },
  };
}
