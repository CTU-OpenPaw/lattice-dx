// SPDX-License-Identifier: Apache-2.0
const {test}=require('node:test');const assert=require('node:assert/strict');
const {createApprovalController}=require('../src/client/approval');const {createFieldRenderer,workflowFieldErrors}=require('../src/client/schema-fields');
const {createInboxComponents}=require('../src/client/inbox-blocks');const {validateManifest}=require('../src/shared/manifest');const manifest=require('../src/shared/manifests/work.json');
const id='11111111-1111-4111-8111-111111111111';
const action={id:'review',from:'pending',to:'done',fields:{note:'text'}};
const run={id,title:'Private review',definitionId:'support',state:'pending',version:1,data:{},availableTransitions:[action,{...action,id:'cancel',to:'cancelled'}]};
const block={id:'form',type:'workflow-form',title:'Review',actionId:'review'};
function hooks(){const slots=[];let index=0,queue=[];const same=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]));const react={createElement:(type,props,...children)=>({type,props:props||{},children:children.flat()}),useState(value){const i=index++;if(!slots[i])slots[i]={value};return [slots[i].value,next=>slots[i].value=typeof next==='function'?next(slots[i].value):next]},useRef(value){const i=index++;if(!slots[i])slots[i]={current:value};return slots[i]},useMemo(fn,deps){const i=index++;if(!slots[i]||!same(slots[i].deps,deps))slots[i]={value:fn(),deps};return slots[i].value},useEffect(fn,deps){const i=index++;if(!slots[i]||!same(slots[i].deps,deps))queue.push(()=>{slots[i]?.cleanup?.();slots[i]={deps,cleanup:fn()}})}};return {react,render(fn){index=0;const tree=fn();const effects=queue;queue=[];effects.forEach(f=>f());return tree;}};}
function find(tree,predicate){if(!tree||typeof tree!=='object')return null;if(predicate(tree))return tree;for(const child of tree.children||[]){const result=find(child,predicate);if(result)return result;}return null;}

const tick=()=>new Promise(setImmediate);
test('single-action Form restricts controller and UI without inventing permission',async()=>{
 let calls=0;const controller=createApprovalController({actorId:'actor',actionId:'review',api:{workflow:async()=>{calls++;return {...run,version:2,state:'done',availableTransitions:[]}}}});controller.load(run);await assert.rejects(controller.execute('cancel',{note:'wrong'}));assert.equal(calls,0);
 await controller.execute('review',{note:'ok'});assert.equal(calls,1);
 const env=hooks(),{ApprovalBlock}=createInboxComponents(env.react),props={block,connected:true,selectedId:id,actorId:'actor',api:{workflow:async()=>run}};
 env.render(()=>ApprovalBlock(props));await tick();let tree=env.render(()=>ApprovalBlock(props));assert.ok(find(tree,n=>n.props['data-transition']==='review'));assert.equal(find(tree,n=>n.props['data-transition']==='cancel'),null);
 assert.equal(find(env.render(()=>ApprovalBlock({...props,actorId:'other'})),n=>n.props['data-transition']==='review'),null);
});
test('required field errors focus the field and prevent writes; editing clears its error',async()=>{
 let writes=0,focused;const env=hooks(),{ApprovalBlock}=createInboxComponents(env.react),props={block,connected:true,selectedId:id,actorId:'actor',api:{workflow:async operation=>{if(operation==='detail')return run;writes++;return {...run,version:2,state:'done',availableTransitions:[]}}}};
 env.render(()=>ApprovalBlock(props));await tick();let tree=env.render(()=>ApprovalBlock(props));await find(tree,n=>n.type==='form').props.onSubmit({preventDefault(){},currentTarget:{elements:{namedItem:name=>({focus:()=>focused=name})}}});tree=env.render(()=>ApprovalBlock(props));assert.equal(writes,0);assert.equal(focused,'note');assert.ok(find(tree,n=>n.props['aria-invalid']===true));
 find(tree,n=>n.type==='textarea').props.onChange({target:{value:'Done'}});tree=env.render(()=>ApprovalBlock(props));assert.equal(find(tree,n=>n.props['aria-invalid']===true),null);await find(tree,n=>n.type==='form').props.onSubmit({preventDefault(){}});assert.equal(writes,1);
});
test('reference failure leaves required selection blocked and visible',async()=>{
 const value={...run,availableTransitions:[{...action,fields:{locationId:'location'}}]};const env=hooks(),{ApprovalBlock}=createInboxComponents(env.react),props={block,connected:true,selectedId:id,actorId:'actor',api:{workflow:async operation=>{if(operation==='detail')return value;throw Error('down')}}};
 env.render(()=>ApprovalBlock(props));await tick();env.render(()=>ApprovalBlock(props));await tick();const tree=env.render(()=>ApprovalBlock(props));assert.ok(find(tree,n=>n.props.role==='alert'));assert.equal(find(tree,n=>n.type==='button'&&n.props.type==='submit').props.disabled,true);
});
test('shared fields preserve controlled values, accessible errors and Unicode codepoint validation',()=>{
 assert.deepEqual(workflowFieldErrors({fields:{proof:'file',quantity:'positiveInteger',note:'text'}},{proof:'bad',quantity:'1.5',note:'😀'.repeat(2000)}),{proof:'Chọn tệp đã quét sạch hoặc nhập ID tệp hợp lệ.',quantity:'Nhập số nguyên dương không quá 1000000.'});
 const env=hooks(),render=createFieldRenderer(env.react);const tree=render({name:'note',title:'Note',kind:'text',id:'note',required:true,value:'😀',error:'Missing',onChange(){}});const input=find(tree,n=>n.type==='textarea');assert.equal(input.props.value,'😀');assert.equal(input.props['aria-describedby'],'note-error');assert.equal(input.props.maxLength,undefined);
});
test('workflow presets are valid and reject arbitrary actions, endpoint injection or crossed evidence scope',()=>{
 assert.deepEqual(validateManifest(manifest),[]);assert.equal(manifest.blocks.filter(b=>b.type==='workflow-form').length,3);
 for(const change of [{actionId:'__proto__'},{actionId:undefined},{url:'http://other'},{attachmentBlockId:'request-files'}]){const m=structuredClone(manifest);Object.assign(m.blocks.find(b=>b.type==='workflow-form'),change);assert.ok(validateManifest(m).length);}
});

test('rebinding the same action on another configured block reloads its context',async()=>{
 const env=hooks(),{ApprovalBlock}=createInboxComponents(env.react),api={workflow:async()=>run};
 const props={block,connected:true,selectedId:id,actorId:'actor',api};env.render(()=>ApprovalBlock(props));await tick();env.render(()=>ApprovalBlock(props));
 const next={...props,block:{...block,id:'another-form'}};assert.equal(find(env.render(()=>ApprovalBlock(next)),n=>n.type==='form'),null);await tick();assert.ok(find(env.render(()=>ApprovalBlock(next)),n=>n.type==='form'));
});
