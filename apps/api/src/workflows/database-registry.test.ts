// SPDX-License-Identifier: Apache-2.0
import { expect,test,vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { WorkflowDefinition,WorkflowRun } from '@dx/contracts';
import { workflowDatabase } from './database.js';
const actor={subject:'alice',organizationId:'org-a',roles:['employee','workflow:start','manager']};
const def:WorkflowDefinition={id:'hr-request',version:1,title:'HR',startRole:'employee',initialState:'draft',startFields:{request:'text'},readerRoles:['manager'],transitions:[{id:'submit',from:'draft',to:'done',role:'employee',fields:{}}]};
const run:WorkflowRun={id:'11111111-1111-4111-8111-111111111111',recordId:'11111111-1111-4111-8111-111111111111',definitionId:def.id,definitionVersion:1,title:'Request',ownerId:actor.subject,organizationId:actor.organizationId,state:'draft',version:1,data:{request:'hello'},createdAt:'2026-10-13',updatedAt:'2026-10-13'};
test('start replay resolves pinned definition on transaction connection before validating newer schema',async()=>{
  const input={definitionId:def.id,title:run.title,input:{request:'hello'}};
  const fingerprint=createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const client={query:vi.fn(async(sql:string)=>({rows:sql.startsWith('SELECT fingerprint')?[{fingerprint,result:run}]:[],rowCount:0})),release:vi.fn()};
  const pool={query:vi.fn(async()=>({rows:[],rowCount:0})),connect:vi.fn(async()=>client)} as unknown as Pool;
  const get=vi.fn(async(_org:string,_id:string,version?:number)=>version===1?def:{...def,version:2,startFields:{newRequired:'text' as const}});
  const repo=await workflowDatabase(pool,{get,list:async()=>[def]});
  expect(await repo.create({...input,input:{request:' hello '}},actor,'same-start')).toEqual(run);
  expect(get).toHaveBeenCalledWith(actor.organizationId,def.id,1,client);
  expect(client.query.mock.calls.some(([sql])=>sql.startsWith('INSERT'))).toBe(false);
  await expect(repo.create({...input,title:'Changed'},actor,'same-start')).rejects.toMatchObject({statusCode:409});
});
test('list and inbox include all tenant publication versions and resolve reader/action policy in SQL',async()=>{
  const pool={query:vi.fn(async()=>({rows:[],rowCount:0}))} as unknown as Pool;
  const list=vi.fn(async()=>[def,{...def,version:2,transitions:[{...def.transitions[0],id:'revise',from:'review'}]}]);
  const repo=await workflowDatabase(pool,{get:async()=>def,list});
  await repo.listPage!(actor,true,{limit:10,offset:0,q:''});
  expect(list).toHaveBeenCalledWith('org-a');
  const call=vi.mocked(pool.query).mock.calls.at(-1)!;
  expect(call[1]).toEqual(expect.arrayContaining([['hr-request:1','hr-request:2'],1,2,'draft','review']));
});

test('batch validates before connecting and rolls back a late collision on its single client',async()=>{
 const {definitionDatabase}=await import('./registry-database.js');
 const query=vi.fn(async(sql:string,values?:unknown[])=>{
 if (!sql.startsWith('INSERT')) return {rows:[],rowCount:0};
 if(values?.[1]==='z-conflict') return {rows:[],rowCount:0};
 return {rows:[{id:values?.[1],revision:1,definition:JSON.parse(values?.[2] as string),createdBy:'alice',updatedBy:'alice',createdAt:'2026-10-13',updatedAt:'2026-10-13'}],rowCount:1};
 });
 const client={query,release:vi.fn()};
 const pool={query:vi.fn(async()=>({rows:[],rowCount:0})),connect:vi.fn(async()=>client)} as unknown as Pool;
 const registry=await definitionDatabase(pool);const {version:_,...draft}=def;
 await expect(registry.createMany([{...draft,title:''}],actor)).rejects.toMatchObject({statusCode:400});
 expect(pool.connect).not.toHaveBeenCalled();
 await expect(registry.createMany([{...draft,id:'z-conflict'},{...draft,id:'a-new'}],actor)).rejects.toMatchObject({statusCode:409});
 expect(query.mock.calls.map(([sql])=>sql.startsWith('INSERT')?'INSERT':sql)).toEqual(['BEGIN','INSERT','INSERT','ROLLBACK']);
 expect(query.mock.calls.filter(([sql])=>sql.startsWith('INSERT')).map(([,values])=>values?.[1])).toEqual(['a-new','z-conflict']);
 expect(client.release).toHaveBeenCalledOnce();expect(pool.query).toHaveBeenCalledOnce();
 query.mockClear();
 expect((await registry.createMany([{...draft,id:'b-new'},{...draft,id:'a-new'}],actor)).map(d=>d.id)).toEqual(['b-new','a-new']);
 expect(query.mock.calls.at(-1)?.[0]).toBe('COMMIT');
});
