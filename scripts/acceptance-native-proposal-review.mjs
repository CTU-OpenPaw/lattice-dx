/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {configureNativeProposalReview} from './configure-native-process.mjs';
const base=new URL(process.env.NOCOBASE_URL??'http://localhost:13003');
if(base.protocol!=='http:'||!['localhost','127.0.0.1'].includes(base.hostname)||Number(base.port)<13001||Number(base.port)>13999)throw Error('Use an isolated local native lab');
async function call(path,{token,method='GET',values}={}) {
  const response=await fetch(new URL('/api/'+path,base),{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},...(values?{body:JSON.stringify(values)}:{}),signal:AbortSignal.timeout(15000)});
  const text=await response.text();let body;try{body=JSON.parse(text);}catch{body={errors:[{message:'Non-JSON response'}]};}
  return {status:response.status,body};
}
async function ok(path,options){const r=await call(path,options);assert.ok(r.status<300,`${path.split('?')[0]} HTTP ${r.status}: ${JSON.stringify(r.body.errors)}`);return r.body.data;}
const root=(await ok('auth:signIn',{method:'POST',values:{email:process.env.NOCOBASE_ADMIN_EMAIL??'admin@nocobase.com',password:process.env.NOCOBASE_ADMIN_PASSWORD??'admin123'}})).token;
const suffix=randomUUID().replaceAll('-','').slice(0,12),org='native_'+suffix,fixtures=[],workflows=[],checks=[];
const filter=value=>'filter='+encodeURIComponent(JSON.stringify(value));
async function create(resource,values,token=root){const row=await ok(resource+':create',{token,method:'POST',values});fixtures.push({resource,id:row.id});return row;}
async function actor(role,organizationId=org){
  const password=randomUUID(),email=randomUUID()+'@example.invalid';
  const user=await create('users',{username:randomUUID(),email,password,roles:[role]});
  const employee=await create('latticeEmployees',{code:randomUUID(),name:role,organizationId,userId:user.id,active:true});
  return {user,employee,token:(await ok('auth:signIn',{method:'POST',values:{email,password}})).token};
}
async function waitFor(label,read,predicate){
  const deadline=Date.now()+20000;
  while(Date.now()<deadline){const value=await read();if(predicate(value))return value;await new Promise(resolve=>setTimeout(resolve,250));}
  throw Error('Timed out: '+label);
}
const mine=(actor,workflow)=>ok('workflowManualTasks:listMine?'+filter({workflowId:workflow.workflowId,status:0}),{token:actor.token});
const submit=(actor,task,form,action,values={})=>call('workflowManualTasks:submit?filterByTk='+task.id,{token:actor.token,method:'POST',values:{result:{[form]:values,_:action}}});
try {
  const employee=await actor('ldx_employee'), manager=await actor('ldx_manager');
  const workflow=await configureNativeProposalReview((path,options)=>ok(path,{...options,token:root}),{organizationId:org,reviewerEmployeeId:manager.employee.id});
  workflows.push(workflow.workflowId);
  await ok('workflows:update?filterByTk='+workflow.workflowId,{token:root,method:'POST',values:{enabled:true}});
  const asset=await create('latticeAssets',{code:suffix,name:'Proposal review fixture',organizationId:org});
  const invoke=(actor,action,values)=>ok('latticeIntegrations:'+action,{token:actor.token,method:'POST',values});
  const target={collection:'latticeAssets',recordId:asset.id};
  const record=await invoke(employee,'record',target);
  const input={...target,eventId:'review-'+suffix,fingerprint:record.fingerprint,text:'Fixture recommendation for a human review task.'};
  const proposal=await invoke(employee,'propose',input);
  assert.equal((await invoke(employee,'propose',input)).id,proposal.id);
  const task=(await waitFor('proposal task',()=>mine(manager,workflow),rows=>rows.length===1))[0];
  const execution=await ok('executions:get?filterByTk='+task.executionId,{token:root});
  assert.equal(String(execution.context.data.id),String(proposal.id));
  assert.equal((await submit(employee,task,'review','reviewed')).status,403);
  assert.equal((await submit(manager,task,'review','reviewed')).status,202);
  await waitFor('resolved task',()=>ok('executions:get?filterByTk='+task.executionId,{token:root}),execution=>execution.status===1);
  const after=await ok('latticeAgentProposals:get?filterByTk='+proposal.id,{token:root});
  assert.equal(after.state,'proposed');
  assert.equal((await mine(manager,workflow)).length,0);
  console.log(JSON.stringify({result:'PASS',checks:['one_review_task_after_replay','unassigned_actor_denied','manager_resolves_task','proposal_state_retained']}));
} finally {
 for(const id of workflows){
  await ok('workflows:update?filterByTk='+id,{token:root,method:'POST',values:{enabled:false}});
  await ok('workflows:destroy?filterByTk='+id,{token:root,method:'POST'});
 }
 await ok('latticeAgentProposals:destroy?'+filter({organizationId:org}),{token:root,method:'POST'});
 for(const row of fixtures.reverse())await ok(row.resource+':destroy?filterByTk='+row.id,{token:root,method:'POST'});
 await ok('latticeContextOutbox:destroy?'+filter({organizationId:org}),{token:root,method:'POST'});
}
