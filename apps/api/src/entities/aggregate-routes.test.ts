// SPDX-License-Identifier: Apache-2.0
import {createLocalJWKSet,exportJWK,generateKeyPair,SignJWT} from 'jose';
import {expect,test,vi} from 'vitest';
import {createApi} from '../app.js';
import type {EntityRepository} from './types.js';
import {EntityError} from './policy.js';
const {publicKey,privateKey}=await generateKeyPair('RS256');
const identity={key:createLocalJWKSet({keys:[{...await exportJWK(publicKey),kid:'aggregate',alg:'RS256'}]}),issuer:'https://identity.test',audience:'dx-api'};
async function token(roles=['data:read'],org:string|null='org') {return new SignJWT({realm_access:{roles},...(org?{organization_id:org}:{})}).setProtectedHeader({alg:'RS256',kid:'aggregate'}).setSubject('reader').setIssuer(identity.issuer).setAudience(identity.audience).setIssuedAt().setExpirationTime('5m').sign(privateKey);}
const payload={schemaId:'invoice',schemaVersion:1,metrics:[{name:'count',operation:'count'}]};
test('aggregate endpoint requires signed read tenant, no command key, exact body and query',async()=>{
 const aggregate=vi.fn(async()=>({schemaId:'invoice',schemaVersion:1,groupBy:[],groups:[{keys:[],metrics:{count:'0'}}]}));
 const app=createApi({workerUrl:'http://localhost:1',identity,entities:{aggregate} as unknown as EntityRepository});
 try {
 const url='/v1/entities/aggregate';
 expect((await app.inject({method:'POST',url,payload})).statusCode).toBe(401);
 for(const auth of [await token([]),await token(['data:write']),await token(['data:read'],null)])expect((await app.inject({method:'POST',url,payload,headers:{authorization:`Bearer ${auth}`}})).statusCode).toBe(403);
 const headers={authorization:`Bearer ${await token()}`};
 expect((await app.inject({method:'POST',url,payload,headers})).statusCode).toBe(200);
 expect(aggregate).toHaveBeenCalledWith({actorId:'reader',organizationId:'org'},{...payload,groupBy:[],filters:[]});
 aggregate.mockClear();
 for(const extra of [{limit:1},{rawSql:'SELECT 1'},{metrics:[]}])expect((await app.inject({method:'POST',url,payload:{...payload,...extra},headers})).statusCode).toBe(400);
 expect((await app.inject({method:'POST',url:url+'?ownerId=owner',payload,headers})).statusCode).toBe(400);expect(aggregate).not.toHaveBeenCalled();
 for(const statusCode of [409,503] as const){aggregate.mockRejectedValueOnce(new EntityError(statusCode,'Aggregate unavailable.'));expect((await app.inject({method:'POST',url,payload,headers})).statusCode).toBe(statusCode);}
 } finally {await app.close();}
});
