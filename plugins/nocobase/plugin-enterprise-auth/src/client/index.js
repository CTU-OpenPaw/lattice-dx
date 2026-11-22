/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
(function(factory){
  if(typeof define==='function'&&define.amd)define('@latticedx/plugin-enterprise-auth',['@nocobase/client','react','antd','@nocobase/plugin-auth'],factory);
  else if(typeof module==='object'&&module.exports)module.exports=factory(require('@nocobase/client'),require('react'),require('antd'),require('@nocobase/plugin-auth/client'));
})(function(client,React,antd,authModule){
  'use strict';
  const h=React.createElement,TYPE='lattice-keycloak';
  function LoginButton({authenticator,returnTo='/admin'}){
    const failed=new URLSearchParams(window.location.search).get('enterpriseError')==='verification_failed';
    const button=h(antd.Button,{block:true,type:'primary',onClick:()=>window.location.assign('/api/enterpriseAuth:start?'+new URLSearchParams({authenticator:authenticator.name,returnTo}))},authenticator.title||'Đăng nhập doanh nghiệp');
    return failed?h(antd.Space,{direction:'vertical',style:{width:'100%'}},h(antd.Alert,{type:'error',message:'Không xác thực được tài khoản doanh nghiệp. Kiểm tra liên kết tài khoản hoặc thử lại.'}),button):button;
  }
  function EnterpriseLoginBlock({title='Đăng nhập doanh nghiệp'}={}){
    const api=client.useAPIClient();
    const [providers,setProviders]=React.useState(null),[selected,setSelected]=React.useState(),[error,setError]=React.useState(false);
    React.useEffect(()=>{let active=true;api.request({url:'authenticators:publicList',skipAuth:true}).then(r=>{if(active){const list=r.data.data.filter(x=>x.authType===TYPE);setProviders(list);setSelected(list[0]?.name);}}).catch(()=>{if(active)setError(true);});return()=>{active=false;};},[api]);
    if(error)return h(antd.Alert,{type:'error',message:'Không tải được phương thức đăng nhập.'});
    if(!providers)return h(antd.Spin);
    if(!providers.length)return h(antd.Alert,{type:'info',message:'Quản trị viên cần bật Enterprise login trong Authentication.'});
    return h(antd.Space,{direction:'vertical',style:{width:'100%'}},h(antd.Typography.Title,{level:5},title),h(antd.Typography.Text,null,'Sử dụng tài khoản doanh nghiệp để vào hệ thống.'),providers.length>1?h(antd.Select,{value:selected,onChange:setSelected,style:{width:'100%'},options:providers.map(p=>({value:p.name,label:p.title||p.name}))}):null,h(LoginButton,{authenticator:providers.find(p=>p.name===selected)||providers[0]}));
  }
  function EnterpriseLoginInitializer(){
    const item=client.useSchemaInitializerItem(),{insert}=client.useSchemaInitializer();
    return h(client.SchemaInitializerItem,{...item,onClick:()=>insert({type:'void','x-settings':'blockSettings:enterpriseLogin','x-decorator':'CardItem','x-component':'EnterpriseLoginBlock'})});
  }
  function Callback(){
    const api=client.useAPIClient(),[failed,setFailed]=React.useState(false);
    const once=React.useRef(false);
    React.useEffect(()=>{
      if(once.current)return;once.current=true;
      const ticket=new URLSearchParams(window.location.search).get('ticket');
      window.history.replaceState(null,'','/enterprise-login');
      api.request({url:'enterpriseAuth:finish',method:'post',data:{ticket},skipAuth:true,skipNotify:true}).then(r=>{
        const data=r.data.data;api.auth.setToken(data.token);api.auth.setAuthenticator(data.authenticator);api.auth.setRole(null);
        window.location.replace(data.returnTo);
      }).catch(()=>setFailed(true));
    },[api]);
    return h('div',{style:{maxWidth:440,margin:'100px auto'}},failed?h(antd.Result,{status:'error',title:'Không thể hoàn tất đăng nhập',subTitle:'Phiên xác thực đã hết hạn hoặc tài khoản chưa được liên kết.',extra:h(antd.Button,{href:'/signin'},'Về trang đăng nhập')}):h(antd.Spin,{tip:'Đang xác thực tài khoản doanh nghiệp...'},h('div',{style:{height:80}})));
  }
  function AdminSettings(){
    return h(antd.Alert,{type:'info',showIcon:true,message:'Kết nối Keycloak native',description:'Issuer, Client ID và callback do cấu hình triển khai quản lý. Liên kết subject với tài khoản có sẵn tại Enterprise identity mappings. Không tự tạo người dùng hoặc cấp quyền khi đăng nhập.'});
  }
  function MappingSettings(){
    const api=client.useAPIClient(),[form]=antd.Form.useForm(),[configuration,setConfiguration]=React.useState(),[mappings,setMappings]=React.useState([]),[status,setStatus]=React.useState();
    const loadMappings=React.useCallback(()=>api.request({url:'enterpriseAuth:listMappings',skipNotify:true}).then(r=>setMappings(r.data.data?.items||[])).catch(()=>{}),[api]);
    React.useEffect(()=>{
      api.request({url:'enterpriseAuth:configuration',skipNotify:true}).then(r=>setConfiguration(r.data.data)).catch(()=>setStatus({type:'error',message:'Chỉ quản trị viên root được cấu hình. Kiểm tra cấu hình triển khai.'}));
      loadMappings();
    },[api,loadMappings]);
    const handleUnlink=async(row)=>{
      try{
        await api.request({url:'enterpriseAuth:unlink',method:'post',data:{authenticator:row.authenticator,subject:row.subject,userId:row.userId},skipNotify:true});
        setStatus({type:'success',message:`Đã gỡ liên kết ${row.subject} khỏi user #${row.userId} và thu hồi phiên hiện tại.`});
        await loadMappings();
      }catch{
        setStatus({type:'error',message:'Không thể gỡ liên kết tài khoản.'});
      }
    };
    const info=configuration?h(antd.Descriptions,{column:1,items:Object.entries(configuration).map(([key,value])=>({key,label:key,children:value}))}):null;
    const mappingTable=h(antd.Table,{
      rowKey:r=>`${r.authenticator}:${r.subject}:${r.userId}`,
      size:'small',
      pagination:false,
      dataSource:mappings,
      locale:{emptyText:'Chưa có liên kết danh tính doanh nghiệp nào.'},
      columns:[
        {title:'Authenticator',dataIndex:'authenticator'},
        {title:'Subject (Keycloak)',dataIndex:'subject'},
        {title:'User ID',dataIndex:'userId'},
        {title:'Issuer',dataIndex:'issuer'},
        {title:'Thao tác',key:'action',render:(_v,row)=>h(antd.Button,{danger:true,size:'small',onClick:()=>handleUnlink(row)},'Gỡ liên kết')},
      ],
    });
    return h(antd.Space,{direction:'vertical',style:{padding:24,maxWidth:880,width:'100%'}},h(antd.Typography.Title,{level:4},'Enterprise identity mappings'),h(AdminSettings),info,status?h(antd.Alert,status):null,mappingTable,h(antd.Form,{form,layout:'vertical',onFinish:async values=>{try{await api.request({url:'enterpriseAuth:link',method:'post',data:values,skipNotify:true});setStatus({type:'success',message:'Đã liên kết tài khoản. Quyền và đơn vị giữ theo NocoBase.'});await loadMappings();}catch{setStatus({type:'error',message:'Không thể liên kết. Kiểm tra subject, user ID, nhân viên đang hoạt động hoặc mapping đã tồn tại.'});}}},...[
      ['authenticator','Tên authenticator','native-keycloak'],['subject','Keycloak user ID (subject)','UUID người dùng Keycloak'],['userId','NocoBase user ID','ID tài khoản đã có nhân viên']
    ].map(([name,label,placeholder])=>h(antd.Form.Item,{key:name,name,label,rules:[{required:true}]},h(antd.Input,{placeholder}))),h(antd.Button,{type:'primary',htmlType:'submit'},'Liên kết tài khoản')));
  }
  class EnterpriseLoginClient extends client.Plugin{
    async load(){
      const auth=this.app.pm.get(authModule.default||authModule.PluginAuthClient);
      if(!auth?.registerType)throw Error('Enterprise login requires the native Authentication plugin.');
      auth.registerType(TYPE,{components:{SignInButton:LoginButton,AdminSettingsForm:AdminSettings}});
      this.app.schemaSettingsManager.add(new client.SchemaSettings({name:'blockSettings:enterpriseLogin',items:[{name:'title',Component:client.SchemaSettingsBlockTitleItem},{name:'remove',type:'remove',componentProps:{removeParentsIfNoChildren:true,breakRemoveOn:{'x-component':'Grid'}}}]}));
      this.app.addComponents({EnterpriseLoginBlock,EnterpriseLoginInitializer});
      this.app.router.add('enterprise-login',{path:'/enterprise-login',Component:Callback,skipAuthCheck:true});
      this.app.pluginSettingsManager.add('auth.enterprise-mappings',{title:'Enterprise identity mappings',icon:'LinkOutlined',Component:MappingSettings,aclSnippet:'pm.auth.authenticators',sort:20});
      for(const name of ['page:addBlock','RecordBlockInitializers'])this.app.schemaInitializerManager.get(name)?.add('otherBlocks.enterpriseLogin',{type:'item',title:'Enterprise login',Component:EnterpriseLoginInitializer});
    }
  }
  return {__esModule:true,default:EnterpriseLoginClient};
});
