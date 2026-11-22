/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { entityDatabase, runEntityCommand } from './database.js';
import type { Entity } from './types.js';
import { canonicalJson } from './policy.js';

function fixture() {
  const statements:string[]=[];
  let receipt:{fingerprint:string;result:unknown}|undefined;
  const client={
    async query(sql:string,params:unknown[]=[]){
      statements.push(sql);
      if(sql.startsWith('SELECT fingerprint')) return {rows:receipt?[receipt]:[]};
      if(sql.startsWith('INSERT INTO enterprise_commands')) receipt={fingerprint:params[4] as string,result:JSON.parse(params[5] as string)};
      return {rows:[]};
    },release(){statements.push('RELEASE');},
  } as unknown as PoolClient;
  const pool={async connect(){return client;}} as unknown as Pool;
  return {pool,statements};
}
const scope={actorId:'alice',organizationId:'org-a'};
test('journal initializes after entity DDL and reads metadata through current ACL before pagination',async()=>{
 const calls:{sql:string;values:unknown[]}[]=[];
 const id='11111111-1111-1111-1111-111111111111';
 const pool={async query(sql:string,values:unknown[]=[]){calls.push({sql,values});if(sql.includes('SELECT id, schema_id'))return {rows:[{id,ownerId:'alice',organizationId:'org-a',createdAt:new Date(),updatedAt:new Date(),archivedAt:new Date()}]};if(sql.includes('FROM enterprise_entity_events a'))return {rows:[{id,entityId:id,schemaId:'invoice',schemaVersion:2,fromVersion:1,toVersion:2,operation:'entity.update',actorSubject:'admin',occurredAt:new Date('2026-01-01')}]};return {rows:[]};}} as unknown as Pool;
 const repository=await entityDatabase(pool);
 expect(calls.findIndex(c=>c.sql.includes('CREATE TABLE IF NOT EXISTS enterprise_entity_events'))).toBeGreaterThan(calls.findIndex(c=>c.sql.includes('CREATE TABLE IF NOT EXISTS enterprise_entities')));
 expect(repository.events).toBeTypeOf('function');
 const result=await repository.events!(scope,id,{limit:1,offset:3,q:'update'});
 expect(result.items[0]).toEqual({id,entityId:id,schemaId:'invoice',schemaVersion:2,fromVersion:1,toVersion:2,operation:'entity.update',actorSubject:'admin',occurredAt:'2026-01-01T00:00:00.000Z'});
 const selection=calls.at(-1)!;
 expect(selection.values).toEqual([id,'org-a','alice','update',2,3]);
 expect(selection.sql).toContain('enterprise_entity_shares');
 expect(selection.sql.indexOf('enterprise_entity_shares')).toBeLessThan(selection.sql.indexOf('LIMIT'));
 expect(selection.sql).not.toContain('a.input');
 expect(selection.sql).not.toContain('actor_subject=$');
 expect(selection.sql).toContain('(e.archived_at IS NULL OR e.owner_id=$3)');
});
test('archived journal remains readable by owner but is hidden from shared recipient',async()=>{
 const calls:string[]=[];
 const id='11111111-1111-1111-1111-111111111111';
 const pool={async query(sql:string){calls.push(sql);if(sql.includes('SELECT id, schema_id'))return {rows:[{id,ownerId:'alice',organizationId:'org-a',archivedAt:new Date(),createdAt:new Date(),updatedAt:new Date()}]};return {rows:[]};}} as unknown as Pool;
 const repository=await entityDatabase(pool);
 await expect(repository.events!({...scope,actorId:'bob'},id,{limit:1,offset:0,q:''})).rejects.toMatchObject({statusCode:404});
 expect(calls.some(sql=>sql.includes('FROM enterprise_entity_events a'))).toBe(false);
 await expect(repository.events!(scope,id,{limit:1,offset:0,q:''})).resolves.toMatchObject({items:[]});
});
test('journal rejects invisible entity and invalid pagination before event selection',async()=>{
 const calls:string[]=[];
 const pool={async query(sql:string){calls.push(sql);return {rows:[]};}} as unknown as Pool;
 const repository=await entityDatabase(pool);
 expect(repository.events).toBeTypeOf('function');
 await expect(repository.events!(scope,'11111111-1111-1111-1111-111111111111',{limit:1,offset:0,q:''})).rejects.toMatchObject({statusCode:404});
 await expect(repository.events!(scope,'11111111-1111-1111-1111-111111111111',{limit:101,offset:0,q:''})).rejects.toMatchObject({statusCode:400});
 expect(calls.some(sql=>sql.includes('FROM enterprise_entity_events'))).toBe(false);
});
test('typed query uses pinned publication and SQL ACL before numeric ordering and paging without a transaction',async()=>{
 const calls:{sql:string;values:unknown[]}[]=[];
 const pool={async query(sql:string,values:unknown[]=[]){calls.push({sql,values});return {rows:sql.includes('FROM enterprise_schema_versions')?[{definition:{id:'invoice',title:'Invoice',fields:{amount:{type:'decimal'}},relations:{}},version:2}]:[]};},async connect(){throw new Error('Read must not hold a transaction client');}} as unknown as Pool;
 const repository=await entityDatabase(pool);
 expect(repository.query).toBeTypeOf('function');
 expect(await repository.query!(scope,{schemaId:'invoice',schemaVersion:2,filters:[{field:'amount',operator:'gt',value:'1.000000000000000001'}],sort:{field:'amount',direction:'desc'},limit:1,offset:3})).toEqual({items:[],page:{limit:1,offset:3,hasMore:false,nextOffset:null}});
 const publication=calls.find(call=>call.sql.includes('FROM enterprise_schema_versions'))!;expect(publication.values).toEqual(['org-a','invoice',2]);expect(publication.sql).toContain('version=$3');
 const selection=calls.at(-1)!;expect(selection.values).toEqual(['org-a','alice','invoice',2,'amount','1.000000000000000001','amount',2,3]);expect(selection.sql).toContain('schema_version=$4');expect(selection.sql).toContain('::numeric');expect(selection.sql.indexOf('enterprise_entity_shares')).toBeLessThan(selection.sql.indexOf('LIMIT'));expect(selection.sql).toContain('archived_at IS NULL');
});
test('typed query missing publication fails 404 before entity SQL',async()=>{
 const statements:string[]=[];const pool={async query(sql:string){statements.push(sql);return {rows:[]};}} as unknown as Pool;
 const repository=await entityDatabase(pool);await expect(repository.query!(scope,{schemaId:'invoice',schemaVersion:9})).rejects.toMatchObject({statusCode:404});expect(statements.some(sql=>sql.includes('SELECT')&&sql.includes('FROM enterprise_entities'))).toBe(false);
});

