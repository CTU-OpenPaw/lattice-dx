/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import {createHash,randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import type {Scope,Task} from '../foundation.js';
import {pageResult,type PageQuery} from '../pagination.js';
import {createFingerprint,parseCreateKey} from '../create-command.js';
import {TaskLifecycleError,type TaskLifecycleRepository,type MutationOperation,type MutationInput,type QueueInput} from './types.js';
import {parseMutation,parseQueueInput,taskId,principal,normalizeDueAt,assertAuthority,assertWorkflow} from './policy.js';
const columns=`id,title,organization_id AS "organizationId",assignee_id AS "assigneeId",created_by AS "createdBy",status,version,record_id AS "recordId",department_id AS "departmentId",due_at AS "dueAt"`;
const serialize=(row:Task):Task=>({...row,...(row.dueAt?{dueAt:new Date(row.dueAt).toISOString()}:{})});
const visible=`t.organization_id=$2 AND (t.created_by=$3 OR t.assignee_id=$3 OR (t.assignee_id='' AND t.status='pending' AND EXISTS(SELECT 1 FROM directory_people p WHERE p.subject=$3 AND p.organization_id=$2 AND p.enabled=true AND p.department_id=t.department_id)))`;
export async function taskLifecycleDatabase(pool:Pool):Promise<TaskLifecycleRepository>{
 await pool.query('ALTER TABLE foundation_tasks ADD COLUMN IF NOT EXISTS department_id text');
 await pool.query('ALTER TABLE foundation_tasks ADD COLUMN IF NOT EXISTS due_at timestamptz');
 await pool.query(`CREATE TABLE IF NOT EXISTS task_lifecycle_history(id uuid PRIMARY KEY,task_id uuid NOT NULL REFERENCES foundation_tasks(id),organization_id text NOT NULL,actor_id text NOT NULL,operation text NOT NULL,from_version integer NOT NULL,to_version integer NOT NULL,occurred_at timestamptz NOT NULL DEFAULT now())`);
 await pool.query('CREATE INDEX IF NOT EXISTS task_lifecycle_history_task ON task_lifecycle_history(task_id,occurred_at,id)');
 await pool.query(`CREATE TABLE IF NOT EXISTS task_lifecycle_commands(organization_id text NOT NULL,actor_id text NOT NULL,operation text NOT NULL,key text NOT NULL,fingerprint text NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(organization_id,actor_id,operation,key))`);
 async function command(actor:Scope,op:string,key:string,input:Record<string,unknown>,execute:(c:PoolClient,receipt:(authorize?:(id:string)=>Promise<void>)=>Promise<Task|undefined>)=>Promise<Task>):Promise<Task>{
  principal(actor.subject);principal(actor.organizationId);
  if(!parseCreateKey(key))throw new TaskLifecycleError(400,'Idempotency-Key bắt buộc.');
  const c=await pool.connect(),tuple=[actor.organizationId,actor.subject,op,key],fingerprint=createFingerprint(input);
  try{
   await c.query('BEGIN');
   const lock=createHash('sha256').update(JSON.stringify(tuple)).digest().readBigInt64BE(0).toString();
   await c.query('SELECT pg_advisory_xact_lock($1::bigint)',[lock]);
   let replayed=false;
   const receipt=async(authorize?:(id:string)=>Promise<void>)=>{
    const r=(await c.query('SELECT fingerprint,result FROM task_lifecycle_commands WHERE organization_id=$1 AND actor_id=$2 AND operation=$3 AND key=$4',tuple)).rows[0];
    if(!r)return undefined;if(authorize)await authorize((r.result as Task).id);if(r.fingerprint!==fingerprint)throw new TaskLifecycleError(409,'Idempotency-Key đã được dùng với nội dung khác.');replayed=true;return r.result as Task;
   };
   const result=await execute(c,receipt);
   // A replay is never rewritten: the immutable stored receipt determines its result.
   if(!replayed)await c.query('INSERT INTO task_lifecycle_commands(organization_id,actor_id,operation,key,fingerprint,result) VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT(organization_id,actor_id,operation,key) DO NOTHING',[...tuple,fingerprint,JSON.stringify(result)]);
   await c.query('COMMIT');return result;
  }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
 }
 async function mutate(op:MutationOperation,id:string,actor:Scope,raw:MutationInput,key:string):Promise<Task>{
  id=taskId(id);const input=parseMutation(op,raw);
  return command(actor,`tasks.${op}`,key,{id,...input},async(c,receipt)=>{
   const task=(await c.query(`SELECT ${columns} FROM foundation_tasks WHERE id=$1 AND organization_id=$2 FOR UPDATE`,[id,actor.organizationId])).rows[0] as Task|undefined;
   let member=false;
   if(task&&op==='claim')member=(await c.query('SELECT subject FROM directory_people WHERE subject=$1 AND organization_id=$2 AND enabled=true AND department_id=$3 FOR SHARE',[actor.subject,actor.organizationId,task.departmentId])).rows.length>0;
   if(task&&op==='claim'&&task.assigneeId!==''&&task.assigneeId!==actor.subject&&member){
    const previous=(await c.query('SELECT 1 FROM task_lifecycle_commands WHERE organization_id=$1 AND actor_id=$2 AND operation=$3 AND key=$4',[actor.organizationId,actor.subject,'tasks.claim',key])).rows[0];
    if(!previous)throw new TaskLifecycleError(409,'Task đã được nhận.');
   }
   assertAuthority(task,actor,op,member);
   const linked=(await c.query('SELECT (EXISTS(SELECT 1 FROM workflow_task_links WHERE task_id=$1) OR EXISTS(SELECT 1 FROM workflow_waits WHERE id=$1)) AS linked',[id])).rows[0].linked;
   assertWorkflow(linked);
   const prior=await receipt();if(prior)return prior;
   if(task.status!=='pending'||task.version!==input.expectedVersion||(op==='claim'&&(task.assigneeId!==''||!member)))throw new TaskLifecycleError(409,'Task đã xử lý hoặc sai phiên bản.');
   if(op==='reassign'){
    const recipient=(await c.query('SELECT subject FROM directory_people WHERE subject=$1 AND organization_id=$2 AND enabled=true FOR SHARE',[input.assigneeId,actor.organizationId])).rows[0];
    if(!recipient)throw new TaskLifecycleError(400,'Assignee không khả dụng trong đơn vị.');
   }
   if(op==='deadline'&&input.dueAt!==null)normalizeDueAt(input.dueAt,Date.now());
   const assignment=op==='claim'?'assignee_id=$3':op==='reassign'?'assignee_id=$3,reason=$4':op==='cancel'?"status='cancelled',reason=$3":'due_at=$3';
   const values:unknown[]=[id,actor.organizationId,op==='claim'?actor.subject:op==='reassign'?input.assigneeId:op==='cancel'?input.reason:input.dueAt];
   if(op==='reassign')values.push(input.reason);
   const result=serialize((await c.query(`UPDATE foundation_tasks SET ${assignment},version=version+1 WHERE id=$1 AND organization_id=$2 RETURNING ${columns}`,values)).rows[0]);
   await c.query('INSERT INTO task_lifecycle_history(id,task_id,organization_id,actor_id,operation,from_version,to_version) VALUES($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),id,actor.organizationId,actor.subject,op,task.version,result.version]);
   return result;
  });
 }
 return {
  async createQueue(actor:Scope,raw:QueueInput,key:string){
   const input=parseQueueInput(raw);
   return command(actor,'tasks.queue.create',key,input,async(c,receipt)=>{
    const members=(await c.query('SELECT subject FROM directory_people WHERE organization_id=$1 AND department_id=$2 AND enabled=true FOR SHARE',[actor.organizationId,input.departmentId])).rows;
    if(!members.length)throw new TaskLifecycleError(400,'Department không khả dụng trong đơn vị.');
    if(input.recordId&&!((await c.query('SELECT id FROM records WHERE id=$1 AND owner_id=$2 AND organization_id=$3 FOR SHARE',[input.recordId,actor.subject,actor.organizationId])).rows[0]))throw new TaskLifecycleError(404,'Không tìm thấy bản ghi trong phạm vi được phép.');
    const prior=await receipt(async id=>{
     const current=(await c.query(`SELECT ${columns} FROM foundation_tasks WHERE id=$1 AND organization_id=$2 FOR UPDATE`,[id,actor.organizationId])).rows[0] as Task|undefined;
     assertAuthority(current,actor,'cancel',false);
    });
    if(prior)return prior;
    if(input.dueAt)normalizeDueAt(input.dueAt,Date.now());
    const result=serialize((await c.query(`INSERT INTO foundation_tasks(id,title,organization_id,assignee_id,created_by,department_id,record_id,due_at) VALUES($1,$2,$3,'',$4,$5,$6,$7) RETURNING ${columns}`,[randomUUID(),input.title,actor.organizationId,actor.subject,input.departmentId,input.recordId??null,input.dueAt??null])).rows[0]);
    await c.query('INSERT INTO task_lifecycle_history(id,task_id,organization_id,actor_id,operation,from_version,to_version) VALUES($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),result.id,actor.organizationId,actor.subject,'createQueue',0,1]);
    return result;
   });
  },
  async queue(actor:Scope,q:PageQuery){
   const rows=(await pool.query(`SELECT ${columns} FROM foundation_tasks t WHERE t.organization_id=$1 AND t.status='pending' AND t.assignee_id='' AND EXISTS(SELECT 1 FROM directory_people p WHERE p.organization_id=$1 AND p.subject=$2 AND p.enabled=true AND p.department_id=t.department_id) AND ($3='' OR strpos(lower(t.title),lower($3))>0) ORDER BY t.created_at DESC,t.id DESC LIMIT $4 OFFSET $5`,[actor.organizationId,actor.subject,q.q,q.limit+1,q.offset])).rows.map(serialize);return pageResult(rows,q);
  },
  claim:(id,a,i,k)=>mutate('claim',id,a,i,k),reassign:(id,a,i,k)=>mutate('reassign',id,a,i,k),cancel:(id,a,i,k)=>mutate('cancel',id,a,i,k),setDeadline:(id,a,i,k)=>mutate('deadline',id,a,i,k),
  async history(id,actor,q){
   id=taskId(id);
   const c=await pool.connect();
   try{
    await c.query('BEGIN');
    const task=(await c.query(`SELECT t.id FROM foundation_tasks t WHERE t.id=$1 AND ${visible} FOR SHARE OF t`,[id,actor.organizationId,actor.subject])).rows[0];
    if(!task)throw new TaskLifecycleError(404,'Không tìm thấy task trong phạm vi được phép.');
    const rows=(await c.query(`SELECT h.id,h.task_id AS "taskId",h.actor_id AS "actorId",h.operation,h.from_version AS "fromVersion",h.to_version AS "toVersion",h.occurred_at AS "occurredAt" FROM task_lifecycle_history h JOIN foundation_tasks t ON t.id=h.task_id WHERE h.task_id=$1 AND h.organization_id=$2 AND ${visible} ORDER BY h.occurred_at,h.id LIMIT $4 OFFSET $5`,[id,actor.organizationId,actor.subject,q.limit+1,q.offset])).rows.map(row=>({...row,occurredAt:new Date(row.occurredAt).toISOString()}));
    await c.query('COMMIT');return pageResult(rows,q);
   }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
  }
 };
}
