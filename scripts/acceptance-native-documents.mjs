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
import {configureNativeProcess} from './configure-native-process.mjs';
const base=new URL(process.env.NOCOBASE_URL??'http://localhost:13000');
if(!['localhost','127.0.0.1'].includes(base.hostname))throw Error('Local acceptance only');
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
  const employee=await actor('ldx_employee'),peer=await actor('ldx_employee'),manager=await actor('ldx_manager'),warehouse=await actor('ldx_warehouse'),director=await actor('ldx_director'),foreign=await actor('ldx_warehouse','foreign_'+suffix);
  const chartFixtures=[];
  for(const [organizationId,requesterId] of [[org,employee.employee.id],[org,peer.employee.id],['foreign_'+suffix,foreign.employee.id]]) {
    chartFixtures.push(await create('latticeRequests',{organizationId,requesterId,code:randomUUID(),name:'Chart scope acceptance'}));
  }
  const chartQuery={
    mode:'builder',variableResolution:'legacy-schema',dataSource:'main',collection:'latticeRequests',
    dimensions:[{field:'code'}],filter:{code:{$in:chartFixtures.map(row=>row.code)}},
    uid:'request-scope-'+suffix,cache:{enabled:true,ttl:30},
  };
  async function chartCodes(token,query=chartQuery){
    const rows=await ok('charts:queryData',{token,method:'POST',values:query});
    return rows.map(row=>row.code).sort();
  }
  assert.deepEqual(await chartCodes(root),chartFixtures.map(row=>row.code).sort());
  assert.deepEqual(await chartCodes(manager.token),chartFixtures.slice(0,2).map(row=>row.code).sort());
  assert.deepEqual(await chartCodes(employee.token),[chartFixtures[0].code]);
  assert.deepEqual(await chartCodes(manager.token,{...chartQuery,filter:{organizationId:'foreign_'+suffix}}),[]);
  const countByStatus={
    ...chartQuery,dimensions:[{field:'status'}],measures:[{field:'code',aggregation:'count',alias:'recordCount'}],
  };
  for(const [token,recordCount] of [[root,3],[manager.token,2],[employee.token,1]]){
    const rows=await ok('charts:queryData',{token,method:'POST',values:countByStatus});
    assert.deepEqual(rows.map(row=>({status:row.status,recordCount:Number(row.recordCount)})),[{status:'draft',recordCount}]);
  }
  const sqlChart=await call('charts:queryData',{token:manager.token,method:'POST',values:{...chartQuery,mode:'sql'}});
  assert.equal(sqlChart.status,403);
  checks.push('native_charts_preserve_organization_record_acl_and_cache_scope');
  for(const collection of ['latticeRequests','latticeOrders']) {
    const workflow=await configureNativeProcess((path,options)=>ok(path,{...options,token:root}),{collection,organizationId:org,reviewerEmployeeId:manager.employee.id,assigneeEmployeeId:warehouse.employee.id});
    workflows.push(workflow);
    await ok('workflows:update?filterByTk='+workflow.workflowId,{token:root,method:'POST',values:{enabled:true}});
    const document=await create(collection,{code:randomUUID(),name:'Native process acceptance',...(collection==='latticeOrders'?{quantity:5}:{} )},employee.token);
    assert.equal(document.organizationId,org);assert.equal(String(document.requesterId),String(employee.employee.id));
    const review=(await waitFor('native review task',()=>mine(manager,workflow),rows=>rows.length===1))[0];
    assert.equal(String(review.userId),String(manager.user.id));checks.push(collection+':native_collection_trigger_and_manual_review');
    assert.equal((await mine(employee,workflow)).length,0);
    assert.equal((await submit(employee,review,'review','approve')).status,403);checks.push(collection+':host_rejects_wrong_task_assignee');
    const hidden=await ok(collection+':get?filterByTk='+document.id,{token:peer.token});assert.ok(!hidden||!hidden.id);
    const crossOrg=await ok(collection+':get?filterByTk='+document.id,{token:foreign.token});assert.ok(!crossOrg||!crossOrg.id);checks.push(collection+':native_acl_and_org_scope');
    const edit=await call(collection+':update?filterByTk='+document.id,{token:employee.token,method:'POST',values:{description:'Attempt after submit'}});assert.equal(edit.status,403);checks.push(collection+':native_draft_scope_prevents_late_edit');
    assert.equal((await submit(manager,review,'review','approve',{status:'completed',decision:'rejected'})).status,202);
    assert.ok((await submit(manager,review,'review','approve')).status>=400);checks.push(collection+':native_task_cannot_be_processed_twice');
    const work=(await waitFor('native execution task',()=>mine(warehouse,workflow),rows=>rows.length===1))[0];
    const assigned=await ok(collection+':get?filterByTk='+document.id,{token:warehouse.token});assert.equal(assigned.status,'assigned');assert.equal(String(assigned.assigneeId),String(warehouse.employee.id));
    assert.equal((await submit(warehouse,work,'work','complete')).status,202);
    const final=await waitFor('native completed record',()=>ok(collection+':get?filterByTk='+document.id,{token:director.token}),record=>record.status==='completed');
    if(collection==='latticeOrders')assert.equal(final.quantity,5);
    const execution=await waitFor('native resolved execution',()=>ok('executions:get?filterByTk='+work.executionId,{token:root}),execution=>execution.status===1);
    assert.ok(execution.id);checks.push(collection+':host_updates_and_execution_history');
    const jobs=await ok('jobs:list?paginate=false&'+filter({executionId:execution.id}),{token:root});assert.ok(jobs.length>5);checks.push(collection+':native_jobs_are_authoritative');
    const rejected=await create(collection,{code:randomUUID(),name:'Native rejection'},employee.token);
    const rejectionTask=(await waitFor('native rejection task',()=>mine(manager,workflow),rows=>rows.length===1))[0];
    assert.equal((await submit(manager,rejectionTask,'review','reject',{decision:'approved'})).status,202);
    await waitFor('native rejected record',()=>ok(collection+':get?filterByTk='+rejected.id,{token:director.token}),record=>record.status==='rejected');
    await waitFor('native rejected branch ends',()=>ok('executions:get?filterByTk='+rejectionTask.executionId,{token:root}),execution=>execution.status===1);
    assert.equal((await mine(warehouse,workflow)).length,0);checks.push(collection+':native_reject_branch_and_preset_values');
    const self=await create(collection,{code:randomUUID(),name:'Native self review denied'},manager.token);
    await waitFor('native self approval condition',()=>ok('executions:list?paginate=false&'+filter({workflowId:workflow.workflowId,status:-1}),{token:root}),rows=>rows.some(execution=>String(execution.context?.data?.id)===String(self.id)));
    assert.equal((await mine(manager,workflow)).length,0);checks.push(collection+':native_condition_blocks_self_approval');
    const revoked=await create(collection,{code:randomUUID(),name:'Native revoked reviewer'},employee.token);
    const revokedTask=(await waitFor('revocation task',()=>mine(manager,workflow),rows=>rows.length===1))[0];
    await ok('latticeEmployees:update?filterByTk='+manager.employee.id,{token:root,method:'POST',values:{active:false}});
    assert.equal((await submit(manager,revokedTask,'review','approve')).status,202);
    await waitFor('native membership query blocks continuation',()=>ok('executions:get?filterByTk='+revokedTask.executionId,{token:root}),execution=>execution.status===-1);
    assert.equal((await ok(collection+':get?filterByTk='+revoked.id,{token:director.token})).status,'submitted');
    await ok('latticeEmployees:update?filterByTk='+manager.employee.id,{token:root,method:'POST',values:{active:true}});checks.push(collection+':native_query_rechecks_active_reviewer');
  }
  const retired=await call('latticeDocuments:submit',{token:employee.token,method:'POST',values:{}});assert.ok(retired.status>=400);checks.push('custom_document_engine_not_exposed');
  const protectedCreate=await call('latticeRequests:create',{token:director.token,method:'POST',values:{name:'Denied',code:randomUUID()}});assert.equal(protectedCreate.status,403);checks.push('native_director_is_read_only');
  await mkdir('output/native-platform',{recursive:true});await writeFile('output/native-platform/native-workflow-acceptance.json',JSON.stringify({at:new Date().toISOString(),checks,scope:'Real native HTTP auth/ACL, collection-trigger workflows, native manual tasks/submission, execution/jobs, persistent records. No browser E2E claim.'},null,2));
  console.log(JSON.stringify({result:'PASS',checks}));
} finally {
  const errors=[];
  for(const workflow of workflows.reverse()) {
    try{await ok('workflows:update?filterByTk='+workflow.workflowId,{token:root,method:'POST',values:{enabled:false}});await ok('workflows:destroy?filterByTk='+workflow.workflowId,{token:root,method:'POST'});}catch{errors.push('workflow:'+workflow.workflowId);}
  }
  for(const fixture of fixtures.reverse()){try{await ok(`${fixture.resource}:destroy?filterByTk=${fixture.id}`,{token:root,method:'POST'});}catch{errors.push(fixture.resource+':'+fixture.id);}}
  if(errors.length)throw Error('Cleanup required: '+errors.join(', '));
}
