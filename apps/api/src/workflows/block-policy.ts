/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import type { WorkflowActor, WorkflowBinding, WorkflowRun, WorkflowStep, WorkflowTypedBinding, WorkflowEntityVersion, WorkflowBlockResult } from '@dx/contracts';
import {name as entityName,slug,version,validateAttributes,EntityError} from '../entities/policy.js';
import { WorkflowError } from './policy.js';
import {validateExpression} from './expression-policy.js';
import {evaluatePrivateExpression,type PrivateValues} from './private-blocks.js';
const unsafe = new Set(['__proto__', 'prototype', 'constructor']);
export function safeBlockName(value: unknown, role = false): value is string {
  return typeof value === 'string' && value.length <= 80 && !unsafe.has(value)
    && (role ? /^[a-zA-Z][a-zA-Z0-9_.:-]*$/ : /^[a-zA-Z][a-zA-Z0-9_-]*$/).test(value);
}
function fail(): never {
  throw new WorkflowError(400, 'Cấu hình block không hợp lệ.');
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function keys(value: unknown, allowed: string[]): asserts value is Record<string, unknown> {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) fail();
}
export function boundedString(value: unknown, max = 4000): value is string {
  return typeof value === 'string' && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
}
export function validateSteps(value: unknown, dataFields: Set<string>, inputFields: Set<string>): asserts value is WorkflowStep[] {
  try {
    validateStepConfiguration(value,dataFields,inputFields);
  } catch(error) {
    if(error instanceof EntityError)throw new WorkflowError(error.statusCode,error.message);
    throw error;
  }
}
function validateStepConfiguration(value: unknown, dataFields: Set<string>, inputFields: Set<string>): asserts value is WorkflowStep[] {
  if (!Array.isArray(value) || value.length > 10) fail();
  const earlier = new Map<string, string>();
  const projection:Record<string,Set<string>>=Object.create(null),evaluation:Record<string,Set<string>>=Object.create(null);
  const expression=(value:unknown)=>validateExpression(value,{data:dataFields,input:inputFields,projection,evaluation});
  function binding(value: unknown) {
    if (!object(value)) fail();
    switch (value.source) {
      case 'literal':
        keys(value, ['source', 'value']);
        if (!boundedString(value.value)) fail();
        break;
      case 'data': case 'input':
        keys(value, ['source', 'field']);
        if (!safeBlockName(value.field) || !(value.source === 'data' ? dataFields : inputFields).has(value.field)) fail();
        break;
      case 'context':
        keys(value, ['source', 'field']);
        if (!['recordId', 'title', 'ownerId', 'actorId'].includes(value.field as string)) fail();
        break;
      case 'result':
        keys(value, ['source', 'stepId', 'field']);
        if (value.field !== 'id' || !['records.create', 'tasks.create','entities.create','entities.read','entities.project','entities.update','entities.archive','entities.link','entities.unlink'].includes(earlier.get(value.stepId as string) ?? '')) fail();
        break;
      default: fail();
    }
  }
  function typed(value:unknown) {
    if (!object(value)) fail();
    if(value.source==='expression'){keys(value,['source','expression']);expression(value.expression);}
    else if(value.source==='literal') {keys(value,['source','value']);if(!['string','number','boolean'].includes(typeof value.value)||typeof value.value==='number'&&!Number.isFinite(value.value)||typeof value.value==='string'&&!boundedString(value.value))fail();}
    else {keys(value,['source','field','as']);if(!['data','input'].includes(value.source as string)||!safeBlockName(value.field)||!(value.source==='data'?dataFields:inputFields).has(value.field)||!['text','integer','decimal','boolean','date','enum'].includes(value.as as string))fail();}
  }
  function attributes(value:unknown) {if(!object(value)||Object.keys(value).length>50)fail();for(const [key,item] of Object.entries(value)){entityName(key);typed(item);}}
  function expected(value:unknown) {
    if(typeof value==='number'){version(value);return;}
    if(!object(value))fail();
    if(value.source==='result'){keys(value,['source','stepId','field']);if(value.field!=='version'||!earlier.get(value.stepId as string)?.startsWith('entities.')||earlier.get(value.stepId as string)==='entities.query')fail();}
    else {if(!['data','input'].includes(value.source as string))fail();typed(value);if(value.as!=='integer')fail();}
  }
  for (const step of value) {
    keys(step, ['id', 'action', 'input', 'assignment']);
    if (!safeBlockName(step.id) || earlier.has(step.id)) fail();
    if (typeof step.action==='string'&&step.action.startsWith('entities.')) {
      if(step.assignment!==undefined)fail();
      const allowed:Record<string,string[]>={'entities.create':['schemaId','schemaVersion','title','attributes'],'entities.read':['id'],'entities.project':['id','fields'],'entities.query':['schemaId','schemaVersion','filters','limit'],'entities.update':['id','expectedVersion','title','attributes'],'entities.archive':['id','expectedVersion'],'entities.link':['id','targetId','name','expectedVersion'],'entities.unlink':['id','targetId','name','expectedVersion']};
      if(!allowed[step.action])fail();keys(step.input,allowed[step.action]);
      const item=step.input;
      if(['entities.create','entities.query'].includes(step.action)){slug(item.schemaId);if(version(item.schemaVersion)>2147483647)fail();}
      if(['entities.create','entities.update'].includes(step.action)){binding(item.title);attributes(item.attributes);}
      if(!['entities.create','entities.query'].includes(step.action))binding(item.id);
      if(['entities.update','entities.archive','entities.link','entities.unlink'].includes(step.action))expected(item.expectedVersion);
      if(['entities.link','entities.unlink'].includes(step.action)){entityName(item.name);binding(item.targetId);}
      if(step.action==='entities.project'){if(!Array.isArray(item.fields)||item.fields.length<1||item.fields.length>20||new Set(item.fields).size!==item.fields.length)fail();for(const field of item.fields)entityName(field);projection[step.id]=new Set(item.fields as string[]);}
      if(step.action==='entities.query'){
        if(item.limit!==undefined&&(!Number.isSafeInteger(item.limit)||Number(item.limit)<1||Number(item.limit)>100))fail();
        if(item.filters!==undefined){if(!Array.isArray(item.filters)||item.filters.length>10)fail();for(const filter of item.filters){keys(filter,['field','operator','value']);entityName(filter.field);if(!['eq','ne','gt','gte','lt','lte','contains','exists'].includes(filter.operator as string))fail();if(filter.operator==='exists'){if(Object.hasOwn(filter,'value'))fail();}else typed(filter.value);}}
      }
    } else if(step.action==='data.evaluate'||step.action==='data.assert'){
      if(step.assignment!==undefined)fail();
      keys(step.input,step.action==='data.evaluate'?['values']:['condition']);
      if(step.action==='data.assert')expression(step.input.condition);
      else {const values=step.input.values;if(!object(values)||Object.keys(values).length<1||Object.keys(values).length>20)fail();for(const [name,value] of Object.entries(values)){if(!safeBlockName(name))fail();expression(value);}evaluation[step.id]=new Set(Object.keys(values));}
    } else if (step.action === 'records.create') {
      if (step.assignment !== undefined) fail();
      keys(step.input, ['title']);
      binding(step.input.title);
    } else if (step.action === 'tasks.create') {
      keys(step.input, ['title', 'assigneeId', 'recordId']);
      binding(step.input.title);
      if (step.input.recordId !== undefined) binding(step.input.recordId);
      if (step.assignment !== undefined) {
        if (step.input.assigneeId !== undefined) fail();
        keys(step.assignment, ['kind', 'department', 'role', 'assigneeId']);
        if (step.assignment.kind !== 'department' || !safeBlockName(step.assignment.role, true)) fail();
        binding(step.assignment.department);
        if (step.assignment.assigneeId !== undefined) binding(step.assignment.assigneeId);
      } else binding(step.input.assigneeId);
    } else if (step.action === 'connectors.dispatch') {
      if (step.assignment !== undefined) fail();
      keys(step.input, ['connectorId', 'operation', 'payload']);
      binding(step.input.connectorId);
      binding(step.input.operation);
      const connector = step.input.connectorId as Record<string, unknown>;
      const operation = step.input.operation as Record<string, unknown>;
      if (connector.source !== 'literal' || !['n8n', 'ngsi-ld', 'agent'].includes(connector.value as string)
        || operation.source !== 'literal' || !safeBlockName(operation.value, true)) fail();
      if (step.input.payload !== undefined) {
        if (!object(step.input.payload) || Object.keys(step.input.payload).length > 50) fail();
        for (const [name, value] of Object.entries(step.input.payload)) {
          if (!safeBlockName(name)) fail();
          binding(value);
        }
      }
    } else if (step.action === 'timers.schedule') {
      if (step.assignment !== undefined || step !== value.at(-1)) fail();
      keys(step.input, ['afterSeconds','serviceId','transitionId','input']);
      if (!Number.isSafeInteger(step.input.afterSeconds) || Number(step.input.afterSeconds)<1 || Number(step.input.afterSeconds)>604800 || typeof step.input.serviceId !== 'string' || step.input.serviceId.length>64 || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(step.input.serviceId) || !safeBlockName(step.input.transitionId)) fail();
      if (!object(step.input.input) || Object.keys(step.input.input).length>50) fail();
      for (const [name,value] of Object.entries(step.input.input)) {if (!safeBlockName(name)) fail();binding(value);}
    } else fail();
    earlier.set(step.id, step.action);
  }
}
export function authorizeBlock(step: WorkflowStep, actor: WorkflowActor) {
  const role = blockRole(step.action);
  if (!actor.roles.includes(role)) throw new WorkflowError(403, 'Không có quyền thực hiện block.');
}
export function blockRole(action:WorkflowStep['action']):string {return action.startsWith('data.')?'data:read':action.startsWith('entities.')?(['entities.read','entities.query','entities.project'].includes(action)?'data:read':'data:write'):({'records.create':'records:write','tasks.create':'tasks:assign','connectors.dispatch':'workflow:integrate','timers.schedule':'workflow:schedule'} as Record<string,string>)[action]!;}
export function resolveTypedBinding(binding:WorkflowTypedBinding,run:WorkflowRun,input:Record<string,string>,privateValues?:PrivateValues):string|number|boolean {
  if(binding.source==='expression'){const value=evaluatePrivateExpression(binding.expression,run,input,privateValues);if(value.type==='null')fail();return value.value as string|number|boolean;}
  if(binding.source==='literal')return binding.value;
  const source=binding.source==='data'?run.data:input;
  const value=Object.hasOwn(source,binding.field)?source[binding.field]:undefined;
  if(!boundedString(value))fail();
  if(binding.as==='integer'){if(!/^-?(0|[1-9]\d*)$/.test(value)||!Number.isSafeInteger(Number(value))||value==='-0')fail();return Number(value);}
  if(binding.as==='boolean'){if(value!=='true'&&value!=='false')fail();return value==='true';}
  if(binding.as==='decimal'||binding.as==='date')validateAttributes({id:'binding',title:'Binding',relations:{},fields:{value:{type:binding.as}}},{value});
  return value;
}
export function resolveEntityVersion(binding:WorkflowEntityVersion,run:WorkflowRun,input:Record<string,string>,results:Map<string,WorkflowBlockResult>):number {
  return version(typeof binding==='number'?binding:binding.source==='result'?results.get(binding.stepId)?.version:resolveTypedBinding(binding,run,input));
}
export function resolveBinding(binding: WorkflowBinding, run: WorkflowRun, input: Record<string, string>, actor: WorkflowActor, results: Map<string, { id?: string }>): string {
  let value: unknown;
  switch (binding.source) {
    case 'literal': value = binding.value; break;
    case 'data': value = Object.hasOwn(run.data, binding.field) ? run.data[binding.field] : undefined; break;
    case 'input': value = Object.hasOwn(input, binding.field) ? input[binding.field] : undefined; break;
    case 'context': value = binding.field === 'actorId' ? actor.subject : run[binding.field]; break;
    case 'result': value = results.get(binding.stepId)?.id; break;
  }
  if (!boundedString(value)) throw new WorkflowError(400, 'Giá trị binding không khả dụng.');
  return value;
}
