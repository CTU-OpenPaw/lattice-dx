// SPDX-License-Identifier: Apache-2.0
const {createWorkflowCommands}=require("../../client/workflow");
function createWorkflowComponent(React){
  const h=React.createElement,labels={submit:'Gửi yêu cầu',approve:'Duyệt',reject:'Từ chối',receive:'Nhận hàng',accept:'Nghiệm thu',handover:'Bàn giao'};
  const fields={reason:'Lý do',receiptAttachmentId:'ID tệp biên nhận',acceptanceNote:'Ghi chú nghiệm thu',assetId:'Mã tài sản',recipientId:'Subject người nhận đã đăng ký',departmentId:'Đơn vị',locationId:'Địa điểm',attachmentId:'ID tệp bàn giao'};
  return function Workflow({api,connection}){
    const connected=connection.connected,subject=connection.identity?.subject;
    const [runs,setRuns]=React.useState([]),[run,setRun]=React.useState(null),[history,setHistory]=React.useState([]),[refs,setRefs]=React.useState([]);
    const [title,setTitle]=React.useState(''),[values,setValues]=React.useState({}),[error,setError]=React.useState(''),[busy,setBusy]=React.useState(false),[inbox,setInbox]=React.useState(false),[file,setFile]=React.useState(null),[fileInfo,setFileInfo]=React.useState(null);
    const lock=React.useRef(false),epoch=React.useRef(0);
    const commands=React.useMemo(()=>createWorkflowCommands({api,actorId:subject}),[api,subject]);
    async function list(){let result=await api.workflow(inbox?'inbox':'list',{query:{definitionId:'procurement',limit:'100',offset:'0'}});const rows=[...result.items];while(result.page?.hasMore){if(rows.length>=10000)throw new Error('Thu hẹp danh sách workflow trước khi tải thêm.');const offset=result.page.nextOffset;result=await api.workflow(inbox?'inbox':'list',{query:{definitionId:'procurement',limit:'100',offset:String(offset)}});if(result.page.offset!==offset||result.page.nextOffset===offset)throw new Error('Phân trang workflow không hợp lệ.');rows.push(...result.items);}return rows;}
    React.useEffect(()=>{const current=++epoch.current;setRuns([]);setRun(null);setHistory([]);setValues({});setFileInfo(null);setError('');setBusy(false);
      if(connected)Promise.all([list(),api.workflow('references')]).then(([rows,result])=>{if(current===epoch.current){setRuns(rows);setRefs(result.items)}}).catch(e=>{if(current===epoch.current)setError(e.message)});
      return()=>{epoch.current++};},[api,connected,subject,inbox]);
    async function perform(operation){if(lock.current||!connected)return;const current=epoch.current;lock.current=true;setBusy(true);setError('');
      try{await operation(current);}catch(e){if(current===epoch.current)setError(e.message)}finally{lock.current=false;if(current===epoch.current)setBusy(false)}
    }
    async function open(id,current){const [detail,audit]=await Promise.all([api.workflow('detail',{id}),api.workflow('history',{id})]);if(current===epoch.current){setRun(detail);setHistory(audit.items);setValues({});setFileInfo(null);}}
    async function saved(result,current){if(current!==epoch.current)return;await open(result.id,current);const rows=await list();if(current===epoch.current)setRuns(rows);}
    async function upload(current){if(!file||!file.size||file.size>1048576)throw new Error('Chọn tệp không rỗng, tối đa 1 MiB.');
      const contentBase64=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(new Error('Không đọc được tệp.'));reader.readAsDataURL(file)});
      // Workflow evidence attaches through its transition, not owner-only recordId.
      const metadata=await api.file('upload',{filename:file.name,contentBase64});if(current===epoch.current)setFileInfo(metadata);
    }
    async function download(id,current){const result=await api.file('content',{id});if(current!==epoch.current)return;const url=URL.createObjectURL(new Blob([Uint8Array.from(atob(result.contentBase64),c=>c.charCodeAt(0))]));const link=document.createElement('a');link.href=url;link.download=result.filename;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
    return h('section',{'data-testid':'procurement-workflow',style:{border:'1px solid #cad5e2',padding:16,marginBottom:20,borderRadius:8}},
      h('h3',null,'Quy trình mua sắm và bàn giao'),h('p',null,'Các bước và quyền lấy từ API. Danh sách chỉ lấy workflow mua sắm, theo từng trang API; gửi sự kiện ngoài chưa bật.'),
      !connected&&h('p',null,'Kết nối tài khoản nghiệp vụ để sử dụng workflow.'),
      h('form',{onSubmit:e=>{e.preventDefault();perform(async current=>{if(!title.trim()||Array.from(title).length>200)throw new Error('Nội dung phải có 1–200 ký tự.');await saved(await commands.execute('create',{definitionId:'procurement',title:title.trim(),input:{}}),current);if(current===epoch.current)setTitle('');})}},
        h('label',null,'Nội dung workflow ',h('input',{value:title,onChange:e=>setTitle(e.target.value),disabled:busy||!connected||commands.uncertain})),
        h('button',{type:'submit',disabled:busy||!connected||commands.uncertain},'Tạo yêu cầu workflow')),
      h('label',null,h('input',{type:'checkbox',checked:inbox,disabled:busy,onChange:e=>setInbox(e.target.checked)}),' Chỉ việc tôi có thể xử lý'),
      h('button',{type:'button',disabled:busy||!connected,onClick:()=>perform(async current=>{const rows=await list();if(current===epoch.current)setRuns(rows);if(run)await open(run.id,current);})},'Tải lại workflow'),
      busy&&h('p',{role:'status'},'Đang xử lý workflow…'),error&&h('p',{role:'alert'},error),
      commands.uncertain&&h('p',null,'Kết quả lệnh chưa xác định. Kiểm tra trước; thử lại giữ nguyên key và dữ liệu. Không tạo yêu cầu mới để thay thế.',h('button',{disabled:busy||!connected,onClick:()=>perform(async current=>saved(await commands.retry(),current))},'Thử lại lệnh cũ')),
      h('ul',null,...runs.map(row=>h('li',{key:row.id},h('button',{disabled:busy,onClick:()=>perform(current=>open(row.id,current))},row.title+' — '+row.state)))),
      run&&h('article',{'data-testid':'workflow-detail'},h('h4',null,run.title),h('p',{'data-testid':'workflow-state'},`ID: ${run.id} — ${run.state} — version ${run.version}`),
        h('label',null,'Tệp bằng chứng workflow ',h('input',{type:'file',disabled:busy||!connected,onChange:e=>setFile(e.target.files[0]||null)})),
        h('button',{disabled:busy||!connected||!file,onClick:()=>perform(upload)},'Tải bằng chứng lên'),
        fileInfo&&h('p',{role:'status'},`ID tệp: ${fileInfo.id} — scan: ${fileInfo.scanStatus}`),
        fileInfo&&fileInfo.scanStatus!=='clean'&&h('p',null,'Không dùng tệp này cho bước workflow khi chưa clean.'),
        ...run.availableTransitions.map(action=>h('form',{key:action.id,'data-transition':action.id,onSubmit:e=>{e.preventDefault();perform(async current=>{const input={};for(const name of Object.keys(action.fields)){if(!values[name]?.trim())throw new Error('Thiếu '+(fields[name]||name));input[name]=values[name];}await saved(await commands.execute('transition',{action:action.id,expectedVersion:run.version,input},run.id),current);})}},
          h('h5',null,labels[action.id]||action.id),...Object.entries(action.fields).map(([name,kind])=>h('label',{key:name,style:{display:'block',margin:8}},fields[name]||name,
            ['department','location'].includes(kind)?h('select',{'aria-label':fields[name]||name,value:values[name]||'',disabled:busy,onChange:e=>setValues(old=>({...old,[name]:e.target.value}))},h('option',{value:''},'Chọn…'),...refs.filter(r=>r.kind===kind).map(r=>h('option',{key:r.id,value:r.id},r.name))):h('input',{'aria-label':fields[name]||name,value:values[name]||'',disabled:busy,onChange:e=>setValues(old=>({...old,[name]:e.target.value}))}))),
          h('button',{type:'submit',disabled:busy||!connected||commands.uncertain},labels[action.id]||action.id))),
        h('h5',null,'Tệp đã liên kết'),...['receiptAttachmentId','attachmentId'].filter(name=>run.data[name]).map(name=>h('button',{key:name,disabled:busy||!connected,onClick:()=>perform(current=>download(run.data[name],current))},'Tải '+(fields[name]||name))),
        h('h5',null,'Lịch sử'),h('ol',null,...history.map(item=>h('li',{key:item.id},`v${item.version}: ${item.action} — ${item.actorId}`)))));
  };
}
module.exports={createWorkflowComponent};
