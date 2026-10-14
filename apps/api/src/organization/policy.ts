// SPDX-License-Identifier: Apache-2.0
import type {DepartmentCreate,DepartmentUpdate,OrganizationActor,SnapshotInput} from './types.js';
import {parseCreateKey} from '../create-command.js';
export class OrganizationError extends Error {constructor(public readonly statusCode:400|403|404|409|503,message:string){super(message);}}
function bad():never{throw new OrganizationError(400,'Invalid organization input.');}
function exact(value:unknown,keys:string[]):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))bad();const o=value as Record<string,unknown>;if(Object.keys(o).some(k=>!keys.includes(k)))bad();return o;}
function text(value:unknown,max:number):string{if(typeof value!=='string'||!value.trim()||Array.from(value.trim()).length>max||/[\u0000-\u001f]/.test(value))bad();return value.trim();}
export function departmentId(value:unknown):string{if(typeof value!=='string'||!/^[a-z][a-z0-9-]{0,63}$/.test(value))bad();return value;}
function nullable(value:unknown,slug=false):string|null{return value===null?null:slug?departmentId(value):text(value,100);}
function revision(value:unknown,min=0):number{if(typeof value!=='number'||!Number.isSafeInteger(value)||value<min)bad();return value;}
function metadata(o:Record<string,unknown>){return {name:text(o.name,200),parentId:nullable(o.parentId,true),managerId:nullable(o.managerId)};}
export function parseDepartmentCreate(value:unknown):DepartmentCreate{const o=exact(value,['id','name','parentId','managerId']);return {id:departmentId(o.id),...metadata(o)};}
export function parseDepartmentUpdate(value:unknown):DepartmentUpdate{const o=exact(value,['expectedVersion','name','parentId','managerId']);return {expectedVersion:revision(o.expectedVersion,1),...metadata(o)};}
export function parseSnapshot(value:unknown):SnapshotInput{const o=exact(value,['expectedRevision','people']);if(Buffer.byteLength(JSON.stringify(value),'utf8')>131072||!Array.isArray(o.people)||o.people.length>200)bad();const seen=new Set<string>();const people=o.people.map(value=>{const p=exact(value,['subject','displayName','departmentId','roles','enabled']);const subject=text(p.subject,100);if(subject!==p.subject||seen.has(subject)||typeof p.enabled!=='boolean'||!Array.isArray(p.roles)||p.roles.length>50)bad();seen.add(subject);const roles=p.roles.map(r=>text(r,100));if(new Set(roles).size!==roles.length)bad();return {subject,displayName:text(p.displayName,200),...(p.departmentId!==undefined?{departmentId:departmentId(p.departmentId)}:{}),roles:roles.sort(),enabled:p.enabled};});return {expectedRevision:revision(o.expectedRevision),people:people.sort((a,b)=>a.subject.localeCompare(b.subject))};}
export function canonicalSnapshot(input:SnapshotInput):string{return JSON.stringify(parseSnapshot(input));}
export function requireManager(actor:OrganizationActor){if(!actor.organizationId||!actor.roles.includes('directory:manage'))throw new OrganizationError(403,'Directory management role required.');}
export function mandatoryKey(value:unknown,rawHeaders?:string[]):string{const key=parseCreateKey(value,rawHeaders);if(!key)bad();return key;}
