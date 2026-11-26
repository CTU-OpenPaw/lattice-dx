/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {workspacePages, workspaceFailure, createNativeWorkspace, WORKSPACE_PATH} = require('../src/client/native-workspace');

test('native workspace lists only host-provided visible pages and safe native paths', () => {
  const routes = [
    {type:'group', title:'Nghiệp vụ', children:[
      {id:1,type:'flowPage',schemaUid:'requests_1',title:'Yêu cầu'},
      {id:2,type:'page',schemaUid:'hidden',title:'Ẩn',hidden:true},
      {id:3,type:'link',schemaUid:'external',title:'Link'},
      {id:4,type:'page',schemaUid:'../settings',title:'Sai'},
    ]},
    {type:'group',hidden:true,children:[{type:'page',schemaUid:'secret',title:'Bí mật'}]},
  ];
  assert.deepEqual(workspacePages(routes),[{id:1,title:'Yêu cầu',path:'/admin/requests_1',section:undefined}]);
  assert.deepEqual(workspacePages(undefined),[]);
});

function workspaceHarness({search='?view=apps', refresh=async()=>{}, service={}, allAccessRoutes, permissions, requestHandler}={}) {
  let cursor=0;
  const state=[], effects=[], routes=new Map(), navigations=[];
  const React={Fragment:'Fragment', createElement:(type,props,...children)=>({type,props:props||{},children}),
    useState(initial) {
      const index=cursor++;
      if (!(index in state)) state[index]=initial;
      return [state[index],value=>{state[index]=typeof value==='function'?value(state[index]):value;}];
    },
    useRef(initial) {const index=cursor++; return state[index]??(state[index]={current:initial});},
    useEffect(effect,deps) {
      const index=cursor++, previous=state[index];
      if (!previous || deps.some((value,index)=>value!==previous.deps[index])) {
        state[index]={deps};effects.push(effect);
      }
    },
  };
  const api={auth:{role:'ldx_employee'},request:async(req)=>requestHandler?requestHandler(req):({data:{data:permissions}})};
  const client={SchemaComponent:'NativeSchema', PagePopups:'NativePopups', useAPIClient:()=>api,
    useListBlockContext:()=>({service}),
    useAllAccessDesktopRoutes:()=>({refresh,allAccessRoutes:allAccessRoutes ?? [{type:'flowPage',schemaUid:'demo',title:'Trang demo'}]}),
  };
  const router={Link:'Link',Outlet:'Outlet',useLocation:()=>({pathname:WORKSPACE_PATH,search}),
    useNavigate:()=>path=>navigations.push(path)};
  const antd=Object.fromEntries(['Button','Input','Alert','Empty','Tabs','ConfigProvider'].map(name=>[name,name]));
  createNativeWorkspace(client,React,antd,{router:{add:(name,route)=>routes.set(name,route)}},router);
  return {navigations,render(){
    cursor=0;const ui=routes.get('admin.lattice-workspace').Component();
    while(effects.length) effects.shift()();
    return ui;
  }};
}

test('an application exposes a configured create link only with route and collection permission', async () => {
  const form={type:'flowPage',schemaUid:'request_form',title:'Form yêu cầu'};
  const group={id:17,type:'group',title:'Yêu cầu nội bộ',options:{workspace:{quickCreate:{
    pageUid:form.schemaUid,collection:'requests',label:'Tạo yêu cầu',
  }}},children:[{type:'page',schemaUid:'list',title:'Danh sách'},form]};
  const readOnly={actions:{'requests:view':{}}};
  const writer={actions:{...readOnly.actions,'requests:create':{}}};
  for (const [route,permissions,expected] of [
    [group,writer,true], [group,readOnly,false], [{...group,children:group.children.slice(0,1)},writer,false],
  ]) {
    const setup=workspaceHarness({allAccessRoutes:[route],permissions});
    setup.render();
    await Promise.resolve();
    const ui=setup.render();
    assert.ok(find(ui,node=>node.type==='Link'&&node.props.to===WORKSPACE_PATH+'?view=apps&app=17'));
    assert.equal(Boolean(find(ui,node=>node.type==='Link'&&node.props.to==='/admin/request_form')),expected);
  }
});

function find(node,predicate) {
  if (!node || typeof node!=='object') return null;
  if (predicate(node)) return node;
  if (typeof node.type==='function') return find(node.type(node.props),predicate);
  return node.children?.flat(Infinity).map(child=>find(child,predicate)).find(Boolean)||null;
}

