// SPDX-License-Identifier: Apache-2.0
import {expect,test,vi} from 'vitest';
import {createHandoverBroker} from './handover-broker.js';
const ns='https://latticedx.example/ns/';
const event={eventId:'ee4b283b-5049-4082-a49b-9a1e0181f328',eventType:'asset.handed_over',definitionId:'procurement',runId:'ee4b283b-5049-4082-a49b-9a1e0181f328',recordId:'ee4b283b-5049-4082-a49b-9a1e0181f328',version:6,organizationId:'org-a',occurredAt:'2026-10-20T12:00:00.123Z',data:{assetId:'urn:ngsi-ld:Asset:org-a:one',departmentId:'warehouse',locationId:'office-1'}};
function fixture(existing?:Record<string,unknown>){
 let asset=existing;const calls:Array<{method:string;body?:Record<string,unknown>}>=[];
 const transport=vi.fn(async(url:string,options:RequestInit)=>{
  const id=decodeURIComponent(new URL(url).pathname.split('/').at(-1)!);
  if(options.method==='GET'){
   if(id.includes(':Department:')||id.includes(':Location:')){const type=id.includes(':Department:')?'Department':'Location';return Response.json({id,type:ns+type,[ns+'organizationId']:{type:'Property',value:'org-a'},[ns+'businessId']:{type:'Property',value:id.split(':').at(-1)}});}
   return asset?Response.json(asset):new Response(null,{status:404});
  }
  const body=JSON.parse(String(options.body));calls.push({method:options.method!,body});
  expect((options.headers as Record<string,string>)['Content-Type']).toBe('application/ld+json');
  expect(body['@context']?.Asset).toBe(ns+'Asset');
  expect(body.status).toMatchObject({type:'Property',value:'in_use'});
  if(options.method==='POST')expect(body.type).toBe('Asset');
  const expanded=Object.fromEntries(Object.entries(body).map(([key,value])=>[key.includes(':')||['id','type'].includes(key)?key:ns+(key==='belongsToDepartment'?'department':key),key==='type'&&value==='Asset'?ns+'Asset':value]));
  asset=options.method==='POST'?expanded:{...asset,...expanded};return new Response(null,{status:options.method==='POST'?201:204});
 });
 return {transport,calls,getAsset:()=>asset};
}
test('handover creates a tenant-scoped Asset, maps relationships and confirms read-back',async()=>{
 const f=fixture(),broker=createHandoverBroker({baseUrl:'http://broker:1026',tenant:'org-a',fetchImpl:f.transport});
 expect(await broker(event)).toEqual({assetId:event.data.assetId,status:'in_use',sourceEventId:event.eventId});
 expect(f.getAsset()?.[ns+'department']).toEqual({type:'Relationship',object:'urn:ngsi-ld:Department:org-a:warehouse'});
 expect(f.getAsset()?.[ns+'status']).toMatchObject({value:'in_use',observedAt:'2026-10-20T12:00:00.000Z'});
 await broker(event);expect(f.calls).toHaveLength(1);
});
test('handover preserves unrelated attributes and rejects newer or equal-second observations',async()=>{
 const previous={id:event.data.assetId,type:ns+'Asset',[ns+'organizationId']:{value:'org-a'},[ns+'businessId']:{value:'one'},[ns+'name']:{type:'Property',value:'Existing laptop'},[ns+'status']:{value:'ready',observedAt:'2026-10-20T11:00:00Z'}};
 const f=fixture(previous);await createHandoverBroker({baseUrl:'http://broker:1026',tenant:'org-a',fetchImpl:f.transport})(event);
 expect(f.getAsset()?.[ns+'name']).toEqual(previous[ns+'name']);expect(f.calls[0]?.method).toBe('PATCH');
 for(const observedAt of ['2026-10-20T12:00:00Z','2026-10-20T13:00:00Z']){
  const newer=fixture({...previous,[ns+'status']:{value:'repair',observedAt}});
  await expect(createHandoverBroker({baseUrl:'http://broker:1026',tenant:'org-a',fetchImpl:newer.transport})(event)).rejects.toMatchObject({statusCode:409});expect(newer.calls).toHaveLength(0);
 }
});
test('wrong references, partial writes and wrong read-back never acknowledge success',async()=>{
 for(const mode of ['reference','partial','readback']){
  const f=fixture();const transport=async(url:string,options:RequestInit)=>{
   if(mode==='reference'&&url.includes('Department'))return new Response(null,{status:404});
   if(mode==='partial'&&options.method==='POST')return new Response(null,{status:207});
   if(mode==='readback'&&options.method==='POST')return new Response(null,{status:201});
   return f.transport(url,options);
  };
  await expect(createHandoverBroker({baseUrl:'http://broker:1026',tenant:'org-a',fetchImpl:transport})(event)).rejects.toThrow();
 }
});
