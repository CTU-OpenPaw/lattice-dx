/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import type {Expression} from './expressions.js';
export type WorkflowActor = { subject: string; organizationId: string; roles: string[] };
export type WorkflowField = 'text' | 'subject' | 'department' | 'location' | 'file' | 'positiveInteger';
export type WorkflowCondition = { field: string; operator: 'eq' | 'gt' | 'exists'; value?: string } | {all: WorkflowCondition[]} | {any: WorkflowCondition[]};
export type WorkflowWaitConfig = { stepId: string; successState: string; failureState: string; resultFields: Record<string, 'text' | 'positiveInteger'>; timeoutSeconds: number };
export type WorkflowCompletion = { status: 'succeeded' | 'failed'; result: Record<string,string>; reason?: string };
export type WorkflowCompletionReceipt = { waitId: string; runId: string; status: 'succeeded' | 'failed' | 'timed_out'; state: string; version: number };
export type WorkflowWait = { id: string; runId: string; version: number; kind: 'task' | 'connector'; status: 'pending' | 'succeeded' | 'failed' | 'timed_out' | 'cancelled'; config: WorkflowWaitConfig; deadline: string; createdAt: string; completedAt: string | null; evidence?: {result:Record<string,string>;reason:string|null} | null };
export type WorkflowTransition = {
  id: string; from: string; to: string; role: string; execution?: 'interactive' | 'service'; ownerOnly?: boolean;
  fields: Record<string, WorkflowField>; eventType?: string;
  assigneeField?: string; task?: 'assign' | 'complete'; steps?: WorkflowStep[];
  condition?: WorkflowCondition; wait?: WorkflowWaitConfig;
};
export type WorkflowDefinition = {
  id: string; version: number; title: string; startRole: string; initialState: string;
  startFields: Record<string, WorkflowField>; readerRoles: string[]; transitions: WorkflowTransition[];
  optionalStartFields?: Record<string, WorkflowField>;
  assignedReader?: { field: string; role: string; states: string[] };
};
export type EntityWorkflowContext = {entityId:string;schemaId:string;schemaVersion:number;entityVersion:number};
export type WorkflowBusinessBinding = {moduleId:string;moduleVersion:string;bindingId:string;allowedTransitions:string[]};
export type WorkflowRun = {
  binding?:WorkflowBusinessBinding;
  entityContext?:EntityWorkflowContext;
  id: string; recordId: string; definitionId: string; definitionVersion: number; title: string;
  ownerId: string; organizationId: string; state: string; version: number; data: Record<string,string>;
  createdAt: string; updatedAt: string;
  status?: 'active' | 'cancelled';
  cancellation?: {actorId:string;reason:string;at:string} | null;
  taskId?: string;
  waiting?: boolean;
};
export type CreateWorkflow = { definitionId: string; title: string; input: Record<string,string>; entityContext?:{entityId:string} };
export type TransitionCommand = { action: string; expectedVersion: number; input: Record<string,string> };
export type WorkflowAudit = {id:string;actorId:string;action:string;fromState:string|null;toState:string;version:number;occurredAt:string;metadata?:Record<string,unknown>|null};
export type WorkflowEvent = {eventId:string;eventType:string;organizationId:string;runId:string;recordId:string;definitionId:string;version:number;occurredAt:string;data:Record<string,string>};

export type WorkflowBinding =
  | { source: 'literal'; value: string }
  | { source: 'data' | 'input'; field: string }
  | { source: 'context'; field: 'recordId' | 'title' | 'ownerId' | 'actorId' }
  | { source: 'result'; stepId: string; field: 'id' };
export type WorkflowConnector = 'n8n' | 'ngsi-ld' | 'agent';
export type WorkflowTypedBinding = {source:'expression';expression:Expression} | {source:'literal';value:string|number|boolean} | {source:'data'|'input';field:string;as:'text'|'integer'|'decimal'|'boolean'|'date'|'enum'};
export type WorkflowEntityVersion = number | {source:'result';stepId:string;field:'version'} | {source:'data'|'input';field:string;as:'integer'};
export type WorkflowEntityMetadata = {id:string;version:number;schemaVersion:number};
export type WorkflowBlockResult = {id?:string;eventId?:string;version?:number;schemaVersion?:number;items?:WorkflowEntityMetadata[];projectedFields?:string[];evaluatedKeys?:string[];asserted?:true;page?:{limit:number;offset:number;hasMore:boolean;nextOffset:number|null}};
export type WorkflowEntityStep =
  | {id:string;action:'entities.create';input:{schemaId:string;schemaVersion:number;title:WorkflowBinding;attributes:Record<string,WorkflowTypedBinding>}}
  | {id:string;action:'entities.project';input:{id:WorkflowBinding;fields:string[]}}
  | {id:string;action:'entities.read';input:{id:WorkflowBinding}}
  | {id:string;action:'entities.query';input:{schemaId:string;schemaVersion:number;filters?:{field:string;operator:'eq'|'ne'|'gt'|'gte'|'lt'|'lte'|'contains'|'exists';value?:WorkflowTypedBinding}[];limit?:number}}
  | {id:string;action:'entities.update';input:{id:WorkflowBinding;expectedVersion:WorkflowEntityVersion;title:WorkflowBinding;attributes:Record<string,WorkflowTypedBinding>}}
  | {id:string;action:'entities.archive';input:{id:WorkflowBinding;expectedVersion:WorkflowEntityVersion}}
  | {id:string;action:'entities.link'|'entities.unlink';input:{id:WorkflowBinding;targetId:WorkflowBinding;name:string;expectedVersion:WorkflowEntityVersion}};
export type WorkflowTimer = {id:string;runId:string;definitionId:string;definitionVersion:number;runVersion:number;stepId:string;serviceId:string;transitionId:string;status:'pending'|'succeeded'|'failed'|'cancelled';attempts:number;lastErrorCode:string|null;dueAt:string;availableAt:string;createdAt:string;completedAt:string|null;receipt:WorkflowRun|null};
export type WorkflowStep =
  | WorkflowEntityStep
  | {id:string;action:'data.evaluate';input:{values:Record<string,Expression>}}
  | {id:string;action:'data.assert';input:{condition:Expression}}
  | {id:string;action:'timers.schedule';input:{afterSeconds:number;serviceId:string;transitionId:string;input:Record<string,WorkflowBinding>}}
  | { id: string; action: 'records.create'; input: { title: WorkflowBinding } }
  | { id: string; action: 'tasks.create'; input: { title: WorkflowBinding; assigneeId?: WorkflowBinding; recordId?: WorkflowBinding }; assignment?: { kind: 'department'; department: WorkflowBinding; role: string; assigneeId?: WorkflowBinding } }
  | { id: string; action: 'connectors.dispatch'; input: { connectorId: { source: 'literal'; value: WorkflowConnector }; operation: { source: 'literal'; value: string }; payload?: Record<string, WorkflowBinding> } };
export type WorkflowActionResult = {
  runId: string; version: number; stepId: string; stepIndex: number; actorId: string; action: WorkflowStep['action'];
  input: Record<string, unknown>; result: WorkflowBlockResult; occurredAt: string;
};
export type WorkflowConnectorEvent = WorkflowEvent & { connectorId: WorkflowConnector; operation: string };

export type CancelWorkflow = {expectedVersion:number;reason:string};
export type TransferWorkflowTask = CancelWorkflow & {taskId:string;assigneeId:string};
