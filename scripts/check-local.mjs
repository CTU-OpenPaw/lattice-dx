// SPDX-License-Identifier: Apache-2.0
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

/** Fixed loopback metadata probes; never authenticates, writes, or calls a model. */
export async function checkLocal({integration=false,agent=false,fetchImpl=fetch}={}){
 const probes=[
  ['engine','http://localhost:8080/ready',x=>x.status==='ready'&&x.service==='api'],
  ['keycloak','http://localhost:8081/realms/lattice/.well-known/openid-configuration',x=>x.issuer==='http://localhost:8081/realms/lattice'],
  ['nocobase','http://localhost:13000/api/app:getLang',x=>typeof x.data?.lang==='string',1048576],
  ...(integration?[
   ['orion-ld','http://localhost:1026/version',x=>typeof x['orionld version']==='string'],
   ['n8n','http://localhost:5678/healthz',x=>x.status==='ok'],
  ]:[]),
  ...(agent?[['9router','http://localhost:20128/v1/models',x=>Array.isArray(x.data)&&x.data.some(m=>m?.id==='combo')]]:[]),
 ];
 const checks=await Promise.all(probes.map(async([service,url,valid,maxBytes=65536])=>{
  let httpStatus;
  try{
   const response=await fetchImpl(url,{method:'GET',redirect:'error',signal:AbortSignal.timeout(3000)});httpStatus=response.status;
   if(!response.ok){await response.body?.cancel();throw Error();}
   const reader=response.body?.getReader();if(!reader)throw Error();
   const chunks=[];let bytes=0;
   try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>maxBytes){await reader.cancel();throw Error();}chunks.push(value);}}finally{reader.releaseLock();}
   const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
   if(!body||typeof body!=='object'||Array.isArray(body)||!valid(body))throw Error();
   return {service,status:'ready',httpStatus};
  }catch{return {service,status:'unavailable',...(httpStatus===undefined?{}:{httpStatus})};}
 }));
 return {scope:'service-readiness',ok:checks.every(c=>c.status==='ready'),businessFlowsVerified:false,checks};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2).filter(a=>a!=='--');
 if(args.some(a=>!['--integration','--agent'].includes(a))){console.error('Usage: pnpm local:doctor [--integration] [--agent]');process.exitCode=1;}
 else checkLocal({integration:args.includes('--integration'),agent:args.includes('--agent')}).then(result=>{console.log(JSON.stringify(result,null,2));if(!result.ok)process.exitCode=1;}).catch(()=>{console.error('Readiness check failed; no raw response printed.');process.exitCode=1;});
}
