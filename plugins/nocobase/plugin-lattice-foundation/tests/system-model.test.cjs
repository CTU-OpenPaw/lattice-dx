// SPDX-License-Identifier: Apache-2.0
const {test}=require('node:test'),assert=require('node:assert/strict');
const {exampleRecipe,studioCommands,fieldValue}=require('../src/client/system-model');
test('portable package consistency ignores key order but detects changed roles',()=>{
 const {sameConfiguration}=require('../src/client/system-model');
 assert.equal(sameConfiguration({role:'employee',fields:['a']},{fields:['a'],role:'employee'}),true);
 assert.equal(sameConfiguration({role:'employee'},{role:'manager'}),false);
});
test('Studio retries the same immutable command and template copies are independent',async()=>{
 const first=exampleRecipe(),second=exampleRecipe();first.pages[0].title='Changed';assert.notEqual(first.pages[0].title,second.pages[0].title);
 const calls=[],api={async studio(operation,payload){calls.push({operation,payload});if(calls.length===1)throw Error('network');return {ok:true};}};
 const commands=studioCommands(api,'designer'),payload={id:'ops',version:'1.0.0',body:{enabled:true,expectedRevision:1}};
 await assert.rejects(commands.execute('enable',payload));payload.version='2.0.0';assert.equal(commands.uncertain,true);
 await commands.retry();assert.deepEqual(calls[0],calls[1]);assert.equal(calls[1].payload.version,'1.0.0');assert.equal(commands.uncertain,false);
 assert.equal(fieldValue('positiveInteger','2'),'2');assert.throws(()=>fieldValue('positiveInteger','0'));
});
