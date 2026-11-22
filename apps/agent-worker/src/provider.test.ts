/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import {expect,test,vi} from 'vitest';
import {createServer} from 'node:http';
import {createProvider,ProviderError} from './provider.js';
const config={baseUrl:'http://localhost:20128/v1',apiKey:'fixture-private-key',model:'fixture/model',timeoutMs:100};
test('provider uses configured fixed endpoint and credentials; accepts actual returned model',async()=>{
 const fetchImpl=vi.fn(async()=>Response.json({model:'resolved-model',choices:[{message:{content:'proposal'}}]}));
 const result=await createProvider(config,fetchImpl as typeof fetch).complete([{role:'user',content:'Synthetic fixture'}]);
 expect(result).toEqual({model:'resolved-model',text:'proposal'});
 const [url,options]=fetchImpl.mock.calls[0] as unknown as [string,RequestInit];
 expect(url).toBe(config.baseUrl+'/chat/completions');expect(options.redirect).toBe('error');
 expect(options.headers).toMatchObject({authorization:'Bearer fixture-private-key'});
 expect(JSON.parse(options.body as string)).toMatchObject({model:'fixture/model',stream:false,max_tokens:512});
});
test('model discovery returns bounded model IDs without credential output',async()=>{
 const provider=createProvider(config,async()=>Response.json({data:[{id:'fixture/model'}]}));
 expect(await provider.models()).toEqual(['fixture/model']);
});
test.each([401,403,429,500,302])('provider sanitizes HTTP %s and never retries',async status=>{
 const fetchImpl=vi.fn(async()=>new Response('secret backend body fixture-private-key',{status}));
 await expect(createProvider(config,fetchImpl as typeof fetch).complete([{role:'user',content:'Fixture'}])).rejects.toMatchObject({code:'provider_http_error',status});
 expect(fetchImpl).toHaveBeenCalledTimes(1);
 try{await createProvider(config,fetchImpl as typeof fetch).models();}catch(error){expect(String(error)).not.toContain('fixture-private-key');expect(String(error)).not.toContain('backend body');}
});
test('provider rejects invalid JSON, oversized responses and empty completion',async()=>{
 for(const response of [new Response('not json'),new Response('x'.repeat(65537)),Response.json({choices:[{message:{content:''}}]})]){
  await expect(createProvider(config,async()=>response).complete([{role:'user',content:'Fixture'}])).rejects.toBeInstanceOf(ProviderError);
 }
});
test('transport and timeout failures do not echo errors or make a second request',async()=>{
 const fetchImpl=vi.fn(async()=>{throw Error('Authorization fixture-private-key');});
 await expect(createProvider(config,fetchImpl as typeof fetch).models()).rejects.toMatchObject({code:'provider_transport_error'});
 expect(fetchImpl).toHaveBeenCalledTimes(1);
});
test('native fetch timeout covers a response that stalls after successful headers',async()=>{
 const server=createServer((_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.write('{"choices":[');});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const address=server.address();if(!address||typeof address==='string')throw Error('Fixture address missing');
  await expect(createProvider({...config,baseUrl:`http://127.0.0.1:${address.port}/v1`,timeoutMs:75}).complete([{role:'user',content:'Fixture'}])).rejects.toMatchObject({code:'provider_transport_error'});
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
test('invalid config/input fails before network and does not disclose the key',async()=>{
 const fetchImpl=vi.fn();
 for(const overrides of [{baseUrl:'http://remote.example/v1'},{baseUrl:'https://user:password@example.com/v1'},{baseUrl:'http://localhost:20128/v1?token=secret'},{apiKey:''},{model:''},{timeoutMs:0}])expect(()=>createProvider({...config,...overrides},fetchImpl)).toThrow(ProviderError);
 await expect(createProvider(config,fetchImpl).complete([{role:'user',content:'x'.repeat(25000)}])).rejects.toMatchObject({code:'provider_input_invalid'});
 expect(fetchImpl).not.toHaveBeenCalled();
});
