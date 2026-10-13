// SPDX-License-Identifier: Apache-2.0
const {createWorkspaceApi} = require('./workspace-api');
const {createWorkflowComponent} = require('./workflow');
function createWorkspaceComponent(client, React, blocks) {
  const h = React.createElement;
  const ProcurementWorkflow=createWorkflowComponent(React);
  const buttonStyle = {padding:'10px 16px',border:'1px solid #cad5e2',borderRadius:8,background:'#fff',cursor:'pointer'};
  function Workspace() {
    const apiClient = client.useAPIClient();
    const [apps,setApps] = React.useState([]), [user,setUser] = React.useState(null);
    const [connection,setConnection] = React.useState({connected:false});
    const [loading,setLoading] = React.useState(true), [busy,setBusy] = React.useState(false);
    const [expired,setExpired] = React.useState(false), [notice,setNotice] = React.useState(null);
    const [loadFailed,setLoadFailed] = React.useState(false);
    const [refreshKey,setRefreshKey] = React.useState(0);
    const mounted = React.useRef(true), operating = React.useRef(false);
    const api = React.useMemo(() => createWorkspaceApi({apiClient,
      notify: value => {if (mounted.current) setNotice(value);},
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
          if (!canceled) {setUser(currentUser);setApps(applications);setConnection(status);setLoadFailed(false);}
        } catch {if (!canceled) setLoadFailed(true);}
        finally {if (!canceled) setLoading(false);}
      }
      load();
      const timer = setInterval(async () => {
        if (operating.current) return;
        try {
          await api.user();
          const status = await api.connection();
          if (!canceled) setConnection(status);
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
    async function act(operation) {
      if (operating.current) return;
      operating.current=true;setBusy(true);setNotice(null);
      try {await operation();}
      catch (error) {if (mounted.current) setNotice({type:'error',message:error.message || 'Thao tác thất bại.'});}
      finally {operating.current=false;if (mounted.current) setBusy(false);}
    }
    const appId = window.location.pathname.startsWith('/lattice/apps/') ? window.location.pathname.slice('/lattice/apps/'.length) : null;
    const selected = apps.find(app=>app.id===appId);
    const loginLink = '/signin?redirect='+encodeURIComponent(window.location.pathname);
    const controls = [];
    if (expired) controls.push(h('a',{key:'login',href:loginLink,style:buttonStyle},'Đăng nhập lại'));
    else {
      controls.push(h('button',{key:'connect',style:buttonStyle,disabled:busy||loading,onClick:()=>act(async()=>{
        if (connection.connected) {await api.disconnect();setConnection({connected:false});}
        else {const url=await api.connect();sessionStorage.setItem('lattice:return-to',window.location.pathname);window.location.assign(url);}
      })},connection.connected?'Ngắt kết nối API':'Kết nối tài khoản nghiệp vụ'));
      controls.push(h('button',{key:'logout',style:buttonStyle,disabled:busy||loading,onClick:()=>act(async()=>{
        await api.signOut();window.location.assign(loginLink);
      })},'Đăng xuất'));
    }
    return h('main',{style:{fontFamily:'system-ui,sans-serif',background:'#f3f6fa',minHeight:'100vh',padding:32,color:'#19324d'}},
      h('div',{style:{maxWidth:1050,margin:'0 auto'}},
        h('header',{style:{display:'flex',justifyContent:'space-between',alignItems:'center',gap:16,flexWrap:'wrap'}},
          h('div',null,h('h1',{style:{margin:'0 0 8px'}},'Lattice Workspace'),h('p',null,'Chọn ứng dụng để làm việc.')),
          h('nav',{style:{display:'flex',gap:10}},h('a',{href:'/admin',style:buttonStyle},'Quản trị NocoBase'),...controls)),
        h('section',{style:{background:'#fff',padding:20,borderRadius:12,margin:'16px 0'}},
          h('p',null,expired?'Phiên NocoBase đã hết hạn.':user?`Đã đăng nhập: ${user.nickname||user.username||user.email}`:'Đang kiểm tra đăng nhập…'),
          h('p',{'data-testid':'api-status'},connection.connected?`API doanh nghiệp: Đã kết nối — ${connection.identity?.username||''}`:'API doanh nghiệp: Chưa kết nối'),
          h('small',null,'Đăng nhập NocoBase và kết nối tài khoản nghiệp vụ là hai phiên riêng.')),
        notice&&h('div',{role:notice.type==='error'?'alert':'status',style:{padding:14,borderRadius:8,background:notice.type==='error'?'#fff0f0':'#eaf8ef',marginBottom:16}},notice.message),
        (loading||busy)&&h('p',{role:'status'},'Đang xử lý…'),
        loadFailed&&!expired&&h('button',{style:buttonStyle,onClick:()=>window.location.reload()},'Tải lại Workspace'),
        !loading&&!expired&&!loadFailed&&(appId?(selected?h('section',{style:{background:'#fff',padding:24,borderRadius:12}},
          h('a',{href:'/lattice'},'← Chọn ứng dụng khác'),h('h2',null,selected.name),
          selected.id==='purchasing'&&h(ProcurementWorkflow,{api,connection}),
          ...selected.blocks.map(block=>h(block.type==='form'?blocks.FormBlock:blocks.ListBlock,{key:block.id,manifest:selected,block,api,connected:connection.connected,refreshKey,onSaved:()=>setRefreshKey(n=>n+1)})),
          ...(selected.id==='purchasing'?[h('p',{key:'legacy'},'Các form hồ sơ nền bên dưới không thay thế workflow mua sắm ở trên.')]:selected.transitions.map(t=>h('p',{key:t.id},'Chuyển trạng thái: Chưa khả dụng. '+t.reason))))
          :h('p',{role:'alert'},'Không tìm thấy ứng dụng. ',h('a',{href:'/lattice'},'Về Workspace')))
          :h('section',{'aria-label':'Ứng dụng',style:{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(260px,1fr))',gap:20}},
            ...apps.map(app=>h('article',{key:app.id,style:{padding:24,background:'#fff',borderRadius:12,border:'1px solid #e0e7ef'}},
              h('h2',null,app.name),h('p',null,`${app.blocks.length} thành phần đã cấu hình`),h('a',{href:app.route,style:buttonStyle},'Mở '+app.name)))))));
  }
  return Workspace;
}
module.exports = {createWorkspaceComponent};
