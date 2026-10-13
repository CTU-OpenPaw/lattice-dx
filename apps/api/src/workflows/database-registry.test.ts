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
