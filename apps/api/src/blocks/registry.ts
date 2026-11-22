/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import {bad,EntityError,exact,name,object,slug,title,uuid,version} from '../entities/policy.js';
import {parseEntityQuery} from '../entities/query.js';
import type {Attributes,EntityRepository,Scope} from '../entities/types.js';
import type {BlockDescriptor} from './types.js';
const positive={type:'integer',minimum:1,maximum:Number.MAX_SAFE_INTEGER};
const id={type:'string',format:'uuid',pattern:'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'};
const schemaId={type:'string',pattern:'^[a-z][a-z0-9-]{0,63}$',maxLength:64};
const fieldName={type:'string',pattern:'^[A-Za-z][A-Za-z0-9_]{0,63}$',maxLength:64};
const scalar={oneOf:[{type:'string',maxLength:16384},{type:'number'},{type:'boolean'}]};
const attributes={type:'object',maxProperties:50,propertyNames:fieldName,additionalProperties:scalar};
const entityTitle={type:'string',minLength:1,maxLength:200};
function shape(properties:Record<string,unknown>,required=Object.keys(properties)):Record<string,unknown>{return {type:'object',properties,required,additionalProperties:false};}
const entitySchema=shape({id,schemaId,schemaVersion:positive,title:entityTitle,attributes,ownerId:{type:'string'},organizationId:{type:'string'},version:positive,archivedAt:{anyOf:[{type:'string',format:'date-time'},{type:'null'}]},createdAt:{type:'string',format:'date-time'},updatedAt:{type:'string',format:'date-time'}});
const pageSchema=shape({items:{type:'array',items:entitySchema,maxItems:100},page:shape({limit:{type:'integer',minimum:1,maximum:100},offset:{type:'integer',minimum:0,maximum:Number.MAX_SAFE_INTEGER-101},hasMore:{type:'boolean'},nextOffset:{anyOf:[{type:'integer',minimum:0,maximum:Number.MAX_SAFE_INTEGER},{type:'null'}]}})});
const filterSchema={oneOf:[shape({field:fieldName,operator:{const:'exists'}}),shape({field:fieldName,operator:{enum:['eq','ne','gt','gte','lt','lte','contains']},value:scalar})]};
const querySchema=shape({schemaId,schemaVersion:{type:'integer',minimum:1,maximum:2147483647},filters:{type:'array',maxItems:10,items:filterSchema},sort:shape({field:fieldName,direction:{enum:['asc','desc']}}),limit:{type:'integer',minimum:1,maximum:100,default:50},offset:{type:'integer',minimum:0,maximum:Number.MAX_SAFE_INTEGER-101,default:0}},['schemaId','schemaVersion']);
const inputs={
 create:shape({schemaId,schemaVersion:{type:'integer',minimum:1,maximum:2147483647},title:entityTitle,attributes},['schemaId','title','attributes']),read:shape({id}),query:querySchema,
 update:shape({id,expectedVersion:positive,title:entityTitle,attributes}),archive:shape({id,expectedVersion:positive}),
 link:shape({id,expectedVersion:positive,name:fieldName,targetId:id}),unlink:shape({id,expectedVersion:positive,name:fieldName,targetId:id}),
};
function freeze<T>(value:T):T{if(value&&typeof value==='object'){for(const nested of Object.values(value))freeze(nested);Object.freeze(value);}return value;}
export const blockCatalog:readonly BlockDescriptor[]=freeze(Object.entries(inputs).map(([operation,inputSchema])=>({id:`entities.${operation}`,version:1 as const,title:`${operation[0].toUpperCase()}${operation.slice(1)} entities`,requiredRole:operation==='read'||operation==='query'?'data:read' as const:'data:write' as const,inputSchema,outputSchema:operation==='query'?pageSchema:entitySchema,mutation:operation!=='read'&&operation!=='query'})));
export function findBlock(id:string):BlockDescriptor|undefined{return blockCatalog.find(block=>block.id===id);}
export async function runBlock(block:BlockDescriptor,repository:EntityRepository,scope:Scope,input:unknown,key:string|undefined):Promise<unknown>{
 if(block.mutation&&!key)bad('Idempotency-Key is required.');
 switch(block.id){
 case 'entities.query':{const parsed=parseEntityQuery(input);if(!repository.query)throw new EntityError(503,'Entity query is unavailable.');return repository.query(scope,parsed);}
 case 'entities.read':{const data=exact(input,['id']);return repository.find(scope,uuid(data.id));}
 case 'entities.create':{const data=exact(input,['schemaId','schemaVersion','title','attributes']);const schemaVersion=data.schemaVersion===undefined?undefined:version(data.schemaVersion);if(schemaVersion!==undefined&&schemaVersion>2147483647)bad('Invalid schema version.');return repository.create(scope,{schemaId:slug(data.schemaId),...(schemaVersion===undefined?{}:{schemaVersion}),title:title(data.title),attributes:object(data.attributes) as Attributes},key!);}
 case 'entities.update':{const data=exact(input,['id','expectedVersion','title','attributes']);return repository.update(scope,uuid(data.id),{expectedVersion:version(data.expectedVersion),title:title(data.title),attributes:object(data.attributes) as Attributes},key!);}
 case 'entities.archive':{const data=exact(input,['id','expectedVersion']);return repository.archive(scope,uuid(data.id),version(data.expectedVersion),key!);}
 case 'entities.link':case 'entities.unlink':{const data=exact(input,['id','expectedVersion','name','targetId']);const parsed={expectedVersion:version(data.expectedVersion),name:name(data.name),targetId:uuid(data.targetId)};return repository[block.id==='entities.link'?'link':'unlink'](scope,uuid(data.id),parsed,key!);}
 default:throw new EntityError(404,'Block not found.');
 }
}
