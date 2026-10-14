import {expect,test} from 'vitest';
import type {PoolClient} from 'pg';
import {audit,applyEntityRelationWithClient} from './client.js';
import {runEntityCommandInTransaction} from './commands.js';
const scope={actorId:'alice',organizationId:'org-a'};
const row={id:'11111111-1111-1111-1111-111111111111',schemaId:'invoice',schemaVersion:2,title:'secret',attributes:{secret:'token'},ownerId:'alice',organizationId:'org-a',version:2,archivedAt:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
test('shared audit appends only whitelisted metadata on the caller connection after audit',async()=>{
 const calls:{sql:string;values:unknown[]}[]=[];
 const db={async query(sql:string,values:unknown[]=[]){calls.push({sql,values});return {rows:[]};}} as unknown as PoolClient;
 for(const operation of ['entity.create','entity.update','entity.archive','entity.link','entity.unlink','entity.schema.migrate']) {
  await audit(db,scope,operation==='entity.create'?undefined:{...row,version:1},row,operation,{secret:'credential'});
 }
 const events=calls.filter(c=>c.sql.startsWith('INSERT INTO enterprise_entity_events'));
 expect(events).toHaveLength(6);
 for(const event of events) {
  expect(event.values).toEqual([expect.any(String),'org-a',row.id,'invoice',2,expect.any(Number),2,expect.any(String),'alice']);
  expect(JSON.stringify(event.values)).not.toContain('secret');
  expect(calls[calls.indexOf(event)-1].sql).toContain('INSERT INTO enterprise_audit');
 }
});
test('share attachment and unsupported audit operations never create journal events',async()=>{
 const calls:string[]=[];
 const db={async query(sql:string){calls.push(sql);return {rows:[]};}} as unknown as PoolClient;
 for(const operation of ['entity.share','entity.share.revoke','entity.attachment.create','unknown']) await audit(db,scope,{...row,version:1},row,operation,{});
 expect(calls.filter(sql=>sql.startsWith('INSERT INTO enterprise_entity_events'))).toHaveLength(0);
});
test('journal insert failure propagates to the owning transaction',async()=>{
 const db={async query(sql:string){if(sql.startsWith('INSERT INTO enterprise_entity_events'))throw new Error('journal failed');return {rows:[]};}} as unknown as PoolClient;
 await expect(audit(db,scope,{...row,version:1},row,'entity.update',{})).rejects.toThrow('journal failed');
});
test('relation no-op does not append audit or journal',async()=>{
 const calls:string[]=[];
 const db={async query(sql:string){calls.push(sql);if(sql.includes('FROM enterprise_schema_versions'))return {rows:[{definition:{relations:{parent:{targetSchemaId:'invoice'}}},version:2}]};return {rows:[]};}} as unknown as PoolClient;
 expect(await applyEntityRelationWithClient(db,scope,row,row,{name:'parent',targetId:row.id,expectedVersion:2},false)).toEqual(row);
 expect(calls.some(sql=>sql.startsWith('INSERT INTO enterprise_audit')||sql.startsWith('INSERT INTO enterprise_entity_events'))).toBe(false);
});
test('accepted command replay returns its receipt without appending another event',async()=>{
 const calls:string[]=[];let receipt:unknown;
 const db={async query(sql:string,values:unknown[]=[]){calls.push(sql);if(sql.startsWith('SELECT fingerprint'))return {rows:receipt?[receipt]:[]};if(sql.startsWith('INSERT INTO enterprise_commands'))receipt={fingerprint:values[4],result:JSON.parse(values[5] as string)};return {rows:[]};}} as unknown as PoolClient;
 const execute=async()=>{await audit(db,scope,undefined,row,'entity.create',{});return row;};
 const first=await runEntityCommandInTransaction(db,scope,'entity.create','key',{},async()=>{},execute);
 expect(await runEntityCommandInTransaction(db,scope,'entity.create','key',{},async()=>{},execute)).toEqual(first);
 expect(calls.filter(sql=>sql.startsWith('INSERT INTO enterprise_entity_events'))).toHaveLength(1);
 expect(calls.filter(sql=>sql.startsWith('INSERT INTO enterprise_commands'))).toHaveLength(1);
});
