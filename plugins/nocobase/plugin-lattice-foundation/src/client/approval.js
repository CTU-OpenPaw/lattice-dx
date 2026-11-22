/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const {createWorkflowCommands}=require('./workflow');
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const kinds=new Set(['text','subject','department','location','file','positiveInteger']);
function assertRun(run,definitionId) {
  if(!run||!uuid.test(run.id)||!Number.isSafeInteger(run.version)||run.version<1||typeof run.title!=='string'||typeof run.state!=='string'||typeof run.definitionId!=='string'||!Array.isArray(run.availableTransitions)||definitionId&&run.definitionId!==definitionId)throw new Error('Dữ liệu công việc không khớp cấu hình.');
  const ids=new Set();
  for(const action of run.availableTransitions){
    if(!action||typeof action.id!=='string'||ids.has(action.id)||action.from!==run.state||!action.fields||typeof action.fields!=='object'||Array.isArray(action.fields)||Object.entries(action.fields).some(([name,kind])=>! /^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(name)||['constructor','prototype','__proto__'].includes(name)||!kinds.has(kind)))throw new Error('Cấu hình hành động không hợp lệ.');
    ids.add(action.id);
  }
  return run;
}
function transitionInput(action,values) {
  if(!values||typeof values!=='object'||Array.isArray(values)||Object.keys(values).some(name=>!Object.hasOwn(action.fields,name)))throw new Error('Dữ liệu ngoài cấu hình hành động.');
  const input={};
  for(const [name,kind] of Object.entries(action.fields)){
    const raw=values[name];const value=typeof raw==='string'?raw.trim():'';
    if(!value||Array.from(value).length>(kind==='text'?2000:100))throw new Error('Thiếu hoặc sai trường '+name+'.');
    if(kind==='file'&&!uuid.test(value))throw new Error(name+' cần ID tệp hợp lệ.');
    if(kind==='positiveInteger'&&(!/^[1-9][0-9]*$/.test(value)||Number(value)>1000000))throw new Error(name+' cần số nguyên dương ≤ 1000000.');
    input[name]=kind==='text'?value:raw;
  }
  return input;
}
function createApprovalController({api,actorId,definitionId,actionId:configuredActionId,newKey}) {
  let run=null;
  const transport={workflow:async(operation,payload)=>{
    const result=assertRun(await api.workflow(operation,payload),definitionId);
    if(result.id!==payload.id||result.definitionId!==run.definitionId||result.version!==payload.body.expectedVersion+1)throw new Error('Chưa xác nhận được kết quả; kiểm tra hoặc thử lại lệnh cũ.');
    return result;
  }};
  const commands=createWorkflowCommands({api:transport,actorId,newKey});
  return {
    load(value){if(commands.busy||commands.uncertain)throw new Error('Hoàn tất lệnh cũ trước khi đổi công việc.');run=assertRun(value,definitionId);},
    async execute(actionId,values){
      if(!run)throw new Error('Mở công việc trước.');
      if(configuredActionId&&actionId!==configuredActionId)throw new Error('Hành động không thuộc cấu hình form.');
      const action=run.availableTransitions.find(item=>item.id===actionId);
      if(run.waiting||!action)throw new Error('Hành động không được API cho phép.');
      const result=await commands.execute('transition',{action:action.id,expectedVersion:run.version,input:transitionInput(action,values)},run.id);run=result;return result;
    },
    async retry(){const result=await commands.retry();run=result;return result;},
    get busy(){return commands.busy;},get uncertain(){return commands.uncertain;},
  };
}
module.exports={assertRun,transitionInput,createApprovalController};
