// SPDX-License-Identifier: Apache-2.0
// Uses a whole disposable database because context reads explicitly address public.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {generateKeyPair,SignJWT} from 'jose';
import {createApi} from '../apps/api/src/app.js';
import {entityDatabase} from '../apps/api/src/entities/database.js';
import {contextLinksDatabase} from '../apps/api/src/context-links/database.js';
import {ngsiLdDatabase} from '../apps/api/src/ngsi-ld/database.js';
import {parseNotification} from '../apps/api/src/ngsi-ld/policy.js';

const database='ngsi_integration_accept_'+randomUUID().replaceAll('-','');
const control=new Pool({connectionString:process.env.DATABASE_URL,max:1});
let pool:Pool|undefined,app:ReturnType<typeof createApi>|undefined,created=false;
async function main(){
 try{
  assert.match(database,/^ngsi_integration_accept_[a-f0-9]{32}$/);
  await control.query('CREATE DATABASE '+database);created=true;
  const url=new URL(process.env.DATABASE_URL!);url.pathname='/'+database;
  pool=new Pool({connectionString:url.href,max:6,statement_timeout:10000,connectionTimeoutMillis:5000});
  assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name,database);
  const repository=await ngsiLdDatabase(pool),entities=await entityDatabase(pool);
  const contextLinks=await contextLinksDatabase(pool,entities,{projectionEnabled:true});
  const tenant='accept-a',subscriptionId='urn:ngsi-ld:Subscription:accept-a:integration',token='acceptance-token-not-a-real-secret-0001';
  const t=Date.now()-10000;
  const raw=(businessId:string,status='ready',at=t)=>({id:`urn:ngsi-ld:Asset:${tenant}:${businessId}`,type:'Asset',businessId:{type:'Property',value:businessId},organizationId:{type:'Property',value:tenant},status:{type:'Property',value:status,observedAt:new Date(at).toISOString()}});
  const message=(data:unknown[])=>({id:'urn:ngsi-ld:Notification:'+randomUUID(),type:'Notification',subscriptionId,data});
  const notification=(data:unknown[])=>parseNotification(message(data),tenant,subscriptionId);
  const id=(businessId:string)=>`urn:ngsi-ld:Asset:${tenant}:${businessId}`;
  await Promise.all([repository.apply(tenant,notification([raw('first','in_use',t+2000)])),repository.apply(tenant,notification([raw('first','ready',t)]))]);
  assert.equal((await repository.find(tenant,id('first')))!.status,'in_use');
  const conflicts=await Promise.allSettled(['ready','repair'].map(status=>repository.apply(tenant,notification([raw('equal',status)]))));
  assert.equal(conflicts.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(conflicts.filter(r=>r.status==='rejected'&&r.reason.statusCode===409).length,1);
  await Promise.all([repository.apply(tenant,notification([raw('batch-b'),raw('batch-a')])),repository.apply(tenant,notification([raw('batch-a','repair',t+2000),raw('batch-b','repair',t+2000)]))]);
  for(const name of ['batch-a','batch-b'])assert.equal((await repository.find(tenant,id(name)))!.status,'repair');
  await repository.apply(tenant,notification([raw('rollback-z')]));
  await assert.rejects(()=>repository.apply(tenant,notification([raw('rollback-a'),raw('rollback-z','repair')])),(e:any)=>e.statusCode===409);
  assert.equal(await repository.find(tenant,id('rollback-a')),undefined);
  assert.equal((await repository.find(tenant,id('rollback-z')))!.status,'ready');
  const keys=await generateKeyPair('RS256');
  const jwt=async(subject:string,org=tenant)=>new SignJWT({organization_id:org,realm_access:{roles:['data:read','data:design']}}).setSubject(subject).setProtectedHeader({alg:'RS256'}).setIssuer('ngsi-acceptance').setAudience('api').setExpirationTime('1h').sign(keys.privateKey);
  app=createApi({workerUrl:'http://unused.invalid',identity:{issuer:'ngsi-acceptance',audience:'api',key:async()=>keys.publicKey},entities,contextLinks,ngsiLd:{token,tenant,subscriptionId,repository}});
  const scope={actorId:'owner',organizationId:tenant};
  await entities.createSchema(scope,{id:'asset',title:'Asset',fields:{},relations:{}});await entities.publishSchema(scope,'asset',1);
  const entity=await entities.create(scope,{schemaId:'asset',title:'Mapped Asset',attributes:{}},'create');
  const owner={authorization:'Bearer '+await jwt('owner')};
  const link=await app.inject({method:'PUT',url:`/v1/entities/${entity.id}/context-links/ngsi-ld`,headers:{...owner,'idempotency-key':'link'},payload:{externalId:id('http'),expectedRevision:0}});assert.equal(link.statusCode,200);
  const receiver=await app.inject({method:'POST',url:'/v1/integrations/ngsi-ld/notifications',headers:{'x-lattice-broker-token':token,'ngsild-tenant':tenant},payload:message([raw('http','repair')])});assert.equal(receiver.statusCode,200);
  const read=await app.inject({url:`/v1/entities/${entity.id}/context`,headers:owner});assert.equal(read.statusCode,200);assert.equal(read.json().observation.status,'repair');
  for(const [subject,org] of [['outsider',tenant],['owner','accept-b']]){
   const denied=await app.inject({url:`/v1/entities/${entity.id}/context`,headers:{authorization:'Bearer '+await jwt(subject,org)}});assert.equal(denied.statusCode,404);
  }
  const noSecret=await app.inject({method:'POST',url:'/v1/integrations/ngsi-ld/notifications',payload:message([raw('unauthorized')])});assert.equal(noSecret.statusCode,403);
  console.log(JSON.stringify({result:'PASS',checks:['concurrent-first-insert-newest-wins','equal-time-conflict','opposite-batch-order','batch-rollback','signed-user-context-from-real-receiver','same-tenant-and-foreign-read-denial','missing-receiver-secret'],database,broker:'SIMULATED notification; actual Orion delivery is a separate smoke'}));
 }finally{
  await app?.close();await pool?.end();
  try{if(created){assert.match(database,/^ngsi_integration_accept_[a-f0-9]{32}$/);await control.query('DROP DATABASE '+database);}}finally{await control.end();}
 }
}
main().catch(()=>{console.error('NGSI integration acceptance failed; raw credentials and rows omitted.');process.exitCode=1;});
