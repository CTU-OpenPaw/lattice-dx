/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import {describe,it,expect} from 'vitest';
import Fastify from 'fastify';
import {generateKeyPair,SignJWT} from 'jose';
import {registerOperations} from './routes.js';
import {parseCutoff,correlationId} from './policy.js';
import {createApi} from '../app.js';
import {createTelemetry} from './telemetry.js';
describe('core operation boundaries',()=>{
 it('keeps readiness fail closed when stores or DB are unavailable',async()=>{
  const app=Fastify();registerOperations(app,{coreConfigured:false});
  expect((await app.inject({url:'/ready'})).statusCode).toBe(503);await app.close();
 });
 it('checks live repository readiness without exposing failure details',async()=>{
  const {publicKey}=await generateKeyPair('RS256');
  const identity={issuer:'test',audience:'api',key:async()=>publicKey};
  for(const state of [true,false,'failure']){
   const app=Fastify();registerOperations(app,{identity,coreConfigured:true,operations:{ready:async()=>{if(state==='failure')throw new Error('private DSN');return state===true;},retentionPreview:async()=>{throw new Error('unused');}}});
   const reply=await app.inject({url:'/ready'});expect(reply.statusCode).toBe(state===true?200:503);expect(reply.body).not.toContain('private');await app.close();
  }
 });
 it('enforces signed operator role and carries only the signed tenant into preview',async()=>{
  const {privateKey,publicKey}=await generateKeyPair('RS256');
  const identity={issuer:'https://identity.test',audience:'api',key:async()=>publicKey};
  let organization;
  const app=Fastify();registerOperations(app,{identity,coreConfigured:true,operations:{ready:async()=>true,retentionPreview:async(org,before)=>{organization=org;return {before,dryRun:true,warning:'review_only',items:[]};}}});
  const token=async(roles:string[])=>new SignJWT({organization_id:'org-a',realm_access:{roles}}).setProtectedHeader({alg:'RS256'}).setSubject('operator').setIssuer(identity.issuer).setAudience(identity.audience).setExpirationTime('5m').sign(privateKey);
  expect((await app.inject({url:'/v1/operations/diagnostics'})).statusCode).toBe(401);
  expect((await app.inject({url:'/v1/operations/diagnostics',headers:{authorization:'Bearer '+await token([])}})).statusCode).toBe(403);
  const reply=await app.inject({url:'/v1/operations/retention-preview?before=2020-01-01T00:00:00Z',headers:{authorization:'Bearer '+await token(['platform:operate'])}});
  expect(reply.statusCode).toBe(200);expect(organization).toBe('org-a');expect(reply.json().dryRun).toBe(true);await app.close();
 });
 it('reports DB reachability separately from incomplete core configuration',async()=>{
  const {privateKey,publicKey}=await generateKeyPair('RS256');
  const identity={issuer:'https://identity.test',audience:'api',key:async()=>publicKey};
  const token=await new SignJWT({organization_id:'org-a',realm_access:{roles:['platform:operate']}}).setProtectedHeader({alg:'RS256'}).setSubject('operator').setIssuer(identity.issuer).setAudience(identity.audience).setExpirationTime('5m').sign(privateKey);
  const app=Fastify();registerOperations(app,{identity,coreConfigured:false,operations:{ready:async()=>true,retentionPreview:async()=>{throw new Error('unused');}}});
  const result=await app.inject({url:'/v1/operations/diagnostics',headers:{authorization:'Bearer '+token}});
  expect(result.statusCode).toBe(503);expect(result.json().database).toBe('reachable');expect(result.json().coreConfigured).toBe(false);await app.close();
 });
 it('rejects impossible/future retention timestamps',()=>{
  for(const value of ['2026-02-30T00:00:00Z','not-a-date','9999-01-01T00:00:00Z','0000-01-01T00:00:00Z'])expect(()=>parseCutoff(value)).toThrow();
  expect(parseCutoff('2020-01-01T00:00:00Z')).toBe('2020-01-01T00:00:00.000Z');
 });
 it('does not reflect unsafe or oversized correlation input',()=>{
  const ids=['team-request-1','line\nbreak','x'.repeat(129),['duplicate']].map(correlationId);
  for(const id of ids)expect(id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  expect(new Set(ids).size).toBe(ids.length);
 });
 it('records each completed failure once and uses server correlation UUIDs',async()=>{
  const telemetry=createTelemetry();const app=createApi({workerUrl:'http://localhost',telemetry});
  const response=await app.inject({url:'/v1/records',headers:{'x-request-id':'private-caller-id'}});
  expect(response.statusCode).toBe(503);expect(response.headers['x-request-id']).toMatch(/^[a-f0-9-]{36}$/);
  expect(response.headers['x-request-id']).not.toBe('private-caller-id');
  expect(telemetry.snapshot().http).toEqual([expect.objectContaining({route:'/v1/records',statusClass:'5xx',count:1})]);
  expect(JSON.stringify(telemetry.snapshot())).not.toContain('private-caller-id');await app.close();
 });
 it('signs metrics and tenant queues and rejects query/body without leaking failures',async()=>{
  const {privateKey,publicKey}=await generateKeyPair('RS256');
  const identity={issuer:'https://identity.test',audience:'api',key:async()=>publicKey};
  const token=async(roles:string[])=>new SignJWT({organization_id:'tenant-a',realm_access:{roles}}).setProtectedHeader({alg:'RS256'}).setSubject('private-subject').setIssuer(identity.issuer).setAudience(identity.audience).setExpirationTime('5m').sign(privateKey);
  const tenants:string[]=[];let fail=false;
  const app=createApi({workerUrl:'http://localhost',identity,runtimeWorkers:{outbox:true,timers:false,waitTimeouts:false,automations:false,fileStorage:false},operations:{ready:async()=>true,retentionPreview:async()=>{throw Error('unused');},queues:async org=>{tenants.push(org);if(fail)throw Error('private DB password');return [{queue:'outbox',status:'pending',count:'2',oldestPendingAt:null}];}}});
  for(const route of ['metrics','queues']){
   const url='/v1/operations/'+route;
   expect((await app.inject({url})).statusCode).toBe(401);
   expect((await app.inject({url,headers:{authorization:'Bearer '+await token([])}})).statusCode).toBe(403);
   const headers={authorization:'Bearer '+await token(['platform:operate'])};
   expect((await app.inject({url:url+'?tenant=foreign',headers})).statusCode).toBe(400);
   expect((await app.inject({url,method:'GET',headers,payload:{private:'body'}})).statusCode).toBe(400);
   const response=await app.inject({url,headers});expect(response.statusCode).toBe(200);
   if(route==='metrics')expect(response.json().scope).toBe('process');
   else expect(response.json().workers.outbox).toBe(true);
  }
  expect(tenants).toEqual(['tenant-a']);fail=true;
  const response=await app.inject({url:'/v1/operations/queues',headers:{authorization:'Bearer '+await token(['platform:operate'])}});
  expect(response.statusCode).toBe(503);expect(response.body).not.toContain('private');await app.close();
 });
});
