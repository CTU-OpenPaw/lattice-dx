// SPDX-License-Identifier: Apache-2.0
import type { CreateWorkflow, TransitionCommand, WorkflowActor, WorkflowAudit, WorkflowEvent, WorkflowRun } from '@dx/contracts';
import type { FileItem } from '../foundation.js';
export type OutboxJob={id:string;runId:string;organizationId:string;payload:WorkflowEvent;attempts:number;leaseToken:string};
export interface WorkflowJobs {
  claim():Promise<OutboxJob|undefined>;
  succeed(job:OutboxJob):Promise<void>;
  fail(job:OutboxJob,error:string):Promise<void>;
}
export type SyncJob={id:string;status:'pending'|'processing'|'succeeded'|'failed';attempts:number;lastError:string|null};
export interface WorkflowRepository {
  create(input:CreateWorkflow,actor:WorkflowActor,key:string):Promise<WorkflowRun>;
  transition(id:string,input:TransitionCommand,actor:WorkflowActor,key:string):Promise<WorkflowRun>;
  list(actor:WorkflowActor,inbox:boolean):Promise<WorkflowRun[]>;
  get(id:string,actor:WorkflowActor):Promise<WorkflowRun>;
  history(id:string,actor:WorkflowActor):Promise<WorkflowAudit[]>;
  jobs(id:string,actor:WorkflowActor):Promise<SyncJob[]>;
  retryJobs(id:string,actor:WorkflowActor,key:string):Promise<number>;
  registerMember(actor:WorkflowActor):Promise<void>;
  references(actor:WorkflowActor):Promise<{kind:string;id:string;name:string}[]>;
  readSharedFile(id:string,actor:WorkflowActor):Promise<(FileItem&{content:Buffer})|undefined>;
}
