/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import {createHash} from 'node:crypto';
import {expect,test,vi} from 'vitest';
import type {Pool} from 'pg';
import type {WorkflowDefinition} from '@dx/contracts';
import {eventsDatabase} from './database.js';
import {canonicalEvent} from './policy.js';

const actor={subject:'source',organizationId:'org-a',roles:['workflow:event:receive','workflow:start','employee']};
const event={eventId:'external/1',eventType:'order-created',occurredAt:'2026-10-14T01:02:03Z',data:{note:'hello'}};
const subscription={id:'sub-one',revision:2,eventType:event.eventType,sourceSubject:'source',definitionId:'event-flow',definitionVersion:3,title:{source:'literal',value:'Order'},input:{note:{source:'event',field:'note'}},enabled:true};
const def:WorkflowDefinition={id:'event-flow',version:3,title:'Event flow',startRole:'employee',initialState:'draft',startFields:{note:'text'},readerRoles:[],transitions:[]};
function fixture(options:{inactive?:boolean;sourceRoles?:string[];receipt?:unknown;subscriptions?:unknown[];failProvenance?:boolean}={}) {
 const query=vi.fn(async(sql:string)=>{
  if(sql.includes('FROM directory_people'))return {rows:options.inactive?[]:[{subject:'source',roles:options.sourceRoles??['workflow:start','employee']}],rowCount:options.inactive?0:1};
  if(sql.startsWith('SELECT fingerprint,result FROM workflow_inbound_events'))return {rows:options.receipt?[options.receipt]:[],rowCount:options.receipt?1:0};
  if(sql.includes('FROM workflow_event_subscriptions'))return {rows:options.subscriptions??[subscription],rowCount:1};
  if(sql.startsWith('INSERT INTO workflow_event_provenance')&&options.failProvenance)throw new Error('forced provenance failure');
  return {rows:[],rowCount:0};
 });
 const client={query,release:vi.fn()};
 const pool={query:vi.fn(async()=>({rows:[],rowCount:0})),connect:vi.fn(async()=>client)} as unknown as Pool;
 const get=vi.fn(async()=>def);
 const createWithClient=vi.fn(async()=>({id:'run-1'}));
 return {query,client,pool,get,createWithClient,options};
}
test('dispatch uses current source actor, pinned definition and one client for provenance and receipt',async()=>{
 const f=fixture();const repo=await eventsDatabase(f.pool,{get:f.get},{createWithClient:f.createWithClient} as never);
 const result=await repo.receive(event,actor);
 expect(result).toEqual({eventId:event.eventId,status:'accepted',runs:[{subscriptionId:subscription.id,runId:'run-1'}]});
 expect(f.createWithClient).toHaveBeenCalledWith(f.client,{definitionId:def.id,definitionVersion:3,title:'Order',input:{note:'hello'}},actor,expect.stringMatching(/^[a-f0-9]{64}$/));
 expect(f.get).toHaveBeenCalledWith('org-a',def.id,3,f.client);
 expect(f.pool.connect).toHaveBeenCalledOnce();
 expect(f.query.mock.calls.at(-1)?.[0]).toBe('COMMIT');
 expect(f.query.mock.calls.some(([sql])=>sql.includes('FOR SHARE'))).toBe(true);
});
test('replay compares canonical fingerprint only after current source authorization',async()=>{
 const receipt={eventId:event.eventId,status:'accepted',runs:[]};
 const f=fixture({receipt:{fingerprint:createHash('sha256').update(canonicalEvent(event)).digest('hex'),result:receipt}});
 const repo=await eventsDatabase(f.pool,{get:f.get},{createWithClient:f.createWithClient} as never);
 expect(await repo.receive(event,actor)).toEqual(receipt);
 expect(f.createWithClient).not.toHaveBeenCalled();
 await expect(repo.receive({...event,data:{note:'changed'}},actor)).rejects.toMatchObject({statusCode:409});
 f.options.inactive=true;
 await expect(repo.receive(event,actor)).rejects.toMatchObject({statusCode:403});
});
test('a late provenance failure rolls back every derived run and never consumes the event ID',async()=>{
 const f=fixture({subscriptions:[subscription,{...subscription,id:'sub-two'}],failProvenance:true});
 const repo=await eventsDatabase(f.pool,{get:f.get},{createWithClient:f.createWithClient} as never);
 await expect(repo.receive(event,actor)).rejects.toThrow('forced provenance failure');
 expect(f.createWithClient).toHaveBeenCalledTimes(2);
 expect(f.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
 expect(f.query.mock.calls.some(([sql])=>sql==='COMMIT')).toBe(false);
});
test('missing mapped field and missing current JWT start role leave no event receipt',async()=>{
 const f=fixture();const repo=await eventsDatabase(f.pool,{get:f.get},{createWithClient:f.createWithClient} as never);
 await expect(repo.receive({...event,data:{}},actor)).rejects.toMatchObject({statusCode:400});
 await expect(repo.receive(event,{...actor,roles:['workflow:event:receive']})).rejects.toMatchObject({statusCode:403});
 expect(f.createWithClient).not.toHaveBeenCalled();
 expect(f.query.mock.calls.some(([sql])=>sql.startsWith('INSERT INTO workflow_inbound_events'))).toBe(false);
});
test('a revoked current directory role denies a new event despite an otherwise valid source JWT',async()=>{
 const f=fixture({sourceRoles:['workflow:start']});const repo=await eventsDatabase(f.pool,{get:f.get},{createWithClient:f.createWithClient} as never);
 await expect(repo.receive(event,actor)).rejects.toMatchObject({statusCode:403});
 expect(f.createWithClient).not.toHaveBeenCalled();
 expect(f.query.mock.calls.some(([sql])=>sql.startsWith('INSERT INTO workflow_inbound_events'))).toBe(false);
});
test('zero matches is durably accepted without requiring any start capability',async()=>{
 const f=fixture({subscriptions:[]});const repo=await eventsDatabase(f.pool,{get:f.get},{createWithClient:f.createWithClient} as never);
 expect(await repo.receive(event,{...actor,roles:['workflow:event:receive']})).toEqual({eventId:event.eventId,status:'accepted',runs:[]});
 expect(f.createWithClient).not.toHaveBeenCalled();
});

function mutationFixture() {
 const state:{existing?:unknown;receipt?:unknown;sourceRoles:string[];count:number;missingReference:boolean;failReceipt:boolean}={sourceRoles:['workflow:start','employee'],count:0,missingReference:false,failReceipt:false};
 const query=vi.fn(async(sql:string,values?:unknown[])=>{
  if(sql.includes('FROM directory_people'))return {rows:[{roles:state.sourceRoles}],rowCount:1};
  if(sql.startsWith('SELECT fingerprint,result'))return {rows:state.receipt?[state.receipt]:[],rowCount:state.receipt?1:0};
  if(sql.startsWith('SELECT count'))return {rows:[{count:state.count}],rowCount:1};
  if(sql.includes('FROM workflow_event_subscriptions'))return {rows:state.existing?[state.existing]:[],rowCount:state.existing?1:0};
  if(sql.includes('FROM workflow_references'))return {rows:[],rowCount:state.missingReference?0:1};
  if(sql.startsWith('INSERT INTO workflow_event_subscriptions')||sql.startsWith('UPDATE workflow_event_subscriptions'))return {rows:[{...subscription,revision:values?.[9]}],rowCount:1};
  if(sql.startsWith('INSERT INTO workflow_event_subscription_receipts')) {
   if(state.failReceipt)throw new Error('forced mutation receipt failure');
   state.receipt={fingerprint:values?.[3],result:JSON.parse(values?.[4] as string)};
  }
  return {rows:[],rowCount:0};
 });
 const client={query,release:vi.fn()};
 const pool={query:vi.fn(async()=>({rows:[],rowCount:0})),connect:vi.fn(async()=>client)} as unknown as Pool;
 const get=vi.fn(async()=>def);
 return {state,query,client,pool,get};
}
const designer={subject:'designer',organizationId:'org-a',roles:['workflow:design','workflow:integrate','workflow:start','employee']};
const {revision:_,...newSubscription}=subscription;
test('subscription receipt is canonical and a successful mutation atomically records revision version and audit',async()=>{
 const f=mutationFixture();const repo=await eventsDatabase(f.pool,{get:f.get},{});
 const result=await repo.createSubscription(newSubscription as never,designer,'create-one');
 expect(result.revision).toBe(1);
 expect(f.get).toHaveBeenCalledWith('org-a',def.id,3,f.client);
 expect(f.query.mock.calls.some(([sql])=>sql.startsWith('INSERT INTO workflow_event_subscription_versions'))).toBe(true);
 expect(f.query.mock.calls.some(([sql])=>sql.startsWith('INSERT INTO workflow_event_subscription_audit'))).toBe(true);
 f.query.mockClear();
 expect(await repo.createSubscription({...newSubscription,input:{note:{field:'note',source:'event'}}} as never,designer,'create-one')).toEqual(result);
 expect(f.query.mock.calls.some(([sql])=>sql.startsWith('INSERT'))).toBe(false);
 await expect(repo.createSubscription({...newSubscription,title:{source:'literal',value:'Different'}} as never,designer,'create-one')).rejects.toMatchObject({statusCode:409});
});
test('subscription checks source metadata rather than inheriting designer start authority',async()=>{
 const f=mutationFixture();f.state.sourceRoles=[];
 const repo=await eventsDatabase(f.pool,{get:f.get},{});
 await expect(repo.createSubscription(newSubscription as never,designer,'create-one')).rejects.toMatchObject({statusCode:403});
 expect(f.query.mock.calls.some(([sql])=>sql.startsWith('INSERT'))).toBe(false);
});
test('subscription rejects stale revision, over-limit matches, undeclared fields and invalid literal references',async()=>{
 const f=mutationFixture();const repo=await eventsDatabase(f.pool,{get:f.get},{});
 f.state.existing=subscription;
 await expect(repo.updateSubscription(subscription.id,{...newSubscription,expectedRevision:1} as never,designer,'update-one')).rejects.toMatchObject({statusCode:409});
 f.state.existing=undefined;f.state.count=10;
 await expect(repo.createSubscription(newSubscription as never,designer,'create-one')).rejects.toMatchObject({statusCode:409});
 f.state.count=0;
 await expect(repo.createSubscription({...newSubscription,input:{unexpected:{source:'event',field:'note'}}} as never,designer,'create-two')).rejects.toMatchObject({statusCode:400});
 f.get.mockImplementation(async()=>({...def,startFields:{location:'location'}} as WorkflowDefinition));
 f.state.missingReference=true;
 await expect(repo.createSubscription({...newSubscription,input:{location:{source:'literal',value:'missing'}}} as never,designer,'create-three')).rejects.toMatchObject({statusCode:400});
 expect(f.query.mock.calls.some(([sql])=>sql.startsWith('INSERT'))).toBe(false);
});
test('subscription mutation receipt failure rolls back snapshot and audit too',async()=>{
 const f=mutationFixture();f.state.failReceipt=true;
 const repo=await eventsDatabase(f.pool,{get:f.get},{});
 await expect(repo.createSubscription(newSubscription as never,designer,'create-one')).rejects.toThrow('forced mutation receipt failure');
 expect(f.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
 expect(f.query.mock.calls.some(([sql])=>sql==='COMMIT')).toBe(false);
});
