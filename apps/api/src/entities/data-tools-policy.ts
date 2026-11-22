/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { createHash } from 'node:crypto';
import { bad, canonicalJson, EntityError, exact, name, object, slug, title, validateAttributes, version } from './policy.js';
import { parseCsv, csvCell } from './data-tools-csv.js';
import type { Attributes, SchemaPublication } from './types.js';
import type { ImportInput, ImportRow, ImportPreparation, MigrationInput } from './data-tools-types.js';
export function format(value:unknown):'json'|'csv'{if(value!=='json'&&value!=='csv')bad('Invalid format.');return value;}
export function digest(value:unknown):string{if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))bad('Invalid expected digest.');return value;}
export function parseImportInput(value:unknown,commit=false):ImportInput & {expectedDigest?:string}{
 const body=exact(value,['schemaId','schemaVersion','format','content',...(commit?['expectedDigest']:[])]);
 if(typeof body.content!=='string'||Buffer.byteLength(body.content,'utf8')>262144||body.content.includes('\0'))bad('Import content must be at most 256 KiB UTF-8 without NUL.');
 const schemaVersion=version(body.schemaVersion);if(schemaVersion>2147483647)bad('Invalid schema version.');
 return {schemaId:slug(body.schemaId),schemaVersion,format:format(body.format),content:body.content,...(commit?{expectedDigest:digest(body.expectedDigest)}:{})};
}
export function parseMigrationInput(value:unknown,commit=false):MigrationInput & {expectedDigest?:string}{
 const body=exact(value,['expectedVersion','targetSchemaVersion','attributes',...(commit?['expectedDigest']:[])]);
 const targetSchemaVersion=version(body.targetSchemaVersion);if(targetSchemaVersion>2147483647)bad('Invalid schema version.');
 return {expectedVersion:version(body.expectedVersion),targetSchemaVersion,attributes:object(body.attributes) as Attributes,...(commit?{expectedDigest:digest(body.expectedDigest)}:{})};
}
export function hash(value:unknown){return createHash('sha256').update(canonicalJson(value)).digest('hex');}
export function prepareImport(schema:SchemaPublication,raw:ImportInput):ImportPreparation{
 const input=parseImportInput(raw);
 if(schema.id!==input.schemaId||schema.version!==input.schemaVersion)bad('Publication pin mismatch.');
 const source:unknown[]=[];
 if(input.format==='json'){
  let value:unknown;try{value=JSON.parse(input.content);}catch{bad('Malformed JSON content.');}
  if(!Array.isArray(value)||value.length>100)bad('Import must be an array of at most 100 rows.');source.push(...value);
 }else{
  const [headers,...records]=parseCsv(input.content);
  if(headers[0]!=='title'||new Set(headers).size!==headers.length)bad('CSV requires unique title and declared field headers.');
  for(const header of headers.slice(1)){name(header);if(!Object.hasOwn(schema.fields,header))bad('Unknown CSV header.');}
  for(const record of records){
   if(record.length!==headers.length){source.push({error:'CSV column count mismatch.'});continue;}
   const attributes:Record<string,unknown>={};let error:string|undefined;
   for(let index=1;index<headers.length;index++){
    const field=headers[index],cell=record[index],definition=schema.fields[field];
    if(cell==='')continue;
    if(definition.type==='integer'){
     if(!/^(?:0|-[1-9]\d*|[1-9]\d*)$/.test(cell)||!Number.isSafeInteger(Number(cell)))error=`Invalid integer for ${field}.`;
     else attributes[field]=Number(cell);
    }else if(definition.type==='boolean'){
     if(cell!=='true'&&cell!=='false')error=`Invalid boolean for ${field}.`;else attributes[field]=cell==='true';
    }else attributes[field]=cell;
   }
   source.push(error?{error}:{title:record[0],attributes});
  }
 }
 const rows:ImportRow[]=[],errors:{row:number;error:string}[]=[];
 source.forEach((raw,index)=>{
  try{
   if(raw&&typeof raw==='object'&&'error' in raw)bad(String(raw.error));
   const row=exact(raw,['title','attributes']);rows.push({title:title(row.title),attributes:validateAttributes(schema,row.attributes)});
  }catch(error){if(!(error instanceof EntityError))throw error;errors.push({row:index+1,error:error.message});}
 });
 const valid=errors.length===0;
 return {schemaId:input.schemaId,schemaVersion:input.schemaVersion,rowCount:source.length,valid,errors:errors.slice(0,100),rows,...(valid?{digest:hash({version:1,schemaId:input.schemaId,schemaVersion:input.schemaVersion,rows})}:{})};
}
export function exportContent(schema:SchemaPublication,rows:ImportRow[],output:'json'|'csv'):string{
 let content:string;
 if(output==='json')content=JSON.stringify(rows);
 else{
  const fields=Object.keys(schema.fields);
  const text=(value:string)=>/^[\s\u0000-\u001f\u007f]*[=+\-@]/.test(value)?`'${value}`:value;
  const cells=rows.map(row=>[csvCell(text(row.title)),...fields.map(field=>{
   const value=row.attributes[field];if(value===undefined)return '';
   const isText=['text','enum'].includes(schema.fields[field].type);
   return isText?csvCell(text(String(value))):csvCell(String(value),{preserveNumeric:true});
  })].join(','));
  content=[['title',...fields].map(h=>csvCell(h)).join(','),...cells].join('\r\n')+'\r\n';
 }
 if(Buffer.byteLength(content,'utf8')>2*1024*1024)throw new EntityError(409,'Export exceeds 2 MiB; narrow query.');
 return content;
}
