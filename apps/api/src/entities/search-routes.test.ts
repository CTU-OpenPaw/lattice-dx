// SPDX-License-Identifier: Apache-2.0
import {createLocalJWKSet,exportJWK,generateKeyPair,SignJWT} from 'jose';
import {expect,test,vi} from 'vitest';
import {createApi} from '../app.js';
import type {EntityRepository} from './types.js';
import {SearchUnavailableError} from './search-client.js';
const {publicKey,privateKey}=await generateKeyPair('RS256');
const identity={key:createLocalJWKSet({keys:[{...await exportJWK(publicKey),kid:'search',alg:'RS256'}]}),issuer:'https://identity.test',audience:'dx-api'};
async function token(roles=['data:read'],org:string|null='org') {return new SignJWT({realm_access:{roles},...(org?{organization_id:org}:{})}).setProtectedHeader({alg:'RS256',kid:'search'}).setSubject('reader').setIssuer(identity.issuer).setAudience(identity.audience).setIssuedAt().setExpirationTime('5m').sign(privateKey);}
test('signed read route enforces bounded exact body and returns page without evidence',async()=>{
 const page={items:[],page:{limit:50,offset:0,hasMore:false,nextOffset:null}};
 const search=vi.fn(async()=>page);
 const app=createApi({workerUrl:'http://localhost:1',identity,entities:{search} as unknown as EntityRepository});
 try {
  const url='/v1/entities/search',payload={q:'  x | y '};
  expect((await app.inject({method:'POST',url,payload})).statusCode).toBe(401);
  for(const auth of [await token(['data:write']),await token(['data:read'],null)])expect((await app.inject({method:'POST',url,payload,headers:{authorization:`Bearer ${auth}`}})).statusCode).toBe(403);
  const headers={authorization:`Bearer ${await token()}`};
  const response=await app.inject({method:'POST',url,payload,headers});
  expect(response.statusCode).toBe(200);expect(response.json()).toEqual(page);
  expect(search).toHaveBeenCalledWith({actorId:'reader',organizationId:'org'},{q:'x | y',limit:50,offset:0});
  search.mockClear();
  for(const extra of [{rawSql:'SELECT 1'},{sort:{}},{filters:[]},{html:true},{schemaId:'invoice'}])expect((await app.inject({method:'POST',url,payload:{...payload,...extra},headers})).statusCode).toBe(400);
  expect((await app.inject({method:'POST',url:url+'?q=other',payload,headers})).statusCode).toBe(400);
  expect((await app.inject({method:'POST',url,payload:' '.repeat(4096)+JSON.stringify(payload),headers:{...headers,'content-type':'application/json'}})).statusCode).toBe(413);
  expect(search).not.toHaveBeenCalled();
  search.mockRejectedValueOnce(new SearchUnavailableError());
  const failure=await app.inject({method:'POST',url,payload,headers});
  expect(failure.statusCode).toBe(503);expect(failure.json()).toEqual({error:'search_unavailable'});
 } finally {await app.close();}
});
