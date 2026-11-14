/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import {expect,test,vi} from 'vitest';
import {createApi} from '../app.js';
import {parseHandover} from './handover.js';
const id='ee4b283b-5049-4082-a49b-9a1e0181f328';
const event={eventId:id,eventType:'asset.handed_over',organizationId:'org-a',runId:id,recordId:id,definitionId:'procurement',version:6,occurredAt:'2026-10-20T12:00:00.123Z',data:{assetId:'urn:ngsi-ld:Asset:org-a:one',departmentId:'warehouse',locationId:'office-1'}};
test('parser rejects cross-tenant IDs, wrong event/key and invalid timestamps before storage',()=>{
 expect(parseHandover(event,id,'org-a')).toEqual(event);
 for(const patch of [{organizationId:'org-b'},{eventType:'other'},{occurredAt:'invalid'},{occurredAt:'2026-02-30T00:00:00.000Z'},{occurredAt:new Date(Date.now()+600000).toISOString()},{recordId:'other'},{data:{...event.data,departmentId:undefined}},{data:{...event.data,assetId:'urn:ngsi-ld:Asset:org-b:one'}}])expect(()=>parseHandover({...event,...patch},id,'org-a')).toThrow();
 expect(()=>parseHandover(event,'wrong','org-a')).toThrow();
});
test('handover route is disabled by default and denies bad credentials before processing',async()=>{
 const deliver=vi.fn(async()=>({assetId:event.data.assetId,status:'in_use',sourceEventId:id}));
 const app=createApi({workerUrl:'http://worker',assetHandover:{token:'x'.repeat(40),tenant:'org-a',deliver}});
 try{
  expect((await app.inject({method:'POST',url:'/v1/integrations/asset-handovers',payload:event})).statusCode).toBe(403);expect(deliver).not.toHaveBeenCalled();
  const response=await app.inject({method:'POST',url:'/v1/integrations/asset-handovers',headers:{authorization:'Bearer '+'x'.repeat(40),'idempotency-key':id},payload:event});
  expect(response.statusCode).toBe(200);expect(response.json()).toMatchObject({status:'in_use'});
 }finally{await app.close();}
 const disabled=createApi({workerUrl:'http://worker'});try{expect((await disabled.inject({method:'POST',url:'/v1/integrations/asset-handovers',payload:event})).statusCode).toBe(503);}finally{await disabled.close();}
});
