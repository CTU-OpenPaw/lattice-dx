// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';

const base=new URL(process.env.NOCOBASE_URL??'http://localhost:13000');
if(!['localhost','127.0.0.1'].includes(base.hostname))throw Error('Local acceptance only');
async function call(path,{token,method='GET',values}={}) {
  const response=await fetch(new URL('/api/'+path,base),{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},...(values?{body:JSON.stringify(values)}:{}),signal:AbortSignal.timeout(15000)});
  return {status:response.status,body:await response.json()};
}
async function success(path,options){const r=await call(path,options);assert.ok(r.status<300,`${path.split('?')[0]} HTTP ${r.status}: ${r.body.errors?.[0]?.code??r.body.errors?.[0]?.message??'request failed'}`);return r.body.data;}
const rootLogin=await success('auth:signIn',{method:'POST',values:{email:process.env.NOCOBASE_ADMIN_EMAIL??'admin@nocobase.com',password:process.env.NOCOBASE_ADMIN_PASSWORD??'admin123'}});
const token=rootLogin.token;
const suffix=randomUUID().replaceAll('-','').slice(0,14),role='native_accept_'+suffix,password=randomUUID();
const fixtures=[];
const create=async(resource,values)=>{const row=await success(resource+':create',{token,method:'POST',values});fixtures.push({resource,id:row.id});return row;};
const checks=[];
let roleCreated=false;
try {
  await success('roles:create',{token,method:'POST',values:{name:role,title:'Native acceptance '+suffix}});roleCreated=true;
  for(const resource of ['latticeAssets','latticeEmployees']){
    await success(`roles/${role}/resources:create`,{token,method:'POST',values:{name:resource,usingActionsConfig:true,actions:[{name:'view'},{name:'create'},{name:'update'},{name:'destroy'}]}});
  }
  const user=await create('users',{username:'native_'+suffix,email:`${suffix}@example.invalid`,nickname:'Native acceptance',password,roles:[role]});
  const orgA='accept_a_'+suffix,orgB='accept_b_'+suffix;
  const deptA=await create('latticeDepartments',{code:'DA_'+suffix,name:'Acceptance A',organizationId:orgA});
  const deptB=await create('latticeDepartments',{code:'DB_'+suffix,name:'Acceptance B',organizationId:orgB});
  const employee=await create('latticeEmployees',{code:'EA_'+suffix,name:'Acceptance employee',organizationId:orgA,departmentId:deptA.id,userId:user.id,active:true});
  const foreignEmployee=await create('latticeEmployees',{code:'EB_'+suffix,name:'Acceptance foreign employee',organizationId:orgB,departmentId:deptB.id});
  const assetA=await create('latticeAssets',{code:'AA_'+suffix,name:'Acceptance asset A',organizationId:orgA,departmentId:deptA.id});
  const assetB=await create('latticeAssets',{code:'AB_'+suffix,name:'Acceptance asset B',organizationId:orgB,departmentId:deptB.id});
  const invalidReferences=[
    {departmentId:deptB.id},{department:{id:deptB.id}},
    {custodianId:foreignEmployee.id},{custodian:{id:foreignEmployee.id}},
  ];
  for(const [index,reference] of invalidReferences.entries()){
    const deniedCreate=await call('latticeAssets:create',{token,method:'POST',values:{code:`BAD_${suffix}_${index}`,name:'Invalid assignment',organizationId:orgA,...reference}});
    if(deniedCreate.body.data?.id)fixtures.push({resource:'latticeAssets',id:deniedCreate.body.data.id});
    assert.equal(deniedCreate.status,409);
    const deniedUpdate=await call('latticeAssets:update?filterByTk='+assetA.id,{token,method:'POST',values:reference});
    assert.equal(deniedUpdate.status,409);
  }
  const unchanged=await success('latticeAssets:get?filterByTk='+assetA.id,{token});
  assert.equal(String(unchanged.departmentId),String(deptA.id));
  assert.equal(unchanged.custodianId,null);
  await success('latticeAssets:update?filterByTk='+assetA.id,{token,method:'POST',values:{custodian:{id:employee.id}}});
  const assigned=await success('latticeAssets:get?filterByTk='+assetA.id,{token});
  assert.equal(String(assigned.custodianId),String(employee.id));
  checks.push('root_asset_assignment_stays_in_organization');
  const session=await success('auth:signIn',{method:'POST',values:{email:`${suffix}@example.invalid`,password}});
  const actorToken=session.token;
  const ctx=await success('latticeNative:context',{token:actorToken});
  assert.equal(ctx.organizationId,orgA);assert.equal(String(ctx.userId),String(user.id));checks.push('verified_native_user_mapping');
  const query=encodeURIComponent(JSON.stringify({code:{$in:['AA_'+suffix,'AB_'+suffix]}}));
  const list=await success('latticeAssets:list?filter='+query,{token:actorToken});
  const rows=Array.isArray(list)?list:list?.items;
  assert.deepEqual(rows.map(r=>String(r.id)),[String(assetA.id)]);checks.push('same_organization_native_list');
  const foreign=await call('latticeAssets:get?filterByTk='+assetB.id,{token:actorToken});
  assert.ok(foreign.status===404 || (foreign.status===200 && !foreign.body.data));checks.push('cross_organization_detail_hidden');
  for(const values of [{organizationId:orgB},{departmentId:deptB.id}]){
    const denied=await call('latticeAssets:update?filterByTk='+assetA.id,{token:actorToken,method:'POST',values});assert.equal(denied.status,403);
  }checks.push('organization_and_relation_write_denied');
  const escalation=await call('latticeEmployees:update?filterByTk='+employee.id,{token:actorToken,method:'POST',values:{organizationId:orgB}});
  assert.equal(escalation.status,403);checks.push('identity_mapping_mutation_denied');
  await success('latticeEmployees:update?filterByTk='+employee.id,{token,method:'POST',values:{active:false}});
  const revoked=await call('latticeNative:context',{token:actorToken});assert.equal(revoked.status,403);checks.push('membership_revocation_rechecked');
  await mkdir('output/native-platform',{recursive:true});
  await writeFile('output/native-platform/acceptance.json',JSON.stringify({at:new Date().toISOString(),checks,scope:'Real HTTP native auth/ACL/collection APIs and persistent PostgreSQL; temporary fixtures cleaned in finally. No browser or workflow E2E claim.'},null,2));
  console.log(JSON.stringify({result:'PASS',checks}));
}finally{
  const cleanupErrors=[];
  for(const fixture of fixtures.reverse()){
    try{await success(`${fixture.resource}:destroy?filterByTk=${fixture.id}`,{token,method:'POST'});}catch{cleanupErrors.push(fixture.resource+':'+fixture.id);}
  }
  if(roleCreated){try{await success('roles:destroy?filterByTk='+role,{token,method:'POST'});}catch{cleanupErrors.push('role:'+role);}}
  if(cleanupErrors.length)throw Error('Acceptance cleanup requires attention: '+cleanupErrors.join(', '));
}
