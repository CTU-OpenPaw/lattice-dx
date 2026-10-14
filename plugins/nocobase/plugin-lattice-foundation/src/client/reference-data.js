// SPDX-License-Identifier: Apache-2.0
async function loadReferenceOptions(api,reference) {
  if(reference.resource)return api.list(reference.resource);
  const rows=[];let offset=0;
  for(;;) {
    const {data:result}=await api.request({url:reference.url,method:'post',data:{operation:reference.operation,query:{...reference.query,limit:'100',offset:String(offset)}}});
    if(!Array.isArray(result?.items)||result.items.length>100||!result.page||result.page.offset!==offset||result.page.limit!==100||typeof result.page.hasMore!=='boolean'||(result.page.hasMore?result.page.nextOffset!==offset+100:result.page.nextOffset!==null))throw new Error('Phân trang lựa chọn không hợp lệ.');
    rows.push(...result.items);
    if(!result.page.hasMore)return rows;
    if(rows.length>=10000)throw new Error('Danh sách lựa chọn quá lớn; cần giới hạn phạm vi.');
    offset=result.page.nextOffset;
  }
}
async function loadFormContext(api,block,contract,contracts) {
  const names=[...new Set(block.fields.filter(field=>field.reference).map(field=>field.reference))];
  const [references,allowed]=await Promise.all([
    Promise.all(names.map(async name=>{try{return {name,rows:await loadReferenceOptions(api,contracts.reference(name))};}catch(error){return {name,error};}})),
    contract.transport.kind==='catalog'?api.catalog().then(items=>items.some(action=>action.id===block.submit.actionId&&action.version===block.submit.version)):Promise.resolve(true),
  ]);
  const required=new Set(block.fields.filter(field=>field.required&&contracts.reference(field.reference)?.mode==='select').map(field=>field.reference));
  if(contract.availabilityReference)required.add(contract.availabilityReference);
  return {options:Object.fromEntries(references.filter(item=>!item.error).map(item=>[item.name,item.rows])),available:allowed&&!references.some(item=>item.error&&required.has(item.name)),error:references.filter(item=>item.error).map(item=>item.error.message).join(' ')};
}
module.exports={loadReferenceOptions,loadFormContext};
