// SPDX-License-Identifier: Apache-2.0
import { expect, test } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { entityDataToolsDatabase } from './data-tools-database.js';
const scope={actorId:'alice',organizationId:'org-a'};
const id='11111111-1111-1111-1111-111111111111',fileId='22222222-2222-2222-2222-222222222222';
const source={id,schemaId:'invoice',schemaVersion:1,title:'A',attributes:{},ownerId:'alice',organizationId:'org-a',version:1,archivedAt:null,createdAt:new Date(),updatedAt:new Date()};
function setup(status='clean',ownerId='alice',recordId:string|null=null){
 const calls:string[]=[];
 const client={async query(sql:string){calls.push(sql);if(sql.includes('FROM enterprise_entities WHERE'))return {rows:[source]};if(sql.includes('FROM foundation_files'))return {rows:[{fileId,filename:'a.txt',size:1,scanStatus:status,ownerId,organizationId:'org-a',recordId,content:Buffer.from('x')}]};if(sql.startsWith('INSERT INTO enterprise_entity_attachments'))return {rows:[{}]};if(sql.startsWith('UPDATE enterprise_entities'))return {rows:[{...source,version:2}]};return {rows:[]};},release(){calls.push('release');}} as unknown as PoolClient;
 return {calls,pool:{query:client.query,async connect(){return client;}} as unknown as Pool};
}
test('attachment uses entity then file lock and atomically changes version/audit/receipt',async()=>{
 const {calls,pool}=setup();const repo=await entityDataToolsDatabase(pool);
 expect((await repo.attach(scope,id,{fileId,expectedVersion:1},'key')).version).toBe(2);
 expect(calls.findIndex(sql=>sql.includes('FOR UPDATE'))).toBeLessThan(calls.findIndex(sql=>sql.includes('FOR SHARE')));
 expect(calls.filter(sql=>sql.startsWith('INSERT INTO enterprise_audit'))).toHaveLength(1);expect(calls).toContain('COMMIT');
});
test.each([['pending','alice',null],['rejected','alice',null],['clean','bob',null],['clean','alice',id]])('attachment rejects scan, foreign owner and legacy files',async(status,owner,record)=>{
 const {pool,calls}=setup(status,owner,record);const repo=await entityDataToolsDatabase(pool);
 await expect(repo.attach(scope,id,{fileId,expectedVersion:1},'key')).rejects.toBeDefined();expect(calls).toContain('ROLLBACK');expect(calls.some(sql=>sql.startsWith('INSERT INTO enterprise_entity_attachments'))).toBe(false);
});

test('import dry run reads explicit publication without writes; commit uses one transaction for entire batch',async()=>{
 const calls:string[]=[];let count=0;
 const client={async query(sql:string,values:unknown[]=[]){calls.push(sql);if(sql.includes('FROM enterprise_schema_versions'))return {rows:[{definition:{id:'invoice',title:'Invoice',fields:{},relations:{}},version:1}]};if(sql.startsWith('INSERT INTO enterprise_entities'))return {rows:[{...source,id:String(values[0]),title:values[5],version:1,schemaVersion:values[4]}]};return {rows:[]};},release(){}} as unknown as PoolClient;
 const pool={query:client.query,async connect(){count++;return client;}} as unknown as Pool;const repo=await entityDataToolsDatabase(pool);calls.length=0;
 const input={schemaId:'invoice',schemaVersion:1,format:'json' as const,content:'[{"title":"A","attributes":{}},{"title":"B","attributes":{}}]'};
 const dry=await repo.importDryRun(scope,input);expect(dry.valid).toBe(true);expect(calls.some(sql=>/INSERT|UPDATE|DELETE|BEGIN/.test(sql))).toBe(false);
 const result=await repo.importCommit(scope,{...input,expectedDigest:dry.digest!},'batch');expect(result.entityIds).toHaveLength(2);expect(count).toBe(1);expect(calls.filter(sql=>sql==='BEGIN')).toHaveLength(1);expect(calls.filter(sql=>sql.startsWith('INSERT INTO enterprise_audit'))).toHaveLength(2);
});
test('migration validates owner, newer pin and incompatible stored relations before any write',async()=>{
 const calls:string[]=[];
 const client={async query(sql:string,values:unknown[]=[]){calls.push(sql);if(sql.includes('FROM enterprise_entities WHERE'))return {rows:[source]};if(sql.includes('FROM enterprise_schema_versions'))return {rows:[{definition:{id:'invoice',title:'Invoice',fields:{},relations:{}},version:values[2]}]};if(sql.includes('FROM enterprise_relations'))return {rows:[{name:'parent',targetSchemaId:'invoice'}]};return {rows:[]};},release(){}} as unknown as PoolClient;
 const repo=await entityDataToolsDatabase({query:client.query,async connect(){return client;}} as unknown as Pool);calls.length=0;
 await expect(repo.migrationDryRun(scope,id,{expectedVersion:1,targetSchemaVersion:2,attributes:{}})).rejects.toMatchObject({statusCode:409});expect(calls.some(sql=>sql.startsWith('UPDATE enterprise_entities'))).toBe(false);
});

