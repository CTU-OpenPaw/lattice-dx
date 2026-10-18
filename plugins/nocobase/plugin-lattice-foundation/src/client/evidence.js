// SPDX-License-Identifier: Apache-2.0
const {assertRun}=require('./approval');
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
function fileMetadata(value,id){
  if(!value||!uuid.test(value.id)||id&&value.id!==id||typeof value.filename!=='string'||!Number.isInteger(value.size)||value.size<1||value.size>1048576||!['clean','pending','error','rejected'].includes(value.scanStatus))throw new Error('Thông tin tệp không hợp lệ.');
  return value;
}
async function evidenceContext({api,manifest,block,selectedId,run}){
  const resource=manifest.collections.find(c=>c.id===block.collection)?.resource;
  const id=selectedId||(resource==='workflows'?block.runId:block.recordId);
  if(!id)return null;if(!uuid.test(id))throw new Error('ID hồ sơ phải là UUID hợp lệ.');
  if(resource==='workflows'){
    const value=assertRun(run||await api.workflow('detail',{id}),block.definitionId);
    if(value.id!==id||!uuid.test(value.recordId))throw new Error('Hồ sơ không khớp cấu hình.');
    const files=[];
    for(const field of block.fileFields||[]){const fileId=value.data?.[field];if(fileId!==undefined){if(!uuid.test(fileId))throw new Error('ID tệp trong hồ sơ không hợp lệ.');if(!files.includes(fileId))files.push(fileId);}}
    return {id,resource,run:value,recordId:value.recordId,fileIds:files};
  }
  if(resource!=='records')throw new Error('Nguồn hồ sơ không được hỗ trợ.');
  return {id,resource,recordId:id,fileIds:[]};
}
function timelineItems(result){
  if(!Array.isArray(result?.items)||result.items.length>100)throw new Error('Dữ liệu lịch sử không hợp lệ.');
  const ids=new Set();
  for(const item of result.items){if(!item||!uuid.test(item.id)||ids.has(item.id)||typeof item.actorId!=='string'||!item.actorId||typeof item.action!=='string'||typeof item.toState!=='string'||!(item.fromState===null||typeof item.fromState==='string')||!Number.isSafeInteger(item.version)||item.version<1||!Number.isFinite(Date.parse(item.occurredAt)))throw new Error('Sự kiện lịch sử không hợp lệ.');ids.add(item.id);}
  return [...result.items].sort((a,b)=>b.version-a.version||b.occurredAt.localeCompare(a.occurredAt));
}
function eventReason(item){return typeof item.reason==='string'?item.reason:typeof item.metadata?.reason==='string'?item.metadata.reason:null;}
function fileBytes(result){fileMetadata(result);if(result.scanStatus!=='clean'||typeof result.contentBase64!=='string')throw new Error('Tệp chưa được phép sử dụng.');const bytes=Uint8Array.from(atob(result.contentBase64),c=>c.charCodeAt(0));if(bytes.length!==result.size)throw new Error('Nội dung tệp không khớp kích thước.');return bytes;}
module.exports={fileMetadata,evidenceContext,timelineItems,eventReason,fileBytes};
