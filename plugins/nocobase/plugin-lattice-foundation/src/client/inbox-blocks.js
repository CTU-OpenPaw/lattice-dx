// SPDX-License-Identifier: Apache-2.0
const {assertRun,createApprovalController}=require('./approval');
function createInboxComponents(React,evidence={}) {
  const defaults={button:{padding:'8px 12px',margin:'4px 4px 4px 0',border:'1px solid #cad5e2',borderRadius:6,background:'#fff',color:'#172b4d',cursor:'pointer'},input:{padding:8,border:'1px solid #cad5e2',borderRadius:6},select:{padding:8,border:'1px solid #cad5e2',borderRadius:6},textarea:{display:'block',width:'100%',boxSizing:'border-box',padding:8,marginTop:6,border:'1px solid #cad5e2',borderRadius:6},table:{width:'100%',borderCollapse:'collapse',marginTop:12},th:{padding:10,textAlign:'left',background:'#f3f6fa',borderBottom:'1px solid #dce3ed'},td:{padding:10,textAlign:'left',borderBottom:'1px solid #e8edf4',maxWidth:250,overflowWrap:'anywhere'},form:{margin:'8px 0'},nav:{marginTop:12}};
  function h(type,props,...children){const value=props||{};return React.createElement(type,{...value,...(typeof type==='string'&&defaults[type]?{style:{...defaults[type],...(type==='button'&&value['aria-pressed']?{background:'#eaf1ff',borderColor:'#2563eb'}:{}),...(type==='button'&&value.disabled?{cursor:'default',opacity:0.55}:{}),...value.style}}:{})},...children);}
  const style={padding:16,border:'1px solid #dce3ed',borderRadius:8,marginBottom:16};
  function ApprovalBlock({manifest,block,api,connected,selectedId,actorId,actorName,canReadDirectory,onSaved,onLocked}) {
    const id=selectedId||block.runId;
    const [run,setRun]=React.useState(null),[values,setValues]=React.useState({}),[refs,setRefs]=React.useState([]);
    const [loading,setLoading]=React.useState(false),[busy,setBusy]=React.useState(false),[error,setError]=React.useState(''),[notice,setNotice]=React.useState(''),[reload,setReload]=React.useState(0);
    const epoch=React.useRef(0);
    const [uploaded,setUploaded]=React.useState(null);
    React.useEffect(()=>setUploaded(null),[id,connected,actorId]);
    const controller=React.useMemo(()=>createApprovalController({api,actorId:connected?(actorId||'session'):null,definitionId:block.definitionId}),[api,id,connected,actorId,block.definitionId]);
    React.useEffect(()=>{const current=++epoch.current;let active=true;setRun(null);setValues({});setError('');setNotice('');setBusy(false);onLocked?.(false);
      if(!id||!connected){setLoading(false);return()=>{active=false;epoch.current++;};}
      setLoading(true);
      api.workflow('detail',{id}).then(value=>{if(active){assertRun(value,block.definitionId);if(value.id!==id)throw new Error('ID công việc không khớp.');controller.load(value);setRun(value);}}).catch(e=>{if(active)setError(e.message)}).finally(()=>{if(active&&current===epoch.current)setLoading(false)});
      return()=>{active=false;epoch.current++;};
    },[controller,id,connected,reload]);
    React.useEffect(()=>{let active=true;setRefs([]);if(connected&&run?.availableTransitions.some(a=>Object.values(a.fields).some(k=>['department','location'].includes(k))))api.workflow('references').then(result=>{if(active)setRefs(result.items||[])}).catch(()=>{});return()=>{active=false};},[api,connected,run]);
    React.useEffect(()=>()=>onLocked?.(false),[onLocked]);
    async function perform(action,retry=false){
      if(!connected||controller.busy||(!retry&&controller.uncertain))return;
      const current=epoch.current;setBusy(true);setError('');setNotice('');onLocked?.(true);
      try{const result=retry?await controller.retry():await controller.execute(action.id,values[action.id]||{});if(current===epoch.current){setRun(result);setValues({});setNotice('Đã xử lý thành công — trạng thái: '+result.state);api.clearNotice?.();onSaved?.(result);}}
      catch(e){if(current===epoch.current)setError(e.message);}
      finally{if(current===epoch.current){setBusy(false);onLocked?.(controller.uncertain);}}
    }
    const locked=busy||controller.uncertain;
    return h('article',{style,'data-block-id':block.id,'data-testid':'lattice-approval'},h('h3',null,block.title),
      !connected&&h('p',null,'Kết nối tài khoản nghiệp vụ để xử lý công việc.'),
      connected&&!id&&h('p',null,'Chọn một công việc trong Inbox hoặc cấu hình ID hồ sơ.'),
      loading&&h('p',{role:'status'},'Đang tải chi tiết…'),error&&h('p',{role:'alert'},error),notice&&h('p',{role:'status'},notice),
      id&&connected&&h('button',{type:'button',disabled:locked||loading,onClick:()=>setReload(n=>n+1)},'Tải lại chi tiết'),
      run&&h('div',null,h('h4',null,run.title),h('p',{'data-testid':'approval-state'},`${run.definitionId} — ${run.state} — v${run.version}`),h('small',null,'ID: '+run.id),
        h('dl',null,...Object.entries(run.data||{}).map(([name,value])=>h('div',{key:name},h('dt',null,block.fieldLabels?.[name]||name),h('dd',null,String(value))))),
        run.waiting&&h('p',null,'Quy trình đang chờ tác vụ hoặc dịch vụ hoàn tất. Chưa có hành động chuyển bước.'),
        !run.waiting&&!run.availableTransitions.length&&h('p',null,'Không có hành động được phép ở trạng thái hiện tại.'),
        ...run.availableTransitions.map(action=>h('form',{key:action.id,'data-transition':action.id,onSubmit:e=>{e.preventDefault();perform(action);},noValidate:true},
          h('h4',null,block.actionLabels?.[action.id]||action.id),
          ...Object.entries(action.fields).map(([name,kind])=>{
            const label=block.fieldLabels?.[name]||name;const inputProps={'aria-label':label,name,required:true,disabled:locked||!connected,value:values[action.id]?.[name]||'',onChange:e=>setValues(old=>({...old,[action.id]:{...old[action.id],[name]:e.target.value}}))};
            return h('label',{key:name,style:{display:'block',margin:'8px 0'}},label+' * ',
              ['department','location'].includes(kind)?h('select',inputProps,h('option',{value:''},'Chọn…'),...refs.filter(r=>r.kind===kind).map(r=>h('option',{key:r.id,value:r.id},r.name))):kind==='text'?h('textarea',{...inputProps,rows:3}):h('input',{...inputProps,type:kind==='positiveInteger'?'number':'text',...(kind==='positiveInteger'?{min:1,max:1000000,step:1}:{})}),
              kind==='subject'&&h('small',null,' Dùng định danh tài khoản trong danh bạ.'),kind==='file'&&h('small',null,' Dùng ID tệp đã được quét sạch.'),kind==='file'&&uploaded&&h('button',{type:'button',disabled:locked||!connected,onClick:()=>setValues(old=>({...old,[action.id]:{...old[action.id],[name]:uploaded.id}}))},'Dùng tệp vừa tải cho '+label));
          }),
          h('button',{type:'submit',disabled:locked||!connected},busy?'Đang xử lý…':block.actionLabels?.[action.id]||action.id)))),
      controller.uncertain&&h('div',null,h('p',{role:'alert'},'Kết quả chưa xác định. Không đổi công việc; thử lại sẽ dùng đúng lệnh và khóa cũ.'),h('button',{type:'button',disabled:busy||!connected,onClick:()=>perform(null,true)},'Thử lại lệnh cũ')),
      run&&evidence.AttachmentBlock&&manifest?.blocks.find(b=>b.id===block.attachmentBlockId)&&h(evidence.AttachmentBlock,{manifest,block:manifest.blocks.find(b=>b.id===block.attachmentBlockId),api,connected,selectedId:id,run,actorId,readOnly:locked||!run.availableTransitions.some(action=>Object.values(action.fields).includes('file')),onUploaded:setUploaded}),
      run&&evidence.ActivityTimelineBlock&&manifest?.blocks.find(b=>b.id===block.timelineBlockId)&&h(evidence.ActivityTimelineBlock,{manifest,block:manifest.blocks.find(b=>b.id===block.timelineBlockId),api,connected,selectedId:id,run,actorId,actorName,canReadDirectory}));
  }
  function TaskInboxBlock({manifest,block,api,connected,actorId,actorName,canReadDirectory=false,refreshKey,onOpen,openDisabled=false}) {
    const [items,setItems]=React.useState([]),[page,setPage]=React.useState(0),[next,setNext]=React.useState(false),[q,setQ]=React.useState(''),[search,setSearch]=React.useState(''),[state,setState]=React.useState(''),[mode,setMode]=React.useState('inbox');
    const [loading,setLoading]=React.useState(false),[error,setError]=React.useState(''),[reload,setReload]=React.useState(0),[selected,setSelected]=React.useState(null),[locked,setLocked]=React.useState(false);
    const [updatedAt,setUpdatedAt]=React.useState(null);
    const [people,setPeople]=React.useState([]),[definitions,setDefinitions]=React.useState([]);
    const [definitionFilter,setDefinitionFilter]=React.useState('');
    const [states,setStates]=React.useState([]);const limit=block.pageSize||10;
    React.useEffect(()=>{setPage(0);setSelected(null);setLocked(false);},[connected,actorId,block.id]);
    React.useEffect(()=>{let active=true;setItems([]);setNext(false);setError('');if(!connected){setLoading(false);return()=>{active=false};}setLoading(true);
      api.workflow(mode,{query:{limit:String(limit),offset:String(page*limit),q:search,...(state?{state}:{}),...((block.definitionId||definitionFilter)?{definitionId:block.definitionId||definitionFilter}:{})}}).then(result=>{
        if(!Array.isArray(result?.items)||result.items.length>limit||!result.page||result.page.offset!==page*limit||result.page.limit!==limit||typeof result.page.hasMore!=='boolean')throw new Error('Phân trang Inbox không hợp lệ.');
        result.items.forEach(row=>assertRun(row,block.definitionId));if(active){setItems(result.items);setNext(result.page.hasMore);setUpdatedAt(new Date());}
      }).catch(e=>{if(active)setError(e.message)}).finally(()=>{if(active)setLoading(false)});return()=>{active=false};
    },[api,connected,actorId,block.definitionId,definitionFilter,limit,page,state,mode,search,reload,refreshKey]);
    React.useEffect(()=>{let active=true;setStates([]);setDefinitions([]);if(connected)api.workflow('definitions').then(result=>{if(active){setDefinitions(result.items||[]);setStates([...new Set((result.items||[]).filter(d=>!block.definitionId||d.id===block.definitionId).flatMap(d=>[d.initialState,...d.transitions.flatMap(t=>[t.from,t.to])]))].sort())}}).catch(()=>{});return()=>{active=false};},[api,connected,block.definitionId]);
    React.useEffect(()=>{let active=true;setPeople([]);if(connected&&canReadDirectory&&api.directoryPeople)api.directoryPeople().then(result=>{if(active&&Array.isArray(result.items))setPeople(result.items)}).catch(()=>{});return()=>{active=false};},[api,connected,actorId,canReadDirectory]);
    const approval=manifest.blocks.find(b=>b.id===block.approvalBlockId);
    const disabled=locked||openDisabled;
    return h('article',{style,'data-block-id':block.id,'data-testid':'lattice-task-inbox'},h('h3',null,block.title),
      h('p',null,'Danh sách theo quyền và bước xử lý do API quyết định.'),!connected&&h('p',null,'Kết nối tài khoản nghiệp vụ để xem công việc.'),
      h('div',{'aria-label':'Phạm vi công việc'},...[['inbox','Cần xử lý'],['list','Có quyền xem']].map(([value,label])=>h('button',{key:value,type:'button','aria-pressed':mode===value,disabled:disabled||!connected,onClick:()=>{setMode(value);setPage(0);setSelected(null)}},label)),...['Đang thực hiện','Đã hoàn thành','Tôi đã tạo'].map(label=>h('button',{key:label,type:'button',disabled:true,title:label+' — sắp có'},label))),
      h('form',{onSubmit:e=>{e.preventDefault();setSearch(q.trim());setPage(0);setSelected(null)}},h('label',null,'Tìm công việc ',h('input',{'aria-label':'Tìm công việc',value:q,disabled:disabled||!connected,onChange:e=>setQ(e.target.value)})),h('button',{type:'submit',disabled:disabled||!connected},'Tìm')),
      h('label',null,'Quy trình ',h('select',{'aria-label':'Lọc quy trình',value:block.definitionId||definitionFilter,disabled:disabled||!connected||!!block.definitionId,onChange:e=>{setDefinitionFilter(e.target.value);setState('');setPage(0);setSelected(null)}},h('option',{value:''},'Tất cả'),...definitions.map(d=>h('option',{key:d.id,value:d.id},d.title)))),
      h('label',null,'Trạng thái ',h('select',{'aria-label':'Trạng thái công việc',value:state,disabled:disabled||!connected,onChange:e=>{setState(e.target.value);setPage(0);setSelected(null)}},h('option',{value:''},'Tất cả'),...states.map(s=>h('option',{key:s,value:s},block.stateLabels?.[s]||s)))),
      h('button',{type:'button',disabled:disabled||loading||!connected,onClick:()=>setReload(n=>n+1)},'Tải lại Inbox'),
      connected&&updatedAt&&h('small',{style:{marginLeft:12,color:'#627187'}},'Cập nhật lúc '+updatedAt.toLocaleTimeString('vi-VN',{hour:'2-digit',minute:'2-digit'})),
      loading&&h('p',{role:'status'},'Đang tải công việc…'),error&&h('p',{role:'alert'},error),connected&&!loading&&!error&&!items.length&&h('p',null,'Không có công việc phù hợp.'),
      connected&&!loading&&!error&&h('div',{style:{overflowX:'auto'}},h('table',null,h('thead',null,h('tr',null,...['Công việc','Quy trình','Người liên quan','Trạng thái','Hạn xử lý','Hành động'].map(t=>h('th',{key:t,scope:'col'},t)))),h('tbody',null,...items.map(row=>h('tr',{key:row.id},h('td',null,h('strong',null,row.title),h('small',{style:{display:'block',color:'#627187'}},'#'+row.id.slice(0,8))),h('td',null,definitions.find(d=>d.id===row.definitionId)?.title||row.definitionId),h('td',null,h('small',{style:{display:'block',color:'#627187'}},'Người tạo:'),people.find(p=>p.subject===row.ownerId)?.displayName||(row.ownerId===actorId?actorName:null)||h('span',{title:row.ownerId},'ID '+String(row.ownerId||'').slice(0,8))),h('td',null,h('span',{style:{display:'inline-block',padding:'3px 8px',borderRadius:12,background:row.availableTransitions.length?'#fff0c2':'#edf1f6',whiteSpace:'nowrap'}},block.stateLabels?.[row.state]||row.state)),h('td',{title:'Chưa có thông tin hạn xử lý'},'—'),h('td',null,h('button',{type:'button','aria-label':'Mở '+row.title,disabled,onClick:()=>{setSelected(row.id);onOpen?.(row)}},approval?.actionLabels?.[row.availableTransitions[0]?.id]||'Mở chi tiết'))))))),
      h('nav',{'aria-label':'Phân trang Inbox'},h('button',{disabled:disabled||loading||!connected||page===0,onClick:()=>{setPage(n=>n-1);setSelected(null)}},'Trước'),h('span',null,` Trang ${page+1} `),h('button',{disabled:disabled||loading||!connected||!next,onClick:()=>{setPage(n=>n+1);setSelected(null)}},'Sau')),
      approval&&selected&&h(ApprovalBlock,{key:selected+':'+(actorId||''),manifest,block:approval,api,connected,actorId,actorName,canReadDirectory,selectedId:selected,onLocked:setLocked,onSaved:()=>setReload(n=>n+1)}));
  }
  return {TaskInboxBlock,ApprovalBlock};
}
module.exports={createInboxComponents};
