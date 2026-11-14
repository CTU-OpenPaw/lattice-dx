/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const {entityPageSchema,entityPageQuery,entityPageAttributes,entityPageCanWrite}=require('./entity-page-model');
function createEntityPage(React,{h,box,button,field,json,inputStyle}) {
  const {useState,useEffect,useRef}=React;
  return function EntityPage({session,page,schemas,enabled=true}) {
    const schema=entityPageSchema(page,schemas),read=!!session.capabilities['entities.read']?.available;
    const scope=JSON.stringify([page,session.connection?.identity?.subject,session.connection?.identity?.organizationId,session.connection?.connected,read,enabled]);
    const current=useRef(scope);current.current=scope;
    const [state,setState]=useState({}),[loading,setLoading]=useState(false);
    const data=state.scope===scope?state:{},entity=data.entity;
    const blocked=session.busy||session.commands.uncertain||loading;
    const put=(patch,token=scope)=>{if(current.current===token)setState(previous=>({...((previous.scope===token)?previous:{}),...patch,scope:token}));};
    const canWrite=action=>current.current===scope&&read&&!loading&&entityPageCanWrite(session,page,enabled,action)&&!entity?.archivedAt;
    async function load(offset=0) {
      if(!read)return;
      put({records:null});
      const result=await session.api.studio('queryEntities',{body:entityPageQuery(page,offset),key:'query-'+globalThis.crypto.randomUUID()});
      put({records:result,offset});
    }
    useEffect(()=>{
      let active=true;setState({scope});setLoading(false);
      if(read&&page.blocks.includes('list'))session.act(async()=>{
        const result=await session.api.studio('queryEntities',{body:entityPageQuery(page),key:'query-'+globalThis.crypto.randomUUID()});
        if(active)put({records:result,offset:0});
      });
      return()=>{active=false;};
    },[scope,session.api]);
    async function open(row) {
      if(current.current!==scope||!read)return;
      if(!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(row.id||''))throw Error('ID hồ sơ phải là UUID hợp lệ.');
      put({entity:null,values:{},title:'',history:null,relations:null});
      setLoading(true);
      try {
        const record=await session.api.entity('detail',{id:row.id});
        if(current.current!==scope)return;
        if(record.schemaId!==page.schemaId||record.schemaVersion!==page.schemaVersion)throw Error('Hồ sơ không thuộc phiên bản cấu trúc của trang.');
        put({entity:record,values:record.attributes,title:record.title});
        if(page.blocks.includes('history'))await history(record,0);
        if(page.blocks.includes('relations'))await relations(record,0);
      } finally {if(current.current===scope)setLoading(false);}
    }
    async function history(record=entity,offset=0) {
      put({history:null});
      const result=await session.api.studio('entityHistory',{id:record.id,query:{limit:'20',offset:String(offset)}});
      put({history:result,historyOffset:offset});
    }
    async function relations(record=entity,offset=0) {
      put({relations:null});
      const result=await session.api.entity('relations',{id:record.id,query:{limit:'20',offset:String(offset)}});
      put({relations:result,relationOffset:offset});
    }
    async function write(action,body) {
      if(!canWrite(action))throw Error('Thao tác hiện không được phép.');
      const operations={create:'entityCreate',update:'entityUpdate',archive:'entityArchive',link:'entityLink',unlink:'entityUnlink'};
      setLoading(true);
      try {
        const result=await session.commands.execute(operations[action],{...(action==='create'?{}:{id:entity.id}),body});
        if(current.current!==scope)return;
        // The command receipt is authoritative even if a later refresh fails.
        put({entity:result,values:result.attributes,title:result.title,history:null,relations:null});
        if(page.blocks.includes('list'))await load(data.offset||0);
        if(page.blocks.includes('history'))await history(result,0);
        if(page.blocks.includes('relations'))await relations(result,0);
      } finally {if(current.current===scope)setLoading(false);}
    }
    function inputs(values,change,disabled) {
      return h('fieldset',{disabled,style:{border:0,padding:0}},...page.fields.map(name=>{
        const definition=schema.fields[name],value=values[name];
        if(!definition)return h('p',{key:name,role:'alert'},'Trường không có trong cấu trúc: '+name);
        if(definition.type==='boolean'||definition.type==='enum')return h('label',{key:name,style:{display:'inline-flex',flexDirection:'column',margin:8}},name+(definition.required?' *':''),h('select',{
          style:inputStyle,'aria-label':name,value:value===undefined?'':String(value),onChange:event=>change(name,definition.type==='boolean'?(event.target.value===''?undefined:event.target.value==='true'):event.target.value)
        },h('option',{value:''},'Chưa chọn'),...(definition.type==='boolean'?[['true','Đúng'],['false','Sai']]:definition.choices.map(item=>[item,item])).map(([key,label])=>h('option',{key,value:key},label))));
        return h('span',{key:name},field(name,value??'',next=>change(name,next),definition.type==='date'?'date':definition.type==='integer'?'number':'text'));
      }));
    }
    function pager(result,offset,callback,label) {
      return h('div',null,button(label+' trước',()=>session.act(()=>callback(Math.max(0,(offset||0)-20))),blocked||!offset),button(label+' sau',()=>session.act(()=>callback(result.page.nextOffset)),blocked||!result?.page?.hasMore));
    }
    const change=(name,value)=>put({values:{...data.values,[name]:value}});
    const editor=(creating)=>h('div',null,
      field('Tiêu đề hồ sơ',data.title||'',value=>put({title:value})),
      inputs(data.values||{},change,blocked||!canWrite(creating?'create':'update')),
      page.actions.includes(creating?'create':'update')&&button(creating?'Tạo hồ sơ':'Lưu thay đổi',()=>session.act(()=>write(creating?'create':'update',creating?
        {schemaId:page.schemaId,schemaVersion:page.schemaVersion,title:data.title||'',attributes:entityPageAttributes(page,schema,data.values||{})}:
        {expectedVersion:entity.version,title:data.title||'',attributes:entityPageAttributes(page,schema,data.values||{},entity.attributes)})),blocked||!canWrite(creating?'create':'update')));
    const panels={
      create:h('div',null,button('Biểu mẫu mới',()=>put({entity:null,values:{},title:'',history:null,relations:null}),blocked),entity?h('p',{role:'status'},'Đã lưu hồ sơ: '+entity.title+' · '+entity.id+' · phiên bản '+entity.version):editor(true)),
      list:h('div',null,button('Tải lại hồ sơ',()=>session.act(()=>load()),blocked),h('table',null,
        h('thead',null,h('tr',null,h('th',null,'Hồ sơ'),...page.fields.map(name=>h('th',{key:name},name)))),
        h('tbody',null,...(data.records?.items||[]).map(row=>h('tr',{key:row.id},h('td',null,button(row.title,()=>session.act(()=>open(row)),blocked)),...page.fields.map(name=>h('td',{key:name},String(row.attributes?.[name]??''))))))),pager(data.records,data.offset,load,'Hồ sơ')),
      detail:entity?h('div',null,h('h3',null,entity.title),h('p',null,'Phiên bản hồ sơ '+entity.version+(entity.archivedAt?' · Đã lưu trữ':'')),
        h('dl',null,...page.fields.map(name=>h('div',{key:name},h('dt',null,name),h('dd',null,String(entity.attributes[name]??''))))),editor(false),
        page.actions.includes('archive')&&button('Lưu trữ hồ sơ',()=>session.act(()=>write('archive',{expectedVersion:entity.version})),blocked||!canWrite('archive'))):h('p',null,'Chọn hồ sơ để xem chi tiết.'),
      history:entity?h('div',null,button('Tải lại lịch sử',()=>session.act(()=>history()),blocked),data.history&&json(data.history),pager(data.history,data.historyOffset,next=>history(entity,next),'Lịch sử')):h('p',null,'Chọn hồ sơ để xem lịch sử.'),
      relations:entity?h('div',null,
        ...(data.relations?.items||[]).map(link=>h('div',{key:link.name+link.targetId},link.name+' · '+link.targetId,
          page.actions.includes('unlink')&&button('Gỡ liên kết',()=>session.act(()=>write('unlink',{expectedVersion:entity.version,name:link.name,targetId:link.targetId})),blocked||!canWrite('unlink')))),
        pager(data.relations,data.relationOffset,next=>relations(entity,next),'Liên kết'),
        page.actions.includes('link')&&h('fieldset',{disabled:blocked||!canWrite('link')},h('legend',null,'Liên kết hồ sơ'),
          h('select',{'aria-label':'Quan hệ',value:data.relationName||'',onChange:event=>put({relationName:event.target.value})},h('option',{value:''},'Chọn quan hệ'),...Object.keys(schema.relations||{}).map(name=>h('option',{key:name,value:name},name))),
          field('ID hồ sơ đích',data.targetId||'',value=>put({targetId:value})),button('Thêm liên kết',()=>session.act(()=>write('link',{expectedVersion:entity.version,name:data.relationName,targetId:data.targetId})),blocked||!canWrite('link')||!data.relationName||!data.targetId))):h('p',null,'Chọn hồ sơ để xem liên kết.'),
    };
    if(!read)return h('p',null,'Tài khoản không có quyền đọc dữ liệu.');
    return h('section',{'data-testid':'entity-page'},h('h2',null,page.title),
      !page.blocks.includes('list')&&page.blocks.some(id=>['detail','history','relations'].includes(id))&&h('section',{style:box},field('ID hồ sơ',data.lookupId||'',value=>put({lookupId:value})),button('Mở hồ sơ',()=>session.act(()=>open({id:data.lookupId})),blocked)),
      ...page.blocks.map(id=>h('section',{key:id,'data-entity-block':id,style:box},panels[id])));
  };
}
module.exports={createEntityPage};
