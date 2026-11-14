/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

function localUrl(value){const url=new URL(value);assert.ok(['localhost','127.0.0.1','[::1]'].includes(url.hostname),'Smoke target must be loopback.');assert.equal(url.protocol,'http:');return url;}
const gateway=localUrl(process.env.STUDIO_CONTEXT_API_URL??'http://localhost:8080');
const identity=localUrl(process.env.STUDIO_CONTEXT_IDENTITY_URL??'http://localhost:8081/realms/lattice/protocol/openid-connect/token');
const actors={},tag=randomUUID().replaceAll('-',''),fixtures={moduleId:'studio-'+tag,schemaId:'studio-data-'+tag,definitionId:'studio-flow-'+tag};
let stage='login',requests=[];
async function pace(){
 const now=Date.now();requests=requests.filter(time=>time>now-61000);
 if(requests.length>=90){await delay(61000-(now-requests[0]));return pace();}
 requests.push(Date.now());
}
async function login(username){
 const response=await fetch(identity,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'password',client_id:'dx-local',username,password:process.env['STUDIO_CONTEXT_PASSWORD_'+username.toUpperCase()]??'local-'+username+'-password'}),signal:AbortSignal.timeout(15000)});
 assert.equal(response.status,200,'Existing local actor login failed: '+username);
 const {access_token:token}=await response.json();assert.equal(typeof token,'string');
 const claims=JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString());
 actors[username]={token,organizationId:claims.organization_id,roles:claims.realm_access?.roles??[]};
}
async function call(path,method='GET',body,expected=200,user='alice',key=randomUUID()){
 await pace();
 const headers={authorization:'Bearer '+actors[user].token,'Idempotency-Key':key};if(body!==undefined)headers['content-type']='application/json';
 let response;
 for(let attempt=0;attempt<3;attempt++){
  response=await fetch(new URL(path,gateway),{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(20000)});
  if(response.status!==429)break;
  await response.arrayBuffer();console.log(JSON.stringify({stage:'gateway-rate-limit',result:'waiting'}));await delay(61000);requests=[];
 }
 assert.equal(response.status,expected,method+' '+path+' returned '+response.status+'; expected '+expected);
 return response.json();
}
function error(value,code){assert.equal(value?.error?.code,code);}
try {
 for(const actor of ['alice','warehouse','bob'])await login(actor);
 assert.ok(actors.alice.roles.includes('data:read')&&actors.alice.roles.includes('data:design')&&actors.alice.roles.includes('workflow:design'));
 assert.ok(actors.warehouse.roles.includes('data:read'),'Existing warehouse needs data:read; do not reseed roles.');
 stage='capabilities-and-catalog';
 const capabilities=await call('/v1/me/capabilities');assert.equal(capabilities.version,1);assert.equal(capabilities.capabilities['context.links.manage'].available,true);
 const catalog=await call('/v1/studio/catalog');assert.equal(catalog.version,1);assert.ok(catalog.entities.fieldTypes.includes('decimal'));assert.ok(catalog.blocks.some(item=>item.id==='entities.read'));
 error(await call('/v1/studio/catalog','GET',undefined,403,'bob'),'authority_denied');
 error(await call('/v1/studio/catalog?actor=override','GET',undefined,400),'invalid_request');
 const definition={id:fixtures.definitionId,title:'Studio acceptance history',startRole:'employee',initialState:'open',startFields:{},readerRoles:[],transitions:[{id:'note',from:'open',to:'open',role:'employee',ownerOnly:true,fields:{reason:'text',privateNote:'text'}}]};
 const manifest={format:'latticedx.enterprise-module',formatVersion:1,id:fixtures.moduleId,version:'1.0.0',title:'Studio acceptance '+tag,schemas:[{id:fixtures.schemaId,title:'Studio acceptance asset',fields:{},relations:{}}],bundle:{format:'latticedx.workflow-bundle',formatVersion:1,definitions:[definition]},blocks:[],dependencies:[]};
 stage='preflight';assert.equal((await call('/v1/studio/preflight','POST',{manifest})).valid,true);
 assert.equal((await call('/v1/studio/preflight','POST',{manifest:{}})).valid,false);
 error(await call('/v1/studio/preflight','POST',{manifest,organizationId:'override'},400),'invalid_request');
 // Preflight must leave no module to read; then create only this run's unique API fixtures.
 const dependenciesPath='/v1/studio/modules/'+fixtures.moduleId+'/versions/1.0.0/dependencies';
 error(await call(dependenciesPath,'GET',undefined,404),'not_found');
 stage='unique-api-fixtures';const installed=await call('/v1/enterprise-modules/install','POST',{manifest},201);
 await call('/v1/workflow-drafts/'+fixtures.definitionId+'/publish','POST',{expectedRevision:1});
 await call('/v1/enterprise-modules/'+fixtures.moduleId+'/versions/1.0.0/enabled','POST',{expectedRevision:installed.revision,enabled:true});
 const dependencies=await call(dependenciesPath);assert.equal(dependencies.module.id,fixtures.moduleId);assert.deepEqual(dependencies.schemas,[fixtures.schemaId]);assert.equal(dependencies.workflows[0].definitionId,fixtures.definitionId);
 const entity=await call('/v1/entities','POST',{schemaId:fixtures.schemaId,title:'Studio acceptance '+tag,attributes:{}},201);fixtures.entityId=entity.id;
 const second=await call('/v1/entities','POST',{schemaId:fixtures.schemaId,title:'Studio conflict '+tag,attributes:{}},201);fixtures.secondEntityId=second.id;
 console.log(JSON.stringify({stage:'fixtures-retained',...fixtures}));
 stage='mapping-revision-replay';const base='/v1/entities/'+entity.id+'/context-links/ngsi-ld';
 assert.equal((await call(base)).mapping,null);assert.equal((await call('/v1/entities/'+entity.id+'/context')).status,'not_linked');
 const input={externalId:'urn:ngsi-ld:Asset:'+capabilities.organizationId+':studio-'+tag,expectedRevision:0},key=randomUUID();
 const mapping=await call(base,'PUT',input,200,'alice',key);assert.equal(mapping.revision,1);
 assert.deepEqual(await call(base,'PUT',input,200,'alice',key),mapping);
 error(await call(base,'PUT',{...input,externalId:input.externalId+'-changed'},409,'alice',key),'idempotency_conflict');
 error(await call(base,'PUT',input,409),'revision_conflict');
 error(await call('/v1/entities/'+second.id+'/context-links/ngsi-ld','PUT',input,409),'external_id_conflict');
 error(await call(base,'GET',undefined,404,'warehouse'),'not_found');
 error(await call('/v1/entities/'+entity.id+'/context','GET',undefined,403,'bob'),'authority_denied');
 const bobCapabilities=await call('/v1/me/capabilities','GET',undefined,200,'bob');assert.notEqual(bobCapabilities.organizationId,capabilities.organizationId);
 // Bob's403 proves role denial only. Actual row tenant isolation is checked by the isolated PostgreSQL helper.
 let tenantEvidence='isolated-postgres-helper-required';
 if(process.env.STUDIO_CONTEXT_FOREIGN_TOKEN){
  const token=process.env.STUDIO_CONTEXT_FOREIGN_TOKEN;actors.foreign={token};
  const foreign=await call('/v1/me/capabilities','GET',undefined,200,'foreign');assert.notEqual(foreign.organizationId,capabilities.organizationId);assert.equal(foreign.capabilities['context.read'].authorized,true);
  error(await call('/v1/entities/'+entity.id+'/context','GET',undefined,404,'foreign'),'not_found');tenantEvidence='authorized-foreign-jwt404';
 }
 stage='source-unavailable';const context=await call('/v1/entities/'+entity.id+'/context');assert.equal(context.status,'source_unavailable');assert.equal(context.observation,null);assert.equal(context.freshnessThresholdSeconds,300);
 const tombstone=await call(base,'DELETE',{expectedRevision:1});assert.equal(tombstone.externalId,null);assert.equal(tombstone.revision,2);
 const history=await call(base+'/history?limit=1&offset=0');assert.equal(history.items[0].operation,'remove');assert.equal(history.page.hasMore,true);
 assert.equal((await call(base+'/history?limit=1&offset=1')).items[0].operation,'link');
 assert.deepEqual(await call(base,'PUT',input,200,'alice',key),mapping);
 stage='workflow-history';let run=await call('/v1/workflows','POST',{definitionId:fixtures.definitionId,title:'Studio reason and paging '+tag,input:{}},201);fixtures.runId=run.id;
 for(let index=0;index<105;index++){
  const reason='Acceptance reason '+index;
  run=await call('/v1/workflows/'+run.id+'/transitions','POST',{action:'note',expectedVersion:run.version,input:{reason,privateNote:'not-public-audit-'+tag}});
  if((index+1)%25===0)console.log(JSON.stringify({stage:'workflow-events',runId:run.id,transitions:index+1}));
 }
 const legacy=await call('/v1/workflows/'+run.id+'/history');assert.equal(legacy.items.length,100);assert.equal('page' in legacy,false);
 const first=await call('/v1/workflows/'+run.id+'/history?limit=100&offset=0');assert.equal(first.page.hasMore,true);assert.equal(first.page.nextOffset,100);
 const last=await call('/v1/workflows/'+run.id+'/history?limit=100&offset='+first.page.nextOffset);assert.equal(last.page.hasMore,false);assert.equal(last.page.nextOffset,null);
 const events=[...first.items,...last.items];assert.equal(events.length,106);assert.equal(new Set(events.map(event=>event.id)).size,106);
 assert.deepEqual(events.map(event=>event.version),Array.from({length:106},(_,index)=>index+1));
 assert.equal(events.find(event=>event.version===2).metadata.reason,'Acceptance reason 0');assert.equal(events.at(-1).metadata.reason,'Acceptance reason 104');assert.ok(!JSON.stringify(events).includes('not-public-audit-'));
 const invalid=await call('/v1/workflows/'+run.id+'/history?q=unsupported','GET',undefined,400);assert.equal(typeof invalid.error,'string');
 await call('/v1/workflows/'+run.id+'/history?limit=1','GET',undefined,404,'bob');
 console.log(JSON.stringify({result:'passed',...fixtures,events:events.length,source:'unavailable; no broker delivery asserted',tenantEvidence,fixtures:'retained'}));
} catch {
 // Do not dump HTTP bodies, JWTs or opaque login/driver errors.
 console.error(JSON.stringify({result:'failed',stage,...fixtures,fixtures:'retained; inspect unique IDs locally with redaction'}));process.exitCode=1;
}
