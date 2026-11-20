/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { expect, test } from 'vitest';
import type { Pool } from 'pg';
import { entityDatabase } from './database.js';

test('production repository exposes all three sharing operations and stores scoped grants',async()=>{
  const sql:string[]=[];
  const repository=await entityDatabase({query:async(text:string)=>{sql.push(text);return {rows:[]};}} as unknown as Pool);
  expect(typeof repository.share).toBe('function');
  expect(typeof repository.revokeShare).toBe('function');
  expect(typeof repository.shares).toBe('function');
  expect(sql.join(' ')).toContain('enterprise_entity_shares');
});

test('standalone entity database initializes its directory dependency',async()=>{
 const sql:string[]=[];
 await entityDatabase({query:async(text:string)=>{sql.push(text);return {rows:[]};}} as unknown as Pool);
 expect(sql.join(' ')).toContain('CREATE TABLE IF NOT EXISTS directory_people');
});

const id='12345678-1234-1234-1234-123456789abc';
const owner={actorId:'alice',organizationId:'org-a'}, peer={actorId:'bob',organizationId:'org-a'};
function sharingFixture(){
 let row={id,schemaId:'invoice',schemaVersion:1,title:'Invoice',attributes:{},ownerId:'alice',organizationId:'org-a',version:1,archivedAt:null,createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z'};
 const queries:{sql:string;values:unknown[]}[]=[];let changed=true,active=true,allowed=true;
 const query=async(sql:string,values:unknown[]=[])=>{
  queries.push({sql,values});
  if(sql.includes('FROM enterprise_entities WHERE')) return {rows:[row]};
  if(sql.startsWith('SELECT subject FROM directory_people')) return {rows:active?[{subject:'bob'}]:[]};
  if(sql.startsWith('SELECT p.subject')) return {rows:allowed?[{subject:'bob'}]:[]};
  if(sql.startsWith('INSERT INTO enterprise_entity_shares')||sql.startsWith('DELETE FROM enterprise_entity_shares')) return {rows:changed?[{}]:[]};
  if(sql.startsWith('UPDATE enterprise_entities')){row={...row,version:row.version+1};return {rows:[row]};}
  if(sql.includes('FROM enterprise_schema_versions'))return {rows:[{definition:{id:'invoice',title:'Invoice',fields:{},relations:{}},version:1}]};
  if(sql.includes('FROM enterprise_audit a'))return {rows:[{id:'audit',entityId:id,actorId:'alice',operation:'entity.share',fromVersion:1,toVersion:2,occurredAt:'2026-01-01T00:00:00Z',input:{principal:'private'},result:row}]};
  return {rows:[]};
 };
 const client={query,release(){}};
 return {pool:{query,connect:async()=>client} as unknown as Pool,queries,setChanged:(value:boolean)=>changed=value,setActive:(value:boolean)=>active=value,setAllowed:(value:boolean)=>allowed=value};
}
test('share no-op creates receipt without version or audit and revoke accepts disabled recipients',async()=>{
 const f=sharingFixture(),repo=await entityDatabase(f.pool);f.setChanged(false);
 expect(await repo.share!(owner,id,{expectedVersion:1,principal:{kind:'person',id:'bob'},permission:'edit'},'no-op')).toMatchObject({version:1});
 expect(f.queries.some(q=>q.sql.startsWith('INSERT INTO enterprise_commands'))).toBe(true);
 expect(f.queries.some(q=>q.sql.startsWith('INSERT INTO enterprise_audit'))).toBe(false);
 f.setChanged(true);f.setActive(false);const previous=f.queries.length;
 expect(await repo.revokeShare!(owner,id,{expectedVersion:1,kind:'person',principalId:'bob'},'revoke')).toMatchObject({version:2});
 expect(f.queries.slice(previous).some(q=>q.sql.includes('directory_people'))).toBe(false);
});
test('share validates active principal, shared editor cannot delegate or archive, editor audit stays at owner',async()=>{
 const f=sharingFixture(),repo=await entityDatabase(f.pool);f.setActive(false);
 await expect(repo.share!(owner,id,{expectedVersion:1,principal:{kind:'person',id:'bob'},permission:'read'},'inactive')).rejects.toMatchObject({statusCode:400});
 await expect(repo.share!(peer,id,{expectedVersion:1,principal:{kind:'person',id:'bob'},permission:'edit'},'delegate')).rejects.toMatchObject({statusCode:404});
 await expect(repo.archive(peer,id,1,'archive')).rejects.toMatchObject({statusCode:404});
 await repo.update(peer,id,{expectedVersion:1,title:'Updated',attributes:{}},'update');
 const audit=f.queries.find(q=>q.sql.startsWith('INSERT INTO enterprise_audit'))!;expect(audit.values[2]).toBe('alice');expect(audit.values[4]).toBe('bob');
 const lock=f.queries.findIndex(q=>q.sql.includes('FROM enterprise_entities WHERE')&&q.sql.includes('FOR UPDATE'));
 const directory=f.queries.findIndex(q=>q.sql.startsWith('SELECT p.subject'));expect(directory).toBeGreaterThan(lock);
});
test('shared history omits snapshots and excludes them from SQL projection while owner retains full history',async()=>{
 const f=sharingFixture(),repo=await entityDatabase(f.pool),page={limit:50,offset:0,q:''};
 const shared=await repo.history(peer,id,page);expect(shared.items[0]).not.toHaveProperty('input');expect(shared.items[0]).not.toHaveProperty('result');
 expect(f.queries.find(q=>q.sql.includes('FROM enterprise_audit a'))!.sql).not.toContain('a.input');
 const full=await repo.history(owner,id,page);expect(full.items[0]).toHaveProperty('input');expect(full.items[0]).toHaveProperty('result');
});
