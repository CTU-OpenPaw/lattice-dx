/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const {test}=require('node:test');const assert=require('node:assert/strict');
const {createApplicationRuntime}=require('../src/client/application-runtime');
const {createContractRegistry}=require('../src/shared/contracts');
const {validateManifest}=require('../src/shared/manifest');
const {createFormActions}=require('../src/client/actions');
const {createApplicationCatalog}=require('../src/shared/application-catalog');
const {loadFormContext}=require('../src/client/reference-data');
function hooks(){const slots=[];let index=0;return {react:{createElement:(type,props,...children)=>({type,props:props||{},children:children.flat().filter(value=>value!==undefined&&value!==null&&value!==false)}),useState(value){const i=index++;if(!slots[i])slots[i]={value};return [slots[i].value,next=>slots[i].value=typeof next==='function'?next(slots[i].value):next]},useEffect(){},},render(fn){index=0;return fn();}};}
function sample(){return {schemaVersion:1,id:'customer-support',name:'Hỗ trợ khách hàng',route:'/lattice/apps/customer-support',permissions:['support:read'],collections:[{id:'tickets',source:'lattice-api',resource:'tickets'}],blocks:[{id:'new-ticket',type:'form',title:'Tạo ticket',collection:'tickets',permissions:['support:write'],fields:[{name:'title',title:'Nội dung',type:'string',required:true,maxLength:200}],submit:{actionId:'tickets.create',version:1}},{id:'ticket-list',type:'list',title:'Tickets',collection:'tickets',permissions:['support:read'],columns:['title']}],transitions:[],workspace:{panels:[{id:'detail',renderer:'support.ticket-detail'}],blocks:[{blockId:'new-ticket',selectFrom:'id'},{blockId:'ticket-list',selectFrom:'id'}]}};}
test('a third application renders registered extensions and shared blocks without changing Workspace',()=>{
 const env=hooks(),Form=()=>{},List=()=>{},Detail=()=>{};const runtime=createApplicationRuntime(env.react,{FormBlock:Form,ListBlock:List});runtime.registerView('support.ticket-detail',Detail);
 const props={manifest:sample(),api:{},connection:{connected:true,identity:{subject:'support-actor'}}};let tree=env.render(()=>runtime.Application(props));
 assert.deepEqual(tree.children.map(n=>n.type),[Detail,Form,List]);tree.children[2].props.onOpen({id:'ticket-42'});tree=env.render(()=>runtime.Application(props));assert.equal(tree.children[0].props.selectedId,'ticket-42');
 tree.children[0].props.onLocked(true);tree=env.render(()=>runtime.Application(props));assert.equal(tree.children[2].props.openDisabled,true);tree.children[2].props.onOpen({id:'other'});tree=env.render(()=>runtime.Application(props));assert.equal(tree.children[0].props.selectedId,'ticket-42');
});
test('uninstalled or duplicate renderer fails closed; manifests cannot specify executable URLs',()=>{
 const env=hooks(),runtime=createApplicationRuntime(env.react,{FormBlock:()=>{},ListBlock:()=>{}});const props={manifest:sample(),connection:{}};assert.equal(env.render(()=>runtime.Application(props)).props.role,'alert');
 runtime.registerView('support.ticket-detail',()=>{});assert.throws(()=>runtime.registerView('support.ticket-detail',()=>{}));
 const manifest=sample();manifest.workspace.panels[0].url='https://other/script.js';assert.ok(validateManifest(manifest).some(e=>e.includes('unknown property')));
});
test('a new action contract validates and saves a third-domain form through the generic controller',async()=>{
 const registry=createContractRegistry();registry.registerResource('tickets',{url:'dxActions:list',method:'get',resource:'tickets'});registry.registerAction('tickets.create',{version:1,resource:'tickets',role:'support:write',lengthMode:'utf16',fields:{title:{required:true,maxLength:200}},transport:{kind:'catalog'}});
 const manifest=sample();assert.deepEqual(validateManifest(manifest,registry),[]);const calls=[];const controller=createFormActions({manifest,blockId:'new-ticket',contracts:registry,apiClient:{request:async options=>{calls.push(options);return options.url==='dxActions:catalog'?{data:{items:[{id:'tickets.create',version:1}]}}:{data:{status:'succeeded',actionId:'tickets.create',version:1,result:{id:'ticket-42'}}};}}});
 assert.equal((await controller.submit({title:'Help'})).id,'ticket-42');assert.equal(calls[1].data.actionId,'tickets.create');await assert.rejects(controller.submit({title:'Help',organizationId:'other'}),{code:'VALIDATION'});
});
test('application catalog accepts an extension and owns validated snapshots without an app-ID branch',()=>{
 const registry=createContractRegistry();registry.registerResource('tickets',{});registry.registerAction('tickets.create',{version:1,resource:'tickets',role:'support:write',fields:{title:{required:true,maxLength:200}}});
 const catalog=createApplicationCatalog(registry),manifest=sample();catalog.register(manifest);manifest.workspace.panels[0].renderer='changed.after.registration';
 assert.equal(catalog.get('customer-support').workspace.panels[0].renderer,'support.ticket-detail');const copy=catalog.list();copy[0].route='/other';assert.equal(catalog.get('customer-support').route,'/lattice/apps/customer-support');assert.throws(()=>catalog.register(sample()),/duplicate application/);
});
test('optional suggestion failure does not block an allowed action; required selection failure blocks it',async()=>{
 const registry=createContractRegistry();registry.registerReference('contacts',{mode:'suggestion',resource:'contacts'});
 const api={list:async()=>{throw new Error('Reference unavailable')},catalog:async()=>[{id:'tickets.create',version:1}]};
 const block={submit:{actionId:'tickets.create',version:1},fields:[{name:'contact',reference:'contacts',required:false}]},contract={transport:{kind:'catalog'}};
 assert.equal((await loadFormContext(api,block,contract,registry)).available,true);
 assert.equal((await loadFormContext(api,block,{...contract,availabilityReference:'contacts'},registry)).available,false);
});

test('command form checks backend capability before loading protected references',async()=>{
 const registry=createContractRegistry();registry.registerReference('contacts',{mode:'select',resource:'contacts'});
 const block={submit:{actionId:'tickets.create',version:1},fields:[{name:'contact',reference:'contacts',required:true}]};
 const contract={transport:{kind:'command'},availabilityCapability:'tickets.create'};let reads=0,allowed=false;
 const api={workflow:async operation=>{assert.equal(operation,'capabilities');return {version:1,capabilities:{'tickets.create':{authorized:allowed,configured:true,available:allowed}}};},list:async()=>{reads++;return [];}};
 const denied=await loadFormContext(api,block,contract,registry);assert.equal(denied.available,false);assert.equal(denied.error,'');assert.equal(reads,0);
 allowed=true;assert.equal((await loadFormContext(api,block,contract,registry)).available,true);assert.equal(reads,1);
 api.workflow=async()=>({version:1,capabilities:{}});
 await assert.rejects(loadFormContext(api,block,contract,registry));assert.equal(reads,1);
});
test('unavailable catalog action does not request form reference data',async()=>{
 let reads=0;const registry=createContractRegistry();registry.registerReference('contacts',{mode:'select',resource:'contacts'});
 const api={catalog:async()=>[],list:async()=>{reads++;throw Error('Should not read');}};
 const result=await loadFormContext(api,{submit:{actionId:'tickets.create',version:1},fields:[{reference:'contacts'}]},{transport:{kind:'catalog'}},registry);
 assert.equal(result.available,false);assert.equal(result.error,'');assert.equal(reads,0);
});
