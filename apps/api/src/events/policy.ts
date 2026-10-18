// SPDX-License-Identifier: Apache-2.0
import {createHash} from 'node:crypto';
import {WorkflowError} from '../workflows/policy.js';
import {definitionId} from '../workflows/registry.js';
import type {EventBinding,InboundEvent,SubscriptionInput,SubscriptionUpdate} from './types.js';

const unsafe=new Set(['__proto__','constructor','prototype']);
function object(value:unknown):value is Record<string,unknown> {
 return !!value&&typeof value==='object'&&!Array.isArray(value)
  &&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);
}
function exact(value:unknown,keys:string[]):value is Record<string,unknown> {
 return object(value)&&Object.keys(value).every(key=>keys.includes(key));
}
function bounded(value:unknown,max:number,empty=false):value is string {
 return typeof value==='string'&&(empty||value.trim().length>0)&&Array.from(value).length<=max&&!/[\u0000-\u001f\u007f]/.test(value);
}
function field(value:unknown):value is string {
 return bounded(value,80)&&/^[A-Za-z][A-Za-z0-9_-]*$/.test(value)&&!unsafe.has(value);
}
function slug(value:unknown):value is string {
 return bounded(value,100)&&/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value);
}
export function validEventId(value:unknown):value is string {return bounded(value,128);}
export function validSubscriptionId(value:unknown):value is string {return slug(value);}
function utc(value:unknown):value is string {
 if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(value)) return false;
 const date=new Date(value);
 return Number.isFinite(date.getTime())&&date.toISOString().slice(0,19)===value.slice(0,19);
}
export function parseEvent(value:unknown):InboundEvent|undefined {
 if(!exact(value,['eventId','eventType','occurredAt','data'])||!validEventId(value.eventId)||!slug(value.eventType)||!utc(value.occurredAt)||!object(value.data)||Object.keys(value.data).length>50) return;
 if(Object.entries(value.data).some(([key,item])=>!field(key)||typeof item!=='string'||Array.from(item).length>2000))return;
 return value as InboundEvent;
}
function binding(value:unknown,title=false):value is EventBinding {
 if(!object(value))return false;
 if(value.source==='event')return exact(value,['source','field'])&&field(value.field);
 if(value.source==='envelope')return exact(value,['source','field'])&&value.field==='eventId';
 return value.source==='literal'&&exact(value,['source','value'])&&bounded(value.value,title?200:2000,!title);
}
export function parseSubscription(value:unknown,update:true):SubscriptionUpdate|undefined;
export function parseSubscription(value:unknown,update?:false):SubscriptionInput|undefined;
export function parseSubscription(value:unknown,update=false):SubscriptionInput|SubscriptionUpdate|undefined {
 const keys=['id','eventType','sourceSubject','definitionId','definitionVersion','title','input','enabled'];
 if(update)keys.push('expectedRevision');
 if(!exact(value,keys)||!validSubscriptionId(value.id)||!slug(value.eventType)||!bounded(value.sourceSubject,200)||!definitionId(value.definitionId)||!Number.isSafeInteger(value.definitionVersion)||Number(value.definitionVersion)<1||Number(value.definitionVersion)>2147483647||!binding(value.title,true)||!object(value.input)||typeof value.enabled!=='boolean'||Object.keys(value.input).length>50)return;
 if(Object.entries(value.input).some(([key,item])=>!field(key)||!binding(item)))return;
 if(update&&(!Number.isSafeInteger(value.expectedRevision)||Number(value.expectedRevision)<1))return;
 return {...value,id:value.id.toLowerCase()} as SubscriptionInput|SubscriptionUpdate;
}
export function requireReceiver(actor:{roles:string[]}):void {
 if(!actor.roles.includes('workflow:event:receive'))throw new WorkflowError(403,'Event receive role required.');
}
export function requireDesigner(actor:{roles:string[]}):void {
 if(!actor.roles.includes('workflow:design')||!actor.roles.includes('workflow:integrate'))throw new WorkflowError(403,'Workflow design and integrate roles required.');
}
export function canonical(value:unknown):string {
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(object(value))return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
 return JSON.stringify(value);
}
export function canonicalEvent(value:InboundEvent):string {return canonical(value);}
export function eventStartKey(org:string,source:string,eventId:string,subscriptionId:string,revision:number):string {
 return createHash('sha256').update(JSON.stringify([org,source,eventId,subscriptionId,revision])).digest('hex');
}
export function resolveBinding(value:EventBinding,data:Record<string,string>,envelope?:Pick<InboundEvent,'eventId'>):string {
 if(value.source==='literal')return value.value;
 if(value.source==='envelope'){
  if(!envelope)throw new WorkflowError(400,'Event envelope is required.');
  return envelope.eventId;
 }
 if(!Object.hasOwn(data,value.field))throw new WorkflowError(400,'Mapped event field is missing.');
 return data[value.field];
}
