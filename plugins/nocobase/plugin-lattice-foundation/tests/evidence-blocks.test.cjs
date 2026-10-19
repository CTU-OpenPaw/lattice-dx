// SPDX-License-Identifier: Apache-2.0
const {test}=require('node:test');const assert=require('node:assert/strict');
const {fileMetadata,evidenceContext,timelineItems,eventReason,fileBytes}=require('../src/client/evidence');
const {createEvidenceComponents}=require('../src/client/evidence-blocks');const {validateManifest}=require('../src/shared/manifest');
const manifest=require('../src/shared/manifests/work.json');
const id='11111111-1111-4111-8111-111111111111',recordId='22222222-2222-4222-8222-222222222222',fileId='33333333-3333-4333-8333-333333333333';
const run={id,recordId,definitionId:'support-case',state:'review',title:'Case',version:2,availableTransitions:[],data:{attachmentId:fileId}};
const clean={id:fileId,filename:'proof.txt',size:4,scanStatus:'clean',contentBase64:'dGVzdA=='};
const event={id,actorId:'actor',action:'review',fromState:'draft',toState:'review',version:2,occurredAt:'2026-10-15T10:00:00.000Z'};
test('evidence contexts use declared file fields and preserve record/workflow separation',async()=>{
  const block=manifest.blocks.find(b=>b.type==='attachment');const calls=[];const api={workflow:async(operation,payload)=>{calls.push({operation,payload});return run;}};
  const context=await evidenceContext({api,manifest,block,selectedId:id});assert.equal(context.recordId,recordId);assert.deepEqual(context.fileIds,[fileId]);assert.equal(context.resource,'workflows');
  await assert.rejects(evidenceContext({api,manifest,block:{...block,definitionId:'other'},selectedId:id}));
  const count=calls.length;await assert.rejects(evidenceContext({api,manifest,block,selectedId:'../files'}));assert.equal(calls.length,count);
  const recordManifest={collections:[{id:'records',resource:'records'}]};assert.equal((await evidenceContext({api,manifest:recordManifest,block:{collection:'records'},selectedId:recordId})).resource,'records');
});
test('quarantined and mismatched file bytes never pass preview/download validation',()=>{
  assert.deepEqual([...fileBytes(clean)],[116,101,115,116]);
  for(const scanStatus of ['pending','error','rejected'])assert.throws(()=>fileBytes({...clean,scanStatus}));
  assert.throws(()=>fileBytes({...clean,size:5}));assert.throws(()=>fileMetadata(clean,id));assert.throws(()=>fileMetadata({...clean,size:1048577}));
});
test('Timeline validates immutable event fields and never invents a reason from current data',()=>{
  const rows=[{...event,version:1},{...event,id:fileId,version:2,metadata:{reason:'Actual API reason'}}];const result=timelineItems({items:rows});assert.equal(result[0].id,fileId);assert.equal(rows[0].version,1);
  assert.equal(eventReason(event),null);assert.equal(eventReason(result[0]),'Actual API reason');assert.equal(eventReason({...event,metadata:{input:{reason:'Not an event reason'}}}),null);
  assert.throws(()=>timelineItems({items:[{...event,occurredAt:'not a date'}]}));assert.throws(()=>timelineItems({items:[event,event]}));assert.throws(()=>timelineItems({items:Array(101).fill(event)}));
});
test('manifest evidence references cannot cross approval scope or name executable fields',()=>{
  assert.deepEqual(validateManifest(manifest),[]);const bad=structuredClone(manifest);bad.blocks.find(b=>b.type==='attachment').definitionId='other';assert.ok(validateManifest(bad).some(e=>e.includes('scope')));
  const fields=structuredClone(manifest);fields.blocks.find(b=>b.type==='attachment').fileFields=['__proto__'];assert.ok(validateManifest(fields).length);
  const upload=structuredClone(manifest);upload.blocks.find(b=>b.type==='attachment').allowUpload='yes';assert.ok(validateManifest(upload).length);
});
function hooks(){const slots=[];let index=0,queue=[];const same=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]));const react={createElement:(type,props,...children)=>({type,props:props||{},children:children.flat()}),useState(value){const i=index++;if(!slots[i])slots[i]={value};return [slots[i].value,next=>slots[i].value=typeof next==='function'?next(slots[i].value):next]},useRef(value){const i=index++;if(!slots[i])slots[i]={current:value};return slots[i]},useEffect(fn,deps){const i=index++;if(!slots[i]||!same(slots[i].deps,deps))queue.push(()=>{slots[i]?.cleanup?.();slots[i]={deps,cleanup:fn()}})}};return {react,render(fn){index=0;const tree=fn();const effects=queue;queue=[];effects.forEach(f=>f());return tree;}};}
function find(tree,predicate){if(!tree||typeof tree!=='object')return null;if(predicate(tree))return tree;for(const child of tree.children||[]){const result=find(child,predicate);if(result)return result;}return null;}
const tick=()=>new Promise(setImmediate);
function mockReader(t,Reader){const original=Object.getOwnPropertyDescriptor(globalThis,'FileReader');Object.defineProperty(globalThis,'FileReader',{configurable:true,writable:true,value:Reader});t.after(()=>{if(original)Object.defineProperty(globalThis,'FileReader',original);else delete globalThis.FileReader;});}
test('Attachment clears private metadata when a later download is denied',async()=>{
  const env=hooks(),{AttachmentBlock}=createEvidenceComponents(env.react);const api={file:async(operation)=>{if(operation==='metadata')return clean;throw {message:'Access revoked',response:{status:404}};}};
  const props={manifest,block:manifest.blocks.find(b=>b.type==='attachment'),api,connected:true,selectedId:id,run};env.render(()=>AttachmentBlock(props));await tick();let tree=env.render(()=>AttachmentBlock(props));assert.ok(find(tree,n=>n.type==='strong'&&n.children.includes('proof.txt')));
  await find(tree,n=>n.type==='button'&&n.children.includes('Tải xuống')).props.onClick();await tick();tree=env.render(()=>AttachmentBlock(props));assert.equal(find(tree,n=>n.type==='strong'&&n.children.includes('proof.txt')),null);
});

