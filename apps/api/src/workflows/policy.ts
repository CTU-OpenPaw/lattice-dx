// SPDX-License-Identifier: Apache-2.0
import { isRecordId, type WorkflowActor, type WorkflowDefinition, type WorkflowRun, type WorkflowTransition, type WorkflowField, type TransitionCommand, type CreateWorkflow } from '@dx/contracts';
import { conditionMatches } from './completion-policy.js';
export class WorkflowError extends Error {
  constructor(public readonly statusCode:400|403|404|409|503,message:string){super(message);}
}
function object(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value);}
function shape(value:unknown,keys:string[]):value is Record<string,unknown>{return object(value)&&Object.keys(value).every(k=>keys.includes(k));}
function text(value:unknown,max=200):value is string{return typeof value==='string'&&!!value.trim()&&Array.from(value).length<=max;}
function input(value:unknown):value is Record<string,string>{return object(value)&&Object.values(value).every(v=>text(v,2000));}
export function parseEntityContext(value:unknown):{entityId:string}|undefined {
  if(!shape(value,['entityId'])||typeof value.entityId!=='string'||!isRecordId(value.entityId))return;
  return {entityId:value.entityId.toLowerCase()};
}
export function parseCreate(value:unknown):CreateWorkflow|undefined {
  if(!shape(value,['definitionId','title','input','entityContext'])||!text(value.definitionId,80)||!text(value.title)||!input(value.input))return;
  const context=parseEntityContext(value.entityContext);
  if(value.entityContext!==undefined&&!context)return;
  return {definitionId:value.definitionId,title:value.title.trim(),input:value.input,...(context?{entityContext:context}:{})};
}
export function parseCommand(value:unknown):TransitionCommand|undefined {
  if(!shape(value,['action','expectedVersion','input'])||!text(value.action,80)||!Number.isSafeInteger(value.expectedVersion)||Number(value.expectedVersion)<1||!input(value.input))return;
  return {action:value.action,expectedVersion:Number(value.expectedVersion),input:value.input};
}
export function validateInput(fields:Record<string,WorkflowField>,value:Record<string,string>,optional:Record<string,WorkflowField>={}):Record<string,string>{
  if(!shape(value,[...Object.keys(fields),...Object.keys(optional)])||Object.keys(fields).some(k=>!text(value[k],fields[k]==='text'?2000:100)))throw new WorkflowError(400,'Dữ liệu bước không hợp lệ.');
  const result:Record<string,string>={};
  for(const [name,kind] of Object.entries({...fields,...optional})){
    if(value[name]===undefined&&name in optional)continue;
    if(!text(value[name],kind==='text'?2000:100))throw new WorkflowError(400,'Dữ liệu bước không hợp lệ.');
    if(kind==='file'&&!isRecordId(value[name]))throw new WorkflowError(400,'Dữ liệu tệp phải là UUID.');
    if(kind==='positiveInteger'&&(!/^[1-9][0-9]*$/.test(value[name])||Number(value[name])>1_000_000))throw new WorkflowError(400,'Số lượng phải là số nguyên dương ≤ 1000000.');
    result[name]=kind==='text'?value[name].trim():value[name];
  }
  return result;
}
export function canReadRun(def:WorkflowDefinition,run:WorkflowRun,actor:WorkflowActor):boolean {
  const assigned=def.assignedReader;
  return run.organizationId===actor.organizationId&&(run.ownerId===actor.subject||def.readerRoles.some(r=>actor.roles.includes(r))
    ||!!assigned&&assigned.states.includes(run.state)&&actor.roles.includes(assigned.role)&&run.data[assigned.field]===actor.subject);
}
export function canUseEvidence(file:{ownerId:string;organizationId:string;scanStatus:string},actor:WorkflowActor,links:{definition:WorkflowDefinition;run:WorkflowRun}[]):boolean {
  return file.organizationId===actor.organizationId&&file.scanStatus==='clean'
    &&(file.ownerId===actor.subject||links.some(link=>canReadRun(link.definition,link.run,actor)));
}
export function authorizeTransition(transition:WorkflowTransition,run:WorkflowRun,actor:WorkflowActor,service=false){
  if(run.binding&&!run.binding.allowedTransitions.includes(transition.id))throw new WorkflowError(403,'Transition is outside the immutable business binding.');
  if(transition.execution==='service'&&!service)throw new WorkflowError(403,'Service transition requires scheduler authority.');
  if(run.organizationId!==actor.organizationId||!actor.roles.includes(transition.role)||(transition.ownerOnly&&actor.subject!==run.ownerId)
    ||transition.assigneeField&&run.data[transition.assigneeField]!==actor.subject)throw new WorkflowError(403,'Không có quyền thực hiện bước.');
}
export function availableTransitions(def:WorkflowDefinition,run:WorkflowRun,actor:WorkflowActor){
  return def.transitions.filter(t=>(!run.binding||run.binding.allowedTransitions.includes(t.id))&&t.execution!=='service'&&run.status!=='cancelled'&&!run.waiting&&conditionMatches(t.condition,run.data)&&t.from===run.state&&actor.roles.includes(t.role)&&(!t.ownerOnly||actor.subject===run.ownerId)&&(!t.assigneeField||run.data[t.assigneeField]===actor.subject)&&actor.organizationId===run.organizationId);
}
export function planTransition(def:WorkflowDefinition,run:WorkflowRun,actor:WorkflowActor,command:TransitionCommand,service=false){
  const transition=def.transitions.find(t=>t.id===command.action);
  if(!transition)throw new WorkflowError(400,'Bước không tồn tại.');
  authorizeTransition(transition,run,actor,service);
  if(run.status==='cancelled'||run.waiting||!conditionMatches(transition.condition,run.data)||run.state!==transition.from||run.version!==command.expectedVersion)throw new WorkflowError(409,'Trạng thái hoặc phiên bản không phù hợp.');
  return {transition,input:validateInput(transition.fields,command.input)};
}