test('catalog refresh prevents duplicate reads, hides stale links on failure and recovers on retry',async()=>{
  let calls=0,reject;
  const setup=workspaceHarness({refresh:()=>++calls===1?new Promise((resolve,fail)=>{reject=fail;}):Promise.resolve()});
  const update=find(setup.render(),node=>node.type==='Button'&&node.children[0]==='Cập nhật danh sách');
  const first=update.props.onClick();
  await update.props.onClick();
  assert.equal(calls,1);
  const loading=setup.render();
  assert.equal(find(loading,node=>node.type==='Button'&&node.children[0]==='Cập nhật danh sách').props.disabled,true);
  assert.equal(find(loading,node=>node.type==='Link'&&node.props.to==='/admin/demo'),null);
  reject({response:{status:503},message:'private diagnostics'});
  await first;
  const failed=setup.render(),alert=find(failed,node=>node.type==='Alert');
  assert.ok(alert);
  assert.equal(find(failed,node=>node.type==='Empty'),null,'An unavailable catalog is not an empty catalog');
  assert.equal(find(failed,node=>node.type==='Link'&&node.props.to==='/admin/demo'),null);
  assert.doesNotMatch(JSON.stringify(alert),/private diagnostics/);
  await alert.props.action.props.onClick();
  const recovered=setup.render();
  assert.ok(find(recovered,node=>node.type==='Link'&&node.props.to==='/admin/demo'));
  assert.ok(find(recovered,node=>node.props.role==='status'&&String(node.children[0]).includes('Đã cập nhật')));
});

test('expired catalog session offers native sign-in instead of claiming missing permissions',async()=>{
  const setup=workspaceHarness({refresh:async()=>{throw {response:{status:401}};}});
  await find(setup.render(),node=>node.type==='Button'&&node.children[0]==='Cập nhật danh sách').props.onClick();
  const alert=find(setup.render(),node=>node.type==='Alert');
  assert.equal(alert.props.action.type,'Link');
  assert.equal(alert.props.action.props.to,'/signin?redirect='+encodeURIComponent(WORKSPACE_PATH));
  assert.equal(workspaceFailure({status:403}).signIn,undefined);
  assert.match(workspaceFailure({status:403}).message,/không có quyền/);
});

test('clearing an empty report search stays in the reports catalog',async()=>{
  const setup=workspaceHarness({search:'?view=reports&q=absent'});
  setup.render();await Promise.resolve();
  const empty=find(setup.render(),node=>node.type==='Empty');
  assert.equal(empty.props.description,'Không tìm thấy trang phù hợp.');
  find(empty,node=>node.type==='Button').props.onClick();
  assert.equal(setup.navigations.at(-1),WORKSPACE_PATH+'?view=reports');
});

test('native task read errors hide stale content, expose retry and retain the native renderer on recovery',async()=>{
  let retries=0;
  const service={error:{response:{status:500}},refreshAsync:async()=>{retries++;service.error=undefined;}};
  const setup=workspaceHarness({search:'',service});
  const taskSchema=find(setup.render(),node=>node.type==='NativeSchema'&&node.props.components);
  const Tasks=taskSchema.props.components.WorkspaceNativeTasks;
  const failed=Tasks({view:'pending'});
  assert.equal(find(failed,node=>node.type==='NativeSchema'),null);
  await find(failed,node=>node.type==='Alert').props.action.props.onClick();
  assert.equal(retries,1);
  assert.ok(find(Tasks({view:'pending'}),node=>node.type==='NativeSchema'));
  const config=find(Tasks({view:'completed'}),node=>node.type==='ConfigProvider');
  assert.equal(config.props.renderEmpty().props.description,'Chưa có công việc đã xử lý.');
  service.loading=true;
  const loading=Tasks({view:'pending'});
  assert.equal(find(loading,node=>node.type==='ConfigProvider').props.renderEmpty(),null);
  assert.ok(find(loading,node=>node.props.role==='status'));
});

test('report classification uses explicit native metadata rather than page titles', () => {
  const routes=[
    {id:1,type:'flowPage',schemaUid:'report_title',title:'Báo cáo'},
    {type:'group',options:{workspace:{section:'reports'}},children:[
      {id:2,type:'flowPage',schemaUid:'summary',title:'Tổng quan'},
    ]},
  ];
  const reports=workspacePages(routes).filter(page=>page.section==='reports');
  assert.deepEqual(reports,[{id:2,title:'Tổng quan',path:'/admin/summary',section:'reports'}]);
});

