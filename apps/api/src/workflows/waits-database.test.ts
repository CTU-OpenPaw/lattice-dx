// SPDX-License-Identifier: Apache-2.0
import { expect, test, vi } from 'vitest';
import type { Pool } from 'pg';
import { waitDatabase } from './waits-database.js';
const actor={subject:'assigned',organizationId:'org-a',roles:['tasks:decide']};
function fixture(kind='task') {
  const wait={id:'resource',run_id:'run',organization_id:'org-a',version:2,kind,assignee_id:'assigned',connector_id:'n8n',status:'pending',deadline:'2099-01-01',expired:false,config:{stepId:'step',successState:'ready',failureState:'failed',resultFields:{note:'text'},timeoutSeconds:20}};
  const run={id:'run',state:'waiting',version:2};
  const query=vi.fn(async(sql:string,values?:unknown[])=>{
    if(sql.startsWith('SELECT run_id,organization_id')) return {rows:[wait],rowCount:1};
    if(sql.startsWith('SELECT id,state,version')) return {rows:[run],rowCount:1};
    if(sql.startsWith('SELECT *,deadline')) return {rows:[wait],rowCount:1};
    if(sql.startsWith('SELECT assignee_id')) return {rows:[{assignee_id:'assigned',organization_id:'org-a'}],rowCount:1};
    if(sql.startsWith('SELECT payload')) return {rows:[{payload:{eventType:'connector.dispatch',connectorId:'n8n'}}],rowCount:1};
    if(sql.startsWith('UPDATE workflow_runs')) return {rows:[{version:3}],rowCount:1};
    if(sql.startsWith('UPDATE foundation_tasks')) return {rows:[{id:'resource'}],rowCount:1};
    if(sql.startsWith('UPDATE workflow_waits SET')) Object.assign(wait,{status:values![0],completion_key:values![1],completion_fingerprint:values![2],completion_actor:values![3],receipt:JSON.parse(values![4] as string)});
    return {rows:[],rowCount:0};
  });
  const client={query,release:vi.fn()};
  const pool={connect:vi.fn(async()=>client),query:vi.fn()} as unknown as Pool;
  return {repository:waitDatabase(pool,vi.fn()),query,wait,pool};
}
test('completion locks run before wait, persists minimal receipt and checks authority before replay',async()=>{
  const {repository,query}=fixture();
  const value={status:'succeeded' as const,result:{note:'verified'}};
  const receipt=await repository.completeWait('resource',value,actor,'key');
  expect(receipt).toEqual({waitId:'resource',runId:'run',status:'succeeded',state:'ready',version:3});
  const sql=query.mock.calls.map(([sql])=>sql);
  expect(sql.findIndex(sql=>sql.includes('workflow_runs')&&sql.includes('FOR UPDATE'))).toBeLessThan(sql.findIndex(sql=>sql.includes('workflow_waits')&&sql.includes('FOR UPDATE')));
  expect(await repository.completeWait('resource',value,actor,'key')).toEqual(receipt);
  await expect(repository.completeWait('resource',value,{...actor,roles:[]},'key')).rejects.toMatchObject({statusCode:403});
  await expect(repository.completeWait('resource',{...value,result:{note:'changed'}},actor,'key')).rejects.toMatchObject({statusCode:409});
  expect(query.mock.calls.filter(([sql])=>sql.startsWith('UPDATE workflow_runs'))).toHaveLength(1);
});
test('wrong connector, invalid fields and deadlines do not mutate workflow',async()=>{
  for(const variant of ['wrong-connector','invalid-field','expired']) {
    const {repository,query,wait}=fixture('connector');
    if(variant==='expired') {wait.deadline='2000-01-01';wait.expired=true;}
    const signed={...actor,roles:['workflow:callback',variant==='wrong-connector'?'connector:agent':'connector:n8n']};
    await expect(repository.completeWait('resource',{status:'succeeded',result:variant==='invalid-field'?{ownerId:'attacker'}:{note:'verified'}},signed,'key')).rejects.toMatchObject({statusCode:variant==='wrong-connector'?403:variant==='invalid-field'?400:409});
    expect(query.mock.calls.some(([sql])=>sql.startsWith('UPDATE'))).toBe(false);
    expect(query.mock.calls.some(([sql])=>sql==='ROLLBACK')).toBe(true);
  }
});
test('timeout settles once with failure state and no follow-on blocks',async()=>{
  const {repository,query,wait,pool}=fixture();
  wait.expired=true;
  vi.mocked(pool.query).mockResolvedValue({rows:[{id:'resource'}],rowCount:1,command:'SELECT',oid:0,fields:[]} as never);
  expect(await repository.expireWaits()).toBe(1);
  expect(wait.status).toBe('timed_out');
  expect(await repository.expireWaits()).toBe(0);
  expect(query.mock.calls.filter(([sql])=>sql.startsWith('UPDATE workflow_runs'))).toHaveLength(1);
  expect(query.mock.calls.some(([sql])=>sql.startsWith('INSERT INTO workflow_jobs')||sql.startsWith('INSERT INTO foundation_tasks'))).toBe(false);
  await expect(repository.completeWait('resource',{status:'succeeded',result:{note:'late'}},actor,'late')).rejects.toMatchObject({statusCode:409});
});
test('wait evidence is reader scoped before listing persisted failure details',async()=>{
  const evidence={result:{},reason:'Provisioning failed'};
  const query=vi.fn(async()=>({rows:[{id:'resource',runId:'run',version:2,kind:'task',status:'failed',config:{},deadline:'2099-01-01',createdAt:'2026-10-13',completedAt:'2026-10-13',evidence}],rowCount:1}));
  const pool={query} as unknown as Pool;
  const get=vi.fn(async()=>{throw new Error('No workflow read access');});
  const repository=waitDatabase(pool,get);
  const page={limit:10,offset:0,q:''};
  await expect(repository.listWaits('run',actor,page)).rejects.toThrow('No workflow read access');
  expect(query).not.toHaveBeenCalled();
  get.mockResolvedValue(undefined as never);
  expect((await repository.listWaits('run',actor,page)).items[0].evidence).toEqual(evidence);
  expect(get).toHaveBeenCalledWith('run',actor);
  expect(query.mock.calls[0]).toBeDefined();
});
