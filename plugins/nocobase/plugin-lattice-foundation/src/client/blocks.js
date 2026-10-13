// SPDX-License-Identifier: Apache-2.0
const {createFormActions} = require('./actions');
const {createWorkspaceApi} = require('./workspace-api');
const {filterPage} = require('./list-data');
function createBlockComponents(client,React,antd) {
  const h=React.createElement;
  const style={padding:14,border:'1px solid #e0e7ef',borderRadius:8,marginBottom:16};
  function AttachmentPanel({api,recordId,connected,allowUnbound=false,onUploaded}) {
    const [file,setFile]=React.useState(null),[saved,setSaved]=React.useState(null),[lookup,setLookup]=React.useState('');
    const [busy,setBusy]=React.useState(false),[error,setError]=React.useState('');
    const lock=React.useRef(false),generation=React.useRef(0);
    React.useEffect(()=>{generation.current++;setSaved(null);setFile(null);setError('');setLookup('');setBusy(false);return()=>{generation.current++};},[recordId,connected]);
    async function perform(operation) {
      if(lock.current||!connected)return;lock.current=true;setBusy(true);setError('');const current=generation.current;
      try{const metadata=await operation(current);if(current===generation.current&&metadata){setSaved(metadata);setLookup(metadata.id);if(metadata.scanStatus==='clean')onUploaded?.(metadata);}}
      catch(e){if(current===generation.current)setError(e.message)}finally{lock.current=false;if(current===generation.current)setBusy(false)}
    }
    async function upload() {
      if(!file||(!recordId&&!allowUnbound))throw new Error('Lưu hồ sơ và chọn tệp trước.');
      if(!file.size||file.size>1048576)throw new Error('Tệp phải có nội dung và không quá 1 MiB.');
      const contentBase64=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(new Error('Không đọc được tệp.'));reader.readAsDataURL(file)});
      return api.file('upload',{filename:file.name,contentBase64,...(recordId?{recordId}:{})});
    }
    async function download(current) {
      const result=await api.file('content',{id:saved.id});
      if(current!==generation.current)return;
      const bytes=Uint8Array.from(atob(result.contentBase64),c=>c.charCodeAt(0));
      const url=URL.createObjectURL(new Blob([bytes],{type:'application/octet-stream'}));
      const link=document.createElement('a');link.href=url;link.download=result.filename;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    }
    return h('section',{'aria-label':'Tệp hồ sơ',style:{marginTop:12,borderTop:'1px solid #ddd',paddingTop:12}},
      h('h4',null,'Tệp đính kèm'),h('p',null,allowUnbound?'Tải tệp sạch trước khi tạo đơn; API chỉ chia sẻ với người kho được giao sau khi gửi đơn.':'Tải tệp sau khi lưu hồ sơ. Quyền đọc theo API; tối đa 1 MiB.'),
      h('label',null,'Chọn tệp ',h('input',{type:'file',disabled:busy||!connected||(!recordId&&!allowUnbound),onChange:e=>setFile(e.target.files[0]||null)})),
      h('button',{type:'button',disabled:busy||!connected||(!recordId&&!allowUnbound)||!file,onClick:()=>perform(upload)},'Tải tệp lên'),
      h('label',{style:{display:'block',marginTop:8}},'ID tệp đã lưu ',h('input',{value:lookup,onChange:e=>setLookup(e.target.value),disabled:busy||!connected})),
      h('button',{type:'button',disabled:busy||!connected||!lookup,onClick:()=>perform(()=>api.file('metadata',{id:lookup}))},'Kiểm tra tệp'),
      busy&&h('p',{role:'status'},'Đang xử lý tệp…'),error&&h('p',{role:'alert'},error),
      saved&&h('div',null,h('p',{role:'status'},`Tệp: ${saved.filename} — ID: ${saved.id} — scan: ${saved.scanStatus}`),
        saved.scanStatus!=='clean'&&h('p',null,'Tệp chưa được phép tải xuống. Không coi upload này là tệp dùng được.'),
        h('button',{type:'button',disabled:busy||!connected||saved.scanStatus!=='clean',onClick:()=>perform(download)},'Tải tệp xuống')));
  }
  function FormBlock({manifest,block,api,connected,onSaved,refreshKey}) {
    const [values,setValues]=React.useState({}),[error,setError]=React.useState(''),[result,setResult]=React.useState(null);
    const [busy,setBusy]=React.useState(false),[available,setAvailable]=React.useState(false);
    const order=block.submit.actionId==='logistics.create';
    const [people,setPeople]=React.useState([]);
    const generation=React.useRef(0);
    React.useEffect(()=>{generation.current++;setResult(null);setError('');setBusy(false);return()=>{generation.current++};},[connected,manifest.id,block.id]);
    const [records,setRecords]=React.useState([]),[referenceError,setReferenceError]=React.useState('');
    const hasReference=block.fields.some(f=>f.reference==='records');
    React.useEffect(()=>{let active=true;setRecords([]);setReferenceError('');if(connected&&hasReference)api.list('records').then(rows=>{if(active)setRecords(rows)}).catch(e=>{if(active)setReferenceError(e.message)});return()=>{active=false};},[api,connected,hasReference,refreshKey]);
    React.useEffect(()=>{if(!connected){setResult(null);setValues({});}},[connected]);
    const controller=React.useMemo(()=>createFormActions({apiClient:api,manifest,blockId:block.id}),[api,manifest,block.id]);
    React.useEffect(()=>{let active=true;setAvailable(false);setPeople([]);if(connected&&!order)api.catalog().then(items=>{
      if(active)setAvailable(items.some(a=>a.id===block.submit.actionId&&a.version===block.submit.version));
    }).catch(()=>{});if(connected&&order)api.logistics('people',{query:{role:'logistics:warehouse',limit:'100',offset:'0'}}).then(async result=>{
      const rows=[...result.items];let page=result.page;while(page.hasMore){if(rows.length>=10000)throw new Error('Directory quá lớn; cần lọc trước.');const next=await api.logistics('people',{query:{role:'logistics:warehouse',limit:'100',offset:String(page.nextOffset)}});if(next.page.offset!==page.nextOffset||next.page.nextOffset===page.nextOffset)throw new Error('Directory pagination invalid');rows.push(...next.items);page=next.page;}
      if(active){setPeople(rows);setAvailable(true);}
    }).catch(e=>{if(active)setError(e.message)});return()=>{active=false};},[api,connected,block.submit.actionId,block.submit.version]);
    async function submit(event) {
      event.preventDefault();if(controller.pending)return;
      const current=generation.current;setBusy(true);setError('');setResult(null);
      try {const saved=await controller.submit(values);if(current===generation.current){setResult(saved);setValues({});onSaved?.(saved);}}
      catch(e){if(current===generation.current)setError(e.message);}
      finally{if(current===generation.current)setBusy(false);}
    }
    if(order&&connected&&!available)return h('article',{style,'data-block-id':block.id},h('h3',null,block.title),h('p',null,'Chỉ tài khoản kinh doanh có quyền directory mới tạo đơn. '+error));
    return h('article',{style,'data-block-id':block.id},h('h3',null,block.title),
      !connected&&h('p',null,'Kết nối tài khoản nghiệp vụ để sử dụng form.'),
      connected&&!available&&h('p',null,'Action chưa được cấp quyền hoặc đang kiểm tra quyền.'),
      referenceError&&h('p',{role:'alert'},referenceError),
      order&&block.attachments&&h(AttachmentPanel,{api,connected:connected&&available&&!busy&&!controller.uncertain,allowUnbound:true,onUploaded:metadata=>setValues(old=>({...old,attachmentId:metadata.id}))}),
      h('form',{onSubmit:submit,noValidate:true},...block.fields.map(field=>h('label',{key:field.name,style:{display:'block',marginBottom:12}},
        h('span',null,field.title+(field.required?' *':'')),
        field.reference==='warehousePeople'?h('select',{'aria-label':field.title,name:field.name,value:values[field.name]||'',disabled:busy||!connected||!available||controller.uncertain,onChange:e=>setValues(old=>({...old,[field.name]:e.target.value}))},h('option',{value:''},'Chọn người kho…'),...people.map(p=>h('option',{key:p.subject,value:p.subject},p.displayName))):h('input',{name:field.name,type:field.type==='positiveInteger'?'number':'text',value:values[field.name]||'',disabled:busy||!connected||!available||controller.uncertain,
          'aria-required':field.required,style:{display:'block',width:'100%',padding:8,marginTop:6,boxSizing:'border-box'},
          list:field.reference?block.id+'-'+field.name:undefined,
          onChange:event=>setValues(old=>({...old,[field.name]:event.target.value}))}),
        field.reference&&h('datalist',{id:block.id+'-'+field.name},...records.map(row=>h('option',{key:row.id,value:row.id},row.title))))),
        h('button',{type:'submit',disabled:busy||!connected||!available||controller.uncertain,style:{padding:'8px 16px'}},busy?'Đang lưu…':'Lưu')),
      controller.uncertain&&h('button',{disabled:busy||!connected,onClick:async()=>{const current=generation.current;setBusy(true);try{const saved=await controller.retry();if(current===generation.current){setResult(saved);setValues({});onSaved?.(saved);}}catch(e){if(current===generation.current)setError(e.message)}finally{if(current===generation.current)setBusy(false)}}},'Thử lại lệnh cũ'),
      error&&h('p',{role:'alert'},error),result&&h('p',{role:'status'},'Đã lưu thành công. ID: '+result.id),
      block.attachments&&!order&&h(AttachmentPanel,{api,recordId:result?.id,connected}));
  }
  const labels={title:'Nội dung',createdAt:'Ngày tạo',status:'Trạng thái',version:'Phiên bản',recordId:'ID hồ sơ'};
  function ListBlock({manifest,block,api,connected,refreshKey,onOpen,openDisabled=false}) {
    const [items,setItems]=React.useState([]),[busy,setBusy]=React.useState(false),[error,setError]=React.useState('');
    const [query,setQuery]=React.useState(''),[page,setPage]=React.useState(1),[size,setSize]=React.useState(10),[reload,setReload]=React.useState(0);
    const resource=manifest.collections.find(c=>c.id===block.collection)?.resource;
    const [serverPage,setServerPage]=React.useState({hasMore:false});
    React.useEffect(()=>{
      let active=true;setItems([]);setError('');
      if(!connected){setBusy(false);return()=>{active=false};}
      setBusy(true);
      api.listPage(resource,{limit:String(size),offset:String((page-1)*size),q:query}).then(result=>{if(active){setItems(result.items);setServerPage(result.page)}}).catch(e=>{if(active)setError(e.message)}).finally(()=>{if(active)setBusy(false)});
      return()=>{active=false};
    },[api,resource,connected,reload,refreshKey,page,size,query]);
    React.useEffect(()=>{setPage(1);setQuery('');},[resource,connected]);
    const data={items,total:items.length,page};
    return h('article',{style,'data-block-id':block.id},h('h3',null,block.title),
      h('p',null,'Bộ lọc và phân trang được thực hiện tại API theo quyền của tài khoản.'),
      !connected&&h('p',null,'Kết nối tài khoản nghiệp vụ để xem dữ liệu.'),
      h('label',null,'Lọc danh sách ',h('input',{'aria-label':'Lọc '+block.title,value:query,onChange:e=>{setQuery(e.target.value);setPage(1)},disabled:!connected,style:{padding:8}})),
      h('button',{onClick:()=>setReload(n=>n+1),disabled:busy||!connected,style:{marginLeft:10}},'Tải lại'),
      busy&&h('p',{role:'status'},'Đang tải danh sách…'),error&&h('p',{role:'alert'},error),
      connected&&!busy&&!error&&h('div',{style:{overflowX:'auto'}},h('table',{style:{width:'100%',borderCollapse:'collapse'}},
        h('thead',null,h('tr',null,...block.columns.map(c=>h('th',{key:c,style:{padding:8,textAlign:'left',borderBottom:'1px solid #ddd'}},labels[c]||c)))),
        h('tbody',null,...data.items.map(row=>h('tr',{key:row.id},...block.columns.map(c=>h('td',{key:c,style:{padding:8,borderBottom:'1px solid #eee'}},c==='title'&&onOpen?h('button',{disabled:openDisabled,onClick:()=>onOpen(row)},String(row[c]??'')):String(row[c]??''))))))),
        !data.total&&h('p',null,'Không có bản ghi phù hợp.'),
        h('nav',{'aria-label':'Phân trang '+block.title},
          h('button',{disabled:data.page<=1,onClick:()=>setPage(data.page-1)},'Trước'),
          h('span',{style:{margin:12}},`Trang ${data.page} — ${data.total} bản ghi`),
          h('button',{disabled:busy||!serverPage.hasMore,onClick:()=>setPage(data.page+1)},'Sau'),
          h('select',{'aria-label':'Số bản ghi mỗi trang',value:size,onChange:e=>{setSize(Number(e.target.value));setPage(1)},style:{marginLeft:12}},
            ...[5,10,20].map(n=>h('option',{key:n,value:n},n+' / trang'))))));
  }
  function ConfiguredBlock({manifestId,blockId,expectedType}) {
    const host=client.useAPIClient();
    const [manifest,setManifest]=React.useState(null),[connection,setConnection]=React.useState({connected:false}),[notice,setNotice]=React.useState(''),[refresh,setRefresh]=React.useState(0);
    const connected=connection.connected;
    const api=React.useMemo(()=>createWorkspaceApi({apiClient:host,notify:n=>setNotice(n.message),onExpired:()=>setConnection({connected:false})}),[host]);
    React.useEffect(()=>{let active=true;if(!manifestId||!blockId)return()=>{active=false};Promise.all([api.applications(),api.connection()]).then(([apps,status])=>{
      if(active){setManifest(apps.find(a=>a.id===manifestId));setConnection(status)}
    }).catch(e=>{if(active)setNotice(e.message)});return()=>{active=false};},[api,manifestId]);
    React.useEffect(()=>{let active=true;const timer=setInterval(()=>api.connection().then(status=>{if(active)setConnection(status)}).catch(()=>{}),30000);return()=>{active=false;clearInterval(timer)};},[api]);
    React.useEffect(()=>{if(!connection.connected||!connection.expiresAt)return;const timer=setTimeout(()=>setConnection({connected:false}),Math.max(0,new Date(connection.expiresAt).getTime()-Date.now()));return()=>clearTimeout(timer);},[connection]);
    const block=manifest?.blocks.find(b=>b.id===blockId);
    if(!manifestId||!blockId)return h('p',null,'Chưa chọn cấu hình. Mở cài đặt block → Chọn ứng dụng và block.');
    if(block&&expectedType&&block.type!==expectedType)return h('p',{role:'alert'},'Loại block không khớp cấu hình đã chọn.');
    return h('div',null,notice&&h('p',{role:'alert'},notice),!connected&&h('a',{href:'/lattice'},'Mở Workspace để kết nối API'),
      connected&&manifestId==='logistics'&&h('a',{href:'/lattice/apps/logistics'},'Mở Workspace Logistics để xem đơn và nhận việc'),
      block?h(block.type==='form'?FormBlock:ListBlock,{manifest,block,api,connected,refreshKey:refresh,onSaved:()=>setRefresh(n=>n+1)}):h('p',null,'Đang tải hoặc không tìm thấy cấu hình block.'));
  }
  function Initializer() {
    const item=client.useSchemaInitializerItem();
    const {insert}=client.useSchemaInitializer();
    const host=client.useAPIClient();
    return h(client.SchemaInitializerItem,{...item,onClick:async()=>{
      try {
        const api=createWorkspaceApi({apiClient:host});
        const apps=await api.applications();
        const options=apps.flatMap(app=>app.blocks.filter(b=>b.type===item.blockType).map(block=>({app,block})));
        if(!options.length)throw new Error('Không có cấu hình block phù hợp.');
        let selected=0;
        antd.Modal.confirm({title:'Chọn cấu hình '+(item.blockType==='form'?'Form':'Danh sách'),
          content:h('select',{'aria-label':'Cấu hình block',defaultValue:0,onChange:e=>{selected=Number(e.target.value)}},
            ...options.map((o,i)=>h('option',{key:i,value:i},o.app.name+' — '+o.block.title))),
          onOk:()=>{const {app,block}=options[selected];insert({type:'void','x-decorator':'BlockItem','x-component':'LatticeConfiguredBlock','x-component-props':{manifestId:app.id,blockId:block.id}});},
          okText:'Thêm block',cancelText:'Hủy'});
      }catch(e){antd.message.error(e.message)}
    }});
  }
  return {FormBlock,ListBlock,ConfiguredBlock,Initializer};
}
module.exports={createBlockComponents};
