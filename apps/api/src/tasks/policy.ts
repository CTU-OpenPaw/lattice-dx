// SPDX-License-Identifier: Apache-2.0
import { isRecordId,parseRecordCreateInput } from '@dx/contracts';
import type { Task,Scope } from '../foundation.js';
import { TaskLifecycleError,type MutationOperation,type MutationInput,type QueueInput } from './types.js';
const bad=()=>new TaskLifecycleError(400,'Input task lifecycle không hợp lệ.');
function object(value:unknown,allowed:string[]):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!allowed.includes(k)))throw bad();
 return value as Record<string,unknown>;
}
export function principal(value:unknown):string {
 if(typeof value!=='string'||!value.trim()||value!==value.trim()||[...value].length>100||/[\x00-\x1f\x7f]/.test(value))throw bad();return value;
}
export function taskId(value:unknown):string{if(typeof value!=='string'||!isRecordId(value))throw bad();return value.toLowerCase();}
export function normalizeDueAt(value:unknown,now?:number):string {
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value))throw bad();
 const date=new Date(value),time=date.getTime();
 if(!Number.isFinite(time)||date.toISOString().slice(0,19)!==value.slice(0,19))throw bad();
 if(now!==undefined&&(time<=now||time>now+366*86400000))throw bad();
 return date.toISOString();
}
export function parseQueueInput(value:unknown):QueueInput{
 const i=object(value,['title','departmentId','recordId','dueAt']);
 const title=parseRecordCreateInput({title:i.title});if(!title)throw bad();
 return {title:title.title,departmentId:principal(i.departmentId),...(i.recordId!==undefined?{recordId:taskId(i.recordId)}:{}),...(i.dueAt!==undefined?{dueAt:normalizeDueAt(i.dueAt)}:{})};
}
export function parseMutation(operation:MutationOperation,value:unknown):MutationInput{
 const i=object(value,operation==='claim'?['expectedVersion']:operation==='reassign'?['expectedVersion','assigneeId','reason']:operation==='cancel'?['expectedVersion','reason']:['expectedVersion','dueAt']);
 if(!Number.isSafeInteger(i.expectedVersion)||Number(i.expectedVersion)<1)throw bad();
 const result:MutationInput={expectedVersion:Number(i.expectedVersion)};
 if(operation==='reassign')result.assigneeId=principal(i.assigneeId);
 if(operation==='reassign'||operation==='cancel'){
  if(typeof i.reason!=='string'||!i.reason.trim()||[...i.reason.trim()].length>500)throw bad();result.reason=i.reason.trim();
 }
 if(operation==='deadline'){if(i.dueAt===undefined)throw bad();result.dueAt=i.dueAt===null?null:normalizeDueAt(i.dueAt);}
 return result;
}
export function assertAuthority(task:Task|undefined,actor:Scope,operation:MutationOperation,member:boolean):asserts task is Task{
 if(!task||task.organizationId!==actor.organizationId||(operation==='claim'?!(task.assigneeId===actor.subject||(task.assigneeId===''&&member)):task.createdBy!==actor.subject))throw new TaskLifecycleError(404,'Không tìm thấy task trong phạm vi được phép.');
}
export function assertWorkflow(linked:boolean){if(linked)throw new TaskLifecycleError(409,'Task liên kết workflow không hỗ trợ lifecycle chung.');}
