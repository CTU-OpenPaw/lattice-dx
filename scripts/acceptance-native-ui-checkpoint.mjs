/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {nodes,assertFieldCompatible,canonical,resourceProjection} from './lib/native-ui-checkpoint.mjs';
const manifestPath=process.env.NATIVE_UI_CHECKPOINT_MANIFEST??'output/native-platform/ui-checkpoint.json';
const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
const host=new URL(manifest.origin);
assert.ok(['localhost','127.0.0.1'].includes(host.hostname)&&host.protocol==='http:'&&host.port!=='13000');
assert.equal(manifest.complete,true,'Finish setup before acceptance');
const bundle=JSON.parse(await readFile(new URL('./fixtures/native-ui-checkpoint.json',import.meta.url),'utf8'));
const sessions=[],checks=[];let root;
async function call(path,{token=root,method='GET',values}={}){
  const r=await fetch(new URL('/api/'+path,host),{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},...(values===undefined?{}:{body:JSON.stringify(values)}),signal:AbortSignal.timeout(15000)});
  return {status:r.status,body:await r.json()};
}
async function ok(path,options){const r=await call(path,options);assert.ok(r.status<300,path.split('?')[0]+' HTTP '+r.status);return r.body.data;}
async function login(email,password){const s=await ok('auth:signIn',{token:null,method:'POST',values:{email,password}});sessions.push(s.token);return s.token;}
const save=()=>writeFile(manifestPath,JSON.stringify(manifest,null,2));
try{
  root=await login(process.env.NOCOBASE_ADMIN_EMAIL??'admin@nocobase.com',process.env.NOCOBASE_ADMIN_PASSWORD??'admin123');
  const employee=await login(manifest.email,'NativeLab-2026!');
  const context=await ok('latticeNative:context',{token:employee});assert.equal(context.organizationId,manifest.organizationId);
  assert.equal(String(context.employeeId),String(manifest.employeeId));checks.push('fixture_identity_and_organization');
  const fields=await ok('collections/latticeRequests/fields:list?filter='+encodeURIComponent(JSON.stringify({name:bundle.field.name})));
  assertFieldCompatible(fields[0],bundle.field);checks.push('field_type_and_final_label_persisted');
  const schema=await ok('uiSchemas:getJsonSchema/'+manifest.schemaUid);
  assert.equal(nodes(schema,node=>node['x-collection-field']==='latticeRequests.studioLabNote').length,2);
  assert.equal(nodes(schema,node=>node['x-component']==='Filter.Action').length,1);checks.push('native_table_form_and_filter_export_persisted');
  manifest.acceptanceRecords??={};
  if(!manifest.acceptanceRecords.own){
    const row=await ok('latticeRequests:create',{token:employee,method:'POST',values:{code:'CONFIG-'+randomUUID(),name:'Hồ sơ kiểm thử cấu hình',studioLabNote:'Ghi chú được tái tạo'}});
    manifest.acceptanceRecords.own=row.id;await save();
  }
  let row=await ok('latticeRequests:get?filterByTk='+manifest.acceptanceRecords.own,{token:employee});
  assert.equal(row.studioLabNote,'Ghi chú được tái tạo');assert.equal(row.status,'draft');
  await ok('latticeRequests:update?filterByTk='+row.id,{token:employee,method:'POST',values:{name:'Hồ sơ đã sửa tên',studioLabNote:'Không được ghi đè'}});
  row=await ok('latticeRequests:get?filterByTk='+row.id,{token:employee});
  assert.equal(row.name,'Hồ sơ đã sửa tên');assert.equal(row.studioLabNote,'Ghi chú được tái tạo');
  checks.push('create_and_read_custom_field_but_update_whitelist_preserves_value');
  const filtered=await ok('latticeRequests:list?filter='+encodeURIComponent(JSON.stringify({id:row.id})),{token:employee});
  assert.equal(filtered.length,1);assert.equal(String(filtered[0].id),String(row.id));checks.push('native_filter_returns_own_record');
  for(const [key,organizationId] of [['peer',manifest.organizationId],['foreign',manifest.organizationId+'-other']]){
    if(!manifest.acceptanceRecords[key]){
      const other=await ok('latticeRequests:create',{method:'POST',values:{code:'CONFIG-'+randomUUID(),name:'Hồ sơ ngoài phạm vi '+key,organizationId}});
      manifest.acceptanceRecords[key]=other.id;await save();
    }
    const other=await ok('latticeRequests:get?filterByTk='+manifest.acceptanceRecords[key],{token:employee});
    assert.ok(!other?.id,key+' document leaked');
  }
  checks.push('peer_and_cross_organization_records_hidden');
  for(const values of [{status:'completed'},{organizationId:manifest.organizationId+'-other'}])assert.equal((await call('latticeRequests:update?filterByTk='+row.id,{token:employee,method:'POST',values})).status,403);
  checks.push('state_and_organization_protected');
  const role=await ok('roles:get?filterByTk='+manifest.role);assert.equal(role.allowConfigure,false);assert.equal(role.allowNewMenu,false);
  for(const [roleName,digest] of Object.entries(manifest.presetDigests)){
    const resources=await ok('roles/'+roleName+'/resources:list?paginate=false&appends[]=actions&appends[]=actions.scope');
    assert.equal(createHash('sha256').update(canonical(resourceProjection(resources))).digest('hex'),digest);
  }
  checks.push('existing_seven_role_presets_unchanged');
  const report={at:new Date().toISOString(),origin:manifest.origin,pageUrl:manifest.origin+manifest.path,packageDigest:manifest.packageDigest,checks,result:'PASS',browserVerified:false,
    limits:['Native configuration and HTTP acceptance only; browser reload/labels/filter interactions still require a separate run.','No workflow is created or enabled by the checkpoint fixture.']};
  await writeFile(manifestPath+'.acceptance.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{for(const token of sessions)await call('auth:signOut',{token,method:'POST',values:{}}).catch(()=>{});}
