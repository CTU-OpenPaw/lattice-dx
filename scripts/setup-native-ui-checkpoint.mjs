// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {checkpointSchema,checkpointPolicy,assertFieldCompatible,assertPolicyCompatible,nodes,canonical,resourceProjection,assertCheckpointTarget,fieldGrantRepairs} from './lib/native-ui-checkpoint.mjs';
import {instantiateNativePage} from './lib/native-ui-fixture.mjs';

const host=new URL(process.env.NOCOBASE_URL??'http://localhost:13004');
assert.ok(host.protocol==='http:'&&['localhost','127.0.0.1'].includes(host.hostname)&&host.port&&host.port!=='13000','Explicit isolated loopback runtime required');
const dbContainer=process.env.NOCOBASE_DB_CONTAINER;
assert.match(dbContainer??'',/^lattice-native-[a-z0-9-]+-(?:nocobase-db|postgres)-1$/,'Set the isolated native DB container');
function docker(args,encoding='utf8'){
  const result=spawnSync('docker',['--context','desktop-linux',...args],{encoding,maxBuffer:256*1024*1024,windowsHide:true});
  assert.equal(result.status,0,'Docker preflight/backup failed; command output withheld');return result.stdout;
}
const dbInfo=JSON.parse(docker(['inspect',dbContainer]))[0];
const project=dbInfo.Config?.Labels?.['com.docker.compose.project'];
const appNames=docker(['ps','--filter','label=com.docker.compose.project='+project,'--filter','label=com.docker.compose.service=nocobase','--format','{{.Names}}']).trim().split(/\r?\n/).filter(Boolean);
assert.equal(appNames.length,1,'Expected one native runtime for the selected DB');
assertCheckpointTarget(host,dbInfo,JSON.parse(docker(['inspect',appNames[0]]))[0]);
const bundle=JSON.parse(await readFile(new URL('./fixtures/native-ui-checkpoint.json',import.meta.url),'utf8'));
const template=JSON.parse(await readFile(new URL('./fixtures/native-ui-page.json',import.meta.url),'utf8'));
const policy=checkpointPolicy(bundle),configured=checkpointSchema(template,bundle);
const digest=createHash('sha256').update(JSON.stringify({bundle,template,policy})).digest('hex');
const manifestPath=process.env.NATIVE_UI_CHECKPOINT_MANIFEST??'output/native-platform/ui-checkpoint.json';
let manifest;
try{manifest=JSON.parse(await readFile(manifestPath,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
if(manifest){assert.equal(manifest.origin,host.origin,'Manifest belongs to another runtime');assert.equal(manifest.packageDigest,digest,'Package changed; inspect the existing fixture before migrating it');}
let token;
const filter=value=>'filter='+encodeURIComponent(JSON.stringify(value));
async function api(path,values){
  const response=await fetch(new URL('/api/'+path,host),{method:values===undefined?'GET':'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token,'X-Role':'root'}:{})},...(values===undefined?{}:{body:JSON.stringify(values)}),signal:AbortSignal.timeout(20000)});
  const body=await response.json();assert.ok(response.ok,path.split('?')[0]+' HTTP '+response.status);return body.data;
}
const save=()=>writeFile(manifestPath,JSON.stringify(manifest,null,2));
async function presetDigests(){
  const digests={};
  for(const key of ['employee','manager','warehouse','dispatcher','driver','director','admin']){
    const resources=await api('roles/ldx_'+key+'/resources:list?paginate=false&appends[]=actions&appends[]=actions.scope');
    digests['ldx_'+key]=createHash('sha256').update(canonical(resourceProjection(resources))).digest('hex');
  }
  return digests;
}
try{
  token=(await api('auth:signIn',{email:process.env.NOCOBASE_ADMIN_EMAIL??'admin@nocobase.com',password:process.env.NOCOBASE_ADMIN_PASSWORD??'admin123'})).token;
  const fields=await api('collections/'+bundle.collection+'/fields:list?'+filter({name:bundle.field.name}));
  if(fields.length)assertFieldCompatible(fields[0],bundle.field);
  if(!manifest){
    const backup=docker(['exec',dbContainer,'pg_dump','-Fc','-U','nocobase','-d','nocobase'],null);
    assert.equal(backup.subarray(0,5).toString(),'PGDMP','Backup required before setup');
    await mkdir('output/backups',{recursive:true});await mkdir('output/native-platform',{recursive:true});
    const id=randomUUID().replaceAll('-','').slice(0,12),schemaUid='config'+id;
    const backupPath='output/backups/native-ui-config-'+id+'.dump';await writeFile(backupPath,backup,{flag:'wx'});
    const page=instantiateNativePage(configured,schemaUid);
    manifest={format:'latticedx.native-ui-checkpoint-install',version:1,origin:host.origin,packageDigest:digest,backupPath,
      organizationId:'native-ui-config-'+id,role:'native_ui_config_'+id,email:'native.config.'+id+'@example.invalid',
      schemaUid,path:'/admin/'+schemaUid,tabUid:page.tabUid,schema:page.schema};await save();
  }
  if(!manifest.presetDigests){manifest.presetDigests=await presetDigests();await save();}
  if(!manifest.fieldGrantSnapshot||manifest.fieldGrantsRestored)assert.deepEqual(await presetDigests(),manifest.presetDigests,'Existing preset grants changed; inspect rather than overwrite');
  if(!fields.length){
    // Native fields.afterCreate adds the field to existing action whitelists.
    // Snapshot every role before creating it; remove only that automatic addition.
    const existingRoles=await api('roles:list?paginate=false');
    manifest.fieldGrantSnapshot=[];
    for(const role of existingRoles)manifest.fieldGrantSnapshot.push({role:role.name,resources:await api('roles/'+role.name+'/resources:list?paginate=false&appends[]=actions&appends[]=actions.scope')});
    await save();
    await api('collections/'+bundle.collection+'/fields:create',bundle.field);manifest.fieldCreated=true;await save();
  }
  if(manifest.fieldGrantSnapshot&&!manifest.fieldGrantsRestored){
    for(const snapshot of manifest.fieldGrantSnapshot){
      const current=await api('roles/'+snapshot.role+'/resources:list?paginate=false&appends[]=actions&appends[]=actions.scope');
      const repairs=fieldGrantRepairs(snapshot.resources,current,bundle.field.name);
      for(const resourceId of new Set(repairs.map(repair=>repair.resourceId))){
        const prior=snapshot.resources.find(resource=>resource.id===resourceId);
        await api('roles/'+snapshot.role+'/resources:update?filterByTk='+resourceId,{actions:prior.actions.map(action=>({id:action.id,name:action.name,fields:action.fields,scopeId:action.scopeId}))});
      }
      const restored=await api('roles/'+snapshot.role+'/resources:list?paginate=false&appends[]=actions&appends[]=actions.scope');
      assert.equal(canonical(resourceProjection(restored)),canonical(resourceProjection(snapshot.resources)),'Existing role grants were not preserved');
    }
    manifest.fieldGrantsRestored=true;await save();
  }
  assert.deepEqual(await presetDigests(),manifest.presetDigests,'Existing preset grants changed; inspect rather than overwrite');
  const roles=await api('roles:list?'+filter({name:manifest.role}));
  if(!roles.length){
    assert.notEqual(manifest.roleCreated,true,'Fixture role was removed; inspect rather than recreating revoked access');
    await api('roles:create',{name:manifest.role,title:'Nhân viên kiểm thử cấu hình',allowConfigure:false,allowNewMenu:false,allowNewAiEmployee:false,strategy:{actions:[]},snippets:[]});
    manifest.roleCreated=true;await save();
  }else{
    assert.equal(manifest.roleCreated,true,'Refusing to adopt a role outside the manifest');
    assert.equal(roles[0].allowConfigure,false,'Fixture role gained configuration access');
    assert.equal(roles[0].allowNewMenu,false,'Fixture role gained menu access');
    assert.deepEqual(roles[0].strategy,{actions:[]},'Fixture role strategy drifted');
  }
  const resources=await api('roles/'+manifest.role+'/resources:list?appends[]=actions&appends[]=actions.scope');
  assert.ok(resources.length<=1,'Unexpected resource grants on fixture role');
  if(!resources.length)await api('roles/'+manifest.role+'/resources:create',policy);
  else assertPolicyCompatible(resources[0],policy);
  if(!manifest.userId){
    assert.equal((await api('users:list?'+filter({email:manifest.email}))).length,0,'Do not overwrite an existing user');
    const user=await api('users:create',{username:manifest.email.split('@')[0],email:manifest.email,nickname:'Nhân viên thử cấu hình',password:'NativeLab-2026!',roles:[manifest.role]});
    manifest.userId=user.id;await save();
  }
  if(!manifest.employeeId){
    const employee=await api('latticeEmployees:create',{code:manifest.organizationId,name:'Nhân viên thử cấu hình',organizationId:manifest.organizationId,userId:manifest.userId,active:true});
    manifest.employeeId=employee.id;await save();
  }
  const user=await api('users:get?filterByTk='+manifest.userId+'&appends[]=roles');
  assert.equal(user.email,manifest.email,'Fixture user identity changed');
  assert.deepEqual(user.roles.map(role=>role.name),[manifest.role],'Fixture user roles changed; do not reset them');
  const membership=await api('latticeEmployees:get?filterByTk='+manifest.employeeId);
  assert.equal(String(membership.userId),String(manifest.userId));
  assert.equal(membership.organizationId,manifest.organizationId);assert.equal(membership.active,true,'Fixture membership was revoked');
  if(!manifest.schemaInserted){
    const existing=await api('uiSchemas:getJsonSchema/'+manifest.schemaUid);
    if(!existing||Object.keys(existing).length===0)await api('uiSchemas:insert',manifest.schema);
    else assert.equal(nodes(existing,node=>node['x-collection-field']==='latticeRequests.studioLabNote').length,2,'Unexpected existing schema');
    manifest.schemaInserted=true;await save();
  }
  if(!manifest.routeId){
    const route=await api('desktopRoutes:create',{title:'Kiểm thử chỉnh cấu hình',type:'page',schemaUid:manifest.schemaUid,enableTabs:false});manifest.routeId=route.id;await save();
  }
  if(!manifest.tabRouteId){
    const tab=await api('desktopRoutes:create',{parentId:manifest.routeId,type:'tabs',schemaUid:manifest.tabUid,tabSchemaName:manifest.tabUid+'name',hidden:true});manifest.tabRouteId=tab.id;await save();
  }
  const granted=await api('roles/'+manifest.role+'/desktopRoutes:list?paginate=false');
  const missing=[manifest.routeId,manifest.tabRouteId].filter(id=>!granted.some(route=>String(route.id)===String(id)));
  if(missing.length)await api('roles/'+manifest.role+'/desktopRoutes:add',{tk:missing});
  assertPolicyCompatible((await api('roles/'+manifest.role+'/resources:list?appends[]=actions&appends[]=actions.scope'))[0],policy);
  const persisted=await api('uiSchemas:getJsonSchema/'+manifest.schemaUid);
  assert.equal(nodes(persisted,node=>node['x-collection-field']==='latticeRequests.studioLabNote').length,2);
  assert.equal(nodes(persisted,node=>node['x-component']==='Filter.Action').length,1);
  assert.deepEqual(await presetDigests(),manifest.presetDigests,'Existing preset grants changed during installation');
  manifest.complete=true;await save();
  console.log(JSON.stringify({result:'PASS',pageUrl:host.origin+manifest.path,email:manifest.email,role:manifest.role,manifestPath,packageDigest:digest}));
}finally{if(token)await api('auth:signOut',{}).catch(()=>{});}
