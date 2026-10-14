// SPDX-License-Identifier: Apache-2.0
import {describe,it,expect,vi} from 'vitest';
import {createTelemetry,observedTick} from './telemetry.js';
import {createApi} from '../app.js';
import {randomUUID} from 'node:crypto';
describe('bounded process telemetry',()=>{
 it('collapses a thousand arbitrary labels and preserves fixed duration buckets',()=>{
  const metrics=createTelemetry(['/v1/records/:id']);
  for(let i=0;i<1000;i++)metrics.recordHttp('/private/'+i,'SECRET','999',10);
  metrics.recordHttp('/v1/records/:id','GET','2xx',51);
  const result=metrics.snapshot();
  expect(result.scope).toBe('process');
  expect(result.http).toHaveLength(2);
  expect(result.http.find(row=>row.route==='unmatched')).toMatchObject({method:'other',statusClass:'5xx',count:1000,buckets:[1000,0,0,0,0,0,0]});
  expect(result.http.find(row=>row.route==='/v1/records/:id')?.buckets).toEqual([0,0,1,0,0,0,0]);
  expect(JSON.stringify(result)).not.toContain('private');
  expect(createTelemetry().snapshot().http).toEqual([]);
 });
 it('rejects invalid durations and caps route registration',()=>{
  const telemetry=createTelemetry();
  for(const duration of [-1,NaN,Infinity])expect(()=>telemetry.recordWorker('outbox','failure',duration)).toThrow();
  expect(()=>createTelemetry(Array.from({length:129},(_,i)=>'/'+i))).toThrow();
  expect(()=>telemetry.registerRoute('/private?token=secret')).toThrow();
 });
 it('uses monotonic tick time at all boundaries and snapshots cannot mutate counters',async()=>{
  const telemetry=createTelemetry();const clock=vi.spyOn(performance,'now');
  try{
   for(const duration of [0,10,11,50,51,100,101,500,501,1000,1001,5000,5001]){
    clock.mockReturnValueOnce(100).mockReturnValueOnce(100+duration);
    await observedTick(async()=>({status:'succeeded'}),(result,ms)=>telemetry.recordWorker('timers',result,ms));
   }
   const snapshot=telemetry.snapshot();expect(snapshot.workers[0]?.buckets).toEqual([2,2,2,2,2,2,1]);
   snapshot.workers[0]!.count=0;snapshot.workers[0]!.buckets.fill(0);
   expect(telemetry.snapshot().workers[0]?.count).toBe(13);
  }finally{clock.mockRestore();}
 });
 it('completes a thousand random unknown HTTP paths without retaining sensitive request values',async()=>{
  const telemetry=createTelemetry();const app=createApi({workerUrl:'http://localhost',telemetry});
  try{
   for(let i=0;i<1000;i++){
    const reply=await app.inject({url:'/private-'+randomUUID()+'?token=private-token',headers:{authorization:'Bearer private-token','x-request-id':'private-correlation'}});
    expect(reply.statusCode).toBe(404);
   }
   const snapshot=telemetry.snapshot();expect(snapshot.http).toEqual([expect.objectContaining({route:'unmatched',method:'GET',statusClass:'4xx',count:1000})]);
   for(const secret of ['private-','private-token','private-correlation'])expect(JSON.stringify(snapshot)).not.toContain(secret);
  }finally{await app.close();}
 });
});
