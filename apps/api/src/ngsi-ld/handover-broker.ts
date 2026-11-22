/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import {HandoverError,type HandoverEvent,type HandoverResult} from './handover.js';
import {readFileSync} from 'node:fs';
const ns='https://latticedx.example/ns/';
const names:Record<string,string>={belongsToDepartment:'department'};
function attribute(entity:Record<string,any>,key:string){return entity[ns+(names[key]??key)]??entity[key];}
/** Handover owns status/department/location/sourceEventId; other broker writers require coordination. */
export function createHandoverBroker({baseUrl,tenant,fetchImpl=fetch}:{baseUrl:string;tenant:string;fetchImpl?:(url:string,options:RequestInit)=>Promise<Response>}){
 const base=new URL(baseUrl);
 const context=JSON.parse(readFileSync(new URL('../../../../infra/config/ngsi-ld/context.jsonld',import.meta.url),'utf8'))['@context'][1];
 if(!['http:','https:'].includes(base.protocol)||base.username||base.password||base.search||base.hash||!/^\/?$/.test(base.pathname)||!/^[A-Za-z0-9_-]{1,128}$/.test(tenant))throw Error('Invalid handover broker configuration');
 return async(event:HandoverEvent):Promise<HandoverResult>=>{
  // One overall budget fits inside n8n and the outbox sender's ten-second timeout.
  const signal=AbortSignal.timeout(6500);
  async function request(method:string,path:string,body?:unknown){
   // Compact application terms plus explicit context also preserve Orion's subscription matching.
   const r=await fetchImpl(new URL('/ngsi-ld/v1'+path,base).href,{method,redirect:'error',signal,headers:{Accept:'application/ld+json','NGSILD-Tenant':tenant,...(body?{'Content-Type':'application/ld+json'}:{})},...(body?{body:JSON.stringify({...body as object,'@context':context})}:{})});
   if(method!=='GET'){await r.body?.cancel();return {status:r.status,data:undefined};}
   if(r.status!==200){await r.body?.cancel();return {status:r.status,data:undefined};}
   // Broker Assets are small; cap unexpected responses rather than retaining arbitrary bodies.
   const reader=r.body?.getReader();if(!reader)throw new HandoverError(502,'broker_invalid_response');
   let size=0;const chunks:Uint8Array[]=[];
   try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>65536){await reader.cancel();throw new HandoverError(502,'broker_invalid_response');}chunks.push(part.value);}}finally{reader.releaseLock();}
   let data;try{data=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new HandoverError(502,'broker_invalid_response');}
   if(!data||typeof data!=='object'||Array.isArray(data))throw new HandoverError(502,'broker_invalid_response');
   return {status:r.status,data};
  }
  const get=(id:string)=>request('GET','/entities/'+encodeURIComponent(id));
  const department=`urn:ngsi-ld:Department:${tenant}:${event.data.departmentId}`,location=`urn:ngsi-ld:Location:${tenant}:${event.data.locationId}`;
  for(const [id,type] of [[department,'Department'],[location,'Location']]){
   const r=await get(id!);if(r.status!==200||r.data.id!==id||![type,ns+type].includes(r.data.type)||attribute(r.data,'organizationId')?.value!==tenant||attribute(r.data,'businessId')?.value!==id!.split(':').at(-1))throw new HandoverError(r.status===404||r.status===200?409:502,'broker_reference_unavailable');
  }
  const id=event.data.assetId,businessId=id.split(':').at(-1)!;
  const observedAt=new Date(Math.floor(Date.parse(event.occurredAt)/1000)*1000).toISOString();
  const updates={
   status:{type:'Property',value:'in_use',observedAt},
   belongsToDepartment:{type:'Relationship',object:department},
   locatedAt:{type:'Relationship',object:location},
   sourceEventId:{type:'Property',value:event.eventId},
  };
  const matches=(a:Record<string,any>)=>attribute(a,'status')?.value==='in_use'&&Date.parse(attribute(a,'status')?.observedAt)===Date.parse(observedAt)&&attribute(a,'belongsToDepartment')?.object===department&&attribute(a,'locatedAt')?.object===location&&attribute(a,'sourceEventId')?.value===event.eventId;
  const validate=(a:Record<string,any>)=>{if(a.id!==id||!['Asset',ns+'Asset'].includes(a.type)||attribute(a,'organizationId')?.value!==tenant||attribute(a,'businessId')?.value!==businessId)throw new HandoverError(409,'broker_asset_conflict');};
  async function update(a:Record<string,any>){
   validate(a);if(matches(a))return;
   const observed=attribute(a,'status')?.observedAt;
   if(attribute(a,'sourceEventId')?.value===event.eventId||typeof observed!=='string'||!Number.isFinite(Date.parse(observed))||Date.parse(observed)>=Date.parse(observedAt))throw new HandoverError(409,'broker_observation_conflict');
   // Append overwrites owned attributes and adds missing ones on an existing Asset.
   const appended=await request('POST','/entities/'+encodeURIComponent(id)+'/attrs',updates);if(appended.status!==204)throw new HandoverError(502,'broker_write_failed');
  }
  const before=await get(id);
  if(before.status===404){
   const created=await request('POST','/entities',{id,type:'Asset',businessId:{type:'Property',value:businessId},organizationId:{type:'Property',value:tenant},...updates});
   if(created.status===409){const raced=await get(id);if(raced.status!==200)throw new HandoverError(502,'broker_readback_failed');await update(raced.data);}
   else if(created.status!==201)throw new HandoverError(502,'broker_write_failed');
  }else if(before.status===200)await update(before.data);
  else throw new HandoverError(502,'broker_unavailable');
  const after=await get(id);if(after.status!==200)throw new HandoverError(502,'broker_readback_failed');validate(after.data);
  if(!matches(after.data))throw new HandoverError(502,'broker_readback_failed');
  return {assetId:id,status:'in_use',sourceEventId:event.eventId};
 };
}
