/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import {expect,test,vi} from 'vitest';
import {checkLocal} from '../scripts/check-local.mjs';
const answer=(url:string)=>url.endsWith('/ready')?{status:'ready',service:'api'}:url.includes('openid-configuration')?{issuer:'http://localhost:8081/realms/lattice'}:url.endsWith('/version')?{'orionld version':'1.10.0'}:url.endsWith('/models')?{data:[{id:'combo'}]}:url.endsWith('getLang')?{data:{lang:'en-US',resources:{translation:'a'.repeat(570000)}}}:{status:'ok'};
test('doctor only reads fixed local endpoints; service readiness is not business acceptance',async()=>{
 const transport=vi.fn(async(url:string)=>Response.json(answer(url)));
 const result=await checkLocal({integration:true,agent:true,fetchImpl:transport});
 expect(result.ok).toBe(true);expect(result.businessFlowsVerified).toBe(false);expect(result.checks).toHaveLength(6);
 for(const [url,opts] of transport.mock.calls as unknown as [string,RequestInit][]){expect(new URL(url).hostname).toBe('localhost');expect(opts.method).toBe('GET');expect(opts.redirect).toBe('error');expect(opts.headers).toBeUndefined();}
 expect(transport.mock.calls.every(([url])=>!url.includes('chat/completions'))).toBe(true);
});
test('unavailable services and malformed responses stay distinct and do not leak bodies',async()=>{
 const transport=vi.fn(async(url:string)=>url.endsWith('/ready')?Response.json({status:'not_ready',secret:'fixture-private'},{status:503}):new Response('fixture-private',{status:200}));
 const result=await checkLocal({fetchImpl:transport});
 expect(result.ok).toBe(false);expect(result.checks.every(c=>c.status==='unavailable')).toBe(true);expect(JSON.stringify(result)).not.toContain('fixture-private');
});
test('a listening 9router without combo is not marked ready for the configured worker',async()=>{
 const result=await checkLocal({agent:true,fetchImpl:async(url)=>Response.json(String(url).endsWith('/models')?{data:[{id:'other'}]}:answer(String(url)))});
 expect(result.checks.find(c=>c.service==='9router')?.status).toBe('unavailable');expect(result.ok).toBe(false);
});
test('oversized successful responses cannot bypass the bounded JSON reader',async()=>{
 const result=await checkLocal({fetchImpl:async(url)=>Response.json(String(url).endsWith('/ready')?{status:'ready',service:'api',padding:'x'.repeat(65536)}:answer(String(url)))});
 expect(result.checks.find(c=>c.service==='engine')?.status).toBe('unavailable');
 expect(result.checks.find(c=>c.service==='nocobase')?.status).toBe('ready');
});
