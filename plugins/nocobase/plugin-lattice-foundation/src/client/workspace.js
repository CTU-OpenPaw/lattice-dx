/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const {createWorkspaceApi} = require('./workspace-api');
const {css,createIcon}=require('./workspace-theme');
function createWorkspaceComponent(client, React, runtime) {
  const h = React.createElement;
  const Icon=createIcon(React);
  const buttonStyle = {padding:'10px 16px',border:'1px solid #cad5e2',borderRadius:8,background:'#fff',cursor:'pointer'};
  function Workspace() {
    const apiClient = client.useAPIClient();
    const [apps,setApps] = React.useState([]), [systems,setSystems] = React.useState([]), [user,setUser] = React.useState(null);
    const [connection,setConnection] = React.useState({connected:false});
    const [loading,setLoading] = React.useState(true), [busy,setBusy] = React.useState(false);
    const [expired,setExpired] = React.useState(false), [notice,setNotice] = React.useState(null);
    const [loadFailed,setLoadFailed] = React.useState(false);
    const [search,setSearch]=React.useState(''),[menuOpen,setMenuOpen]=React.useState(false),[helpOpen,setHelpOpen]=React.useState(false);
    const searchRef=React.useRef(null),helpClose=React.useRef(null);
    const mounted = React.useRef(true), operating = React.useRef(false);
    const api = React.useMemo(() => createWorkspaceApi({apiClient,
      notify: value => {if (mounted.current) setNotice(value?.message?value:null);},
      onExpired: source => {if (mounted.current) {if (source==='nocobase') setExpired(true); else setConnection({connected:false});}},
    }), [apiClient]);
    React.useEffect(() => {
      mounted.current = true;
      let canceled = false;
      async function load() {
        try {
          const currentUser = await api.user();
          const applications = await api.applications();
          const status = await api.connection();
          let publishedSystems = [];
          if (status?.connected) {
            try {
              publishedSystems = await api.systems();
            } catch {
              publishedSystems = [];
            }
          }
          if (!canceled) {
            setUser(currentUser);
            setApps(applications);
            setSystems(publishedSystems);
            setConnection(status);
            setLoadFailed(false);
          }
        } catch {if (!canceled) setLoadFailed(true);}
        finally {if (!canceled) setLoading(false);}
      }
      load();
      const timer = setInterval(async () => {
        if (operating.current) return;
        try {
          await api.user();
          const status = await api.connection();
          if (!canceled) {
            setConnection(status);
            if (status?.connected) {
              const sys = await api.systems();
              if (!canceled) setSystems(sys);
            } else if (!status?.connected) {
              setSystems([]);
            }
          }
        } catch { /* Error notification/session state is handled centrally. */ }
      }, 30000);
      return () => {canceled=true;mounted.current=false;clearInterval(timer);};
    }, [api]);
    React.useEffect(() => {
      if (!connection.connected || !connection.expiresAt) return;
      const timer = setTimeout(() => {
        setConnection({connected:false});
        setNotice({type:'error',message:'Kết nối tài khoản nghiệp vụ đã hết hạn. Hãy kết nối lại.'});
      }, Math.max(0,new Date(connection.expiresAt).getTime()-Date.now()));
      return () => clearTimeout(timer);
    }, [connection]);
    React.useEffect(()=>{const listener=event=>{if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='k'){event.preventDefault();searchRef.current?.focus();}if(event.key==='Escape'){setSearch('');setHelpOpen(false);setMenuOpen(false);}};window.addEventListener('keydown',listener);return()=>window.removeEventListener('keydown',listener);},[]);
    React.useEffect(()=>{if(!helpOpen)return;const previous=document.activeElement;helpClose.current?.focus();return()=>previous?.focus?.();},[helpOpen]);
    async function act(operation) {
      if (operating.current) return;
      operating.current=true;setBusy(true);setNotice(null);
      try {await operation();}
      catch (error) {if (mounted.current) setNotice({type:'error',message:error.message || 'Thao tác thất bại.'});}
      finally {operating.current=false;if (mounted.current) setBusy(false);}
    }
    const appId = window.location.pathname.startsWith('/lattice/apps/') ? window.location.pathname.slice('/lattice/apps/'.length) : null;
    const selected = apps.find(app=>app.id===appId);
    const showApps=!appId&&new URLSearchParams(window.location.search).get('view')==='apps';
    const home=apps.find(app=>app.workspace?.home===true);
    const businessApps=apps.filter(app=>app.workspace?.shortcut?.hidden!==true);
    const results=businessApps.filter(app=>app.name.toLocaleLowerCase('vi').includes(search.toLocaleLowerCase('vi')));
    const matchingSystems=systems.filter(sys=>(sys.title||sys.id).toLocaleLowerCase('vi').includes(search.toLocaleLowerCase('vi')));
    const isHome=!showApps&&(!appId||selected?.workspace?.home===true);
    const activeApp=isHome?home:selected;
    const actorName=connection.identity?.username||user?.nickname||user?.username||user?.email||'Tài khoản';
    React.useEffect(()=>{const target=(window.location.hash||'').slice(1);if(!activeApp||! /^[a-z][a-z0-9-]{0,63}$/.test(target))return;const timer=setTimeout(()=>{const block=document.querySelector('[data-block-id="'+target+'"]');block?.scrollIntoView({behavior:'smooth',block:'center'});},150);return()=>clearTimeout(timer);},[activeApp,loading]);
    const loginLink = '/signin?redirect='+encodeURIComponent(window.location.pathname);
    const controls = [];
    if (expired) controls.push(h('a',{key:'login',href:loginLink,style:buttonStyle},'Đăng nhập lại'));
    else {
      controls.push(h('button',{key:'connect',style:buttonStyle,disabled:busy||loading,onClick:()=>act(async()=>{
        if (connection.connected) {await api.disconnect();setConnection({connected:false});setSystems([]);}
        else {const url=await api.connect();sessionStorage.setItem('lattice:return-to',window.location.pathname);window.location.assign(url);}
      })},connection.connected?'Ngắt kết nối API':'Kết nối tài khoản nghiệp vụ'));
      controls.push(h('button',{key:'logout',style:buttonStyle,disabled:busy||loading,onClick:()=>act(async()=>{
        await api.signOut();window.location.assign(loginLink);
      })},'Đăng xuất'));
    }
    function cards(list){return h('div',{className:'lx-shortcuts'},...list.map(app=>{
      const shortcut=app.workspace?.shortcut||{};const create=app.blocks.find(block=>block.id===shortcut.createBlockId&&block.type==='form');
      return h('article',{key:app.id,className:'lx-app-card'},h('div',{className:'lx-card-heading'},h('span',{className:'lx-card-icon'},h(Icon,{name:shortcut.icon||'apps'})),h('h3',null,app.name)),shortcut.description&&h('p',null,shortcut.description),h('div',{className:'lx-card-actions'},create&&h('a',{className:'lx-button',href:app.route+'#'+create.id},h(Icon,{name:'plus',size:15}),shortcut.createLabel||'Tạo mới'),h('a',{className:'lx-button',href:app.route,'aria-label':'Mở '+app.name},'Mở')));
    }));}
    function systemCards(list){return h('div',{className:'lx-shortcuts','data-testid':'system-cards'},...list.map(sys=>
      h('article',{key:sys.id+sys.version,className:'lx-app-card'},
        h('div',{className:'lx-card-heading'},
          h('span',{className:'lx-card-icon'},h(Icon,{name:'settings'})),
          h('h3',null,sys.title||sys.id),
          h('span',{style:{fontSize:'12px',padding:'2px 6px',borderRadius:4,background:sys.enabled?'#dcfce7':'#fef3c7',color:sys.enabled?'#15803d':'#b45309',fontWeight:600,marginLeft:'auto'}},sys.enabled?'Đang hoạt động':'Tạm dừng')
        ),
        h('p',null,`Phiên bản ${sys.version}${sys.description?` · ${sys.description}`:''}`),
        h('div',{className:'lx-card-actions'},
          h('a',{className:'lx-button',href:`/lattice/systems/${sys.id}/${sys.version}`,'aria-label':'Truy cập hệ thống '+(sys.title||sys.id)},'Truy cập hệ thống')
        )
      )
    ));}
    return h('div',{className:'lx-workspace'},h('style',null,css),
      h('header',{className:'lx-top'},
        h('button',{className:'lx-button lx-mobile-menu','aria-label':'Mở điều hướng','aria-expanded':menuOpen,onClick:()=>setMenuOpen(value=>!value)},h(Icon,{name:'menu'})),
        h('a',{href:'/lattice',className:'lx-brand','aria-label':'Lattice Workspace'},h('span',{className:'lx-brand-mark','aria-hidden':true},'L'),h('strong',null,'LatticeDX'),h('span',{className:'lx-badge'},'Workspace')),
        h('div',{className:'lx-search'},h('label',null,h(Icon,{name:'search'}),h('span',{className:'lx-sr-only'},'Tìm ứng dụng'),h('input',{ref:searchRef,value:search,placeholder:'Tìm ứng dụng hoặc nhấn Ctrl+K',onChange:event=>setSearch(event.target.value),'aria-label':'Tìm ứng dụng','aria-controls':'lx-search-results','aria-expanded':!!search})),search&&h('div',{className:'lx-search-results',id:'lx-search-results'},(results.length||matchingSystems.length)?[...results.map(app=>h('a',{key:app.id,href:app.route},app.name)),...matchingSystems.map(sys=>h('a',{key:sys.id+sys.version,href:'/lattice/systems/'+sys.id+'/'+sys.version},'[Hệ thống] '+(sys.title||sys.id)+' (v'+sys.version+')'))]:h('p',{className:'lx-muted'},'Không tìm thấy ứng dụng hoặc hệ thống phù hợp.'))),
        h('div',{className:'lx-account'},h('span',{className:'lx-badge'},connection.connected?'Tài khoản doanh nghiệp':'Chưa kết nối'),h('button',{className:'lx-button',disabled:true,'aria-label':'Thông báo — sắp có',title:'Thông báo — sắp có'},h(Icon,{name:'bell'})),h('span',{className:'lx-avatar','aria-hidden':true},actorName.slice(0,1).toUpperCase()),h('span',{className:'lx-account-name'},actorName))),
      h('div',{className:'lx-shell'},h('aside',{className:'lx-sidebar'+(menuOpen?' lx-sidebar-open':'')},
        h('nav',{'aria-label':'Điều hướng Workspace'},
          h('a',{href:'/lattice',className:'lx-nav-item','aria-current':isHome?'page':undefined},h(Icon,{name:'inbox'}),'Công việc của tôi'),
          h('a',{href:'/lattice?view=apps',className:'lx-nav-item','aria-current':showApps||appId&&!isHome?'page':undefined},h(Icon,{name:'apps'}),'Ứng dụng'),
          h('a',{href:'/lattice/systems',className:'lx-nav-item'},h(Icon,{name:'settings'}),'Hệ thống doanh nghiệp'),
          h('button',{className:'lx-nav-item',disabled:true,title:'Báo cáo — sắp có'},h(Icon,{name:'report'}),'Báo cáo'),
          h('button',{className:'lx-nav-item',disabled:true},h(Icon,{name:'bot'}),'AI Assistant',h('span',{className:'lx-badge'},'Dự kiến'))
        ),
        h('div',{className:'lx-sidebar-footer'},h('a',{className:'lx-nav-item',href:'/lattice/console'},h(Icon,{name:'apps'}),'Điều hành doanh nghiệp'),h('button',{className:'lx-nav-item',onClick:()=>setHelpOpen(true)},h(Icon,{name:'help'}),'Trợ giúp'),h('button',{className:'lx-nav-item',disabled:true,title:'Cài đặt cá nhân — sắp có'},h(Icon,{name:'settings'}),'Cài đặt cá nhân'),h('a',{className:'lx-nav-item',href:'/admin'},h(Icon,{name:'settings'}),'Quản trị NocoBase'))),
      h('main',{className:'lx-main'},
        h('h1',null,showApps?'Ứng dụng':isHome?'Công việc của tôi':selected?.name||'Workspace'),
        h('section',{className:'lx-connection','data-connected':connection.connected===true,'aria-label':'Kết nối tài khoản'},h('span',{'data-testid':'api-status'},connection.connected?`API doanh nghiệp: Đã kết nối — ${connection.identity?.username||''}`:'API doanh nghiệp: Chưa kết nối'),h('small',null,expired?'Phiên đăng nhập đã hết hạn.':'Dùng tài khoản nghiệp vụ để xem công việc đúng quyền.'),h('div',{className:'lx-connection-actions'},...controls)),
        notice&&h('div',{className:'lx-notice',role:notice.type==='error'?'alert':'status'},notice.message),
        (loading||busy)&&h('p',{role:'status'},'Đang xử lý…'),
        loadFailed&&!expired&&h('button',{className:'lx-button',onClick:()=>window.location.reload()},'Tải lại Workspace'),
        !loading&&!expired&&!loadFailed&&h(React.Fragment,null,
          (isHome||showApps)&&h(React.Fragment,null,
            h('section',{'aria-label':showApps?'Ứng dụng':'Lối tắt ứng dụng'},h('div',{className:'lx-section-heading'},h('h2',null,showApps?'Tất cả ứng dụng':'Lối tắt ứng dụng'),!showApps&&h('a',{className:'lx-text-link',href:'/lattice?view=apps'},'Xem tất cả ứng dụng',h(Icon,{name:'arrow',size:17}))),cards(businessApps),!businessApps.length&&!systems.length&&h('p',{className:'lx-muted'},'Chưa có ứng dụng được cấu hình.')),
            systems.length>0&&h('section',{'aria-label':'Hệ thống doanh nghiệp',style:{marginTop:24}},h('div',{className:'lx-section-heading'},h('h2',null,'Hệ thống doanh nghiệp đã xuất bản'),h('a',{className:'lx-text-link',href:'/lattice/systems'},'Tất cả hệ thống',h(Icon,{name:'arrow',size:17}))),systemCards(systems))
          ),
          !showApps&&(activeApp?h('section',{className:isHome?'':'lx-panel'},!isHome&&h('a',{className:'lx-back',href:'/lattice?view=apps'},'← Chọn ứng dụng khác'),h(runtime.Application,{key:activeApp.id,manifest:activeApp,api,connection})):h('p',{role:'alert'},appId?'Không tìm thấy ứng dụng.':'Chưa cấu hình trang công việc.',h('a',{href:'/lattice?view=apps'},' Xem ứng dụng')))))),
      helpOpen&&h('div',{className:'lx-dialog-overlay'},h('section',{className:'lx-dialog',role:'dialog','aria-modal':true,'aria-labelledby':'lx-help-title',onKeyDown:event=>{if(event.key==='Tab'){event.preventDefault();helpClose.current?.focus();}}},h('h2',{id:'lx-help-title'},'Làm việc trong Workspace'),h('p',null,'Kết nối tài khoản nghiệp vụ để xem các công việc và hành động được cấp quyền. Chọn một công việc để xem chi tiết trước khi xử lý.'),h('p',null,'Nếu kết nối hết hạn, kết nối lại rồi tải lại danh sách. Khi kết quả thao tác chưa rõ, dùng “Thử lại lệnh cũ” thay vì tạo yêu cầu mới.'),h('p',null,'Nhấn Ctrl+K để tìm ứng dụng. Các mục “Dự kiến” sẽ được bổ sung sau.'),h('button',{className:'lx-button',ref:helpClose,onClick:()=>setHelpOpen(false)},'Đóng trợ giúp'))));
  }
  return Workspace;
}
module.exports = {createWorkspaceComponent};
