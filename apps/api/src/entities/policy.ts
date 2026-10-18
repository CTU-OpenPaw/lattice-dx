// SPDX-License-Identifier: Apache-2.0
import type { Attributes, Field, SchemaDefinition } from './types.js';
export const entityFieldTypes = Object.freeze(['text','boolean','integer','decimal','date','enum']);
export class EntityError extends Error {
  constructor(public readonly statusCode:400|404|409|503, message:string) { super(message); }
}
export function bad(message = 'Invalid entity input.'): never { throw new EntityError(400, message); }
function boundedJson(value:unknown) {
  if(Buffer.byteLength(JSON.stringify(value),'utf8')>16384) bad('Entity data exceeds 16 KiB.');
}
const reserved = new Set(['__proto__','prototype','constructor','id','schemaId','schemaVersion','ownerId','organizationId','version','archivedAt','createdAt','updatedAt','audit']);
export function object(value:unknown): Record<string,unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) bad();
  return value as Record<string,unknown>;
}
export function exact(value:unknown, keys:string[]):Record<string,unknown> {
  const result=object(value);
  if(Object.keys(result).some(key=>!keys.includes(key))) bad();
  return result;
}
export function slug(value:unknown):string {
  if(typeof value!=='string'||!/^[a-z][a-z0-9-]{0,63}$/.test(value)) bad('Invalid schema ID.');
  return value;
}
export function name(value:unknown):string {
  if(typeof value!=='string'||!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value)||reserved.has(value)) bad('Invalid field/relation name.');
  return value;
}
export function title(value:unknown):string {
  if(typeof value!=='string'||!value.trim()||Array.from(value.trim()).length>200) bad('Invalid title.');
  return value.trim();
}
export function version(value:unknown):number {
  if(typeof value!=='number'||!Number.isSafeInteger(value)||value<1) bad('Invalid expected version.');
  return value;
}
export function uuid(value:unknown):string {
  if(typeof value!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) bad('Entity ID must be a UUID.');
  return value.toLowerCase();
}
export function parseSchema(input:unknown):SchemaDefinition {
  const data=exact(input,['id','title','fields','relations']);
  boundedJson(data);
  const fields=object(data.fields), relations=object(data.relations===undefined?{}:data.relations);
  if(Object.keys(fields).length>50||Object.keys(relations).length>20) bad('Too many definitions.');
  const parsed:Record<string,Field>={};
  for(const [key,value] of Object.entries(fields)) {
    name(key);
    const field=exact(value,['type','required','maxLength','choices']);
    if(typeof field.type!=='string'||!entityFieldTypes.includes(field.type)) bad('Invalid field type.');
    if(field.required!==undefined&&typeof field.required!=='boolean') bad();
    if(field.maxLength!==undefined&&(field.type!=='text'||!Number.isSafeInteger(field.maxLength)||Number(field.maxLength)<1||Number(field.maxLength)>4000)) bad();
    if(field.choices!==undefined&&field.type!=='enum') bad();
    if(field.type==='enum'&&(!Array.isArray(field.choices)||field.choices.length<1||field.choices.length>100||field.choices.some(x=>typeof x!=='string'||!x.trim()||Array.from(x).length>200)||new Set(field.choices).size!==field.choices.length)) bad('Invalid enum choices.');
    parsed[key]={...field} as Field;
  }
  const declared:SchemaDefinition['relations']={};
  for(const [key,value] of Object.entries(relations)) {
    name(key);
    const relation=exact(value,['targetSchemaId']);
    declared[key]={targetSchemaId:slug(relation.targetSchemaId)};
  }
  return {id:slug(data.id),title:title(data.title),fields:parsed,relations:declared};
}
function realDate(value:string):boolean {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||value.slice(0,4)==='0000') return false;
  const parsed=new Date(value+'T00:00:00Z');
  return Number.isFinite(parsed.getTime())&&parsed.toISOString().slice(0,10)===value;
}
export function validateAttributes(schema:SchemaDefinition,input:unknown):Attributes {
  const values=object(input);
  boundedJson(values);
  if(Object.keys(values).some(key=>!Object.hasOwn(schema.fields,key)||reserved.has(key))) bad('Unknown attribute.');
  for(const [key,field] of Object.entries(schema.fields)) {
    const value=Object.hasOwn(values,key)?values[key]:undefined;
    if(value===undefined) { if(field.required) bad(`Required field: ${key}.`); continue; }
    let valid=false;
    switch(field.type) {
      case 'text': valid=typeof value==='string'&&Array.from(value).length<=(field.maxLength??4000)&&(!field.required||!!value.trim()); break;
      case 'boolean': valid=typeof value==='boolean'; break;
      case 'integer': valid=typeof value==='number'&&Number.isSafeInteger(value); break;
      case 'decimal': valid=typeof value==='string'&&/^-?(?:0|[1-9]\d{0,37})(?:\.\d{1,18})?$/.test(value)&&value.replace(/[-.]/g,'').length<=38; break;
      case 'date': valid=typeof value==='string'&&realDate(value); break;
      case 'enum': valid=typeof value==='string'&&!!field.choices?.includes(value); break;
    }
    if(!valid) bad(`Invalid value for ${key}.`);
  }
  return {...values} as Attributes;
}
export function canonicalJson(input:unknown):string {
  function normalize(value:unknown):unknown {
    if(Array.isArray(value)) return value.map(normalize);
    if(value&&typeof value==='object') return Object.fromEntries(Object.keys(value).sort().map(key=>[key,normalize((value as Record<string,unknown>)[key])]));
    return value;
  }
  return JSON.stringify(normalize(input));
}

export function principalKind(value:unknown):'person'|'department' {
  if(value!=='person'&&value!=='department') bad('Invalid principal kind.');
  return value;
}
export function principalId(value:unknown):string {
  if(typeof value!=='string'||!value.trim()||value!==value.trim()||value.length>200||/[\u0000-\u001f\u007f]/.test(value)||reserved.has(value)) bad('Invalid principal ID.');
  return value;
}
export function parseShare(value:unknown):import('./types.js').ShareInput {
  const data=exact(value,['expectedVersion','principal','permission']);
  const principal=exact(data.principal,['kind','id']);
  if(data.permission!=='read'&&data.permission!=='edit') bad('Invalid share permission.');
  return {expectedVersion:version(data.expectedVersion),principal:{kind:principalKind(principal.kind),id:principalId(principal.id)},permission:data.permission};
}
