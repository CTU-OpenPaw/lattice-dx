/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import {test,expect,vi} from 'vitest';
import type {Pool,PoolClient} from 'pg';
import type {WorkflowActor,WorkflowDefinition,WorkflowRun} from '@dx/contracts';
import {timerDatabase} from './timer-database.js';
const actor:WorkflowActor={subject:'service',organizationId:'org',roles:['workflow:service','automation']};
const run={id:'run',recordId:'run',organizationId:'org',definitionId:'timer-test',definitionVersion:1,ownerId:'owner',version:2,state:'scheduled',status:'active',data:{},title:'Run',createdAt:'2026-01-01',updatedAt:'2026-01-01'} as WorkflowRun;
const timer={id:'timer',run_id:'run',organization_id:'org',definition_id:'timer-test',definition_version:1,run_version:2,transition_id:'execute',service_id:'service',status:'pending',attempts:0,input:{},due:true};
const def:WorkflowDefinition={id:'timer-test',version:1,title:'Timer',startRole:'employee',initialState:'scheduled',startFields:{},readerRoles:['automation'],transitions:[{id:'execute',from:'scheduled',to:'done',role:'automation',execution:'service',fields:{}}]};
function fixture(options:{error?:unknown;locked?:boolean;row?:WorkflowRun;timer?:typeof timer}={}) {
 const query=vi.fn(async(sql:string)=>{
  if(sql.includes('FROM workflow_runs'))return {rows:options.locked?[]:[options.row??run],rowCount:1};
  if(sql.includes('FROM workflow_timers'))return {rows:[options.timer??timer],rowCount:1};
  if(sql.includes('FROM workflow_services'))return {rows:[{subject:'service'}],rowCount:1};
  if(sql.includes('FROM directory_people'))return {rows:[{subject:'service',roles:actor.roles}],rowCount:1};
  return {rows:[],rowCount:0};
 });
 const client={query} as unknown as PoolClient;
 const pool={query:vi.fn(async()=>({rows:[{id:'timer',run_id:'run'}]}))} as unknown as Pool;
 const transitionWithClient=vi.fn(async()=>{if(options.error)throw options.error;return {...run,version:3,state:'done'};});
 const transaction=async<T>(fn:(client:PoolClient)=>Promise<T>)=>fn(client);
 const definition=vi.fn(async()=>def);
 const store=timerDatabase({pool,transaction,get:async()=>run,definition,columns:'*',serialize:r=>r,transitionWithClient});
 return {store,query,pool,transitionWithClient,definition,client};
}
test('tick uses run then timer locks and one supplied client, atomically storing command result',async()=>{
 const f=fixture();expect(await f.store.tickOne()).toEqual({timerId:'timer',status:'succeeded'});
 expect(f.transitionWithClient).toHaveBeenCalledWith(f.client,'run',{action:'execute',expectedVersion:2,input:{}},actor,'timer:timer',{timerId:'timer'});
 expect(f.definition).toHaveBeenCalledWith(run,f.client);
 expect(f.pool.query).toHaveBeenCalledTimes(1);
 const calls=f.query.mock.calls.map(c=>c[0]);expect(calls.findIndex(c=>c.includes('FROM workflow_runs'))).toBeLessThan(calls.findIndex(c=>c.includes('FROM workflow_timers')));
 expect(calls.some(c=>c.includes("receipt=$2"))).toBe(true);
});
test('a busy run is skipped without touching timer or executing a transition',async()=>{
 const f=fixture({locked:true});expect(await f.store.tickOne()).toBeUndefined();expect(f.transitionWithClient).not.toHaveBeenCalled();expect(f.query.mock.calls.some(c=>c[0].includes('FROM workflow_timers'))).toBe(false);
});
test('transient execution rolls back step effects before recording bounded retry, max three',async()=>{
 for(const attempts of [0,1,2]) {
  const f=fixture({error:{code:'40001',message:'do not persist'},timer:{...timer,attempts}});
  expect(await f.store.tickOne()).toEqual({timerId:'timer',status:attempts<2?'pending':'failed'});
  const calls=f.query.mock.calls;const rollback=calls.findIndex(c=>c[0]==='ROLLBACK TO SAVEPOINT timer_attempt');const write=calls.findIndex(c=>c[0].includes('last_error_code=$4'));
  expect(rollback).toBeGreaterThan(-1);expect(write).toBeGreaterThan(rollback);
  expect((calls[write] as unknown[])[1]).toEqual(['timer',attempts<2?'pending':'failed',attempts+1,'database_transient',5*2**attempts]);
 }
});
test('stale pin or cancelled run fails before service transition invocation',async()=>{
 for(const row of [{...run,status:'cancelled' as const},{...run,version:3},{...run,definitionVersion:2}]) {
  const f=fixture({row});expect(await f.store.tickOne()).toEqual({timerId:'timer',status:'failed'});expect(f.transitionWithClient).not.toHaveBeenCalled();
 }
});

test('retry checks fresh service block capabilities before resetting or saving a receipt',async()=>{
 let roles=['workflow:service','automation'];
 const failed={...timer,status:'failed',attempts:1};
 const timerResult={id:'timer',runId:'run',definitionId:'timer-test',definitionVersion:1,runVersion:2,stepId:'record',serviceId:'service',transitionId:'execute',status:'pending',attempts:0,lastErrorCode:null,dueAt:'2026-01-01',availableAt:'2026-01-01',createdAt:'2026-01-01',completedAt:null,receipt:null};
 const targetDefinition:WorkflowDefinition={...def,transitions:[{...def.transitions[0],steps:[{id:'record',action:'records.create',input:{title:{source:'literal',value:'Created by service'}}}]}]};
 const query=vi.fn(async(sql:string)=>{
  if(sql.includes('FROM workflow_runs'))return {rows:[run],rowCount:1};
  if(sql.startsWith('SELECT * FROM workflow_timers'))return {rows:[failed],rowCount:1};
  if(sql.includes('FROM workflow_services'))return {rows:[{subject:'service'}],rowCount:1};
  if(sql.includes('FROM directory_people'))return {rows:[{subject:'service',roles}],rowCount:1};
  if(sql.startsWith('UPDATE workflow_timers'))return {rows:[timerResult],rowCount:1};
  return {rows:[],rowCount:0};
 });
 const client={query} as unknown as PoolClient;
 const store=timerDatabase({pool:{} as Pool,transaction:async fn=>fn(client),get:async()=>run,definition:async()=>targetDefinition,columns:'*',serialize:r=>r,transitionWithClient:vi.fn()});
 const admin={...actor,subject:'admin',roles:['workflow:sync','automation']};
 await expect(store.retryTimer('run','timer',2,admin,'retry')).rejects.toMatchObject({statusCode:403});
 expect(query.mock.calls.some(c=>c[0].startsWith('UPDATE workflow_timers')||c[0].startsWith('INSERT INTO workflow_timer_commands'))).toBe(false);
 roles=[...roles,'records:write'];query.mockClear();
 expect(await store.retryTimer('run','timer',2,admin,'retry')).toMatchObject({id:'timer',status:'pending',attempts:0});
 expect(query.mock.calls.some(c=>c[0].startsWith('UPDATE workflow_timers'))).toBe(true);
 expect(query.mock.calls.some(c=>c[0].startsWith('INSERT INTO workflow_timer_commands'))).toBe(true);
});
