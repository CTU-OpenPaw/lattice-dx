// SPDX-License-Identifier: Apache-2.0
// Persistent, isolated localhost fixtures for browser acceptance; never resets
// an existing user's password, roles or mapping. No production credentials.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {configureNativeProcess} from './configure-native-process.mjs';
import {instantiateNativePage} from './lib/native-ui-fixture.mjs';
const host = new URL(process.env.NOCOBASE_URL ?? 'http://localhost:13000');
assert.ok(['localhost', '127.0.0.1'].includes(host.hostname) && host.protocol === 'http:', 'Local lab only');
const dbContainer = process.env.NOCOBASE_DB_CONTAINER ?? 'lattice-dx-nocobase-db-1';
if (host.port !== '13000') {
  assert.ok(process.env.NOCOBASE_DB_CONTAINER && dbContainer !== 'lattice-dx-nocobase-db-1', 'Set the isolated lab DB container explicitly');
}
const base = new URL('/api/', host).href;
const org = 'native-ui-lab';
const manifestPath='output/native-platform/ui-lab.json';
async function api(path,{token,method='GET',values}={}){
  const r=await fetch(base+path,{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},...(values?{body:JSON.stringify(values)}:{}),signal:AbortSignal.timeout(15000)});
  const body=await r.json();assert.ok(r.ok,`${path.split('?')[0]} HTTP ${r.status}: ${JSON.stringify(body.errors)}`);return body.data;
}
const token=(await api('auth:signIn',{method:'POST',values:{email:'admin@nocobase.com',password:'admin123'}})).token;
const root=(path,options)=>api(path,{...options,token});
let manifest;try{manifest=JSON.parse(await readFile(manifestPath,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
if(manifest){assert.equal(manifest.organizationId,org);assert.equal(manifest.origin??'http://localhost:13000',host.origin,'Lab manifest belongs to a different runtime');assert.ok(manifest.path&&manifest.workflow&&manifest.accounts.length===3,'Incomplete lab manifest; inspect recorded IDs before resuming');console.log(JSON.stringify({result:'EXISTS',path:manifest.path,accounts:manifest.accounts.map(a=>a.username)}));}
else{
  const dump=spawnSync('docker',['exec',dbContainer,'pg_dump','--format=custom','-U','nocobase','-d','nocobase'],{encoding:null,maxBuffer:256*1024*1024,windowsHide:true});
  assert.equal(dump.status,0,'DB backup required');assert.equal(dump.stdout.subarray(0,5).toString(),'PGDMP');
  await mkdir('output/backups',{recursive:true});await mkdir('output/native-platform',{recursive:true});
  const backupPath=`output/backups/native-ui-${randomUUID()}.dump`;await writeFile(backupPath,dump.stdout,{flag:'wx'});
  manifest={organizationId:org,origin:host.origin,accounts:[],backupPath};
  // Save partial manifest after every mutation so failures remain inspectable.
  const save=()=>writeFile(manifestPath,JSON.stringify(manifest,null,2));await save();
  const department=await root('latticeDepartments:create',{method:'POST',values:{code:'NATIVE-UI-LAB',name:'Native UI Lab',organizationId:org}});manifest.departmentId=department.id;await save();
  for(const [suffix,role,label] of [['employee','ldx_employee','Nhân viên thử native'],['manager','ldx_manager','Quản lý thử native'],['worker','ldx_warehouse','Người thực hiện thử native']]){
    const username='native.lab.'+suffix,email=username+'@example.invalid';
    const existing=await root('users:list?filter='+encodeURIComponent(JSON.stringify({username})));assert.equal(existing.length,0,'Fixture user exists outside manifest; do not overwrite');
    const user=await root('users:create',{method:'POST',values:{username,email,nickname:label,password:'NativeLab-2026!',roles:[role]}});
    manifest.accounts.push({username,email,role,userId:user.id});await save();
    const employee=await root('latticeEmployees:create',{method:'POST',values:{code:'NATIVE-UI-'+suffix.toUpperCase(),name:label,organizationId:org,departmentId:department.id,userId:user.id,active:true}});
    manifest.accounts.at(-1).employeeId=employee.id;await save();
  }
  const process=await configureNativeProcess(root,{collection:'latticeRequests',organizationId:org,reviewerEmployeeId:manifest.accounts[1].employeeId,assigneeEmployeeId:manifest.accounts[2].employeeId});
  manifest.workflow=process;await save();
  const uid='nativeuilab'+randomUUID().replaceAll('-','').slice(0,10);
  const fixture=JSON.parse(await readFile(new URL('./fixtures/native-ui-page.json',import.meta.url),'utf8'));
  const {schema,tabUid}=instantiateNativePage(fixture,uid);
  await root('uiSchemas:insert',{method:'POST',values:schema});
  const route=await root('desktopRoutes:create',{method:'POST',values:{title:'Native UI Lab',type:'page',schemaUid:uid,enableTabs:false,hideInMenu:false}});
  manifest.routeId=route.id;manifest.schemaUid=uid;manifest.path='/admin/'+uid;await save();
  const tabRoute=await root('desktopRoutes:create',{method:'POST',values:{parentId:route.id,type:'tabs',schemaUid:tabUid,tabSchemaName:tabUid+'name',hidden:true}});
  manifest.tabUid=tabUid;manifest.tabRouteId=tabRoute.id;await save();
  await root('workflows:update?filterByTk='+process.workflowId,{method:'POST',values:{enabled:true}});
  console.log(JSON.stringify({result:'CREATED',path:manifest.path,accounts:manifest.accounts.map(a=>a.username),workflowId:process.workflowId,backupPath}));
}
// Grant only this isolated native page; resource/field permissions stay in the
// existing native presets. Association add preserves every other menu grant.
for(const role of ['ldx_employee','ldx_manager','ldx_warehouse'])await root(`roles/${role}/desktopRoutes:add`,{method:'POST',values:{tk:[manifest.routeId,manifest.tabRouteId]}});
