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
