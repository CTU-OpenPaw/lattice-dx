// SPDX-License-Identifier: Apache-2.0
const {test}=require('node:test'),assert=require('node:assert/strict');
test('runtime renders configured block order and never silently adds excluded panels',()=>{
 const {createRuntimeBlocks}=require('../src/client/runtime-blocks'),h=(type,props,...children)=>({type,props:props||{},children});
 const Layout=createRuntimeBlocks({Fragment:'fragment'},{h,box:{},button:()=>({button:true}),json:value=>value});
 const result=Layout({order:['history','list','create'],children:['create-node','list-node','detail-node'],history:'history-node',selected:{},busy:false});
 assert.deepEqual(result.children[0].map(item=>item.props.key),['history','list','create']);
 assert.equal(JSON.stringify(result).includes('detail-node'),false);
});
