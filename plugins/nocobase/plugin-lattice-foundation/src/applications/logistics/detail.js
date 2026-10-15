// SPDX-License-Identifier: Apache-2.0
const {createWorkflowCommands}=require('../../client/workflow');
function createLogisticsComponent(React){
  const h=React.createElement;
  return function LogisticsDetail({api,connection,orderId,onChanged,onLocked}){
    const [order,setOrder]=React.useState(null),[history,setHistory]=React.useState([]),[note,setNote]=React.useState(''),[error,setError]=React.useState(''),[busy,setBusy]=React.useState(false);
    const epoch=React.useRef(0),lock=React.useRef(false),mounted=React.useRef(true);
    const commands=React.useMemo(()=>createWorkflowCommands({api,actorId:connection.identity?.subject,channel:'logistics'}),[api,connection.identity?.subject]);
    React.useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;epoch.current++}},[]);
    async function load(current){const [run,audit]=await Promise.all([api.logistics('detail',{id:orderId}),api.logistics('history',{id:orderId})]);if(current===epoch.current&&mounted.current){setOrder(run);setHistory(audit.items);}}
    React.useEffect(()=>{const current=++epoch.current;setOrder(null);setHistory([]);setError('');setNote('');if(orderId&&connection.connected)load(current).catch(e=>{if(current===epoch.current)setError(e.message)});return()=>{epoch.current++};},[api,orderId,connection.connected,connection.identity?.subject]);
    async function perform(operation){if(lock.current||!connection.connected)return;lock.current=true;onLocked?.(true);const current=epoch.current;setBusy(true);setError('');try{await operation(current);}catch(e){if(current===epoch.current&&mounted.current)setError(e.message);}finally{lock.current=false;if(mounted.current){setBusy(false);onLocked?.(!!commands.uncertain);}}}
    async function changed(result,current){if(current!==epoch.current)return;await load(current);if(current===epoch.current)onChanged?.(result);}
    async function download(current){const result=await api.file('content',{id:order.data.attachmentId});if(current!==epoch.current)return;const url=URL.createObjectURL(new Blob([Uint8Array.from(atob(result.contentBase64),c=>c.charCodeAt(0))]));const a=document.createElement('a');a.href=url;a.download=result.filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
    if(!orderId)return h('p',null,'Chọn đơn hoặc nhiệm vụ để xem chi tiết.');
    return h('section',{'data-testid':'logistics-detail',style:{border:'1px solid #cad5e2',padding:16,marginBottom:16}},
      h('h3',null,'Chi tiết đơn Logistics'),error&&h('p',{role:'alert'},error),busy&&h('p',{role:'status'},'Đang xử lý đơn…'),
      h('button',{disabled:busy||!connection.connected,onClick:()=>perform(load)},'Tải lại đơn'),
      order&&connection.connected&&h('article',null,h('h4',null,order.title),h('p',{'data-testid':'logistics-state'},`ID: ${order.id} — ${order.state} — version ${order.version}`),
        h('dl',null,...[['Khách hàng',order.customerName],['Địa chỉ',order.deliveryAddress],['SKU',order.sku],['Số lượng',order.quantity],['Người kho',order.warehouseAssigneeId],['Task ID',order.taskId||'Chưa giao']].flatMap(([label,value])=>[h('dt',{key:label},label),h('dd',{key:label+'v'},String(value))])),
        order.data.attachmentId&&h('button',{disabled:busy,onClick:()=>perform(download)},'Tải tệp đơn'),
        ...order.availableTransitions.filter(a=>['submit','receive'].includes(a.id)).map(a=>h('form',{key:a.id,onSubmit:e=>{e.preventDefault();perform(async current=>{if(a.id==='receive'&&!note.trim())throw new Error('Nhập ghi chú nhận việc.');await changed(await commands.execute(a.id,{expectedVersion:order.version,...(a.id==='receive'?{receiptNote:note.trim()}:{})},order.id),current);});}},
          a.id==='receive'&&h('label',null,'Ghi chú nhận việc ',h('input',{value:note,disabled:busy||commands.uncertain,onChange:e=>setNote(e.target.value)})),
          h('button',{type:'submit',disabled:busy||commands.uncertain},a.id==='submit'?'Gửi đơn cho kho':'Nhận việc kho'))),
        commands.uncertain&&h('button',{disabled:busy,onClick:()=>perform(async current=>changed(await commands.retry(),current))},'Thử lại lệnh cũ'),
        h('h4',null,'Lịch sử đơn'),h('ol',null,...history.map(item=>h('li',{key:item.id},`v${item.version}: ${item.action} — ${item.actorId}`)))));
  };
}
module.exports={createLogisticsComponent};
