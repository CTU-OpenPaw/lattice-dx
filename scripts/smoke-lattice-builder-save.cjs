// SPDX-License-Identifier: Apache-2.0
// Creates an isolated hidden native page via authorized NocoBase APIs.
// Does not duplicate or edit any existing page.
const assert=require('node:assert/strict');const {randomBytes}=require('node:crypto');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{const base='http://localhost:13000';
const login=await fetch(base+'/api/auth:signIn',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'admin@nocobase.com',password:'admin123'})});assert.equal(login.status,200);const token=(await login.json()).data.token;
async function api(action,body){const response=await fetch(base+'/api/'+action,{method:body?'POST':'GET',headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});assert.ok(response.ok,action+' HTTP '+response.status);return (await response.json()).data;}
const originalSchema=JSON.stringify(await api('flowModels:findOne?uid=diox035kb4o&includeAsyncNode=true'));
const uid=()=> 'lt'+randomBytes(5).toString('hex');const root=process.env.LATTICE_NATIVE_TEST_ROOT||uid(),pageId=uid(),tab=uid(),grid=uid();
if(process.env.LATTICE_NATIVE_TEST_ROOT){assert.match(root,/^lt[0-9a-f]{10}$/);const routes=await api('desktopRoutes:list?paginate=false');assert.ok(routes.some(r=>r.schemaUid===root&&r.title==='Lattice Step6 Test '+root&&r.hideInMenu===true),'only reuse our isolated test page');}
else {
const route=await api('desktopRoutes:create',{title:'Lattice Step6 Test '+root,type:'flowPage',schemaUid:root,enableTabs:false,hideInMenu:true});
await api('desktopRoutes:create',{parentId:route.id,type:'tabs',schemaUid:tab,tabSchemaName:uid(),hidden:true});
await api('flowModels:save',{uid:root,schema:{use:'RouteModel'},subModels:{page:{uid:pageId,use:'RootPageModel',parentId:root,subKey:'page',subType:'object'}}});
await api('flowModels:save',{uid:tab,schema:{use:'RouteModel'},subModels:{grid:{uid:grid,use:'BlockGridModel',parentId:tab,subKey:'grid',subType:'object'}}});
}
console.log('Isolated native test page: /admin/'+root);
const browser=await chromium.launch({headless:true,channel:'msedge'});try{
const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.goto(base+'/signin?redirect='+encodeURIComponent('/admin/'+root));await page.locator('input[type=password]').waitFor();await page.locator('input:not([type=password])').first().fill('admin@nocobase.com');await page.locator('input[type=password]').fill('admin123');await page.getByRole('button',{name:/sign in/i}).click();await page.waitForURL('**/admin/'+root);
if(!await page.getByText('Add block',{exact:true}).isVisible())await page.getByTitle('UI Editor',{exact:true}).click();
if(!process.env.LATTICE_NATIVE_TEST_ROOT){await page.getByText('Add block',{exact:true}).click();await page.getByText('Lattice Form',{exact:true}).click();}
await page.keyboard.press('Escape');await page.getByText('Chưa chọn cấu hình.',{exact:false}).last().hover();
await page.locator('svg[data-icon="menu"]').last().hover();
await page.getByText('Chọn ứng dụng và block',{exact:true}).click();
await page.locator('.ant-modal .ant-select-selector').click();await page.getByText('Mua sắm nội bộ — Tạo hồ sơ yêu cầu mua sắm',{exact:true}).click();await page.getByRole('button',{name:'Save',exact:true}).click();
await page.locator('[data-block-id="create-request"]').waitFor();
await page.getByText('Add block',{exact:true}).click();await page.getByText('Lattice Danh sách',{exact:true}).click();await page.keyboard.press('Escape');await page.getByText('Chưa chọn cấu hình.',{exact:false}).last().hover();await page.locator('svg[data-icon="menu"]').last().hover();await page.getByText('Chọn ứng dụng và block',{exact:true}).click();
await page.locator('.ant-modal .ant-select-selector').click();await page.getByText('Mua sắm nội bộ — Hồ sơ của tôi',{exact:true}).click();await page.getByRole('button',{name:'Save',exact:true}).click();await page.locator('[data-block-id="request-list"]').waitFor();
await page.reload();await page.locator('[data-block-id="create-request"]').waitFor();await page.locator('[data-block-id="request-list"]').waitFor();
const routes=await api('desktopRoutes:list?paginate=false');const route=routes.find(r=>r.schemaUid===root);const child=routes.find(r=>r.parentId===route.id&&r.type==='tabs');assert.ok(child);
const stored=JSON.stringify(await api('flowModels:findOne?uid='+child.schemaUid+'&includeAsyncNode=true'));
assert.ok(stored.includes('purchasing:create-request'));assert.ok(stored.includes('purchasing:request-list'));
assert.equal(JSON.stringify(await api('flowModels:findOne?uid=diox035kb4o&includeAsyncNode=true')),originalSchema,'existing expense page schema unchanged');
await page.screenshot({path:'output/lattice-builder-save.png',fullPage:true});
assert.deepEqual(errors,[]);
console.log(JSON.stringify({result:'PASS',path:'/admin/'+root,formBinding:'persisted',listBinding:'persisted',reload:'PASS',originalPageUnchanged:true}));
}finally{await browser.close()}
})().catch(e=>{console.error(e.message);process.exitCode=1});
