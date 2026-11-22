/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, expect, it, vi } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createApi } from '../app.js';
import type { ModuleRepository, ModuleVersion } from '../modules/types.js';
import { parseManifest } from '../modules/policy.js';
import { WorkflowError } from '../workflows/policy.js';
import type { EntityRepository } from '../entities/types.js';
import type { RecordRepository } from '../records.js';
import type { FoundationRepository } from '../foundation.js';
import type { WorkflowRepository } from '../workflows/types.js';
import type { DefinitionRegistry } from '../workflows/registry.js';
import type { DirectoryRepository } from '../directory.js';
const { privateKey, publicKey } = await generateKeyPair('RS256');
const key = createLocalJWKSet({keys:[{...await exportJWK(publicKey),kid:'studio',alg:'RS256'}]});
const identity = {issuer:'https://identity.test',audience:'dx-api',key};
const designer = ['workflow:design','data:design'];
async function auth(roles=designer, organization: string | null='org-a', extra: Record<string,unknown>={}) {
  return {authorization:'Bearer '+await new SignJWT({...extra,organization_id:organization ?? undefined,realm_access:{roles}})
    .setProtectedHeader({alg:'RS256',kid:'studio'}).setSubject('alice').setIssuer(identity.issuer)
    .setAudience(identity.audience).setExpirationTime('5m').sign(privateKey)};
}
const manifest = {format:'latticedx.enterprise-module',formatVersion:1,id:'sample',version:'1.0.0',title:'Sample',schemas:[],
  bundle:{format:'latticedx.workflow-bundle',formatVersion:1,definitions:[{id:'sample-flow',title:'Sample',startRole:'employee',initialState:'draft',startFields:{},readerRoles:[],transitions:[{id:'submit',from:'draft',to:'done',role:'employee',fields:{}}]}]},blocks:[],dependencies:[]};
