// SPDX-License-Identifier: Apache-2.0
export type WorkflowActor = { subject: string; organizationId: string; roles: string[] };
export type WorkflowField = 'text' | 'subject' | 'department' | 'location' | 'file' | 'positiveInteger';
export type WorkflowCondition = { field: string; operator: 'eq' | 'gt' | 'exists'; value?: string };
export type WorkflowWaitConfig = { stepId: string; successState: string; failureState: string; resultFields: Record<string, 'text' | 'positiveInteger'>; timeoutSeconds: number };
export type WorkflowCompletion = { status: 'succeeded' | 'failed'; result: Record<string,string>; reason?: string };
export type WorkflowCompletionReceipt = { waitId: string; runId: string; status: 'succeeded' | 'failed' | 'timed_out'; state: string; version: number };
export type WorkflowWait = { id: string; runId: string; version: number; kind: 'task' | 'connector'; status: 'pending' | 'succeeded' | 'failed' | 'timed_out'; config: WorkflowWaitConfig; deadline: string; createdAt: string; completedAt: string | null; evidence?: {result:Record<string,string>;reason:string|null} | null };
export type WorkflowTransition = {
  id: string; from: string; to: string; role: string; ownerOnly?: boolean;
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
export type WorkflowRun = {
  id: string; recordId: string; definitionId: string; definitionVersion: number; title: string;
  ownerId: string; organizationId: string; state: string; version: number; data: Record<string,string>;
  createdAt: string; updatedAt: string;
  taskId?: string;
  waiting?: boolean;
};
export type CreateWorkflow = { definitionId: string; title: string; input: Record<string,string> };
export type TransitionCommand = { action: string; expectedVersion: number; input: Record<string,string> };
export type WorkflowAudit = {id:string;actorId:string;action:string;fromState:string|null;toState:string;version:number;occurredAt:string};
export type WorkflowEvent = {eventId:string;eventType:string;organizationId:string;runId:string;recordId:string;definitionId:string;version:number;occurredAt:string;data:Record<string,string>};

export type WorkflowBinding =
  | { source: 'literal'; value: string }
  | { source: 'data' | 'input'; field: string }
  | { source: 'context'; field: 'recordId' | 'title' | 'ownerId' | 'actorId' }
  | { source: 'result'; stepId: string; field: 'id' };
export type WorkflowConnector = 'n8n' | 'ngsi-ld' | 'agent';
export type WorkflowStep =
  | { id: string; action: 'records.create'; input: { title: WorkflowBinding } }
  | { id: string; action: 'tasks.create'; input: { title: WorkflowBinding; assigneeId?: WorkflowBinding; recordId?: WorkflowBinding }; assignment?: { kind: 'department'; department: WorkflowBinding; role: string; assigneeId?: WorkflowBinding } }
  | { id: string; action: 'connectors.dispatch'; input: { connectorId: { source: 'literal'; value: WorkflowConnector }; operation: { source: 'literal'; value: string }; payload?: Record<string, WorkflowBinding> } };
export type WorkflowActionResult = {
  runId: string; version: number; stepId: string; stepIndex: number; actorId: string; action: WorkflowStep['action'];
  input: Record<string, string | Record<string, string>>; result: { id?: string; eventId?: string }; occurredAt: string;
};
export type WorkflowConnectorEvent = WorkflowEvent & { connectorId: WorkflowConnector; operation: string };
