// SPDX-License-Identifier: Apache-2.0
import {expect,test,vi} from 'vitest';
import {runIncidentJob} from './incident.js';

const jobId='abcdef11-1111-4111-8111-111111111111';
const assetId='22222222-2222-4222-8222-222222222222';
const leaseToken='33333333-3333-4333-8333-333333333333';
const proposalId='44444444-4444-4444-8444-444444444444';
const config={apiUrl:'http://localhost:4000',workerToken:'private-worker-token',baseUrl:'http://localhost:20128/v1',apiKey:'private-provider-key',model:'combo'};
const context={case:{id:jobId,title:'Synthetic incident',state:'analyzing',notificationId:jobId},asset:{id:assetId,title:'Fixture asset',version:1,attributes:{status:'in_use',serial:'fixture'}}};
const proposal={summary:'Inspect before changing status.',suggestedStatus:'repair',evidence:[assetId]};
function fixture(options:{deny?:boolean;output?:unknown;providerError?:boolean;lostResult?:boolean;confirmed?:boolean;expired?:boolean;late?:boolean;attachment?:unknown;notificationId?:string}={}){
 let clock=Date.now();const paths:string[]=[];
 const api=vi.fn(async(url: string|URL|Request,init?:RequestInit)=>{
  const path=String(url).split('/v1/agent-jobs/')[1];paths.push(path);
  expect((init?.headers as Record<string,string>).authorization).toBe('Bearer private-worker-token');
  if(path.endsWith('/claim'))return Response.json({id:jobId,assetId,runId:jobId,status:'running',leaseToken,leaseUntil:new Date(clock+(options.expired?-1:60000)).toISOString(),deadline:new Date(clock+300000).toISOString()});
  if(path.endsWith('/context')){expect((init?.headers as Record<string,string>)['x-agent-lease']).toBe(leaseToken);return options.deny?Response.json({}, {status:403}):Response.json({...context,case:{...context.case,notificationId:options.notificationId??jobId},...(options.attachment?{attachment:options.attachment}:{})});}
  if(path.endsWith('/result')){expect(JSON.parse(init!.body as string)).toEqual({leaseToken,proposal});if(options.lostResult)throw Error('lost secret response');return Response.json({id:jobId,status:'completed',proposalId,proposal});}
  if(path.endsWith('/fail'))return Response.json({status:'failed'});
  return Response.json(options.confirmed?{id:jobId,status:'completed',proposalId,proposal}:{id:jobId,status:'running'});
 });
 const provider=vi.fn(async(_url: string|URL|Request,init?:RequestInit)=>{
  expect(JSON.parse(init!.body as string).model).toBe('combo');
  if(options.late)clock+=61000;
  if(options.providerError)throw Error('private provider error');
  return Response.json({model:'resolved-combo-member',choices:[{message:{content:JSON.stringify(options.output??proposal)}}]});
 });
 return {api,provider,paths,run:()=>runIncidentJob(config,jobId,{fetchImpl:api,providerFetch:provider,now:()=>clock})};
}
test('claims one job, reads only leased context and persists a proposal without human actions',async()=>{
 const f=fixture();expect(await f.run()).toEqual({jobId,proposalId,model:'resolved-combo-member',status:'completed'});
 expect(f.paths).toEqual([jobId+'/claim',jobId+'/context',jobId+'/result']);expect(f.provider).toHaveBeenCalledTimes(1);
});
test('denied context never reaches the model',async()=>{
 const f=fixture({deny:true});await expect(f.run()).rejects.toMatchObject({code:'tool_denied'});expect(f.provider).not.toHaveBeenCalled();expect(f.paths.at(-1)).toBe(jobId+'/fail');
});
test('accepts opaque notification IDs used by external broker events',async()=>{
 expect((await fixture({notificationId:'external/opaque/01'}).run()).status).toBe('completed');
});
test('normalizes uppercase UUID input consistently with backend routes',async()=>{
 const f=fixture();expect((await runIncidentJob(config,jobId.toUpperCase(),{fetchImpl:f.api,providerFetch:f.provider})).jobId).toBe(jobId);
});
test.each([{...proposal,action:'approve'},{...proposal,evidence:['invented-source']},{...proposal,summary:''},{...proposal,evidence:[]}])('rejects invalid or ungrounded model output',async output=>{
 const f=fixture({output});await expect(f.run()).rejects.toMatchObject({code:'invalid_output'});expect(f.paths.some(p=>p.endsWith('/result'))).toBe(false);
});
test('provider failures use a safe code and never expose its error',async()=>{
 const f=fixture({providerError:true});await expect(f.run()).rejects.toThrow('model_unavailable');expect(JSON.parse(f.api.mock.calls.at(-1)![1]!.body as string).code).toBe('model_unavailable');
});
test.each([{expired:true},{late:true}])('does not submit a result beyond the lease',async options=>{
 const f=fixture(options);await expect(f.run()).rejects.toMatchObject({code:'lease_expired'});expect(f.paths.some(p=>p.endsWith('/result'))).toBe(false);if(options.expired)expect(f.provider).not.toHaveBeenCalled();
});
test('uncertain result delivery is read back, never failed or inferred twice',async()=>{
 const f=fixture({lostResult:true,confirmed:true});expect((await f.run()).proposalId).toBe(proposalId);expect(f.provider).toHaveBeenCalledTimes(1);expect(f.paths.at(-1)).toBe(jobId);expect(f.paths.some(p=>p.endsWith('/fail'))).toBe(false);
 const g=fixture({lostResult:true});await expect(g.run()).rejects.toMatchObject({code:'result_uncertain'});expect(g.paths.some(p=>p.endsWith('/fail'))).toBe(false);
});
test('supports explicit small UTF-8 text attachments and rejects PDFs before model call',async()=>{
 const f=fixture({attachment:{id:proposalId,filename:'reading.txt',contentBase64:Buffer.from('temperature=60; inspect the sensor').toString('base64')}});await f.run();
 expect(JSON.parse(f.provider.mock.calls[0][1]!.body as string).messages[1].content).toContain('temperature=60');
 const g=fixture({attachment:{id:proposalId,filename:'reading.pdf',contentBase64:'YQ=='}});await expect(g.run()).rejects.toMatchObject({code:'unsupported_attachment'});expect(g.provider).not.toHaveBeenCalled();
});
test('rejects direct model IDs, invalid job IDs and unsafe API URLs before network',async()=>{
 const api=vi.fn();for(const [c,id] of [[{...config,model:'agy/forbidden'},jobId],[config,'../other'],[{...config,apiUrl:'http://remote.example'},jobId]] as const){await expect(runIncidentJob(c,id,{fetchImpl:api})).rejects.toMatchObject({code:'worker_config_invalid'});}expect(api).not.toHaveBeenCalled();
});
