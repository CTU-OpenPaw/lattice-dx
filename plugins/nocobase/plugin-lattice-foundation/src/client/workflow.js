// SPDX-License-Identifier: Apache-2.0
function createWorkflowCommands({api,actorId,channel='workflow',newKey=()=>globalThis.crypto.randomUUID()}) {
  let pending=null,busy=false;
  async function send(){
    if(busy)throw new Error('Lệnh đang xử lý.');if(!pending)throw new Error('Không có lệnh cần thử lại.');
    busy=true;
    try{const result=await api[channel](pending.operation,{...(pending.id?{id:pending.id}:{}),key:pending.key,body:pending.body});pending=null;return result;}
    catch(error){const status=error.status||error.response?.status;if(status>=400&&status<500&&status!==429)pending=null;throw error;}
    finally{busy=false;}
  }
  return {async execute(operation,body,id){if(!actorId)throw new Error('Chưa kết nối tài khoản.');if(pending||busy)throw new Error('Kiểm tra hoặc thử lại lệnh cũ trước khi tạo lệnh mới.');pending={operation,id,key:'ui-'+newKey(),body:JSON.parse(JSON.stringify(body))};return send();},retry:send,get uncertain(){return !!pending},get busy(){return busy}};
}
module.exports={createWorkflowCommands};
