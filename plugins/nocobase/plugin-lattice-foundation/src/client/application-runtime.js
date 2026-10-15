// SPDX-License-Identifier: Apache-2.0
function createApplicationRuntime(React,blocks) {
  const h=React.createElement,views=new Map();
  function registerView(name,Component) {
    if(typeof name!=='string'||!/^[a-z][a-z0-9.-]{0,79}$/.test(name)||views.has(name)||typeof Component!=='function')throw new Error('Invalid or duplicate application view: '+name);
    views.set(name,Component);
  }
  function Application({manifest,api,connection}) {
    const [selectedId,setSelectedId]=React.useState(null),[locked,setLocked]=React.useState(false),[refresh,setRefresh]=React.useState(0);
    React.useEffect(()=>{setSelectedId(null);setLocked(false);},[manifest.id,connection.connected,connection.identity?.subject]);
    const layout=manifest.workspace||{},panels=layout.panels||[];
    // A missing extension fails visibly rather than exposing a partial workbench.
    const missing=panels.find(panel=>!views.has(panel.renderer));
    if(missing)return h('p',{role:'alert'},'Chưa cài thành phần ứng dụng: '+missing.renderer);
    const bindings=layout.blocks||manifest.blocks.map(block=>({blockId:block.id}));
    function open(row,binding){if(!locked&&binding.selectFrom&&typeof row?.[binding.selectFrom]==='string')setSelectedId(row[binding.selectFrom]);}
    return h('div',{'data-testid':'application-runtime'},
      ...panels.map(panel=>h(views.get(panel.renderer),{key:panel.id+':'+(selectedId||'')+':'+(connection.identity?.subject||''),manifest,api,connection,selectedId,onLocked:setLocked,onChanged:()=>setRefresh(n=>n+1)})),
      ...bindings.map(binding=>{
        const block=manifest.blocks.find(item=>item.id===binding.blockId);
        if(!block)return h('p',{key:binding.blockId,role:'alert'},'Không tìm thấy cấu hình block.');
        return h({form:blocks.FormBlock,list:blocks.ListBlock,'task-inbox':blocks.TaskInboxBlock,approval:blocks.ApprovalBlock}[block.type],{key:block.id+':'+(connection.identity?.subject||''),manifest,block,api,connected:connection.connected,actorId:connection.identity?.subject,selectedId,refreshKey:refresh,openDisabled:locked,onLocked:setLocked,
          canReadDirectory:connection.capabilities?.directoryRead===true,actorName:connection.identity?.username,onSaved:result=>{setRefresh(n=>n+1);open(result,binding);},onOpen:binding.selectFrom?row=>open(row,binding):undefined});
      }),
      layout.note&&h('p',null,layout.note),
      ...(layout.showTransitions===false?[]:manifest.transitions.map(item=>h('p',{key:item.id},'Chuyển trạng thái: Chưa khả dụng. '+item.reason))));
  }
  return {registerView,Application};
}
module.exports={createApplicationRuntime};
