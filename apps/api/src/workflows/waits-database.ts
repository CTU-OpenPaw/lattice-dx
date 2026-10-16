// SPDX-License-Identifier: Apache-2.0
import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { WorkflowActor, WorkflowCompletion, WorkflowCompletionReceipt, WorkflowRun, WorkflowWait } from '@dx/contracts';
import { WorkflowError } from './policy.js';
import { completionResult, parseCompletion } from './completion-policy.js';
import { pageResult, type PageQuery } from '../pagination.js';
export type StoredWait = WorkflowWait & {organization_id:string;assignee_id:string|null;connector_id:string|null;completion_key:string|null;completion_fingerprint:string|null;completion_actor:string|null;receipt:WorkflowCompletionReceipt|null;run_id:string;expired:boolean};
async function transaction<T>(pool:Pool, operation:(client:PoolClient)=>Promise<T>):Promise<T> {
  const client=await pool.connect();
  try { await client.query('BEGIN'); const value=await operation(client); await client.query('COMMIT'); return value; }
  catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
}
function fingerprint(value:WorkflowCompletion) {
  return createHash('sha256').update(JSON.stringify({status:value.status,result:Object.fromEntries(Object.entries(value.result).sort(([a],[b])=>a.localeCompare(b))),reason:value.reason??null})).digest('hex');
}
export async function lockedWait(client:PoolClient,id:string,organizationId?:string) {
  const reference=(await client.query('SELECT run_id,organization_id FROM workflow_waits WHERE id=$1',[id])).rows[0];
  if(!reference || organizationId !== undefined && reference.organization_id !== organizationId) throw new WorkflowError(404,'Không tìm thấy yêu cầu hoàn thành.');
  const run=(await client.query('SELECT id,state,version,status FROM workflow_runs WHERE id=$1 FOR UPDATE',[reference.run_id])).rows[0];
  const wait=(await client.query('SELECT *,deadline<=clock_timestamp() AS expired FROM workflow_waits WHERE id=$1 FOR UPDATE',[id])).rows[0] as StoredWait;
  return {run,wait};
}
export async function settle(client:PoolClient,run:{id:string;state:string;version:number;status?:string},wait:StoredWait,status:WorkflowCompletionReceipt['status'],result:Record<string,string>,actorId:string,key?:string,hash?:string,reason?:string) {
  if(run.status==='cancelled'||run.version!==wait.version) throw new WorkflowError(409,'Phiên bản yêu cầu không còn phù hợp.');
  const state=status==='succeeded'?wait.config.successState:wait.config.failureState;
  const next=(await client.query('UPDATE workflow_runs SET state=$1,version=version+1,data=data||$2::jsonb,updated_at=now() WHERE id=$3 RETURNING version',[state,JSON.stringify(result),run.id])).rows[0];
  const receipt:WorkflowCompletionReceipt={waitId:wait.id,runId:run.id,status,state,version:next.version};
  if(wait.kind==='task') {
    const task=await client.query("UPDATE foundation_tasks SET status=$1,version=version+1,reason=$2,decided_by=$3,decided_at=now() WHERE id=$4 AND organization_id=$5 AND assignee_id=$6 AND status='pending' RETURNING id",[status==='succeeded'?'completed':'rejected',reason??'',actorId,wait.id,wait.organization_id,wait.assignee_id]);
    if(!task.rowCount) throw new WorkflowError(409,'Việc liên kết không khả dụng.');
  }
  await client.query('INSERT INTO workflow_audit(id,run_id,actor_id,action,from_state,to_state,version) VALUES($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),run.id,actorId,`wait.${status}`,run.state,state,next.version]);
  await client.query('UPDATE workflow_waits SET status=$1,completed_at=now(),completion_key=$2,completion_fingerprint=$3,completion_actor=$4,receipt=$5,evidence=$6 WHERE id=$7',[status,key??null,hash??null,actorId,JSON.stringify(receipt),JSON.stringify({result,reason:reason??null}),wait.id]);
  return receipt;
}
export function waitDatabase(pool:Pool,get:(id:string,actor:WorkflowActor)=>Promise<WorkflowRun>) {
  return {
    async listWaits(id:string,actor:WorkflowActor,query:PageQuery) {
      await get(id,actor);
      const rows=(await pool.query('SELECT id,run_id AS "runId",version,kind,status,config,deadline,evidence,created_at AS "createdAt",completed_at AS "completedAt" FROM workflow_waits WHERE run_id=$1 AND organization_id=$2 ORDER BY created_at DESC,id DESC LIMIT $3 OFFSET $4',[id,actor.organizationId,query.limit+1,query.offset])).rows;
      return pageResult(rows.map(row=>({...row,deadline:new Date(row.deadline).toISOString(),createdAt:new Date(row.createdAt).toISOString(),completedAt:row.completedAt?new Date(row.completedAt).toISOString():null})),query);
    },
    async completeWait(id:string,value:WorkflowCompletion,actor:WorkflowActor,key:string) {
      return transaction(pool,async client=>{
        const {run,wait}=await lockedWait(client,id,actor.organizationId);
        if(wait.kind==='task') {
          if(actor.subject!==wait.assignee_id || !actor.roles.includes('tasks:decide')) throw new WorkflowError(403,'Không có quyền hoàn thành việc.');
          const task=(await client.query('SELECT assignee_id,organization_id FROM foundation_tasks WHERE id=$1',[id])).rows[0];
          if(!task || task.assignee_id!==actor.subject || task.organization_id!==actor.organizationId) throw new WorkflowError(403,'Không có quyền hoàn thành việc.');
        } else {
          if(!actor.roles.includes('workflow:callback') || !actor.roles.includes(`connector:${wait.connector_id}`)) throw new WorkflowError(403,'Không có quyền hoàn thành connector.');
          const job=(await client.query('SELECT payload FROM workflow_jobs WHERE id=$1 AND run_id=$2 AND organization_id=$3',[id,run.id,actor.organizationId])).rows[0];
          if(wait.connector_id==='agent' && job?.payload.operation==='incident.analyze') throw new WorkflowError(403,'Managed incident waits require durable agent completion.');
          if(!job || job.payload.eventType!=='connector.dispatch' || job.payload.connectorId!==wait.connector_id) throw new WorkflowError(403,'Connector không phù hợp.');
        }
        const parsed=parseCompletion(value);if(!parsed) throw new WorkflowError(400,'Dữ liệu hoàn thành không hợp lệ.');
        const result=completionResult(wait.config,parsed),hash=fingerprint(parsed);
        if(wait.completion_key===key) {
          if(wait.completion_actor!==actor.subject || wait.completion_fingerprint!==hash) throw new WorkflowError(409,'Idempotency-Key đã dùng với dữ liệu khác.');
          return wait.receipt!;
        }
        if(run.status==='cancelled' || wait.status!=='pending' || wait.expired) throw new WorkflowError(409,'Yêu cầu đã kết thúc hoặc hết hạn.');
        return settle(client,run,wait,parsed.status,result,actor.subject,key,hash,parsed.reason);
      });
    },
    async expireWaits() {
      const candidates=(await pool.query("SELECT id FROM workflow_waits WHERE status='pending' AND deadline<=now() ORDER BY deadline LIMIT 100")).rows;
      let count=0;
      for(const candidate of candidates) count+=await transaction(pool,async client=>{
        const {run,wait}=await lockedWait(client,candidate.id);
        if(run.status==='cancelled' || wait.status!=='pending' || !wait.expired) return 0;
        await settle(client,run,wait,'timed_out',{},'workflow:timeout',undefined,undefined,'Workflow wait timed out.');return 1;
      });
      return count;
    },
  };
}
