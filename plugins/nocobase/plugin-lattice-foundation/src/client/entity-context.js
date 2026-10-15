// SPDX-License-Identifier: Apache-2.0
const {evidenceContext}=require('./evidence');
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const version=n=>Number.isSafeInteger(n)&&n>0;
const date=s=>typeof s==='string'&&Number.isFinite(Date.parse(s));
async function loadEntityContext({api,manifest,block,selectedId,run}){
  const source=await evidenceContext({api,manifest,block,selectedId,run});
  if(!source)return null;
  if(source.resource!=='workflows')throw new Error('Context Entity cần nguồn quy trình.');
  if(!source.run.entityContext)return null;
  const link=await api.workflow('entityContext',{id:source.id});
  const {context,current}=link||{};
  if(!context||!current||!uuid.test(context.entityId)||current.id!==context.entityId||typeof context.schemaId!=='string'||current.schemaId!==context.schemaId||!version(context.schemaVersion)||!version(context.entityVersion)||!version(current.version)||!version(current.schemaVersion))throw new Error('Liên kết dữ liệu không hợp lệ.');
  if(['entityId','schemaId','schemaVersion','entityVersion'].some(key=>context[key]!==source.run.entityContext[key]))throw new Error('Liên kết không khớp quy trình đã chọn. Hãy tải lại chi tiết.');
  const entity=await api.entity('detail',{id:context.entityId});
  if(!entity||entity.id!==current.id||entity.schemaId!==current.schemaId||entity.schemaVersion!==current.schemaVersion||entity.version!==current.version||typeof entity.title!=='string'||!date(entity.updatedAt)||!(entity.archivedAt===null||date(entity.archivedAt))||!entity.attributes||typeof entity.attributes!=='object'||Array.isArray(entity.attributes))throw new Error('Dữ liệu đã đổi hoặc phản hồi không khớp liên kết. Hãy tải lại.');
  if(block.entitySchemaId&&entity.schemaId!==block.entitySchemaId)throw new Error('Dữ liệu không thuộc schema đã cấu hình.');
  const fields=(block.entityFields||[]).map(field=>{
    const value=Object.hasOwn(entity.attributes,field.name)?entity.attributes[field.name]:null;
    if(value!==null&&!['string','number','boolean'].includes(typeof value))throw new Error('Giá trị trường dữ liệu không hợp lệ.');
    return {title:field.title,value};
  });
  return {context,entity,fields};
}
function createEntityContextComponent(React){
  const h=React.createElement;
  return function ContextEntityBlock({manifest,block,api,connected,selectedId,run,actorId,refreshKey}){
    const [result,setResult]=React.useState(null),[loading,setLoading]=React.useState(false),[error,setError]=React.useState(''),[reload,setReload]=React.useState(0);
    const key=selectedId||block.runId,scope=JSON.stringify([actorId,key,run?.version,block]);
    React.useEffect(()=>{let active=true;setResult(null);setError('');
      if(!connected||!key){setLoading(false);return()=>{active=false};}setLoading(true);
      loadEntityContext({api,manifest,block,selectedId,run}).then(value=>{if(active)setResult({scope,value});}).catch(e=>{if(active)setError([403,404].includes(e.status||e.response?.status)?'Không có liên kết được phép xem. Quyền xem quy trình không tự cấp quyền xem dữ liệu.':e.message||'Không tải được dữ liệu liên kết.');}).finally(()=>{if(active)setLoading(false)});
      return()=>{active=false};
    },[api,manifest,block,key,run,connected,actorId,refreshKey,reload]);
    const data=connected&&result?.scope===scope?result.value:null;
    return h('section',{'data-testid':'lattice-context-entity','data-block-id':block.id,'aria-label':block.title,style:{padding:16,border:'1px solid #dce3ed',borderRadius:8,marginTop:16,background:'#fff',overflowWrap:'anywhere'}},h('h3',null,block.title),
      !connected&&h('p',null,'Kết nối tài khoản nghiệp vụ để xem dữ liệu liên kết.'),connected&&!key&&h('p',null,'Chọn công việc để xem dữ liệu liên kết.'),
      connected&&key&&h('button',{style:{padding:'7px 12px',border:'1px solid #cdd7e5',borderRadius:6,background:'#fff',color:'#172b4d'},type:'button',disabled:loading,onClick:()=>setReload(n=>n+1)},'Tải lại dữ liệu liên kết'),
      loading&&h('p',{role:'status'},'Đang tải dữ liệu liên kết…'),error&&h('p',{role:'alert'},error),connected&&key&&!loading&&!error&&result?.scope===scope&&!data&&h('p',null,'Công việc này chưa liên kết dữ liệu nghiệp vụ.'),
      data&&h('div',null,h('h4',null,data.entity.title),h('dl',{style:{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(180px,1fr))',gap:16}},
        ...[{title:'ID dữ liệu',value:data.entity.id},{title:'Schema',value:data.entity.schemaId},{title:'Phiên bản hiện tại',value:data.entity.version},{title:'Phiên bản khi tạo quy trình',value:data.context.entityVersion},{title:'Trạng thái lưu trữ',value:data.entity.archivedAt?'Đã lưu trữ':'Đang hoạt động'},...data.fields].map((field,i)=>h('div',{key:i},h('dt',{style:{color:'#5e6c84',fontSize:12,marginBottom:5}},field.title),h('dd',{style:{margin:0}},field.value===null?'Chưa có dữ liệu':String(field.value)))),
        h('div',null,h('dt',{style:{color:'#5e6c84',fontSize:12,marginBottom:5}},'Cập nhật dữ liệu lúc'),h('dd',{style:{margin:0}},h('time',{dateTime:data.entity.updatedAt},new Date(data.entity.updatedAt).toLocaleString('vi-VN'))))),
        (data.context.entityVersion!==data.entity.version||data.context.schemaVersion!==data.entity.schemaVersion)&&h('p',{role:'status'},'Dữ liệu hiện tại đã thay đổi từ lúc tạo quy trình. Liên kết gốc được giữ nguyên.'),
        h('p',null,'Nguồn: dữ liệu nghiệp vụ của LatticeDX. Chưa có trạng thái đồng bộ broker cho liên kết này.')));
  };
}
module.exports={loadEntityContext,createEntityContextComponent};
