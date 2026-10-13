// SPDX-License-Identifier: Apache-2.0
export type WorkflowActor = { subject: string; organizationId: string; roles: string[] };
export type WorkflowField = 'text' | 'subject' | 'department' | 'location' | 'file' | 'positiveInteger';
export type WorkflowTransition = {
  id: string; from: string; to: string; role: string; ownerOnly?: boolean;
  fields: Record<string, WorkflowField>; eventType?: string;
  assigneeField?: string; task?: 'assign' | 'complete';
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
};
export type CreateWorkflow = { definitionId: string; title: string; input: Record<string,string> };
export type TransitionCommand = { action: string; expectedVersion: number; input: Record<string,string> };
export type WorkflowAudit = {id:string;actorId:string;action:string;fromState:string|null;toState:string;version:number;occurredAt:string};
export type WorkflowEvent = {eventId:string;eventType:string;organizationId:string;runId:string;recordId:string;definitionId:string;version:number;occurredAt:string;data:Record<string,string>};
