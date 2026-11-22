/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import type {WorkflowActor,WorkflowDefinition,WorkflowField} from '@dx/contracts';
import {entityEventOperations} from '../entities/events.js';
import {definitionId} from '../workflows/registry.js';
import {validateInput,WorkflowError} from '../workflows/policy.js';
import {authorizeBlock} from '../workflows/block-policy.js';
import {TimerError} from '../workflows/timer-policy.js';
import type {AutomationBinding,AutomationRuleInput} from './types.js';
export class AutomationError extends WorkflowError{constructor(public readonly code:string,status:400|403|404|409|503=409){super(status,code);}}
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&(Object.getPrototypeOf(v)===Object.prototype||Object.getPrototypeOf(v)===null);
const positive=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>0&&Number(v)<=2147483647;
function fail():never{throw new AutomationError('validation_failed',400);}
function binding(v:unknown,title=false):v is AutomationBinding{
 if(!object(v))return false;
 if(v.source==='literal')return Object.keys(v).length===2&&typeof v.value==='string'&&!!v.value.trim()&&Array.from(v.value).length<=(title?200:2000);
 return v.source==='event'&&Object.keys(v).length===2&&typeof v.field==='string'&&(title?['entityId','operation']:['entityId','schemaId','schemaVersion','entityVersion','eventId','operation']).includes(v.field);
}
export function parseRule(value:unknown,update=false):AutomationRuleInput&{expectedRevision?:number}{
 const keys=['id','schemaId','schemaVersion','operations','serviceId','definitionId','definitionVersion','title','input','transitionId','enabled',...(update?['expectedRevision']:[])];
 if(!object(value)||Object.keys(value).some(k=>!keys.includes(k))||!definitionId(value.id)||!definitionId(value.schemaId)||!definitionId(value.serviceId)||!definitionId(value.definitionId)||!positive(value.schemaVersion)||!positive(value.definitionVersion)||typeof value.enabled!=='boolean'||!binding(value.title,true)||!object(value.input)||Object.keys(value.input).length>20||Object.entries(value.input).some(([k,v])=>! /^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(k)||['constructor','prototype','__proto__'].includes(k)||!binding(v))||!Array.isArray(value.operations)||!value.operations.length||value.operations.length>10||new Set(value.operations).size!==value.operations.length||value.operations.some(v=>!(entityEventOperations as readonly unknown[]).includes(v))||value.transitionId!==undefined&&(typeof value.transitionId!=='string'||! /^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(value.transitionId))||update&&!positive(value.expectedRevision))fail();
 return JSON.parse(JSON.stringify(value));
}
export function requireConfiguration(actor:WorkflowActor){if(!actor.organizationId||!['workflow:design','data:automate'].every(r=>actor.roles.includes(r)))throw new AutomationError('authority_denied',403);}
export function requireKey(key:unknown):asserts key is string{if(typeof key!=='string'||! /^[A-Za-z0-9._:-]{1,128}$/.test(key))fail();}
const safeInitialActions=new Set(['entities.create','entities.query','records.create','tasks.create','connectors.dispatch','timers.schedule']);
export function validateRuleDefinition(rule:AutomationRuleInput,definition:WorkflowDefinition,actor:WorkflowActor):void{
 if(definition.id!==rule.definitionId||definition.version!==rule.definitionVersion)throw new AutomationError('definition_unavailable',409);
 if(!['workflow:service','workflow:start','data:read',definition.startRole].every(r=>actor.roles.includes(r)))throw new AutomationError('authority_denied',403);
 const fields={...definition.startFields,...definition.optionalStartFields};
 if(Object.keys(definition.startFields).some(k=>!Object.hasOwn(rule.input,k))||Object.keys(rule.input).some(k=>!Object.hasOwn(fields,k)))fail();
 for(const [name,map] of Object.entries(rule.input)){
  const kind=fields[name];
  if(map.source==='literal')validateInput({[name]:kind},{[name]:map.value});
  else{const eventKind:WorkflowField=['schemaVersion','entityVersion'].includes(map.field)?'positiveInteger':'text';if(kind!==eventKind&&!(kind==='file'&&['entityId','eventId'].includes(map.field))&&kind!=='text')fail();}
 }
 if(rule.transitionId){const transition=definition.transitions.find(t=>t.id===rule.transitionId);
  if(!transition||transition.from!==definition.initialState||transition.execution==='service'||Object.keys(transition.fields).length||transition.assigneeField||(transition.steps??[]).some(step=>!safeInitialActions.has(step.action)))fail();
  if(!actor.roles.includes(transition.role))throw new AutomationError('authority_denied',403);
  for(const step of transition.steps??[])authorizeBlock(step,actor);
 }
}
export function classifyAutomationError(error:unknown):{code:string;transient:boolean}{
 if(error instanceof AutomationError||error instanceof TimerError)return {code:error.code,transient:false};
 if(error instanceof WorkflowError)return {code:({400:'validation_failed',403:'authority_denied',404:'entity_unavailable',409:'state_conflict',503:'definition_unavailable'} as const)[error.statusCode],transient:false};
 if(['40001','40P01','55P03','57014','53300','57P03'].includes((error as {code?:string})?.code??''))return {code:'database_transient',transient:true};
 return {code:'internal_error',transient:true};
}