test('typed equal command replay executes one mutation and stores original result',async()=>{
  const {pool,statements}=fixture();
  let writes=0;
  const execute=async()=>({id:'id',version:++writes});
  const validate=async()=>{};
  const first=await runEntityCommand(pool,scope,'entity.create','key',{attributes:{b:false,a:'0.0100'}},validate,execute);
  const replay=await runEntityCommand(pool,scope,'entity.create','key',{attributes:{a:'0.0100',b:false}},validate,execute);
  expect(replay).toEqual(first);
  expect(writes).toBe(1);
  expect(statements.filter(x=>x==='COMMIT')).toHaveLength(2);
  expect(statements.filter(x=>x==='RELEASE')).toHaveLength(2);
});

test('conflicting receipt rolls back and does not mutate',async()=>{
  const {pool,statements}=fixture();
  let writes=0;
  const execute=async()=>++writes;
  await runEntityCommand(pool,scope,'entity.update','key',{value:'1'},async()=>{},execute);
  await expect(runEntityCommand(pool,scope,'entity.update','key',{value:1},async()=>{},execute)).rejects.toMatchObject({statusCode:409});
  expect(writes).toBe(1);
  expect(statements).toContain('ROLLBACK');
});

test('current authority is validated before receipt replay and failures release one client',async()=>{
  const {pool,statements}=fixture();
  await runEntityCommand(pool,scope,'entity.archive','key',{id:'id'},async()=>{},async()=>({version:2}));
  const denied=async()=>{throw new Error('hidden');};
  await expect(runEntityCommand(pool,scope,'entity.archive','key',{id:'id'},denied,async()=>({version:3}))).rejects.toThrow('hidden');
  expect(statements.at(-2)).toBe('ROLLBACK');
  expect(statements.at(-1)).toBe('RELEASE');
});

