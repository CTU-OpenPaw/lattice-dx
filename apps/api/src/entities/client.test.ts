import { expect, test } from 'vitest';
import type { PoolClient } from 'pg';
import { createEntityAtPublication } from './client.js';
import { runEntityCommandInTransaction } from './commands.js';
const scope={actorId:'alice',organizationId:'org-a'};
test('caller client pinned create and command use no connection or transaction lifecycle',async()=>{
 const statements:string[]=[];
 const client={async query(sql:string,values:unknown[]=[]){statements.push(sql);if(sql.includes('FROM enterprise_schema_versions')){expect(values).toEqual(['org-a','invoice',1]);return {rows:[{definition:{id:'invoice',title:'Invoice',fields:{},relations:{}},version:1}]};}if(sql.startsWith('INSERT INTO enterprise_entities'))return {rows:[{id:values[0],organizationId:'org-a',ownerId:'alice',schemaId:'invoice',schemaVersion:1,title:'A',attributes:{},version:1,archivedAt:null,createdAt:new Date(),updatedAt:new Date()}]};return {rows:[]};}} as unknown as PoolClient;
 const result=await runEntityCommandInTransaction(client,scope,'batch','key',{value:1},async()=>{},db=>createEntityAtPublication(db,scope,{schemaId:'invoice',schemaVersion:1,title:'A',attributes:{}}));
 expect(result.schemaVersion).toBe(1);expect(statements.some(sql=>['BEGIN','COMMIT','ROLLBACK'].includes(sql))).toBe(false);expect(statements.filter(sql=>sql.startsWith('INSERT INTO enterprise_audit'))).toHaveLength(1);
});

test('shared locked operation applies update/archive and no-op relation without pool lifecycle',async()=>{
 const {applyEntityUpdateWithClient,applyEntityArchiveWithClient,applyEntityRelationWithClient}=await import('./client.js');
 const calls:string[]=[];
 const before={id:'11111111-1111-1111-1111-111111111111',schemaId:'invoice',schemaVersion:1,title:'A',attributes:{},ownerId:'alice',organizationId:'org-a',version:1,archivedAt:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
 const client={async query(sql:string){calls.push(sql);if(sql.includes('FROM enterprise_schema_versions'))return {rows:[{definition:{id:'invoice',title:'Invoice',fields:{count:{type:'integer'}},relations:{parent:{targetSchemaId:'invoice'}}},version:1}]};if(sql.startsWith('UPDATE enterprise_entities'))return {rows:[{...before,version:2}]};return {rows:[]};}} as unknown as PoolClient;
 await expect(applyEntityUpdateWithClient(client,scope,before,{expectedVersion:1,title:'B',attributes:{count:'1' as unknown as number}})).rejects.toMatchObject({statusCode:400});
 expect((await applyEntityUpdateWithClient(client,scope,before,{expectedVersion:1,title:'B',attributes:{count:1}})).version).toBe(2);
 expect((await applyEntityArchiveWithClient(client,scope,before,1)).version).toBe(2);
 const audits=calls.filter(sql=>sql.startsWith('INSERT INTO enterprise_audit')).length;
 expect(await applyEntityRelationWithClient(client,scope,before,before,{name:'parent',targetId:before.id,expectedVersion:1},false)).toEqual(before);
 expect(calls.filter(sql=>sql.startsWith('INSERT INTO enterprise_audit'))).toHaveLength(audits);
 await expect(applyEntityArchiveWithClient(client,{...scope,actorId:'bob'},before,1)).rejects.toMatchObject({statusCode:404});
 expect(calls.some(sql=>['BEGIN','COMMIT','ROLLBACK'].includes(sql))).toBe(false);
});
