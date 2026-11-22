/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import {PageError} from '../pagination.js';
import {bad,exact,name,slug,version,validateAttributes} from './policy.js';
import type {EntityQuery,Field,QueryOperator,SchemaPublication} from './types.js';
export const entityQueryOperators = Object.freeze(['eq','ne','gt','gte','lt','lte','contains','exists']);
export function parseEntityQuery(input:unknown):EntityQuery & {limit:number;offset:number;filters:NonNullable<EntityQuery['filters']>} {
 const body=exact(input,['schemaId','schemaVersion','filters','sort','limit','offset']);
 if(Buffer.byteLength(JSON.stringify(body),'utf8')>16384) bad('Entity data exceeds 16 KiB.');
 const schemaId=slug(body.schemaId),schemaVersion=version(body.schemaVersion);
 if(schemaVersion>2147483647) bad('Invalid schema version.');
 const limit=body.limit===undefined?50:body.limit,offset=body.offset===undefined?0:body.offset;
 if(typeof limit!=='number'||!Number.isSafeInteger(limit)||limit<1||limit>100||typeof offset!=='number'||!Number.isSafeInteger(offset)||offset<0||offset>Number.MAX_SAFE_INTEGER-101) throw new PageError('Invalid pagination.');
 const raw=body.filters===undefined?[]:body.filters;
 if(!Array.isArray(raw)||raw.length>10) bad('Invalid filters.');
 const filters=raw.map(value=>{
  const item=exact(value,['field','operator','value']),field=name(item.field);
  if(typeof item.operator!=='string'||!entityQueryOperators.includes(item.operator)) bad('Invalid query operator.');
  const operator=item.operator as QueryOperator;
  if(operator==='exists' ? Object.hasOwn(item,'value') : !Object.hasOwn(item,'value')) bad('Invalid query value.');
  if(operator!=='exists'&&!['string','number','boolean'].includes(typeof item.value)) bad('Invalid query value.');
  return {field,operator,...(operator==='exists'?{}:{value:item.value as string|number|boolean})};
 });
 let sort:EntityQuery['sort'];
 if(body.sort!==undefined){const item=exact(body.sort,['field','direction']);if(item.direction!=='asc'&&item.direction!=='desc')bad('Invalid sort direction.');sort={field:name(item.field),direction:item.direction};}
 return {schemaId,schemaVersion,filters,...(sort?{sort}:{}),limit,offset};
}
export function compileEntityQuery(input:EntityQuery,schema:SchemaPublication,start=1):{predicate:string;order:string;values:unknown[]} {
 const query=parseEntityQuery(input),values:unknown[]=[];
 const bind=(value:unknown)=>{values.push(value);return `$${start+values.length-1}`;};
 const fieldType=(key:string):Field=>{if(!Object.hasOwn(schema.fields,key))bad('Unknown query field.');return schema.fields[key];};
 // PostgreSQL can reorder WHERE evaluation: guard casts inside CASE even for
 // unrelated schema rows whose same-named attribute contains arbitrary text.
 const comparisons={eq:'=',ne:'<>',gt:'>',gte:'>=',lt:'<',lte:'<='};
 const predicates=query.filters.map(filter=>{
  const field=fieldType(filter.field),key=bind(filter.field),exists=`attributes ? ${key}`;
  if(filter.operator==='exists')return exists;
  if(filter.operator==='contains'&&field.type!=='text')bad('Contains requires text.');
  if(['gt','gte','lt','lte'].includes(filter.operator)&&!['integer','decimal','date'].includes(field.type))bad('Field cannot be ordered.');
  validateAttributes({...schema,fields:{[filter.field]:{...field,required:false}}},{[filter.field]:filter.value});
  const value=bind(filter.value);
  if(filter.operator==='contains')return `(${exists} AND strpos(${typedFieldExpression(key,field)},${value}::text)>0)`;
  const numeric=field.type==='decimal'||field.type==='integer';
  return `(${exists} AND ${typedFieldExpression(key,field)} ${comparisons[filter.operator]} ${value}::${numeric?'numeric':'text'})`;
 });
 let order='created_at DESC,id DESC';
 if(query.sort){const field=fieldType(query.sort.field),key=bind(query.sort.field),direction=query.sort.direction.toUpperCase();order=`${typedFieldExpression(key,field)} ${direction} NULLS LAST,id ${direction}`;}
 return {predicate:predicates.length?predicates.join(' AND '):'TRUE',order,values};
}

export function typedFieldExpression(key:string,field:Field):string {
  const text=`(attributes ->> ${key})`;
  if(field.type==='decimal')return `CASE WHEN jsonb_typeof(attributes -> ${key})='string' AND ${text} ~ '^-?(0|[1-9][0-9]{0,37})([.][0-9]{1,18})?$' AND length(translate(${text},'-.',''))<=38 THEN ${text}::numeric END`;
  if(field.type==='integer')return `CASE WHEN jsonb_typeof(attributes -> ${key})='number' AND ${text} ~ '^-?(0|[1-9][0-9]{0,15})$' THEN ${text}::numeric END`;
  return text;
 }
