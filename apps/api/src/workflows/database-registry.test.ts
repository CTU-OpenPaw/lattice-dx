/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
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

test('internal pinned start uses the supplied client without a nested transaction or pool query',async()=>{
 const client={query:vi.fn(async(sql:string)=>({rows:sql.startsWith('INSERT INTO workflow_runs')?[{...run,definitionVersion:3}]:[],rowCount:0})),release:vi.fn()};
 const pool={query:vi.fn(async()=>({rows:[],rowCount:0})),connect:vi.fn()} as unknown as Pool;
 const get=vi.fn(async()=>({...def,version:3}));
 const repo=await workflowDatabase(pool,{get,list:async()=>[def]});
 vi.mocked(pool.query).mockClear();
 expect(repo.createWithClient).toBeTypeOf('function');
 const created=await repo.createWithClient!(client as never,{definitionId:def.id,definitionVersion:3,title:run.title,input:run.data},actor,'event-start');
 expect(created.definitionVersion).toBe(3);
 expect(get).toHaveBeenCalledWith('org-a',def.id,3,client);
 expect(pool.connect).not.toHaveBeenCalled();
 expect(pool.query).not.toHaveBeenCalled();
 expect(client.query.mock.calls.some(([sql])=>['BEGIN','COMMIT','ROLLBACK'].includes(sql))).toBe(false);
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

test('same-client transition keeps current read authorization before replay and refuses public service mode',async()=>{
 const receipt={...run,version:2,state:'done'};
 const command={action:'submit',expectedVersion:1,input:{}};
 const fingerprint=createHash('sha256').update(JSON.stringify(command)).digest('hex');
 const query=vi.fn(async(sql:string)=>({rows:sql.includes('FROM workflow_runs')?[run]:sql.startsWith('SELECT actor_id')?[{actor_id:actor.subject,fingerprint,result:receipt}]:[],rowCount:0}));
 const client={query} as never;
 const pool={query:vi.fn(async()=>({rows:[],rowCount:0})),connect:vi.fn()} as unknown as Pool;
 let current=def;
 const get=vi.fn(async()=>current);
 const repo=await workflowDatabase(pool,{get,list:async()=>[def]});
 vi.mocked(pool.query).mockClear();
 expect(await repo.transitionWithClient!(client,run.id,command,actor,'receipt')).toEqual(receipt);
 expect(get).toHaveBeenCalledWith(actor.organizationId,def.id,def.version,client);
 expect(pool.query).not.toHaveBeenCalled();expect(pool.connect).not.toHaveBeenCalled();
 current={...def,transitions:[{...def.transitions[0],execution:'service'}]};
 await expect(repo.transitionWithClient!(client,run.id,command,actor,'receipt')).rejects.toMatchObject({statusCode:403});
 current={...def,readerRoles:[]};
 await expect(repo.transitionWithClient!(client,run.id,command,{...actor,subject:'other'},'receipt')).rejects.toMatchObject({statusCode:404});
});
