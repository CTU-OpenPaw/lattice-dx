// SPDX-License-Identifier: Apache-2.0
import {describe,it,expect} from 'vitest';
import Fastify from 'fastify';
import {generateKeyPair,SignJWT} from 'jose';
import {registerOperations} from './routes.js';
import {parseCutoff,correlationId} from './policy.js';
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
  expect(correlationId('team-request-1')).toBe('team-request-1');
  for(const value of ['line\nbreak','x'.repeat(129),['duplicate']])expect(correlationId(value)).toMatch(/^[a-f0-9-]{36}$/);
 });
});
