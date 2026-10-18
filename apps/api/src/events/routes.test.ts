// SPDX-License-Identifier: Apache-2.0
import {expect,test,vi} from 'vitest';
import {generateKeyPair,exportJWK,createLocalJWKSet,SignJWT} from 'jose';
import {createApi} from '../app.js';
import type {EventRepository} from './types.js';

const {privateKey,publicKey}=await generateKeyPair('RS256');
const key=createLocalJWKSet({keys:[{...await exportJWK(publicKey),kid:'events',alg:'RS256'}]});
async function auth(roles=['workflow:event:receive'],org='org-a',subject='source') {
 return {authorization:'Bearer '+await new SignJWT({organization_id:org,realm_access:{roles}}).setProtectedHeader({alg:'RS256',kid:'events'}).setSubject(subject).setIssuer('https://identity.test').setAudience('dx-api').setExpirationTime('5m').sign(privateKey)};
}
const event={eventId:'external/1',eventType:'order-created',occurredAt:'2026-10-14T01:02:03Z',data:{note:'hello'}};
const subscription={id:'sub-one',eventType:event.eventType,sourceSubject:'source',definitionId:'event-flow',definitionVersion:3,title:{source:'literal',value:'Order'},input:{note:{source:'event',field:'note'}},enabled:true};
test('signed event endpoints require receive role and use only JWT source and tenant',async()=>{
 const receipt={eventId:event.eventId,status:'accepted',runs:[]};
 const receive=vi.fn(async()=>receipt),get=vi.fn(async()=>receipt);
 const app=createApi({workerUrl:'http://localhost:1',identity:{issuer:'https://identity.test',audience:'dx-api',key},events:{receive,get} as unknown as EventRepository});
 try {
  const request={method:'POST' as const,url:'/v1/workflow-events',payload:event};
  expect((await app.inject(request)).statusCode).toBe(401);
  expect((await app.inject({...request,headers:await auth(['workflow:start'])})).statusCode).toBe(403);
  const headers=await auth();
  expect((await app.inject({...request,headers})).json()).toEqual(receipt);
  expect(receive).toHaveBeenCalledWith(event,{subject:'source',organizationId:'org-a',roles:['workflow:event:receive']});
  expect((await app.inject({...request,headers,payload:{...event,sourceSubject:'forged'}})).statusCode).toBe(400);
  expect((await app.inject({url:'/v1/workflow-events/'+encodeURIComponent(event.eventId),headers:await auth(undefined,'org-b','other')})).statusCode).toBe(200);
  expect(get).toHaveBeenCalledWith(event.eventId,{subject:'other',organizationId:'org-b',roles:['workflow:event:receive']});
  const large={...event,data:Object.fromEntries(Array.from({length:50},(_,i)=>['f'+i,'x'.repeat(2000)]))};
  expect((await app.inject({...request,headers,payload:large})).statusCode).toBe(200);
  expect((await app.inject({...request,headers,payload:{...event,data:{note:'x'.repeat(131072)}}})).statusCode).toBe(413);
 } finally {await app.close();}
});
test('subscription routes require both design roles, mutation key, fixed ID and revision',async()=>{
 const createSubscription=vi.fn(async()=>({...subscription,revision:1}));
 const updateSubscription=vi.fn(async()=>({...subscription,revision:2}));
 const listSubscriptions=vi.fn(async()=>({items:[],page:{limit:10,offset:0,hasMore:false,nextOffset:null}}));
 const app=createApi({workerUrl:'http://localhost:1',identity:{issuer:'https://identity.test',audience:'dx-api',key},events:{createSubscription,updateSubscription,listSubscriptions} as unknown as EventRepository});
 try {
  const headers={...await auth(['workflow:design','workflow:integrate']),'idempotency-key':'subscription-1'};
  const request={method:'POST' as const,url:'/v1/workflow-event-subscriptions',payload:subscription};
  expect((await app.inject({...request,headers:await auth(['workflow:design'])})).statusCode).toBe(403);
  expect((await app.inject({...request,headers:await auth(['workflow:design','workflow:integrate'])})).statusCode).toBe(400);
  expect((await app.inject({...request,headers})).statusCode).toBe(201);
  const patch={method:'PATCH' as const,url:request.url+'/sub-one',headers,payload:{...subscription,expectedRevision:1}};
  expect((await app.inject(patch)).statusCode).toBe(200);
  expect((await app.inject({...patch,payload:{...subscription,id:'different',expectedRevision:1}})).statusCode).toBe(400);
  expect((await app.inject({...patch,payload:subscription})).statusCode).toBe(400);
  expect((await app.inject({url:request.url+'?limit=10',headers})).statusCode).toBe(200);
  expect(listSubscriptions).toHaveBeenCalledWith(expect.objectContaining({subject:'source',organizationId:'org-a'}),{limit:10,offset:0,q:''});
  expect((await app.inject({url:request.url+'?organizationId=other',headers})).statusCode).toBe(400);
 } finally {await app.close();}
});
