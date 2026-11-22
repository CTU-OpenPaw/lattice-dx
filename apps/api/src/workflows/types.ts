/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CancelWorkflow, TransferWorkflowTask, CreateWorkflow, TransitionCommand, WorkflowActor, WorkflowActionResult, WorkflowAudit, WorkflowEvent, WorkflowRun, WorkflowWait, WorkflowCompletion, WorkflowCompletionReceipt, WorkflowTimer, EntityWorkflowContext } from '@dx/contracts';
import type {PoolClient} from 'pg';
import type { FileItem } from '../foundation.js';
import type { Page, PageQuery } from '../pagination.js';
export type WorkflowQuery=PageQuery & {state?:string;definitionId?:string};
export type OutboxJob={id:string;runId:string;organizationId:string;payload:WorkflowEvent;attempts:number;leaseToken:string};
export interface WorkflowJobs {
  claim():Promise<OutboxJob|undefined>;
  succeed(job:OutboxJob):Promise<void>;
  fail(job:OutboxJob,error:string):Promise<void>;
}
export type SyncJob={id:string;status:'pending'|'processing'|'succeeded'|'failed'|'cancelled';attempts:number;lastError:string|null};
export interface WorkflowRepository {
  entityContext?(id:string,actor:WorkflowActor):Promise<{context:EntityWorkflowContext;current:{id:string;schemaId:string;schemaVersion:number;version:number;archivedAt:string|null}}>;
  listEntityWorkflows?(id:string,actor:WorkflowActor,page:PageQuery):Promise<Page<WorkflowRun>>;
  transitionWithClient?(client:PoolClient,id:string,input:TransitionCommand,actor:WorkflowActor,key:string,internal?:{timerId:string}):Promise<WorkflowRun>;
  tickOne?():Promise<{timerId:string;status:WorkflowTimer['status']}|undefined>;
  listTimers?(id:string,actor:WorkflowActor,page:PageQuery):Promise<Page<WorkflowTimer>>;
  retryTimer?(id:string,timerId:string,expectedVersion:number,actor:WorkflowActor,key:string):Promise<WorkflowTimer>;
  listServices?(actor:WorkflowActor):Promise<{id:string;enabled:boolean}[]>;
  createWithClient?(client:PoolClient,input:CreateWorkflow & {definitionVersion?:number},actor:WorkflowActor,key:string):Promise<WorkflowRun>;
  cancel?(id:string,value:CancelWorkflow,actor:WorkflowActor,key:string):Promise<WorkflowRun>;
  taskTransfer?(id:string,value:TransferWorkflowTask,actor:WorkflowActor,key:string):Promise<WorkflowRun>;
  listWaits?(id:string,actor:WorkflowActor,query:PageQuery):Promise<Page<WorkflowWait>>;
  completeWait?(id:string,value:WorkflowCompletion,actor:WorkflowActor,key:string):Promise<WorkflowCompletionReceipt>;
  expireWaits?():Promise<number>;
  create(input:CreateWorkflow,actor:WorkflowActor,key:string):Promise<WorkflowRun>;
  transition(id:string,input:TransitionCommand,actor:WorkflowActor,key:string):Promise<WorkflowRun>;
  list(actor:WorkflowActor,inbox:boolean):Promise<WorkflowRun[]>;
  listPage?(actor:WorkflowActor,inbox:boolean,query:WorkflowQuery):Promise<Page<WorkflowRun>>;
  get(id:string,actor:WorkflowActor):Promise<WorkflowRun>;
  history(id:string,actor:WorkflowActor):Promise<WorkflowAudit[]>;
  historyPage?(id:string,actor:WorkflowActor,query:PageQuery):Promise<Page<WorkflowAudit>>;
  executions?(id:string,actor:WorkflowActor,query?:PageQuery):Promise<WorkflowActionResult[]>;
  jobs(id:string,actor:WorkflowActor):Promise<SyncJob[]>;
  retryJobs(id:string,actor:WorkflowActor,key:string):Promise<number>;
  registerMember(actor:WorkflowActor):Promise<void>;
  references(actor:WorkflowActor):Promise<{kind:string;id:string;name:string}[]>;
  readSharedFile(id:string,actor:WorkflowActor):Promise<(FileItem&{content?:Buffer})|undefined>;
}
