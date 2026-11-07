// SPDX-License-Identifier: Apache-2.0
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {workspacePages, createNativeWorkspace, WORKSPACE_PATH} = require('../src/client/native-workspace');

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
