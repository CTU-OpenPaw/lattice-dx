// SPDX-License-Identifier: Apache-2.0
const {test}=require('node:test'),assert=require('node:assert/strict');
const {attributesFromForm,workflowForPage,moveItem,enabledSections}=require('../src/client/console-model');
test('typed forms preserve booleans/decimals and reject empty required or unsafe numeric values',()=>{
 const fields={name:{type:'text',required:true},count:{type:'integer'},active:{type:'boolean'},cost:{type:'decimal'},kind:{type:'enum',choices:['a','b']}};
 assert.deepEqual(attributesFromForm(fields,{name:'A',count:'3',active:false,cost:'12.30',kind:'a'}),{name:'A',count:3,active:false,cost:'12.30',kind:'a'});
 assert.throws(()=>attributesFromForm(fields,{name:''}));assert.throws(()=>attributesFromForm(fields,{name:'A',count:'1.5'}));assert.throws(()=>attributesFromForm(fields,{name:'A',kind:'x'}));
});
test('workflow editor starts from existing semantics and block order is immutable',()=>{
 const page={requesterRole:'employee',reviewerRole:'reviewer',handlerRole:'handler'};
 const flow=workflowForPage(page);assert.equal(flow.transitions.find(t=>t.id==='approve').task,'assign');assert.equal(flow.transitions.find(t=>t.id==='complete').assigneeField,'handlerId');
 flow.transitions[0].to='changed';assert.notEqual(workflowForPage(page).transitions[0].to,'changed');
 const blocks=['create','list','history'];assert.deepEqual(moveItem(blocks,2,-1),['create','history','list']);assert.deepEqual(blocks,['create','list','history']);
 assert.deepEqual(enabledSections({}),['home','work']);assert.ok(enabledSections({'entities.design':{available:true}}).includes('data'));
});
test('uncertain schema creation reconciles exact ID/content before retry and entity writes reuse existing channel',async()=>{
 const {consoleTransport}=require('../src/client/console-model'),calls=[],body={id:'assets',title:'Assets',fields:{},relations:{}};
 const send=consoleTransport({async studio(operation,payload){calls.push(operation);if(operation==='createSchema')throw Error('timeout');return {...body,revision:1};},async entity(operation,payload){calls.push(operation);return payload;}});
 await assert.rejects(send('createSchema',{body,key:'same'}));assert.equal((await send('createSchema',{body,key:'same'})).revision,1);assert.deepEqual(calls,['createSchema','schema']);
 await send('entityUpdate',{id:'id',body:{},key:'entity'});assert.equal(calls.at(-1),'update');
});
test('SSO return targets preserve known console filters without open redirects or unknown query',()=>{
 const {safeReturnTo}=require('../src/client/console-model');
 assert.equal(safeReturnTo('/lattice/console?section=data&schema=assets&version=1'),'/lattice/console?section=data&schema=assets&version=1');
 for(const value of ['//evil/lattice','javascript:alert(1)','/lattice/console?next=https://evil','/lattice/console?section=evil','/lattice/studio?x=1'])assert.equal(safeReturnTo(value),null);
});
