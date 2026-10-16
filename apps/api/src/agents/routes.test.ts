import {it,expect} from 'vitest';
import Fastify from 'fastify';
import {SignJWT,generateKeyPair} from 'jose';
import {registerAgents} from './routes.js';
it('signed human cannot claim and strict worker requests reject extra fields before repository',async()=>{
 const app=Fastify();let calls=0;const keys=await generateKeyPair('RS256');
 registerAgents(app,{identity:{issuer:'fixture',audience:'api',key:async()=>keys.publicKey},agents:{claim:async()=>{calls++;return {};}} as any});
 async function token(roles:string[]){return new SignJWT({organization_id:'tenant',realm_access:{roles}}).setProtectedHeader({alg:'RS256'}).setSubject('worker').setIssuer('fixture').setAudience('api').setExpirationTime('1h').sign(keys.privateKey);}
 const id='00000000-0000-4000-8000-000000000001';
 const human=await app.inject({method:'POST',url:`/v1/agent-jobs/${id}/claim`,headers:{authorization:`Bearer ${await token(['data:read'])}`},payload:{}});expect(human.statusCode).toBe(403);
 const malformed=await app.inject({method:'POST',url:`/v1/agent-jobs/${id}/claim`,headers:{authorization:`Bearer ${await token(['connector:agent','agent:worker'])}`},payload:{runId:id}});expect(malformed.statusCode).toBe(400);expect(calls).toBe(0);await app.close();
});