test('Attachment clears cached metadata and selection when a later metadata lookup is denied',async()=>{
  let revoked=false;const env=hooks(),{AttachmentBlock}=createEvidenceComponents(env.react);
  const api={file:async()=>{if(revoked)throw {message:'Access revoked',response:{status:404}};return clean;}};
  const props={manifest,block:manifest.blocks.find(b=>b.type==='attachment'),api,connected:true,selectedId:id,run,onUploaded:()=>{}};
  env.render(()=>AttachmentBlock(props));await tick();let tree=env.render(()=>AttachmentBlock(props));
  assert.ok(find(tree,n=>n.type==='strong'&&n.children.includes('proof.txt')));
  assert.ok(find(tree,n=>n.type==='button'&&n.children.includes('Chọn tệp này')));
  find(tree,n=>n.type==='input'&&n.props['aria-label']==='ID tệp đính kèm').props.onChange({target:{value:fileId}});
  revoked=true;tree=env.render(()=>AttachmentBlock(props));
  await find(tree,n=>n.type==='button'&&n.children.includes('Kiểm tra tệp đính kèm')).props.onClick();
  tree=env.render(()=>AttachmentBlock(props));
  assert.equal(find(tree,n=>n.type==='strong'&&n.children.includes('proof.txt')),null);
  assert.equal(find(tree,n=>n.type==='button'&&n.children.includes('Chọn tệp này')),null);
  assert.ok(find(tree,n=>n.props.role==='alert'&&n.children.includes('Access revoked')));
});
test('disconnect during local file read prevents upload to a stale workflow',async t=>{
  let reader;class Reader{constructor(){reader=this}readAsDataURL(){}abort(){this.onabort?.();}}
  mockReader(t,Reader);const uploads=[];const api={file:async(operation,payload)=>{uploads.push({operation,payload});return clean;}};
  const env=hooks(),{AttachmentBlock}=createEvidenceComponents(env.react);const props={manifest,block:manifest.blocks.find(b=>b.type==='attachment'),api,connected:true,selectedId:id,run:{...run,data:{}}};
  env.render(()=>AttachmentBlock(props));await tick();let tree=env.render(()=>AttachmentBlock(props));find(tree,n=>n.type==='input'&&n.props.type==='file').props.onChange({target:{files:[{name:'proof.txt',size:4}]}});tree=env.render(()=>AttachmentBlock(props));
  const pending=find(tree,n=>n.type==='button'&&n.children.includes('Tải tệp đính kèm lên')).props.onClick();await tick();env.render(()=>AttachmentBlock({...props,connected:false}));await pending;assert.deepEqual(uploads,[]);assert.ok(reader);
});
test('workflow uploads stay unbound until an explicit workflow action links the clean ID',async t=>{
  class Reader{readAsDataURL(){this.result='data:text/plain;base64,dGVzdA==';this.onload();}abort(){}}
  mockReader(t,Reader);const uploads=[];const api={file:async(operation,payload)=>{uploads.push({operation,payload});return clean;}};let chosen;
  const env=hooks(),{AttachmentBlock}=createEvidenceComponents(env.react);const props={manifest,block:manifest.blocks.find(b=>b.type==='attachment'),api,connected:true,selectedId:id,run:{...run,data:{}},onUploaded:meta=>chosen=meta.id};
  env.render(()=>AttachmentBlock(props));await tick();let tree=env.render(()=>AttachmentBlock(props));find(tree,n=>n.type==='input'&&n.props.type==='file').props.onChange({target:{files:[{name:'proof.txt',size:4}]}});tree=env.render(()=>AttachmentBlock(props));await find(tree,n=>n.type==='button'&&n.children.includes('Tải tệp đính kèm lên')).props.onClick();assert.equal(uploads[0].payload.recordId,undefined);assert.equal(chosen,fileId);
});
test('Timeline discards delayed events on disconnect',async()=>{
  let finish;const api={workflow:async()=>new Promise(resolve=>finish=resolve)};const env=hooks(),{ActivityTimelineBlock}=createEvidenceComponents(env.react);const props={manifest,block:manifest.blocks.find(b=>b.type==='activity-timeline'),api,connected:true,selectedId:id,run};
  env.render(()=>ActivityTimelineBlock(props));await tick();env.render(()=>ActivityTimelineBlock({...props,connected:false}));finish({items:[event]});await tick();const tree=env.render(()=>ActivityTimelineBlock({...props,connected:false}));assert.equal(find(tree,n=>n.type==='time'),null);
});
test('loaded evidence disappears on the first render of a different session or selection',async()=>{
  const api={file:async()=>clean,workflow:async()=>({items:[event]})};
  const env=hooks(),{AttachmentBlock}=createEvidenceComponents(env.react);const props={manifest,block:manifest.blocks.find(b=>b.type==='attachment'),api,connected:true,selectedId:id,run,actorId:'actor'};
  env.render(()=>AttachmentBlock(props));await tick();assert.ok(find(env.render(()=>AttachmentBlock(props)),n=>n.type==='strong'&&n.children.includes('proof.txt')));
  const first=env.render(()=>AttachmentBlock({...props,actorId:'another-actor'}));assert.equal(find(first,n=>n.type==='strong'&&n.children.includes('proof.txt')),null);
  const historyEnv=hooks(),{ActivityTimelineBlock}=createEvidenceComponents(historyEnv.react);const historyProps={...props,block:manifest.blocks.find(b=>b.type==='activity-timeline')};
  historyEnv.render(()=>ActivityTimelineBlock(historyProps));await tick();assert.ok(find(historyEnv.render(()=>ActivityTimelineBlock(historyProps)),n=>n.type==='time'));
  assert.equal(find(historyEnv.render(()=>ActivityTimelineBlock({...historyProps,connected:false})),n=>n.type==='time'),null);
});
