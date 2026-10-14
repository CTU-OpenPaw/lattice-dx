// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { isRecordId, type WorkflowActor, type WorkflowConnectorEvent, type WorkflowRun, type WorkflowStep, type WorkflowWaitConfig } from '@dx/contracts';
import { authorizeBlock, boundedString, resolveBinding } from './block-policy.js';
import { WorkflowError } from './policy.js';
function title(value: string) {
  if (!boundedString(value, 200) || !value.trim()) throw new WorkflowError(400, 'Title block không hợp lệ.');
  return value.trim();
}
function subject(value: string) {
  if (!boundedString(value, 100) || !value.trim() || value !== value.trim()) throw new WorkflowError(400, 'Assignee không hợp lệ.');
  return value;
}
/** All reads and writes use the caller's transaction connection, including directory routing. */
export async function executeBlocks(client: PoolClient, steps: WorkflowStep[], run: WorkflowRun, input: Record<string, string>, actor: WorkflowActor, wait?: WorkflowWaitConfig): Promise<void> {
  const results = new Map<string, { id?: string; eventId?: string }>();
  for (const [stepIndex, step] of steps.entries()) {
    authorizeBlock(step, actor);
    const resolve = (binding: Parameters<typeof resolveBinding>[0]) => resolveBinding(binding, run, input, actor, results);
    let resolved: Record<string, string | Record<string, string>>;
    let result: { id?: string; eventId?: string };
    if (step.action === 'records.create') {
      resolved = { title: title(resolve(step.input.title)) };
      const id = randomUUID();
      await client.query('INSERT INTO records(id,title,owner_id,organization_id) VALUES($1,$2,$3,$4)', [id, resolved.title, actor.subject, actor.organizationId]);
      result = { id };
    } else if (step.action === 'tasks.create') {
      const taskTitle = title(resolve(step.input.title));
      let assigneeId: string;
      if (step.assignment) {
        const department = subject(resolve(step.assignment.department));
        if (step.assignment.assigneeId) {
          assigneeId = subject(resolve(step.assignment.assigneeId));
          const found = await client.query(
            'SELECT subject FROM directory_people WHERE organization_id=$1 AND department_id=$2 AND enabled=true AND roles @> $3::jsonb AND subject=$4 FOR SHARE',
            [actor.organizationId, department, JSON.stringify([step.assignment.role]), assigneeId],
          );
          if (!found.rowCount) throw new WorkflowError(400, 'Người nhận không thuộc phòng ban hoặc không khả dụng.');
        } else {
          const candidates = (await client.query(
            'SELECT subject FROM directory_people WHERE organization_id=$1 AND department_id=$2 AND enabled=true AND roles @> $3::jsonb ORDER BY subject LIMIT 2 FOR SHARE',
            [actor.organizationId, department, JSON.stringify([step.assignment.role])],
          )).rows;
          if (!candidates.length) throw new WorkflowError(400, 'Phòng ban không có người nhận phù hợp.');
          if (candidates.length > 1) throw new WorkflowError(409, 'Phòng ban có nhiều người nhận phù hợp; cần chọn người cụ thể.');
          assigneeId = candidates[0].subject;
        }
      } else {
        assigneeId = subject(resolve(step.input.assigneeId!));
        const found = await client.query('SELECT subject FROM directory_people WHERE organization_id=$1 AND subject=$2 AND enabled=true FOR SHARE', [actor.organizationId, assigneeId]);
        if (!found.rowCount) throw new WorkflowError(400, 'Người nhận không khả dụng trong đơn vị.');
      }
      const recordId = step.input.recordId ? resolve(step.input.recordId) : undefined;
      if (recordId !== undefined) {
        if (!isRecordId(recordId)) throw new WorkflowError(400, 'ID hồ sơ không hợp lệ.');
        const found = await client.query('SELECT 1 FROM records WHERE id=$1 AND owner_id=$2 AND organization_id=$3 FOR SHARE', [recordId, actor.subject, actor.organizationId]);
        if (!found.rowCount) throw new WorkflowError(400, 'Hồ sơ không thuộc người giao trong đơn vị.');
      }
      resolved = { title: taskTitle, assigneeId, ...(recordId ? { recordId } : {}) };
      if (step.assignment) { resolved.department = resolve(step.assignment.department); resolved.role = step.assignment.role; }
      const id = randomUUID();
      await client.query('INSERT INTO foundation_tasks(id,title,organization_id,assignee_id,created_by,record_id) VALUES($1,$2,$3,$4,$5,$6)', [id, taskTitle, actor.organizationId, assigneeId, actor.subject, recordId ?? null]);
      result = { id };
    } else {
      const payload = Object.fromEntries(Object.entries(step.input.payload ?? {}).map(([key, binding]) => [key, resolve(binding)]));
      const eventId = randomUUID();
      const event: WorkflowConnectorEvent = {
        eventId, eventType: 'connector.dispatch', connectorId: step.input.connectorId.value, operation: step.input.operation.value,
        organizationId: actor.organizationId, runId: run.id, recordId: run.recordId, definitionId: run.definitionId,
        version: run.version, occurredAt: run.updatedAt, data: payload,
      };
      await client.query('INSERT INTO workflow_jobs(id,run_id,organization_id,payload) VALUES($1,$2,$3,$4)', [eventId, run.id, actor.organizationId, JSON.stringify(event)]);
      resolved = { connectorId: event.connectorId, operation: event.operation, payload };
      result = { eventId };
    }
    await client.query('INSERT INTO workflow_action_results(run_id,version,step_id,actor_id,action,input,result,step_index) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [run.id, run.version, step.id, actor.subject, step.action, JSON.stringify(resolved), JSON.stringify(result), stepIndex]);
    results.set(step.id, result);
    if (wait && step.id === wait.stepId) {
      await client.query(`INSERT INTO workflow_waits(id,run_id,organization_id,version,kind,assignee_id,connector_id,config,deadline)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()+$9 * interval '1 second')`,
      [result.id ?? result.eventId,run.id,actor.organizationId,run.version,step.action === 'tasks.create' ? 'task' : 'connector',
        resolved.assigneeId ?? null,resolved.connectorId ?? null,JSON.stringify(wait),wait.timeoutSeconds]);
      run.waiting = true;
    }
  }
}
