/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import {parseCreateKey} from '../create-command.js';
import {uuid} from '../entities/policy.js';
import type {MappingMutation,MappingRemoval} from './types.js';
export class ContextLinksError extends Error {
 constructor(public readonly statusCode:number,public readonly code:string,message:string){super(message);}
}
export function invalid(message='Invalid context mapping request.'):never {throw new ContextLinksError(400,'invalid_request',message);}
export function exact(value:unknown,keys:readonly string[]):Record<string,unknown> {
 if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value))||Object.keys(value).length!==keys.length||keys.some(k=>!Object.hasOwn(value,k)))invalid();
 return value as Record<string,unknown>;
}
export function entityId(value:unknown):string {try{return uuid(value);}catch{return invalid('Entity ID must be a UUID.');}}
export function externalId(value:unknown,organizationId:string):string {
 const prefix=`urn:ngsi-ld:Asset:${organizationId}:`;
 if(!/^[A-Za-z0-9_-]{1,128}$/.test(organizationId)||typeof value!=='string'||!value.startsWith(prefix)||!/^[A-Za-z0-9_-]{1,128}$/.test(value.slice(prefix.length)))invalid('External ID must identify an Asset in the current organization.');
 return value;
}
export function revision(value:unknown):number {
 if(typeof value!=='number'||!Number.isInteger(value)||value<0||value>=2147483647)invalid('Invalid mapping revision.');
 return value;
}
export function commandKey(value:unknown,rawHeaders?:string[]):string {
 try {const key=parseCreateKey(value,rawHeaders);if(key)return key;}catch{}
 return invalid('A single bounded Idempotency-Key is required.');
}
export function parseMutation(value:unknown,org:string,remove:false):MappingMutation;
export function parseMutation(value:unknown,org:string,remove:true):MappingRemoval;
export function parseMutation(value:unknown,org:string,remove:boolean):MappingMutation|MappingRemoval {
 const body=exact(value,remove?['expectedRevision']:['externalId','expectedRevision']);
 return {expectedRevision:revision(body.expectedRevision),...(!remove?{externalId:externalId(body.externalId,org)}:{})};
}
