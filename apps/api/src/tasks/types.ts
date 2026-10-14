// SPDX-License-Identifier: Apache-2.0
import type { Task,Scope } from '../foundation.js';
import type { Page,PageQuery } from '../pagination.js';
export type TaskLifecycleActor=Scope;
export type QueueInput={title:string;departmentId:string;recordId?:string;dueAt?:string};
export type MutationOperation='claim'|'reassign'|'cancel'|'deadline';
export type MutationInput={expectedVersion:number;assigneeId?:string;reason?:string;dueAt?:string|null};
export type TaskHistory={id:string;taskId:string;actorId:string;operation:string;fromVersion:number;toVersion:number;occurredAt:string};
export interface TaskLifecycleRepository {
 createQueue(actor:Scope,input:QueueInput,key:string):Promise<Task>;
 queue(actor:Scope,query:PageQuery):Promise<Page<Task>>;
 claim(id:string,actor:Scope,input:MutationInput,key:string):Promise<Task>;
 reassign(id:string,actor:Scope,input:MutationInput,key:string):Promise<Task>;
 cancel(id:string,actor:Scope,input:MutationInput,key:string):Promise<Task>;
 setDeadline(id:string,actor:Scope,input:MutationInput,key:string):Promise<Task>;
 history(id:string,actor:Scope,query:PageQuery):Promise<Page<TaskHistory>>;
}
export class TaskLifecycleError extends Error {constructor(public readonly statusCode:400|404|409|503,message:string){super(message);}}
