/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const {test}=require('node:test');const assert=require('node:assert/strict');
const {createBlockComponents}=require('../src/client/blocks');
const {createFormActions}=require('../src/client/actions');
const manifest=require('../src/shared/manifests/purchasing.json');
function hooks(){
  const slots=[];let index=0,queue=[];
  const same=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]));
  const react={createElement:(type,props,...children)=>({type,props:props||{},children:children.flat()}),
    useState(initial){const i=index++;if(!slots[i])slots[i]={value:initial};return [slots[i].value,v=>{slots[i].value=typeof v==='function'?v(slots[i].value):v}];},
    useRef(value){const i=index++;if(!slots[i])slots[i]={current:value};return slots[i];},
    useMemo(fn,deps){const i=index++;if(!slots[i]||!same(slots[i].deps,deps))slots[i]={value:fn(),deps};return slots[i].value;},
    useEffect(fn,deps){const i=index++;if(!slots[i]||!same(slots[i].deps,deps)){queue.push(()=>{slots[i]?.cleanup?.();slots[i]={deps,cleanup:fn()}})}}};
  return {react,slots,render(fn){index=0;const result=fn();const effects=queue;queue=[];effects.forEach(run=>run());return result;}};
}
function find(node,predicate){if(!node||typeof node!=='object')return null;if(predicate(node))return node;for(const child of node.children||[]){const result=find(child,predicate);if(result)return result;}return null;}
test('form ignores delayed write results and callbacks after disconnect',async()=>{
  let resolve;const delayed=new Promise(r=>{resolve=r});let saved=0;
  const api={catalog:async()=>[],request:async options=>options.url==='dxActions:catalog'?{data:{items:[{id:'records.create',version:1}]}}:delayed};
  const env=hooks();const {FormBlock}=createBlockComponents({},env.react,{});
  const props={manifest,block:manifest.blocks[0],api,connected:true,onSaved:()=>saved++};
  let tree=env.render(()=>FormBlock(props));find(tree,n=>n.type==='input'&&n.props.name==='title').props.onChange({target:{value:'Demo'}});
  tree=env.render(()=>FormBlock(props));const submission=find(tree,n=>n.type==='form').props.onSubmit({preventDefault(){}});
  await new Promise(setImmediate);env.render(()=>FormBlock({...props,connected:false}));
  resolve({data:{status:'succeeded',actionId:'records.create',version:1,result:{id:'late-record'}}});await submission;
  assert.equal(env.slots[2].value,null);assert.equal(env.slots[3].value,false);assert.equal(saved,0);
});
test('text length uses the API Unicode code-point limit, including emoji',async()=>{
  let requests=0;const controller=createFormActions({manifest,blockId:'create-request',apiClient:{request:async options=>{requests++;return options.url==='dxActions:catalog'?{data:{items:[{id:'records.create',version:1}]}}:{data:{actionId:'records.create',version:1,status:'succeeded',result:{id:'record-1'}}}}}});
  await assert.rejects(controller.submit({title:'😀'.repeat(201)}),{code:'VALIDATION'});assert.equal(requests,0);
  assert.equal((await controller.submit({title:'😀'.repeat(200)})).id,'record-1');assert.equal(requests,2);
});
test('native configured block clears its connection at declared expiry',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout','setInterval'],now:Date.now()});
  const status={connected:true,expiresAt:new Date(Date.now()+1000).toISOString()};
  const host={request:async options=>options.url==='latticeApps:list'?{data:{data:{items:[manifest]}}}:{data:status}};
  const env=hooks();const {ConfiguredBlock}=createBlockComponents({useAPIClient:()=>host},env.react,{});
  const props={manifestId:'purchasing',blockId:'create-request',expectedType:'form'};
  env.render(()=>ConfiguredBlock(props));await new Promise(setImmediate);env.render(()=>ConfiguredBlock(props));
  assert.equal(env.slots[1].value.connected,true);t.mock.timers.tick(1001);assert.equal(env.slots[1].value.connected,false);
});
