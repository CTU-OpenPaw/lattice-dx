/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { expect, test, vi } from 'vitest';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { createApi } from '../app.js';
import type { DefinitionRegistry } from './registry.js';
const definition={id:'portable-request',title:'Request',startRole:'employee',initialState:'draft',startFields:{request:'text'},readerRoles:['manager'],transitions:[{id:'submit',from:'draft',to:'done',role:'employee',fields:{}}]};
const bundle={format:'latticedx.workflow-bundle',formatVersion:1,definitions:[definition]};
const {privateKey,publicKey}=await generateKeyPair('RS256');
const key=createLocalJWKSet({keys:[{...await exportJWK(publicKey),kid:'bundle',alg:'RS256'}]});
async function auth(roles=['workflow:design'],org='org-a'){return {authorization:'Bearer '+await new SignJWT({organization_id:org,realm_access:{roles}}).setProtectedHeader({alg:'RS256',kid:'bundle'}).setSubject('alice').setIssuer('https://identity.test').setAudience('dx-api').setExpirationTime('5m').sign(privateKey)};}
test('signed routes preview without writes, explicit tenant export and draft-only import',async()=>{
 const get=vi.fn(async(org:string,_id:string,version:number)=>org==='org-a'?{...definition,version}:undefined),createMany=vi.fn(async()=>[{id:definition.id,revision:1}]);
 const app=createApi({workerUrl:'http://localhost:1',identity:{issuer:'https://identity.test',audience:'dx-api',key},definitionRegistry:{get,createMany} as unknown as DefinitionRegistry});
 try{
 const headers=await auth();const request={method:'POST' as const,url:'/v1/workflow-bundles/validate',payload:{bundle}};
 expect((await app.inject(request)).statusCode).toBe(401);
 expect((await app.inject({...request,headers:await auth(['employee'])})).statusCode).toBe(403);
 expect((await app.inject({...request,headers})).json().workflowCount).toBe(1);expect(createMany).not.toHaveBeenCalled();
 expect((await app.inject({...request,headers,payload:{bundle,organizationId:'other'}})).statusCode).toBe(400);
 const exported=await app.inject({method:'POST',url:'/v1/workflow-bundles/export',headers,payload:{definitions:[{id:definition.id,version:1}]}});
 expect(exported.json()).toEqual(bundle);expect(get).toHaveBeenCalledWith('org-a',definition.id,1);
 expect((await app.inject({method:'POST',url:'/v1/workflow-bundles/export',headers,payload:{definitions:[{id:definition.id}]}})).statusCode).toBe(400);
 expect((await app.inject({method:'POST',url:'/v1/workflow-bundles/export',headers:await auth(undefined,'foreign'),payload:{definitions:[{id:definition.id,version:1}]}})).statusCode).toBe(404);
  for (const version of [0,-1,1.5,'1',2147483648]) expect((await app.inject({method:'POST',url:'/v1/workflow-bundles/export',headers,payload:{definitions:[{id:definition.id,version}]}})).statusCode).toBe(400);
 expect((await app.inject({...request,headers,payload:{bundle:{...bundle,definitions:[{...definition,transitions:[{...definition.transitions[0],from:'hidden'}]}]}}})).statusCode).toBe(400);
 const largeDefinitions=Array.from({length:10},(_,index)=>({...definition,id:'large-'+index,transitions:[{...definition.transitions[0],condition:{field:'request',operator:'eq',value:'x'.repeat(1900)}}]}));
 expect((await app.inject({...request,headers,payload:{bundle:{...bundle,definitions:largeDefinitions}}})).statusCode).toBe(200);
 expect((await app.inject({...request,url:'/v1/workflow-bundles/import',headers})).statusCode).toBe(201);
 expect(createMany.mock.calls[0]).toEqual([bundle.definitions,{subject:'alice',organizationId:'org-a',roles:['workflow:design']}]);
 expect((await app.inject({...request,headers,payload:{bundle:{...bundle,padding:'x'.repeat(131072)}}})).statusCode).toBe(413);
 }finally{await app.close();}
});
test('missing identity or registry returns 503',async()=>{
 for(const options of [{},{identity:{issuer:'https://identity.test',audience:'dx-api',key}}]){
 const app=createApi({workerUrl:'http://localhost:1',...options});try{expect((await app.inject({method:'POST',url:'/v1/workflow-bundles/validate',headers:await auth(),payload:{bundle}})).statusCode).toBe(503);}finally{await app.close();}
 }
});
