// SPDX-License-Identifier: Apache-2.0
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
