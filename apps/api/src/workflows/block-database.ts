/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import {enqueueIncident} from '../agents/enqueue.js';
import {createPrivateValues,projectFields,evaluatePrivateExpression} from './private-blocks.js';
import {validateSteps} from './block-policy.js';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { isRecordId, type WorkflowActor, type WorkflowConnectorEvent, type WorkflowRun, type WorkflowStep, type WorkflowWaitConfig, type WorkflowDefinition, type WorkflowBlockResult, type WorkflowEntityStep } from '@dx/contracts';
import { authorizeBlock, boundedString, resolveBinding, resolveTypedBinding, resolveEntityVersion } from './block-policy.js';
import {createEntityAtPublication,lockEntities,applyEntityUpdateWithClient,applyEntityArchiveWithClient,applyEntityRelationWithClient,missing,queryEntitiesWithClient,publication} from '../entities/client.js';
import {checkAccess} from '../entities/access.js';
import {EntityError,uuid} from '../entities/policy.js';
import type {Entity} from '../entities/types.js';
import { scheduleTimer } from './timer-database.js';
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
export async function executeBlocks(client: PoolClient, steps: WorkflowStep[], run: WorkflowRun, input: Record<string, string>, actor: WorkflowActor, wait?: WorkflowWaitConfig, definition?:WorkflowDefinition): Promise<void> {
  validateSteps(steps,new Set([...Object.keys(run.data),...Object.keys(definition?.startFields??{}),...Object.keys(definition?.optionalStartFields??{}),...(definition?.transitions??[]).flatMap(t=>[...Object.keys(t.fields),...Object.keys(t.wait?.resultFields??{})])]),new Set([...Object.keys(input),...(definition?.transitions??[]).flatMap(t=>Object.keys(t.fields))]));
  const privateValues=createPrivateValues();
  const results = new Map<string, WorkflowBlockResult>();
  const scope={actorId:actor.subject,organizationId:actor.organizationId};
  const entitySteps=steps.filter((step):step is WorkflowEntityStep=>step.action.startsWith('entities.'));
  for(const step of steps)authorizeBlock(step,actor);
  // Validated result IDs refer only to earlier blocks: existing entity aliases
  // ultimately have a non-result ID here; created IDs belong to this transaction.
  let locked:Map<string,Entity>;
  try {
    const ids:string[]=[];
    for(const step of entitySteps)if('id' in step.input){for(const binding of [step.input.id,...('targetId' in step.input?[step.input.targetId]:[])])if(binding.source!=='result')ids.push(uuid(resolveBinding(binding,run,input,actor,results)));}
    locked=await lockEntities(client,scope,ids);
  }catch(error){if(error instanceof EntityError)throw new WorkflowError(error.statusCode,error.message);throw error;}
  for (const [stepIndex, step] of steps.entries()) {
    authorizeBlock(step, actor);
    const resolve = (binding: Parameters<typeof resolveBinding>[0]) => resolveBinding(binding, run, input, actor, results);
    let resolved: Record<string, unknown>;
    let result: WorkflowBlockResult;
    if(step.action.startsWith('entities.')) {
      const entityStep=step as WorkflowEntityStep;
      const metadata=(row:Entity)=>({id:row.id,version:row.version,schemaVersion:row.schemaVersion});
      const attributes=(values:Record<string,import('@dx/contracts').WorkflowTypedBinding>)=>Object.fromEntries(Object.entries(values).map(([key,binding])=>[key,resolveTypedBinding(binding,run,input,privateValues)]));
      const rowFor=async(binding:import('@dx/contracts').WorkflowBinding):Promise<Entity>=>{const id=uuid(resolve(binding));const row=locked.get(id);if(!row)throw missing();return row;};
      try {
        if(entityStep.action==='entities.query') {
          const config=entityStep.input;
          const page=await queryEntitiesWithClient(client,scope,{schemaId:config.schemaId,schemaVersion:config.schemaVersion,limit:config.limit??50,filters:(config.filters??[]).map(filter=>({field:filter.field,operator:filter.operator,...(filter.value?{value:resolveTypedBinding(filter.value,run,input,privateValues)}:{})}))});
          resolved={schemaId:config.schemaId,schemaVersion:config.schemaVersion,limit:config.limit??50};result={items:page.items.map(metadata),page:page.page};
        } else {
          let row:Entity;
          if(entityStep.action==='entities.create') {row=await createEntityAtPublication(client,scope,{...entityStep.input,title:resolve(entityStep.input.title),attributes:attributes(entityStep.input.attributes)});resolved={schemaId:entityStep.input.schemaId,schemaVersion:entityStep.input.schemaVersion};}
          else {
            const before=await rowFor(entityStep.input.id);resolved={id:before.id};
            if(entityStep.action==='entities.read'||entityStep.action==='entities.project'){await checkAccess(client,scope,before,'read');row=before;if(entityStep.action==='entities.project'){privateValues.projection[step.id]=projectFields(row,await publication(client,scope,row.schemaId,row.schemaVersion),entityStep.input.fields);resolved.fields=entityStep.input.fields;}}
            else {
              const expectedVersion=resolveEntityVersion(entityStep.input.expectedVersion,run,input,results);resolved.expectedVersion=expectedVersion;
              if(entityStep.action==='entities.update')row=await applyEntityUpdateWithClient(client,scope,before,{expectedVersion,title:resolve(entityStep.input.title),attributes:attributes(entityStep.input.attributes)});
              else if(entityStep.action==='entities.archive')row=await applyEntityArchiveWithClient(client,scope,before,expectedVersion);
              else {const target=await rowFor(entityStep.input.targetId);resolved={...resolved,targetId:target.id,name:entityStep.input.name};row=await applyEntityRelationWithClient(client,scope,before,target,{expectedVersion,name:entityStep.input.name,targetId:target.id},entityStep.action==='entities.unlink');}
            }
          }
          locked.set(row.id,row);result={...metadata(row),...(entityStep.action==='entities.project'?{projectedFields:entityStep.input.fields}:{})};
        }
      }catch(error){if(error instanceof EntityError)throw new WorkflowError(error.statusCode,error.message);throw error;}
    } else if(step.action==='data.evaluate'){
      const values=Object.fromEntries(Object.entries(step.input.values).map(([name,expression])=>[name,evaluatePrivateExpression(expression,run,input,privateValues)]));
      privateValues.evaluation[step.id]=values;resolved={evaluatedKeys:Object.keys(values)};result={evaluatedKeys:Object.keys(values)};
    } else if(step.action==='data.assert'){
      const condition=evaluatePrivateExpression(step.input.condition,run,input,privateValues);
      if(condition.type!=='boolean')throw new WorkflowError(400,'Assertion requires a boolean.');
      if(condition.value!==true)throw new WorkflowError(409,'Workflow assertion failed.');
      resolved={};result={asserted:true};
    } else if (step.action === 'records.create') {
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
    } else if (step.action === 'timers.schedule') {
      const snapshot=Object.fromEntries(Object.entries(step.input.input).map(([name,binding])=>[name,resolve(binding)]));
      if(!definition)throw new WorkflowError(400,'Timer definition unavailable.');
      const timer=await scheduleTimer(client,run,step,snapshot,definition);
      resolved={afterSeconds:String(step.input.afterSeconds),serviceId:step.input.serviceId,transitionId:step.input.transitionId,input:snapshot};
      result={id:timer.id};run.waiting=true;
    } else if(step.action==='connectors.dispatch') {
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
    } else throw new WorkflowError(400,'Unknown workflow block.');
    await client.query('INSERT INTO workflow_action_results(run_id,version,step_id,actor_id,action,input,result,step_index) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [run.id, run.version, step.id, actor.subject, step.action, JSON.stringify(resolved), JSON.stringify(result), stepIndex]);
    results.set(step.id, result);
    if (wait && step.id === wait.stepId) {
      await client.query(`INSERT INTO workflow_waits(id,run_id,organization_id,version,kind,assignee_id,connector_id,config,deadline)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()+$9 * interval '1 second')`,
      [result.id ?? result.eventId,run.id,actor.organizationId,run.version,step.action === 'tasks.create' ? 'task' : 'connector',
        resolved.assigneeId ?? null,resolved.connectorId ?? null,JSON.stringify(wait),wait.timeoutSeconds]);
      if(step.action==='connectors.dispatch' && resolved.connectorId==='agent' && resolved.operation==='incident.analyze')await enqueueIncident(client,run,actor,String(result.eventId),wait,{eventType:'connector.dispatch',connectorId:resolved.connectorId,operation:resolved.operation});
      run.waiting = true;
    }
  }
}
