/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const {test}=require('node:test');const assert=require('node:assert/strict');
const {createApprovalController,transitionInput}=require('../src/client/approval');
const {validateManifest}=require('../src/shared/manifest');
const {createInboxComponents}=require('../src/client/inbox-blocks');
const manifest=require('../src/shared/manifests/work.json');
const id='11111111-1111-4111-8111-111111111111';
function run(definitionId='support-case'){return {id,title:'Support review',definitionId,state:'submitted',version:2,data:{},availableTransitions:[{id:'resolve',from:'submitted',to:'resolved',fields:{note:'text'}}]};}
test('same Approval controller handles unrelated configured workflows and never invents actions',async()=>{
  for(const definitionId of ['support-case','employee-intake']){
    const calls=[];const controller=createApprovalController({actorId:'actor',api:{workflow:async(operation,payload)=>{calls.push({operation,payload});return {...run(definitionId),state:'resolved',version:3,availableTransitions:[]};}}});
    controller.load(run(definitionId));await assert.rejects(controller.execute('approve',{}));assert.equal(calls.length,0);
    await assert.rejects(controller.execute('resolve',{note:''}));assert.equal(calls.length,0);
    await controller.execute('resolve',{note:'  Done  '});assert.equal(calls[0].payload.body.expectedVersion,2);assert.deepEqual(calls[0].payload.body.input,{note:'Done'});
  }
});
test('Approval locks uncertain commands, preserves payload and key, and clears stale-version rejection',async()=>{
  const calls=[];let failure=true;const controller=createApprovalController({actorId:'actor',newKey:()=> 'fixed',api:{workflow:async(operation,payload)=>{calls.push(structuredClone(payload));if(failure)throw {status:502};return {...run(),state:'resolved',version:3,availableTransitions:[]};}}});
  controller.load(run());await assert.rejects(controller.execute('resolve',{note:'Original'}));assert.equal(controller.uncertain,true);
  assert.throws(()=>controller.load(run()),/Hoàn tất/);await assert.rejects(controller.execute('resolve',{note:'Changed'}));failure=false;await controller.retry();assert.deepEqual(calls[0],calls[1]);
  controller.load(run());failure=true;const denied=createApprovalController({actorId:'actor',api:{workflow:async()=>{throw {status:409}}}});denied.load(run());await assert.rejects(denied.execute('resolve',{note:'Done'}));assert.equal(denied.uncertain,false);
});
test('Approval fails closed on unexpected response, cross-definition selection and waiting runs',async()=>{
  const controller=createApprovalController({actorId:'actor',definitionId:'support-case',api:{workflow:async()=>({...run(),id:'22222222-2222-4222-8222-222222222222'})}});
  assert.throws(()=>controller.load(run('another-domain')));
  controller.load({...run(),waiting:true});await assert.rejects(controller.execute('resolve',{note:'Done'}));
  controller.load(run());await assert.rejects(controller.execute('resolve',{note:'Done'}));assert.equal(controller.uncertain,true);
});
test('step inputs follow API field types, reason requirements and string quantity contract',()=>{
  const action={fields:{reason:'text',quantity:'positiveInteger',proof:'file'}};
  assert.throws(()=>transitionInput(action,{reason:'',quantity:'2',proof:id}));
  assert.throws(()=>transitionInput(action,{reason:'why',quantity:'1.5',proof:id}));
  assert.throws(()=>transitionInput(action,{reason:'why',quantity:'2',proof:id,organizationId:'other'}));
  assert.deepEqual(transitionInput(action,{reason:' why ',quantity:'2',proof:id}),{reason:'why',quantity:'2',proof:id});
});
test('manifest validates workflow block scope and rejects executable/foreign configuration',()=>{
  assert.deepEqual(validateManifest(manifest),[]);
  const invalid=structuredClone(manifest);invalid.blocks[0].definitionId='support-case';assert.ok(validateManifest(invalid).some(e=>e.includes('scope')));
  const foreign=structuredClone(manifest);foreign.collections[0].resource='records';assert.ok(validateManifest(foreign).some(e=>e.includes('workflows')));
  const unsafe=structuredClone(manifest);unsafe.blocks[1].actionLabels={approve:{url:'https://other'}};assert.ok(validateManifest(unsafe).length);
});
test('Workspace shortcuts reference installed forms, never arbitrary URLs',()=>{
  const purchasing=structuredClone(require('../src/shared/manifests/purchasing.json'));assert.deepEqual(validateManifest(purchasing),[]);
  purchasing.workspace.shortcut.url='https://other';assert.ok(validateManifest(purchasing).some(e=>e.includes('unknown property')));delete purchasing.workspace.shortcut.url;
  purchasing.workspace.shortcut.createBlockId='request-list';assert.ok(validateManifest(purchasing).some(e=>e.includes('Form block')));
  purchasing.blocks=null;assert.doesNotThrow(()=>validateManifest(purchasing));
});
function hooks(){const slots=[];let index=0,queue=[];const same=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]));const react={createElement:(type,props,...children)=>({type,props:props||{},children:children.flat()}),useState(value){const i=index++;if(!slots[i])slots[i]={value};return [slots[i].value,next=>slots[i].value=typeof next==='function'?next(slots[i].value):next]},useRef(value){const i=index++;if(!slots[i])slots[i]={current:value};return slots[i]},useMemo(fn,deps){const i=index++;if(!slots[i]||!same(slots[i].deps,deps))slots[i]={value:fn(),deps};return slots[i].value},useEffect(fn,deps){const i=index++;if(!slots[i]||!same(slots[i].deps,deps))queue.push(()=>{slots[i]?.cleanup?.();slots[i]={deps,cleanup:fn()}})}};return {react,render(fn){index=0;const tree=fn();const effects=queue;queue=[];effects.forEach(f=>f());return tree;}};}
function find(tree,predicate){if(!tree||typeof tree!=='object')return null;if(predicate(tree))return tree;for(const child of tree.children||[]){const result=find(child,predicate);if(result)return result;}return null;}
test('Inbox forwards server pagination/filter and ignores delayed private rows after disconnect',async()=>{
  let finish;const calls=[];const api={workflow:async(operation,payload)=>{calls.push({operation,payload});if(operation==='definitions')return {items:[]};return new Promise(resolve=>finish=resolve);}};
  const env=hooks(),{TaskInboxBlock}=createInboxComponents(env.react);const props={manifest,block:manifest.blocks[0],api,connected:true,actorId:'actor'};
  env.render(()=>TaskInboxBlock(props));assert.deepEqual(calls[0],{operation:'inbox',payload:{query:{limit:'10',offset:'0',q:''}}});
  env.render(()=>TaskInboxBlock({...props,connected:false}));finish({items:[run()],page:{offset:0,limit:10,hasMore:false,nextOffset:null}});await new Promise(setImmediate);
  const tree=env.render(()=>TaskInboxBlock({...props,connected:false}));assert.equal(find(tree,n=>n.type==='td'&&n.children.includes('Support review')),null);
});
test('Approval does not report a late write as success after disconnect',async()=>{
  let finish,saved=0;const api={workflow:async(operation)=>operation==='detail'?run():new Promise(resolve=>finish=resolve)};
  const env=hooks(),{ApprovalBlock}=createInboxComponents(env.react);const props={block:manifest.blocks[1],api,connected:true,selectedId:id,actorId:'actor',onSaved:()=>saved++};
  env.render(()=>ApprovalBlock(props));await new Promise(setImmediate);let tree=env.render(()=>ApprovalBlock(props));find(tree,n=>n.type==='textarea').props.onChange({target:{value:'Done'}});
  tree=env.render(()=>ApprovalBlock(props));find(tree,n=>n.type==='form').props.onSubmit({preventDefault(){}});await new Promise(setImmediate);
  env.render(()=>ApprovalBlock({...props,connected:false}));finish({...run(),state:'resolved',version:3,availableTransitions:[]});await new Promise(setImmediate);assert.equal(saved,0);
});
