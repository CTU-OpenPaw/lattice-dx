/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const {fileMetadata,evidenceContext,timelineItems,eventReason,fileBytes}=require('./evidence');
function createEvidenceComponents(React){
  const h=React.createElement;
  const style={padding:16,border:'1px solid #dce3ed',borderRadius:8,marginTop:16,background:'#fff'};
  const button={padding:'7px 12px',margin:'6px 6px 6px 0',border:'1px solid #cdd7e5',borderRadius:6,background:'#fff'};
  const scans={clean:'Đã quét sạch',pending:'Đang chờ quét',error:'Không xác nhận được kết quả quét',rejected:'Tệp bị chặn'};
  function AttachmentBlock({manifest,block,api,connected,selectedId,run,actorId,refreshKey,onUploaded,readOnly=false}){
    const [context,setContext]=React.useState(null),[files,setFiles]=React.useState([]),[file,setFile]=React.useState(null),[lookup,setLookup]=React.useState('');
    const [loading,setLoading]=React.useState(false),[busy,setBusy]=React.useState(false),[error,setError]=React.useState(''),[notice,setNotice]=React.useState(''),[preview,setPreview]=React.useState(null),[stage,setStage]=React.useState(''),[progress,setProgress]=React.useState(0),[reload,setReload]=React.useState(0);
    const epoch=React.useRef(0),lock=React.useRef(false),reader=React.useRef(null);
    const key=selectedId||block.runId||block.recordId;
    React.useEffect(()=>{let active=true;++epoch.current;setContext(null);setFiles([]);setFile(null);setLookup('');setError('');setNotice('');setPreview(null);setBusy(false);setStage('');setProgress(0);
      if(!connected){setLoading(false);return()=>{active=false;++epoch.current;};}setLoading(true);
      evidenceContext({api,manifest,block,selectedId,run}).then(async value=>{
        if(!active)return;setContext(value?{...value,_actorId:actorId}:null);if(!value)return;
        const result=await Promise.all(value.fileIds.map(async id=>{try{return fileMetadata(await api.file('metadata',{id}),id);}catch{return {id,unavailable:true};}}));if(active)setFiles(result);
      }).catch(e=>{if(active)setError(e.message)}).finally(()=>{if(active)setLoading(false)});
      return()=>{active=false;++epoch.current;reader.current?.abort();};
    },[api,manifest,block,key,run,connected,actorId,refreshKey,reload]);
    function remember(metadata){setFiles(old=>[metadata,...old.filter(item=>item.id!==metadata.id)]);}
    async function perform(operation){if(lock.current||!connected)return;lock.current=true;setBusy(true);setError('');setNotice('');setPreview(null);const current=epoch.current;
      try{await operation(current);}catch(e){if(current===epoch.current)setError(e.message||'Không thể xử lý tệp.');}finally{lock.current=false;if(current===epoch.current){setBusy(false);setStage('');}}
    }
    async function upload(current){
      if(!context||!file||readOnly||block.allowUpload===false)throw new Error('Chọn hồ sơ và tệp trước khi tải lên.');
      if(!file.size||file.size>1048576)throw new Error('Tệp phải có nội dung và không quá 1 MiB.');
      setStage('reading');setProgress(0);
      const contentBase64=await new Promise((resolve,reject)=>{const currentReader=new FileReader();reader.current=currentReader;currentReader.onprogress=e=>{if(current===epoch.current&&e.lengthComputable)setProgress(Math.round(e.loaded/e.total*100));};currentReader.onload=()=>resolve(String(currentReader.result).split(',')[1]);currentReader.onerror=()=>reject(new Error('Không đọc được tệp.'));currentReader.onabort=()=>reject(new Error('Đã dừng đọc tệp.'));currentReader.readAsDataURL(file);});
      if(current!==epoch.current)return;setStage('uploading');
      const result=fileMetadata(await api.file('upload',{filename:file.name,contentBase64,...(context.resource==='records'?{recordId:context.recordId}:{})}));
      if(current!==epoch.current)return;remember(result);setFile(null);setLookup(result.id);setNotice(context.resource==='workflows'?'Tệp đã tải lên. Chỉ được gắn vào quy trình khi bạn xác nhận bước xử lý.':'Tệp đã tải lên và liên kết với hồ sơ.');if(result.scanStatus==='clean')onUploaded?.(result);
    }
    async function inspect(current){
      const id=lookup.trim();
      try{const result=fileMetadata(await api.file('metadata',{id}),id);if(current===epoch.current)remember(result);}
      catch(e){if(current===epoch.current){setFiles(old=>old.map(value=>value.id===id?{id,unavailable:true}:value));setPreview(null);}throw e;}
    }
    async function content(item,current,download){
      try{
        const result=fileMetadata(await api.file('content',{id:item.id}),item.id);const bytes=fileBytes(result);if(current!==epoch.current)return;
        if(download){const url=URL.createObjectURL(new Blob([bytes],{type:'application/octet-stream'}));const link=document.createElement('a');link.href=url;link.download=result.filename;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);setNotice('Đã gửi tệp tới trình tải xuống.');}
        else setPreview({id:item.id,name:result.filename,text:new TextDecoder().decode(bytes.slice(0,65536)),truncated:bytes.length>65536});
      }catch(e){if(current===epoch.current){setFiles(old=>old.map(value=>value.id===item.id?{id:item.id,unavailable:true}:value));setPreview(null);}throw e;}
    }
    const visible=context&&connected&&context.id===key&&context._actorId===actorId&&(!run||context.run?.version===run.version);
    return h('section',{style,'data-block-id':block.id,'data-testid':'lattice-attachment','aria-label':block.title},h('h3',null,block.title),
      !connected&&h('p',null,'Kết nối tài khoản nghiệp vụ để xem tệp.'),connected&&!loading&&!context&&!error&&h('p',null,'Chọn một hồ sơ để xem và tải tệp.'),
      loading&&h('p',{role:'status'},'Đang tải thông tin tệp…'),error&&h('p',{role:'alert'},error),notice&&h('p',{role:'status'},notice),
      visible&&h('div',null,h('button',{style:button,type:'button',disabled:busy||!connected,onClick:()=>setReload(n=>n+1)},'Tải lại tệp'),
        block.allowUpload!==false&&h('div',null,h('label',null,'Chọn tệp đính kèm ',h('input',{'aria-label':'Chọn tệp đính kèm',type:'file',disabled:busy||!connected||readOnly,onChange:e=>{setFile(e.target.files?.[0]||null);setError('');}})),h('small',{style:{display:'block'}},'Tối đa 1 MiB. Tệp chưa quét sạch không được xem hoặc tải xuống.'),
          h('button',{style:button,type:'button',disabled:busy||!file||!connected||readOnly,onClick:()=>perform(upload)},'Tải tệp đính kèm lên')),
        busy&&h('div',{role:'status'},stage==='reading'?'Đang đọc tệp…':stage==='uploading'?'Đang tải lên và kiểm tra tệp…':'Đang xử lý tệp…',h('progress',{max:100,...(stage==='reading'?{value:progress}:{})})),
        h('details',null,h('summary',null,'Kiểm tra tệp bằng ID'),h('label',null,'ID tệp ',h('input',{'aria-label':'ID tệp đính kèm',value:lookup,disabled:busy||!connected,onChange:e=>setLookup(e.target.value)})),h('button',{style:button,type:'button',disabled:busy||!lookup.trim()||!connected,onClick:()=>perform(inspect)},'Kiểm tra tệp đính kèm')),
        !loading&&!files.length&&h('p',null,context.resource==='records'?'Chưa tải tệp trong phiên này. Dùng ID để kiểm tra tệp đã có.':'Không có tệp trong các trường đã cấu hình.'),
        h('ul',{style:{paddingLeft:20}},...files.map(item=>h('li',{key:item.id,style:{margin:'12px 0'}},item.unavailable?h('p',{role:'alert'},'Không truy cập được tệp '+item.id+'. Tệp có thể đã bị thu hồi quyền.'):h('div',null,h('strong',null,item.filename),h('p',null,`${item.size} byte · ${scans[item.scanStatus]}`),h('small',null,'ID: '+item.id),
          item.scanStatus!=='clean'&&h('p',null,'Tệp đang bị giữ lại; chỉ sử dụng khi kết quả quét là sạch.'),
          h('div',null,onUploaded&&!readOnly&&item.scanStatus==='clean'&&h('button',{style:button,type:'button',disabled:busy||!connected,onClick:()=>onUploaded(item)},'Chọn tệp này'),h('button',{style:button,type:'button',disabled:busy||!connected||item.scanStatus!=='clean'||! /\.(txt|md|csv|json|log)$/i.test(item.filename),onClick:()=>perform(current=>content(item,current,false))},'Xem văn bản'),h('button',{style:button,type:'button',disabled:busy||!connected||item.scanStatus!=='clean',onClick:()=>perform(current=>content(item,current,true))},'Tải xuống')))))),
        preview&&h('div',{'data-testid':'attachment-preview'},h('h4',null,preview.name),h('pre',{style:{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:320,overflow:'auto'}},preview.text),preview.truncated&&h('p',null,'Chỉ hiển thị 64 KiB đầu của tệp.'),h('button',{style:button,onClick:()=>setPreview(null)},'Đóng xem trước'))));
  }
  function ActivityTimelineBlock({manifest,block,api,connected,selectedId,run,actorId,actorName,canReadDirectory=false,refreshKey}){
    const [items,setItems]=React.useState([]),[people,setPeople]=React.useState([]),[loading,setLoading]=React.useState(false),[error,setError]=React.useState(''),[page,setPage]=React.useState(0),[reload,setReload]=React.useState(0);
    const [loadedFor,setLoadedFor]=React.useState('');
    const key=selectedId||block.runId,size=block.pageSize||10;
    const scope=JSON.stringify([actorId,key]);const visibleItems=connected&&loadedFor===scope?items:[];
    React.useEffect(()=>{let active=true;setItems([]);setError('');setPage(0);if(!connected||!key){setLoading(false);return()=>{active=false};}setLoading(true);
      evidenceContext({api,manifest,block,selectedId,run}).then(context=>api.workflow('history',{id:context.id})).then(result=>{const rows=timelineItems(result);if(active){setItems(rows);setLoadedFor(scope);}}).catch(e=>{if(active)setError(e.message)}).finally(()=>{if(active)setLoading(false)});return()=>{active=false};
    },[api,manifest,block,key,run,connected,actorId,refreshKey,reload]);
    React.useEffect(()=>{let active=true;setPeople([]);if(connected&&canReadDirectory&&api.directoryPeople)api.directoryPeople().then(result=>{if(active&&Array.isArray(result.items))setPeople(result.items)}).catch(()=>{});return()=>{active=false};},[api,connected,actorId,canReadDirectory]);
    return h('section',{style,'data-block-id':block.id,'data-testid':'lattice-timeline','aria-label':block.title},h('h3',null,block.title),!connected&&h('p',null,'Kết nối tài khoản nghiệp vụ để xem lịch sử.'),connected&&!key&&h('p',null,'Chọn một hồ sơ để xem lịch sử.'),
      connected&&key&&h('button',{style:button,disabled:loading,onClick:()=>setReload(n=>n+1)},'Tải lại lịch sử'),loading&&h('p',{role:'status'},'Đang tải lịch sử…'),error&&h('p',{role:'alert'},error),
      connected&&key&&!loading&&!error&&!visibleItems.length&&h('p',null,'Chưa có sự kiện lịch sử.'),
      h('ol',{style:{paddingLeft:22}},...visibleItems.slice(page*size,(page+1)*size).map(item=>h('li',{key:item.id,style:{padding:'8px 0 14px',borderBottom:'1px solid #edf1f6'}},h('strong',null,block.actionLabels?.[item.action]||item.action),h('p',null,`${item.fromState===null?'Khởi tạo':block.stateLabels?.[item.fromState]||item.fromState} → ${block.stateLabels?.[item.toState]||item.toState} · v${item.version}`),h('p',null,'Người thao tác: ',people.find(p=>p.subject===item.actorId)?.displayName||(item.actorId===actorId?actorName:null)||h('span',{title:item.actorId},'ID '+item.actorId.slice(0,8))),h('time',{dateTime:item.occurredAt},new Date(item.occurredAt).toLocaleString('vi-VN')),eventReason(item)!==null&&h('p',null,'Lý do: '+eventReason(item))))),
      visibleItems.length>=100&&h('p',null,'API trả tối đa 100 sự kiện. Danh sách này có thể chưa bao gồm toàn bộ lịch sử.'),
      visibleItems.length>0&&h('nav',{'aria-label':'Phân trang lịch sử'},h('button',{style:button,disabled:page===0||loading,onClick:()=>setPage(n=>n-1)},'Trước'),h('span',null,`Trang ${page+1} · ${visibleItems.length} sự kiện đã tải`),h('button',{style:button,disabled:(page+1)*size>=visibleItems.length||loading,onClick:()=>setPage(n=>n+1)},'Sau')));
  }
  return {AttachmentBlock,ActivityTimelineBlock};
}
module.exports={createEvidenceComponents};