test('migration commit records old/new publication audit and receipt replay preserves accepted pin with current owner check',async()=>{
 let sourceRow={...source};let receipt:unknown;const calls:string[]=[];
 const client={async query(sql:string,values:unknown[]=[]){calls.push(sql);
  if(sql.includes('FROM enterprise_entities WHERE'))return {rows:[sourceRow]};
  if(sql.includes('FROM enterprise_schema_versions'))return {rows:[{definition:{id:'invoice',title:'Invoice',fields:{label:{type:'text'}},relations:{}},version:values[2]}]};
  if(sql.startsWith('SELECT fingerprint'))return {rows:receipt?[receipt]:[]};
  if(sql.startsWith('INSERT INTO enterprise_commands'))receipt={fingerprint:values[4],result:JSON.parse(String(values[5]))};
  if(sql.startsWith('UPDATE enterprise_entities')){sourceRow={...sourceRow,schemaVersion:Number(values[1]),attributes:JSON.parse(String(values[2])),version:sourceRow.version+1};return {rows:[sourceRow]};}
  if(sql.startsWith('INSERT INTO enterprise_audit'))expect(JSON.parse(String(values[8]))).toMatchObject({oldSchemaVersion:1,newSchemaVersion:2});
  return {rows:[]};},release(){}} as unknown as PoolClient;
 const repo=await entityDataToolsDatabase({query:client.query,async connect(){return client;}} as unknown as Pool);
 const input={expectedVersion:1,targetSchemaVersion:2,attributes:{label:'new'}};
 const dry=await repo.migrationDryRun(scope,id,input);const commit={...input,expectedDigest:dry.digest!};
 const first=await repo.migrationCommit(scope,id,commit,'migration');expect(first).toMatchObject({schemaVersion:2,version:2});
 sourceRow={...sourceRow,schemaVersion:3,version:3};expect(await repo.migrationCommit(scope,id,commit,'migration')).toEqual(first);
 sourceRow={...sourceRow,ownerId:'bob'};await expect(repo.migrationCommit(scope,id,commit,'migration')).rejects.toMatchObject({statusCode:404});
 expect(calls.filter(sql=>sql.startsWith('UPDATE enterprise_entities'))).toHaveLength(1);
});
test('import audit failure propagates rollback and prevents batch receipt and further rows',async()=>{
 const calls:string[]=[];
 const client={async query(sql:string,values:unknown[]=[]){calls.push(sql);if(sql.includes('FROM enterprise_schema_versions'))return {rows:[{definition:{id:'invoice',title:'Invoice',fields:{},relations:{}},version:1}]};if(sql.startsWith('INSERT INTO enterprise_entities'))return {rows:[{...source,id:values[0]}]};if(sql.startsWith('INSERT INTO enterprise_audit'))throw new Error('audit failure');return {rows:[]};},release(){}} as unknown as PoolClient;
 const repo=await entityDataToolsDatabase({query:client.query,async connect(){return client;}} as unknown as Pool);
 const input={schemaId:'invoice',schemaVersion:1,format:'json' as const,content:'[{"title":"A","attributes":{}},{"title":"B","attributes":{}}]'};
 const dry=await repo.importDryRun(scope,input);await expect(repo.importCommit(scope,{...input,expectedDigest:dry.digest!},'fail')).rejects.toThrow('audit failure');expect(calls).toContain('ROLLBACK');expect(calls.filter(sql=>sql.startsWith('INSERT INTO enterprise_entities'))).toHaveLength(1);expect(calls.some(sql=>sql.startsWith('INSERT INTO enterprise_commands'))).toBe(false);
});
