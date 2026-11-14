/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import {afterEach,expect,test,vi} from 'vitest';
import {createLocalJWKSet,exportJWK,generateKeyPair,SignJWT} from 'jose';
import {createApi} from '../app.js';
import type {EntityRepository} from '../entities/types.js';
import type {ContextLinksRepository} from './types.js';
const {privateKey,publicKey}=await generateKeyPair('RS256');
const identity={issuer:'https://identity.test',audience:'dx-api',key:createLocalJWKSet({keys:[{...await exportJWK(publicKey),kid:'context',alg:'RS256'}]})};
const id='00000000-0000-4000-8000-000000000001',base=`/v1/entities/${id}`,urn='urn:ngsi-ld:Asset:org:asset';
async function headers(roles=['data:read','data:design'],org:string|undefined='org'){
 return {authorization:'Bearer '+await new SignJWT({organization_id:org,realm_access:{roles}}).setProtectedHeader({alg:'RS256',kid:'context'}).setSubject('alice').setIssuer(identity.issuer).setAudience(identity.audience).setExpirationTime('5m').sign(privateKey),'idempotency-key':'key'};
}
const apps:ReturnType<typeof createApi>[]=[];
function fixture(visible=true){
 const find=vi.fn(async()=>visible?{id}:undefined),mapping={provider:'ngsi-ld',entityId:id,externalId:urn,revision:1,updatedAt:new Date().toISOString()};
 const contextLinks={get:vi.fn(async()=>mapping),put:vi.fn(async()=>mapping),remove:vi.fn(async()=>({...mapping,externalId:null,revision:2})),history:vi.fn(async()=>({items:[],page:{limit:50,offset:0,hasMore:false,nextOffset:null}})),context:vi.fn(async()=>({version:1,entityId:id,mapping,status:'source_unavailable',freshnessThresholdSeconds:300,observation:null}))};
 const options={workerUrl:'http://localhost:1',identity,entities:{find} as unknown as EntityRepository,contextLinks:contextLinks as unknown as ContextLinksRepository};
 const app=createApi(options);apps.push(app);return {app,contextLinks,find,options};
}
afterEach(async()=>{await Promise.all(apps.splice(0).map(app=>app.close()));});
const endpoints=[['GET','/context-links/ngsi-ld'],['PUT','/context-links/ngsi-ld'],['DELETE','/context-links/ngsi-ld'],['GET','/context-links/ngsi-ld/history'],['GET','/context']] as const;
test('every context endpoint authenticates tenant and data read role; mutation also requires design',async()=>{
 const {app,contextLinks}=fixture();
 for(const [method,path] of endpoints){
  const payload=method==='PUT'?{externalId:urn,expectedRevision:0}:method==='DELETE'?{expectedRevision:1}:undefined;
  expect((await app.inject({method,url:base+path,payload})).statusCode).toBe(401);
  expect((await app.inject({method,url:base+path,headers:await headers([], 'org'),payload})).json()).toMatchObject({error:{code:'authority_denied'}});
  expect((await app.inject({method,url:base+path,headers:await headers(['data:read','data:design'],''),payload})).statusCode).toBe(403);
  if(method!=='GET')expect((await app.inject({method,url:base+path,headers:await headers(['data:read']),payload})).statusCode).toBe(403);
 }
 for(const fn of Object.values(contextLinks))expect(fn).not.toHaveBeenCalled();
});
test('denied current entity readability prevents any context repository access',async()=>{
 const {app,contextLinks,find}=fixture(false);
 for(const [method,path] of endpoints){const result=await app.inject({method,url:base+path,headers:await headers(),payload:method==='PUT'?{externalId:urn,expectedRevision:0}:method==='DELETE'?{expectedRevision:1}:undefined});expect(result.statusCode).toBe(404);expect(result.json()).toMatchObject({error:{code:'not_found'}});}
 expect(find).toHaveBeenCalledWith({actorId:'alice',organizationId:'org'},id);for(const fn of Object.values(contextLinks))expect(fn).not.toHaveBeenCalled();
});
test('strict bodies queries IDs and bounded mandatory keys reject before mutation',async()=>{
 const {app,contextLinks}=fixture(),auth=await headers(),url=base+'/context-links/ngsi-ld';
 for(const payload of [{externalId:urn,expectedRevision:0,actorId:'other'},{externalId:'urn:ngsi-ld:Asset:other:x',expectedRevision:0},{externalId:urn,expectedRevision:'0'},{}])expect((await app.inject({method:'PUT',url,headers:auth,payload})).json()).toMatchObject({error:{code:'invalid_request'}});
 for(const key of ['', 'a'.repeat(129),'space key'])expect((await app.inject({method:'PUT',url,headers:{...auth,'idempotency-key':key},payload:{externalId:urn,expectedRevision:0}})).statusCode).toBe(400);
 const {['idempotency-key']:_,...noKey}=auth;expect((await app.inject({method:'PUT',url,headers:noKey,payload:{externalId:urn,expectedRevision:0}})).statusCode).toBe(400);
 for(const path of ['/context?url=http://evil','/context-links/ngsi-ld?organizationId=other','/context-links/ngsi-ld/history?q=x','/context-links/ngsi-ld/history?limit=0'])expect((await app.inject({url:base+path,headers:auth})).statusCode).toBe(400);
 expect((await app.inject({url:'/v1/entities/wrong/context',headers:auth})).statusCode).toBe(400);
 expect(contextLinks.put).not.toHaveBeenCalled();
});
test('routes expose typed results with current JWT scope and capability availability',async()=>{
 const {app,contextLinks}=fixture(),auth=await headers();
 expect((await app.inject({method:'PUT',url:base+'/context-links/ngsi-ld',headers:auth,payload:{externalId:urn,expectedRevision:0}})).statusCode).toBe(200);
 expect(contextLinks.put).toHaveBeenCalledWith({actorId:'alice',organizationId:'org'},id,{externalId:urn,expectedRevision:0},'key');
 expect((await app.inject({url:base+'/context',headers:auth})).json()).toMatchObject({status:'source_unavailable',observation:null});
 const capabilities=(await app.inject({url:'/v1/me/capabilities',headers:auth})).json().capabilities;
 expect(capabilities['context.read']).toEqual({authorized:true,configured:true,available:true});expect(capabilities['context.links.manage']).toEqual({authorized:true,configured:true,available:true});
 contextLinks.context.mockRejectedValueOnce(new Error('database password'));const failed=await app.inject({url:base+'/context',headers:auth});expect(failed.statusCode).toBe(503);expect(failed.body).not.toContain('password');
});
