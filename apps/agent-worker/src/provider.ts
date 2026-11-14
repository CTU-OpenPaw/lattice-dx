/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
export class ProviderError extends Error {
 constructor(public readonly code:string,public readonly status?:number){super(code);}
}
type Message={role:'system'|'user';content:string};
type Config={baseUrl:string;apiKey:string;model:string;timeoutMs?:number};
const fail=(code:string,status?:number):never=>{throw new ProviderError(code,status);};
const modelId=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,199}$/.test(value);

/** Server/CLI only. Explicit config, fixed paths, no retries and no raw error output. */
export function createProvider(config:Config,fetchImpl:typeof fetch=fetch){
 let base:URL;
 try{base=new URL(config.baseUrl);}catch{return fail('provider_config_invalid');}
 if(base.username||base.password||base.search||base.hash||!(base.protocol==='https:'||(base.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(base.hostname)))||typeof config.apiKey!=='string'||!config.apiKey.trim()||/[\r\n]/.test(config.apiKey)||!modelId(config.model))fail('provider_config_invalid');
 const timeoutMs=config.timeoutMs??45000;
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>120000)fail('provider_config_invalid');
 const baseUrl=base.toString().replace(/\/$/,'');
 async function request(path:string,body?:unknown):Promise<any>{
  try{
   const response=await fetchImpl(baseUrl+path,{method:body===undefined?'GET':'POST',redirect:'error',signal:AbortSignal.timeout(timeoutMs),headers:{authorization:'Bearer '+config.apiKey,...(body!==undefined?{'content-type':'application/json'}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
   if(!response.ok){await response.body?.cancel();fail('provider_http_error',response.status);}
   const reader=response.body?.getReader()??fail('provider_response_invalid');
   const chunks:Uint8Array[]=[];let size=0;
   try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>65536){await reader.cancel();fail('provider_response_too_large');}chunks.push(value);}}finally{reader.releaseLock();}
   try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return fail('provider_response_invalid');}
  }catch(error){if(error instanceof ProviderError)throw error;return fail('provider_transport_error');}
 }
 return {
  async models():Promise<string[]>{
   const body=await request('/models');
   if(!Array.isArray(body?.data)||body.data.length>500||body.data.some((item:any)=>!modelId(item?.id)))fail('provider_response_invalid');
   return body.data.map((item:{id:string})=>item.id);
  },
  async complete(messages:Message[]):Promise<{model:string;text:string}>{
   if(!Array.isArray(messages)||messages.length<1||messages.length>10||messages.some(m=>!m||!['system','user'].includes(m.role)||typeof m.content!=='string'||!m.content.trim())||Buffer.byteLength(JSON.stringify(messages),'utf8')>24000)fail('provider_input_invalid');
   const body=await request('/chat/completions',{model:config.model,messages,max_tokens:512,stream:false});
   const text=body?.choices?.[0]?.message?.content;
   if(typeof text!=='string'||!text.trim()||text.length>16000)fail('provider_response_invalid');
   return {model:modelId(body.model)?body.model:config.model,text};
  },
 };
}