const previewResult = {hash:'hash',resources:{schemas:[],workflows:['sample-flow'],blocks:[]},requiredRoles:['employee'],connectors:[],conflicts:[] as string[],dependencyErrors:[] as string[]};
function modules() {
  const preview=vi.fn(async(value:unknown)=>{parseManifest(value);return previewResult;});
  const install=vi.fn(); const get=vi.fn(async()=>({id:'sample',version:'1.0.0',dependencies:[{id:'base',version:'2.0.0'}],hash:'private',bindings:[],workflows:[],schemas:[],blocks:[],revision:1,enabled:true,title:'Sample'} as ModuleVersion));
  return {repository:{preview,install,get} as unknown as ModuleRepository,preview,install,get};
}
const apps: ReturnType<typeof createApi>[]=[];
function api(options: Partial<Parameters<typeof createApi>[0]>={}) {const app=createApi({workerUrl:'http://localhost:1',identity,...options});apps.push(app);return app;}
afterEach(async()=>{await Promise.all(apps.splice(0).map(app=>app.close()));vi.unstubAllGlobals();});
const endpoints=[['GET','/v1/me/capabilities'],['GET','/v1/studio/catalog'],['POST','/v1/studio/preflight'],['GET','/v1/studio/modules/sample/versions/1.0.0/dependencies']] as const;
it('advertises Logistics creation only for sales with start authority and configured dependencies',async()=>{
 const app=api({workflows:{} as WorkflowRepository,directory:{} as DirectoryRepository});
 for(const [roles,allowed] of [[['logistics:warehouse'],false],[['logistics:sales'],false],[['logistics:sales','workflow:start'],true]] as [string[],boolean][]){
  const response=await app.inject({url:'/v1/me/capabilities',headers:await auth(roles)});
  expect(response.json().capabilities['logistics.create']).toEqual({authorized:allowed,configured:true,available:allowed});
 }
 const unavailable=await api().inject({url:'/v1/me/capabilities',headers:await auth(['logistics:sales','workflow:start'])});
 expect(unavailable.json().capabilities['logistics.create']).toEqual({authorized:true,configured:false,available:false});
});
it('authenticates every Studio route and requires verified tenant scope',async()=>{
  const m=modules(),app=api({modules:m.repository});
  for(const [method,url] of endpoints){
    expect((await app.inject({method,url,...(method==='POST'?{payload:{manifest}}:{})})).statusCode).toBe(401);
    const denied=await app.inject({method,url,headers:await auth(designer,null),...(method==='POST'?{payload:{manifest}}:{})});
    expect(denied.statusCode).toBe(403);expect(denied.json()).toEqual({error:{code:'authority_denied',message:expect.any(String)}});
  }
  expect(m.preview).not.toHaveBeenCalled();expect(m.get).not.toHaveBeenCalled();
});
it('reports only configured capabilities separately from JWT authorization',async()=>{
  const app=api(),headers=await auth(['data:read','data:design','workflow:design']);
  const response=await app.inject({url:'/v1/me/capabilities',headers});
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({version:1,subject:'alice',organizationId:'org-a',capabilities:{'entities.read':{authorized:true,configured:false,available:false},'modules.preflight':{authorized:true,configured:false,available:false},'records.create':{authorized:false,configured:false,available:false}}});
  const noIdentity=api({identity:undefined});
  expect((await noIdentity.inject({url:'/v1/me/capabilities'})).json()).toEqual({error:{code:'identity_unavailable',message:expect.any(String)}});
});
it('requires current designer roles and does not accept resource_access grants',async()=>{
  const app=api({modules:modules().repository});
  const headers=await auth([], 'org-a',{resource_access:{studio:{roles:designer}}});
  for(const [method,url] of endpoints.slice(1))expect((await app.inject({method,url,headers,...(method==='POST'?{payload:{manifest}}:{})})).statusCode).toBe(403);
  expect((await app.inject({method:'POST',url:'/v1/studio/preflight',headers:await auth(['workflow:design']),payload:{manifest}})).statusCode).toBe(403);
});
it('filters catalog descriptors by role and reports configured availability without inventing runtimes',async()=>{
  const headers=await auth(['data:design','data:read','records:write','tasks:assign']);
  const app=api({entities:{} as EntityRepository,records:{} as RecordRepository,foundation:{} as FoundationRepository});
  const response=await app.inject({url:'/v1/studio/catalog',headers});expect(response.statusCode).toBe(200);
  const body=response.json();expect(body.version).toBe(1);
  expect(body.entities.fieldTypes).toContain('decimal');expect(body.entities.queryOperators).toContain('exists');
  expect(body.blocks.map((item:{id:string})=>item.id)).toEqual(['entities.read','entities.query']);
  expect(body.blocks.find((item:{id:string})=>item.id==='entities.read')).toMatchObject({version:1,inputSchema:expect.any(Object),availability:{authorized:true,configured:true,available:true}});
  expect(body.blocks.find((item:{id:string})=>item.id==='entities.query').availability.configured).toBe(false);
  expect(body.actions.find((item:{id:string})=>item.id==='records.create')).toMatchObject({inputSchema:expect.any(Object),availability:{available:true}});
  expect(body.actions.find((item:{id:string})=>item.id==='tasks.create').availability.configured).toBe(false);
  expect(body.workflow.blocks).toEqual([]);expect(body.workflow.fieldTypes).toEqual([]);expect(body.connectors).toEqual([]);expect(body.services).toEqual([]);
});
it('reuses workflow descriptors and exposes only safe authorized connector/service IDs',async()=>{
  const listServices=vi.fn(async()=>[{id:'scheduled',enabled:true,url:'https://secret',secret:'credential'}]);
  const list=vi.fn(async()=>[{...manifest.bundle.definitions[0],version:1,transitions:[{id:'submit',from:'draft',to:'done',role:'employee',fields:{},steps:[{id:'sync',action:'connectors.dispatch',input:{connectorId:{source:'literal',value:'erp'},payload:{}}}]}]}]);
  const app=api({workflows:{listServices} as unknown as WorkflowRepository,definitionRegistry:{list} as unknown as DefinitionRegistry});
  const response=await app.inject({url:'/v1/studio/catalog',headers:await auth([...designer,'workflow:integrate','workflow:schedule','data:read'])});
  expect(response.statusCode).toBe(200);const body=response.json();
  expect(body.workflow.fieldTypes).toContain('positiveInteger');expect(body.workflow.blocks).toEqual(expect.arrayContaining([expect.objectContaining({id:'entities.project',input:expect.any(Object)})]));
  expect(body.connectors).toEqual([{id:'erp',version:1}]);expect(body.services).toEqual([{id:'scheduled',version:1,enabled:true}]);
  expect(JSON.stringify(body)).not.toMatch(/secret|credential|https:/);expect(list).toHaveBeenCalledWith('org-a');
  expect(listServices).toHaveBeenCalledWith({subject:'alice',organizationId:'org-a',roles:[...designer,'workflow:integrate','workflow:schedule','data:read']});
});
it('returns valid preview without calling installation, network or other mutations',async()=>{
  const m=modules(),app=api({modules:m.repository});const network=vi.fn(()=>{throw new Error('Network forbidden');});vi.stubGlobal('fetch',network);
  const response=await app.inject({method:'POST',url:'/v1/studio/preflight',headers:await auth(),payload:{manifest}});
  expect(response.statusCode).toBe(200);expect(response.json()).toMatchObject({version:1,valid:true,issues:[],preview:previewResult});
  expect(m.preview).toHaveBeenCalledWith(manifest,{subject:'alice',organizationId:'org-a',roles:designer});expect(m.install).not.toHaveBeenCalled();expect(network).not.toHaveBeenCalled();
});
it('turns preview conflicts and dependency errors into structured configuration issues',async()=>{
  const m=modules();m.preview.mockResolvedValue({...previewResult,conflicts:['Schema sample already exists.'],dependencyErrors:['Missing base 2.0.0.']});
  const response=await api({modules:m.repository}).inject({method:'POST',url:'/v1/studio/preflight',headers:await auth(),payload:{manifest}});
  expect(response.statusCode).toBe(200);expect(response.json()).toMatchObject({valid:false,issues:[{code:'resource_conflict',path:'manifest',message:'Schema sample already exists.'},{code:'dependency_error',path:'manifest.dependencies',message:'Missing base 2.0.0.'}]});expect(m.install).not.toHaveBeenCalled();
});
it('returns invalid manifest as a safe configuration issue using the repository validator',async()=>{
  const m=modules(),app=api({modules:m.repository});
  for(const value of [{},null,{...manifest,url:'https://attacker.invalid'}]){
    const response=await app.inject({method:'POST',url:'/v1/studio/preflight',headers:await auth(),payload:{manifest:value}});
    expect(response.statusCode).toBe(200);expect(response.json()).toMatchObject({valid:false,issues:[{code:'invalid_manifest',path:'manifest',message:expect.any(String)}]});
    expect(response.body).not.toContain('attacker');
  }
  expect(m.install).not.toHaveBeenCalled();
});
it('rejects unsupported queries and envelopes before accessing repositories',async()=>{
  const m=modules(),app=api({modules:m.repository}),headers=await auth();
  for(const [method,url] of endpoints)expect((await app.inject({method,url:url+'?organizationId=org-b',headers,...(method==='POST'?{payload:{manifest}}:{})})).statusCode).toBe(400);
  for(const payload of [{},{manifest,actor:{roles:designer}},{manifest,organizationId:'org-b'},[],null]){
    const response=await app.inject({method:'POST',url:'/v1/studio/preflight',headers:{...headers,'content-type':'application/json'},payload: JSON.stringify(payload)});expect(response.statusCode).toBe(400);expect(response.json()).toMatchObject({error:{code:'invalid_request',message:expect.any(String)}});
  }
  expect(m.preview).not.toHaveBeenCalled();expect(m.get).not.toHaveBeenCalled();
});
it('returns direct installed references with fresh JWT tenant checks and no inventory traversal',async()=>{
  const m=modules();m.get.mockImplementation(async(_id?:unknown,_version?:unknown,actor?:unknown)=>{if((actor as {organizationId:string}).organizationId!=='org-a')throw new WorkflowError(404,'Not found');return {id:'sample',version:'1.0.0',dependencies:[{id:'base',version:'2.0.0'}],schemas:['business'],workflows:[{definitionId:'sample-flow',definitionVersion:2}],blocks:[{id:'entities.read',version:1}],bindings:[{id:'business',schemaId:'business',schemaVersion:1,definitionId:'sample-flow',definitionVersion:2,allowedTransitions:['submit']}]} as ModuleVersion;});
  const app=api({modules:m.repository}),url=endpoints[3][1];
  const found=await app.inject({url,headers:await auth(['workflow:design'])});expect(found.statusCode).toBe(200);expect(found.json()).toEqual({version:1,module:{id:'sample',version:'1.0.0'},dependencies:[{id:'base',version:'2.0.0'}],schemas:['business'],workflows:[{definitionId:'sample-flow',definitionVersion:2}],blocks:[{id:'entities.read',version:1}],bindings:[{id:'business',schemaId:'business',schemaVersion:1,definitionId:'sample-flow',definitionVersion:2,allowedTransitions:['submit']}]});
  const foreign=await app.inject({url,headers:await auth(['workflow:design'],'org-b')});expect(foreign.statusCode).toBe(404);expect(foreign.json()).toEqual({error:{code:'not_found',message:expect.any(String)}});
  expect(m.get).toHaveBeenCalledTimes(2);expect(m.get).toHaveBeenLastCalledWith('sample','1.0.0',{subject:'alice',organizationId:'org-b',roles:['workflow:design']});
});
it('uses safe local error envelopes for unavailable, malformed JSON and unexpected failures',async()=>{
  const app=api(),headers=await auth();
  for(const [method,url] of endpoints.slice(2)){
    const response=await app.inject({method,url,headers,...(method==='POST'?{payload:{manifest}}:{})});expect(response.statusCode).toBe(503);expect(response.json()).toEqual({error:{code:'runtime_unavailable',message:expect.any(String)}});
  }
  const m=modules();m.preview.mockRejectedValue(new Error('postgres://secret:password@internal SELECT private'));
  const failed=await api({modules:m.repository}).inject({method:'POST',url:'/v1/studio/preflight',headers,payload:{manifest}});expect(failed.statusCode).toBe(500);expect(failed.json()).toEqual({error:{code:'internal_error',message:expect.any(String)}});expect(failed.body).not.toMatch(/postgres|password|SELECT/);
  const malformed=await app.inject({method:'POST',url:'/v1/studio/preflight',headers:{...headers,'content-type':'application/json'},payload:'{'});expect(malformed.statusCode).toBe(400);expect(malformed.json()).toMatchObject({error:{code:'invalid_request'}});
});
it('validates exact dependency path references before reading the module',async()=>{
  const m=modules(),app=api({modules:m.repository}),headers=await auth();
  for(const url of ['/v1/studio/modules/SAMPLE/versions/1.0.0/dependencies','/v1/studio/modules/sample/versions/01.0.0/dependencies'])expect((await app.inject({url,headers})).statusCode).toBe(400);
  expect(m.get).not.toHaveBeenCalled();
});
// The workflow executor uses its own transaction for builtin steps; standalone APIs are optional.
it('bases builtin workflow step availability on its executor independently of standalone APIs',async()=>{
  const roles=[...designer,'data:read','data:write','records:write','tasks:assign','workflow:integrate','workflow:schedule'];
  const app=api({workflows:{} as WorkflowRepository}),headers=await auth(roles);
  const response=await app.inject({url:'/v1/studio/catalog',headers});
  expect(response.statusCode).toBe(200);
  const body=response.json();
  for(const id of ['entities.create','entities.read','entities.query','entities.project','records.create','tasks.create','connectors.dispatch','timers.schedule'])
    expect(body.workflow.blocks.find((item:{id:string})=>item.id===id)).toMatchObject({availability:{authorized:true,configured:true,available:true}});
  for(const descriptor of [...body.actions,...body.blocks])expect(descriptor.availability).toEqual({authorized:true,configured:false,available:false});
  const unconfigured=await api().inject({url:'/v1/studio/catalog',headers});
  expect(unconfigured.statusCode).toBe(200);
  for(const descriptor of unconfigured.json().workflow.blocks)expect(descriptor.availability.configured).toBe(false);
});
it('rejects signed GET payload framing without repository reads',async()=>{
  const m=modules(),app=api({modules:m.repository}),headers=await auth();
  for(const [,url] of endpoints.filter(([method])=>method==='GET')){
    for(const framing of [{'content-length':'2'},{'transfer-encoding':'chunked'}]){
      const response=await app.inject({method:'GET',url,headers:{...headers,...framing,'content-type':'application/json'},payload:'{}'});
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({error:{code:'invalid_request',message:expect.any(String)}});
    }
  }
  expect(m.get).not.toHaveBeenCalled();
  const empty=await app.inject({url:'/v1/me/capabilities',headers:{...headers,'content-length':'0'}});
  expect(empty.statusCode).toBe(200);
});