test('unlink cleans an archived target while new linking still rejects it and locks stable IDs',async()=>{
  const sourceId='ffffffff-ffff-ffff-ffff-ffffffffffff',targetId='11111111-1111-1111-1111-111111111111';
  const base={schemaId:'invoice',schemaVersion:1,title:'Invoice',attributes:{},ownerId:'alice',organizationId:'org-a',version:1,archivedAt:null,createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z'};
  const source:Entity={...base,id:sourceId};
  const target:Entity={...base,id:targetId,archivedAt:'2026-01-02T00:00:00Z'};
  const locks:string[]=[];
  const client={async query(sql:string,values:unknown[]=[]) {
    if(sql.includes('FROM enterprise_entities WHERE')) {locks.push(values[0] as string);return {rows:[values[0]===sourceId?source:target]};}
    if(sql.includes('FROM enterprise_schema_versions')) return {rows:[{definition:{id:'invoice',title:'Invoice',fields:{},relations:{parent:{targetSchemaId:'invoice'}}},version:1}]};
    if(sql.startsWith('DELETE FROM enterprise_relations')) return {rows:[{source_id:sourceId}]};
    if(sql.startsWith('UPDATE enterprise_entities')) return {rows:[{...source,version:2}]};
    return {rows:[]};
  },release(){}} as unknown as PoolClient;
  const pool={query:client.query.bind(client),async connect(){return client;}} as unknown as Pool;
  const repository=await entityDatabase(pool);
  const input={name:'parent',targetId,expectedVersion:1};
  await expect(repository.link(scope,sourceId,input,'link')).rejects.toMatchObject({statusCode:409});
  expect(await repository.unlink(scope,sourceId,input,'unlink')).toMatchObject({id:sourceId,version:2});
  expect(locks).toEqual([targetId,sourceId,targetId,sourceId]);
});

test('create receipt replay checks current entity scope and retains archived pinned snapshots',async()=>{
  const input={schemaId:'invoice',title:'Invoice',attributes:{label:'Original'}};
  const accepted:Entity={id:'12345678-1234-1234-1234-123456789abc',schemaId:'invoice',schemaVersion:1,title:'Invoice',attributes:input.attributes,ownerId:'alice',organizationId:'org-a',version:1,archivedAt:null,createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z'};
  let current:Entity={...accepted,version:2,archivedAt:'2026-01-02T00:00:00Z'};
  const scopedReads:unknown[][]=[];
  const receipt={fingerprint:createHash('sha256').update(canonicalJson(input)).digest('hex'),result:accepted};
  const client={async query(sql:string,values:unknown[]=[]) {
    if(sql.startsWith('SELECT fingerprint')) return {rows:[receipt]};
    if(sql.includes('FROM enterprise_schema_versions')) return {rows:[{definition:{id:'invoice',title:'New invoice',fields:{different:{type:'boolean',required:true}},relations:{}},version:2}]};
    if(sql.includes('FROM enterprise_entities WHERE')) {
      scopedReads.push(values);
      expect(sql).toContain('FOR UPDATE');
      return {rows:current.id===values[0]&&current.organizationId===values[1]?[current]:[]};
    }
    return {rows:[]};
  },release(){}} as unknown as PoolClient;
  let connections=0;
  const pool={query:client.query.bind(client),async connect(){connections++;return client;}} as unknown as Pool;
  const repository=await entityDatabase(pool);
  expect(await repository.create(scope,input,'create')).toEqual(accepted);
  current={...current,ownerId:'bob'};
  await expect(repository.create(scope,input,'create')).rejects.toMatchObject({statusCode:404});
  current={...current,ownerId:'alice',organizationId:'org-b'};
  await expect(repository.create(scope,input,'create')).rejects.toMatchObject({statusCode:404});
  expect(scopedReads).toHaveLength(3);
  expect(connections).toBe(3);
});
