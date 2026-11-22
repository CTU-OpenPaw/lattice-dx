/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const {failure,recordInput,fingerprint}=require('./native-integration-policy');
const {resolveNativeActor}=require('./native-scope');
async function boundedJson(response,maxBytes=131072){
 const reader=response.body?.getReader();if(!reader)throw failure('INTEGRATION_RESPONSE_INVALID',502);
 let size=0;const chunks=[];
 try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>maxBytes){await reader.cancel();throw failure('INTEGRATION_RESPONSE_TOO_LARGE',502);}chunks.push(part.value);}}finally{reader.releaseLock();}
 try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw failure('INTEGRATION_RESPONSE_INVALID',502);}
}
const ALLOWED_INTERNAL_HOSTS=new Set(['127.0.0.1','localhost','[::1]','::1','nocobase','host.docker.internal']);
function resolveInternalBaseUrl(env=process.env,override){
 const raw=override??env?.NOCOBASE_INTERNAL_URL??env?.DX_INTERNAL_NOCOBASE_URL;
 if(!raw||!String(raw).trim())return 'http://127.0.0.1';
 let parsed;
 try{parsed=new URL(String(raw).trim());}catch{throw failure('INTEGRATION_INTERNAL_URL_INVALID',500);}
 const host=parsed.hostname.toLowerCase();
 if(!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password||parsed.search||parsed.hash||!ALLOWED_INTERNAL_HOSTS.has(host)){
  throw failure('INTEGRATION_INTERNAL_URL_INVALID',500);
 }
 return parsed.origin;
}
async function readNativeRecord(ctx,input,{fetchImpl=fetch,internalBaseUrl}={}){
 const {collection,recordId}=recordInput(input);
 const actor=await resolveNativeActor(ctx.app.db,ctx.state.currentUser);
 if(ctx.app.name&&ctx.app.name!=='main')throw failure('INTEGRATION_SUBAPP_UNSUPPORTED',503);
 // Reuse the host's actual API pipeline rather than duplicating field/data ACL.
 // No origin, path, query, role or organization is accepted from tool arguments.
 const baseUrl=resolveInternalBaseUrl(process.env,internalBaseUrl);
 const headers={Accept:'application/json','X-Role':ctx.state.currentRole};
 for(const key of ['Authorization','Cookie','X-Authenticator']){const value=ctx.get(key);if(value)headers[key]=value;}
 let response;try{response=await fetchImpl(baseUrl+'/api/'+collection+':get?filterByTk='+encodeURIComponent(recordId),{headers,redirect:'error',signal:AbortSignal.timeout(5000)});}catch{throw failure('INTEGRATION_NATIVE_API_UNAVAILABLE',503);}
 if(!response.ok){await response.body?.cancel();throw failure('INTEGRATION_RECORD_ACCESS_DENIED',[401,403,404].includes(response.status)?response.status:502);}
 const body=await boundedJson(response),row=body.data;
 if(!row||typeof row!=='object'||Array.isArray(row)||String(row.id)!==recordId)throw failure('INTEGRATION_RECORD_NOT_FOUND',404);
 // Scope is checked independently as well. Never add hidden business fields to
 // the response; native API field guards decide exactly what the caller sees.
 const scoped=await ctx.app.db.getRepository(collection).findOne({filter:{id:recordId,organizationId:actor.organizationId},fields:['id']});
 if(!scoped)throw failure('INTEGRATION_RECORD_NOT_FOUND',404);
 return {actor,collection,recordId,record:row,fingerprint:fingerprint(row)};
}
module.exports={readNativeRecord,boundedJson,resolveInternalBaseUrl};