// The native View action appends /popups/... to the landing route.
// Without a child outlet route it navigates to 404 instead of its native form.
test('workspace registers the host popup renderer beneath its landing route', () => {
  const routes = new Map();
  function PagePopups() {}
  const client = {useAPIClient() {}, useAllAccessDesktopRoutes() {}, SchemaComponent() {}, PagePopups};
  const router = {useLocation() {}, useNavigate() {}};
  const workspace = createNativeWorkspace(client, {createElement() {}}, {}, {
    router: {add(name, route) {routes.set(name, route);}},
  }, router);
  assert.equal(typeof workspace.Shell, 'function');
  assert.equal(routes.get('admin.lattice-workspace').path, WORKSPACE_PATH);
  assert.deepEqual(routes.get('admin.lattice-workspace.popups'), {
    path: WORKSPACE_PATH + '/popups/*', Component: PagePopups,
  });
  assert.equal(createNativeWorkspace({...client, PagePopups:null}, {}, {}, {}, router), null);
});

test('workspace merges latticePortals:listAccessible shortcuts when allAccessRoutes is empty', async () => {
  const requests = [];
  const portals = [
    { uid: 'admin-layout-model', title: 'Admin', routePath: '/admin', firstPagePath: '/admin', enabled: true },
    { uid: 'ldx-portal-procurement', title: 'Mua sắm', routePath: '/p/procurement', firstPagePath: '/p/procurement/requests', enabled: true },
    { uid: 'ldx-portal-logistics-employee', title: 'Logistics · Đơn của tôi', routePath: '/p/logistics-employee', firstPagePath: '/p/logistics-employee/orders', enabled: true },
  ];
  const setup = workspaceHarness({
    search: '',
    allAccessRoutes: [],
    requestHandler: async (req) => {
      requests.push(req);
      if (req.url === 'latticePortals:listAccessible') return { data: { data: portals } };
      if (req.url === 'dxosApprovals:listInbox') return { data: { data: { items: [] } } };
      return { data: { data: {} } };
    },
  });
  setup.render();
  await new Promise(resolve => setImmediate(resolve));
  const ui = setup.render();
  assert.ok(requests.some(r => r.url === 'latticePortals:listAccessible' && r.skipNotify === true));
  assert.ok(find(ui, node => node.type === 'Link' && node.props.to === '/p/procurement/requests'));
  assert.ok(find(ui, node => node.type === 'Link' && node.props.to === '/p/logistics-employee/orders'));
  assert.equal(find(ui, node => node.type === 'Empty' && node.props.description === 'Chưa có ứng dụng được cấp quyền.'), null);
});

test('workspace renders DX-OS Approval Inbox items, supports decide, and suppresses redundant empty tasks notice', async () => {
  const requests = [];
  let inboxItems = [
    {
      source: 'ai_hitl',
      itemKey: 'ai:41',
      id: 41,
      title: 'AI đề xuất hiệu chuẩn PT100',
      summary: 'Cập nhật hồ sơ REQ-2026-001',
      status: 'pending',
      canAct: true,
    },
    {
      source: 'proposals',
      itemKey: 'prop:12',
      id: 12,
      title: 'Đề xuất AI: latticeOrders #12',
      summary: 'Ưu tiên xuất kho FEFO lô sắp hết hạn',
      status: 'pending',
      canAct: true,
    },
  ];
  const setup = workspaceHarness({
    search: '',
    allAccessRoutes: [],
    requestHandler: async (req) => {
      requests.push(req);
      if (req.url === 'latticePortals:listAccessible') return { data: { data: [] } };
      if (req.url === 'dxosApprovals:listInbox') return { data: { data: { items: inboxItems } } };
      if (req.url === 'dxosApprovals:decide') {
        inboxItems = inboxItems.filter(i => i.itemKey !== req.data.itemKey);
        return { data: { data: { ok: true } } };
      }
      return { data: { data: {} } };
    },
  });
  setup.render();
  await new Promise(resolve => setImmediate(resolve));
  const ui = setup.render();
  const dump = JSON.stringify(ui);
  assert.ok(dump.includes('Phê duyệt & Đề xuất cần xử lý (DX-OS Inbox)'));
  assert.ok(dump.includes('AI đề xuất hiệu chuẩn PT100'));
  assert.ok(dump.includes('Đề xuất AI: latticeOrders #12'));

  const taskSchema = find(ui, node => node.type === 'NativeSchema' && node.props.components);
  const Tasks = taskSchema.props.components.WorkspaceNativeTasks;
  const todoProps = taskSchema.props.schema.properties.pending.properties.todos['x-component-props'];
  assert.equal(todoProps.suppressEmpty, true);
  const tasksUi = Tasks(todoProps);
  const cfg = find(tasksUi, node => node.type === 'ConfigProvider');
  assert.equal(cfg.props.renderEmpty(), null);

  const approveBtn = find(ui, node => node.type === 'Button' && node.props['data-testid'] === 'ldx-inbox-approve-ai:41');
  assert.ok(approveBtn, 'Expected approve button for ai:41');
  await approveBtn.props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(requests.some(r => r.url === 'dxosApprovals:decide' && r.data.itemKey === 'ai:41' && r.data.decision === 'approve'));
});
