// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const [reportPath] = process.argv.slice(2);
assert(reportPath, 'Usage: node scripts/setup-native-workspace-demo.mjs <clean-install report.json>');
const report = JSON.parse(await readFile(reportPath, 'utf8'));
assert(report.format === 'latticedx.native-clean-install' && report.complete === true &&
  /^lattice-native-clean-[a-f0-9]{12}$/.test(report.project), 'A completed clean-install report is required');
const origin = new URL(report.origin);
assert(/^http:\/\/localhost:13\d{3}$/.test(origin.origin) && Number(origin.port) >= 13004 &&
  origin.href === origin.origin + '/', 'Expected a local clean-install origin');

let token;
async function api(path, values) {
  const response = await fetch(new URL('/api/' + path, origin), {
    method: values === undefined ? 'GET' : 'POST',
    headers: {'Content-Type':'application/json', ...(token ? {Authorization:'Bearer ' + token, 'X-Role':'root'} : {})},
    body: values === undefined ? undefined : JSON.stringify(values),
    signal: AbortSignal.timeout(20000),
  });
  assert(response.ok, path.split('?')[0] + ' returned HTTP ' + response.status);
  return (await response.json()).data;
}

token = (await api('auth:signIn', {email:'admin@nocobase.com', password:'admin123'})).token;
const title = 'Yêu cầu nội bộ';
const formTitle = 'Tạo yêu cầu';
const collection = 'latticeRequests';
const listRoutes = () => api('desktopRoutes:list?paginate=false');
let routes = await listRoutes();
assert(routes.some(route => report.pageUrl === origin.origin + '/admin/' + route.schemaUid &&
  route.title === 'Native UI Lab'), 'The running lab does not match the clean-install report');
const existingGroups = routes.filter(route => route.type === 'group' && route.title === title);
assert(existingGroups.length <= 1, 'More than one application has the demo title');
const marker = 'native-workspace-demo-v1';
let group = existingGroups[0];
if (!group) {
  const page = await api('flowSurfaces:applyBlueprint', {
    version:'1', mode:'create',
    navigation:{group:{title, icon:'AppstoreOutlined'}, item:{title:formTitle, icon:'FileTextOutlined'}},
    page:{title:formTitle, displayTitle:true, enableTabs:false},
    tabs:[{title:formTitle, blocks:[{
      key:'request-form', type:'createForm', collection, fields:['code','name','description'], actions:['submit'],
    }]}],
  });
  routes = await listRoutes();
  const created = routes.find(route => route.type === 'flowPage' && route.schemaUid === page.target.pageSchemaUid);
  group = routes.find(route => route.type === 'group' && route.title === title && route.id === created?.parentId);
  assert(group, 'The native designer did not create the expected application');
  await api('desktopRoutes:update?filterByTk=' + group.id, {options:{
    ...group.options, workspace:{...group.options?.workspace, fixture:marker,
      quickCreate:{pageUid:created.schemaUid, label:formTitle, collection}},
  }});
  routes = await listRoutes();
  group = routes.find(route => route.id === group.id);
}

const settings = group?.options?.workspace;
assert(settings?.fixture === marker, 'An existing application uses the demo title. Its configuration was preserved.');
const page = routes.find(route => route.parentId === group.id && route.type === 'flowPage' &&
  route.schemaUid === settings.quickCreate?.pageUid);
assert(page && settings.quickCreate.collection === collection && settings.quickCreate.label === formTitle,
  'The configured demo form has changed');
const tabs = routes.filter(route => route.parentId === page.id && route.type === 'tabs');
assert(tabs.length === 1, 'Expected one native form tab');
for (const role of ['ldx_employee','ldx_manager','ldx_warehouse']) {
  await api('roles/' + role + '/desktopRoutes:add', {tk:[group.id, page.id, tabs[0].id]});
}

console.log(JSON.stringify({result:'PASS', sourceCommit:report.sourceCommit,
  workspaceUrl:origin.origin + '/admin/lattice-workspace?view=apps', formUrl:origin.origin + '/admin/' + page.schemaUid}));
