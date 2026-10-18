// SPDX-License-Identifier: Apache-2.0
import {createHash,randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {isRecordId} from '@dx/contracts';
import {parseCreateKey,CreateCommandError} from '../create-command.js';
import type {WorkflowRun,WorkflowActor,WorkflowDefinition,CancelWorkflow,TransferWorkflowTask} from '@dx/contracts';
import {WorkflowError} from './policy.js';
import {assertIncidentActor} from '../agents/incident-policy.js';
export function parseLifecycle(value:unknown,transfer=false):CancelWorkflow|TransferWorkflowTask|undefined {
 if(!value||typeof value!=='object'||Array.isArray(value))return;
 const v=value as Record<string,unknown>,allowed=transfer?['taskId','assigneeId','expectedVersion','reason']:['expectedVersion','reason'];
 if(Object.keys(v).some(k=>!allowed.includes(k))||!Number.isSafeInteger(v.expectedVersion)||Number(v.expectedVersion)<1||typeof v.reason!=='string'||!v.reason.trim()||Array.from(v.reason).length>500)return;
 if(transfer&&(typeof v.taskId!=='string'||!isRecordId(v.taskId)||typeof v.assigneeId!=='string'||!v.assigneeId.trim()||v.assigneeId!==v.assigneeId.trim()||Array.from(v.assigneeId).length>100||/[\x00-\x1f\x7f]/.test(v.assigneeId)))return;
 return {expectedVersion:Number(v.expectedVersion),reason:v.reason.trim(),...(transfer?{taskId:(v.taskId as string).toLowerCase(),assigneeId:v.assigneeId as string}:{})} as CancelWorkflow|TransferWorkflowTask;
}
export async function taskHistory(client:PoolClient,task:{id:string;version:number},actor:WorkflowActor,operation:string) {
 const installed=(await client.query("SELECT to_regclass('task_lifecycle_history') AS table_name")).rows[0]?.table_name;
 if(installed)await client.query('INSERT INTO task_lifecycle_history(id,task_id,organization_id,actor_id,operation,from_version,to_version) VALUES($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),task.id,actor.organizationId,actor.subject,operation,task.version-1,task.version]);
}
type Services={transaction:<T>(fn:(client:PoolClient)=>Promise<T>)=>Promise<T>;columns:string;serialize:(run:WorkflowRun)=>WorkflowRun;definition:(run:WorkflowRun,client:PoolClient)=>Promise<WorkflowDefinition>};
export function lifecycleDatabase(s:Services){
 async function mutate(id:string,value:CancelWorkflow|TransferWorkflowTask,actor:WorkflowActor,key:string,operation:'cancel'|'task-transfer') {
  if(typeof id!=='string'||!isRecordId(id))throw new WorkflowError(400,'ID quy trình phải là UUID.');
  id=id.toLowerCase();
  return s.transaction(async c=>{
   const row=(await c.query(`SELECT ${s.columns} FROM workflow_runs WHERE id=$1 AND organization_id=$2 FOR UPDATE`,[id,actor.organizationId])).rows[0];
   if(!row||row.ownerId!==actor.subject)throw new WorkflowError(404,'Không tìm thấy quy trình.');
   if(!actor.roles.includes('workflow:start')||operation==='task-transfer'&&!actor.roles.includes('tasks:assign'))throw new WorkflowError(403,'Không có quyền cập nhật quy trình.');
   await assertIncidentActor(c,row,actor,operation==='task-transfer'?['workflow:start','tasks:assign']:['workflow:start']);
   const parsed=parseLifecycle(value,operation==='task-transfer');
   if(!parsed)throw new WorkflowError(400,'Dữ liệu cập nhật không hợp lệ.');
   value=parsed;
   try{const parsedKey=parseCreateKey(key);if(!parsedKey)throw new WorkflowError(400,'Idempotency-Key bắt buộc.');key=parsedKey;}
   catch(error){if(error instanceof CreateCommandError)throw new WorkflowError(400,error.message);throw error;}
   const normalized={operation,...parsed};
   const hash=createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
   const replay=(await c.query('SELECT actor_id,fingerprint,result FROM workflow_commands WHERE run_id=$1 AND key=$2',[id,key])).rows[0];
   if(replay){if(replay.actor_id!==actor.subject||replay.fingerprint!==hash)throw new WorkflowError(409,'Idempotency-Key đã dùng với dữ liệu khác.');return replay.result as WorkflowRun;}
   const run=s.serialize(row);
   if(run.status==='cancelled'||run.version!==value.expectedVersion)throw new WorkflowError(409,'Trạng thái hoặc phiên bản không phù hợp.');
   const waits=(await c.query("SELECT * FROM workflow_waits WHERE run_id=$1 AND status='pending' ORDER BY id FOR UPDATE",[id])).rows;
   let next:WorkflowRun;
   if(operation==='cancel'){
    await c.query("SELECT id FROM workflow_timers WHERE run_id=$1 AND status='pending' ORDER BY id FOR UPDATE",[id]);
    await c.query("UPDATE workflow_timers SET status='cancelled',completed_at=now() WHERE run_id=$1 AND status='pending'",[id]);
    const tasks=(await c.query(`SELECT * FROM foundation_tasks WHERE organization_id=$2 AND status='pending' AND id IN (
     SELECT task_id FROM workflow_task_links WHERE run_id=$1 UNION SELECT id FROM workflow_waits WHERE run_id=$1 AND kind='task'
     UNION SELECT (result->>'id')::uuid FROM workflow_action_results WHERE run_id=$1 AND action='tasks.create' AND result->>'id' IS NOT NULL
    ) ORDER BY id FOR UPDATE`,[id,actor.organizationId])).rows;
    await c.query("SELECT id FROM workflow_jobs WHERE run_id=$1 AND status IN ('pending','processing') ORDER BY id FOR UPDATE",[id]);
    const cancelled=(await c.query("UPDATE foundation_tasks SET status='cancelled',version=version+1,reason=$2,decided_by=$3,decided_at=now() WHERE id=ANY($1::uuid[]) AND status='pending' RETURNING id,version",[tasks.map(t=>t.id),normalized.reason,actor.subject])).rows;
    for(const t of cancelled)await taskHistory(c,t,actor,'workflow.cancel');
    await c.query("UPDATE workflow_waits SET status='cancelled',completed_at=now(),evidence=$2::jsonb WHERE run_id=$1 AND status='pending'",[id,JSON.stringify({result:{},reason:normalized.reason})]);
    await c.query("UPDATE workflow_jobs SET status='cancelled',lease_token=NULL,lease_until=NULL WHERE run_id=$1 AND status IN ('pending','processing')",[id]);
    next=s.serialize((await c.query(`UPDATE workflow_runs SET status='cancelled',cancellation=jsonb_build_object('actorId',$2::text,'reason',$3::text,'at',clock_timestamp()),version=version+1,updated_at=now() WHERE id=$1 RETURNING ${s.columns}`,[id,actor.subject,normalized.reason])).rows[0]);
   }else{
    const v=value as TransferWorkflowTask;
    const link=(await c.query('SELECT task_id FROM workflow_task_links WHERE run_id=$1 AND task_id=$2',[id,v.taskId])).rows[0];
    const wait=waits.find(w=>w.id===v.taskId&&w.kind==='task');
    if(!link&&!wait)throw new WorkflowError(409,'Việc không thuộc yêu cầu có thể chuyển giao.');
    const task=(await c.query('SELECT * FROM foundation_tasks WHERE id=$1 AND organization_id=$2 FOR UPDATE',[v.taskId,actor.organizationId])).rows[0];
    if(!task||task.status!=='pending')throw new WorkflowError(409,'Việc đã kết thúc.');
    const def=await s.definition(run,c),roles=link&&def.assignedReader?[def.assignedReader.role]:[];
    if(link&&!def.assignedReader)throw new WorkflowError(409,'Quy trình không hỗ trợ chuyển giao.');
    const person=await c.query('SELECT 1 FROM directory_people WHERE subject=$1 AND organization_id=$2 AND enabled=true AND roles @> $3::jsonb FOR SHARE',[v.assigneeId,actor.organizationId,JSON.stringify(roles)]);
    if(!person.rowCount)throw new WorkflowError(400,'Người được giao không khả dụng trong đơn vị.');
    const updated=(await c.query('UPDATE foundation_tasks SET assignee_id=$2,version=version+1 WHERE id=$1 RETURNING id,version',[v.taskId,v.assigneeId])).rows[0];
    await taskHistory(c,updated,actor,'workflow.task-transfer');
    const data=link?{[def.assignedReader!.field]:v.assigneeId}:{};
    next=s.serialize((await c.query(`UPDATE workflow_runs SET data=data||$2::jsonb,version=version+1,updated_at=now() WHERE id=$1 RETURNING ${s.columns}`,[id,JSON.stringify(data)])).rows[0]);
    await c.query("UPDATE workflow_waits SET version=$2,assignee_id=CASE WHEN id=$3 THEN $4 ELSE assignee_id END WHERE run_id=$1 AND status='pending'",[id,next.version,v.taskId,v.assigneeId]);
   }
   next.waiting=operation==='task-transfer'&&waits.length>0;
   const legacy=(await c.query('SELECT task_id FROM workflow_task_links WHERE run_id=$1',[id])).rows[0];
   if(legacy)next.taskId=legacy.task_id;
   await c.query('INSERT INTO workflow_audit(id,run_id,actor_id,action,from_state,to_state,version,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)',[randomUUID(),id,actor.subject,operation,run.state,next.state,next.version,JSON.stringify(normalized)]);
   await c.query('INSERT INTO workflow_commands(run_id,key,actor_id,fingerprint,result) VALUES($1,$2,$3,$4,$5)',[id,key,actor.subject,hash,JSON.stringify(next)]);
   return next;
  });
 }
 return {cancel:(id:string,v:CancelWorkflow,a:WorkflowActor,k:string)=>mutate(id,v,a,k,'cancel'),taskTransfer:(id:string,v:TransferWorkflowTask,a:WorkflowActor,k:string)=>mutate(id,v,a,k,'task-transfer')};
}
