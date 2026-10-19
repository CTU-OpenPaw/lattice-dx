// SPDX-License-Identifier: Apache-2.0
// Local-only fixtures; credentials/tokens stay in memory. Retains test entities for review.
const assert=require('node:assert/strict');const {writeFileSync}=require('node:fs');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{
  const {freshManifest,localConfig,loginActors,api}=await import('./lib/team-integration.mjs');
  const config=localConfig(),actors=await loginActors(config),call=api(config,actors),manifest=freshManifest();
  Object.assign(manifest.schemas[0].fields,{location:{type:'text',maxLength:200},status:{type:'enum',choices:['ready','in_use','repair','retired']}});
  const installed=await call('alice','/v1/enterprise-modules/install','POST',{manifest},201);
  const definitionId=manifest.bundle.definitions[0].id,schemaId=manifest.schemas[0].id;
  await call('alice','/v1/workflow-drafts/'+definitionId+'/publish','POST',{expectedRevision:1});
  await call('alice',`/v1/enterprise-modules/${manifest.id}/versions/1.0.0/enabled`,'POST',{expectedRevision:installed.revision,enabled:true});
  const attributes={assetCode:'CTX-'+manifest.id.slice(-8),description:'Context UI fixture',location:'Kho A',status:'ready'};
  let entity=await call('alice','/v1/entities','POST',{schemaId,title:'Context Asset '+manifest.id.slice(-8),attributes},201);
  const title='Context UI '+manifest.id.slice(-8);
  const run=await call('alice',`/v1/enterprise-modules/${manifest.id}/versions/1.0.0/bindings/asset-review/start`,'POST',{entityId:entity.id,title,input:{}},201);
  const browser=await chromium.launch({headless:true,channel:'msedge'}),errors=[];
  try{
    const page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',e=>errors.push(e.message));
    await page.goto('http://localhost:13000/signin?redirect=%2Flattice%2Fapps%2Fwork');await page.locator('input[type=password]').waitFor();await page.locator('input:not([type=password])').first().fill('admin@nocobase.com');await page.locator('input[type=password]').fill('admin123');await page.getByRole('button',{name:/sign in/i}).click();await page.waitForURL('**/lattice/apps/work');
    await page.getByRole('button',{name:'Kết nối tài khoản nghiệp vụ',exact:true}).click();await page.waitForURL('http://localhost:8081/**');await page.locator('#username').fill('warehouse');await page.locator('#password').fill('local-warehouse-password');await page.locator('#kc-login').click();await page.waitForURL('**/lattice/apps/work');await page.getByTestId('api-status').filter({hasText:'warehouse'}).waitFor();
    const inbox=page.getByTestId('lattice-task-inbox');await inbox.getByLabel('Tìm công việc',{exact:true}).fill(title);await inbox.getByRole('button',{name:'Tìm',exact:true}).click();await inbox.getByRole('button',{name:'Mở '+title,exact:true}).click();
    const context=page.getByTestId('lattice-context-entity');await context.getByRole('alert').filter({hasText:'Không có liên kết được phép xem'}).waitFor();assert.equal((await context.innerText()).includes(entity.title),false);
    entity=await call('alice',`/v1/entities/${entity.id}/shares`,'POST',{expectedVersion:entity.version,principal:{kind:'person',id:actors.warehouse.subject},permission:'read'});
    await context.getByRole('button',{name:'Tải lại dữ liệu liên kết'}).click();await context.getByRole('heading',{name:entity.title,exact:true}).waitFor();await context.getByText('Kho A',{exact:true}).waitFor();await context.getByText('ready',{exact:true}).waitFor();
    entity=await call('alice',`/v1/entities/${entity.id}`,'PATCH',{expectedVersion:entity.version,title:entity.title,attributes:{...attributes,location:'Kho B',status:'in_use'}});
    await context.getByRole('button',{name:'Tải lại dữ liệu liên kết'}).click();await context.getByText('Kho B',{exact:true}).waitFor();await context.getByText('in_use',{exact:true}).waitFor();await context.getByText(/Dữ liệu hiện tại đã thay đổi/).waitFor();
    await page.reload();await inbox.getByLabel('Tìm công việc',{exact:true}).fill(title);await inbox.getByRole('button',{name:'Tìm',exact:true}).click();await inbox.getByRole('button',{name:'Mở '+title,exact:true}).click();await context.getByText('Kho B',{exact:true}).waitFor();
    await page.screenshot({path:'output/lattice-context-entity.png',fullPage:true});
    await call('bob',`/v1/workflows/${run.id}/entity-context`,'GET',undefined,403);
    entity=await call('alice',`/v1/entities/${entity.id}/shares/person/${actors.warehouse.subject}`,'DELETE',{expectedVersion:entity.version});
    await context.getByRole('button',{name:'Tải lại dữ liệu liên kết'}).click();await context.getByRole('alert').filter({hasText:'Không có liên kết được phép xem'}).waitFor();assert.equal((await context.innerText()).includes(entity.title),false);assert.equal((await context.innerText()).includes('Kho B'),false);
    // Leave a shared fixture for Hưng to inspect; no workflow transition is executed.
    await call('alice',`/v1/entities/${entity.id}/shares`,'POST',{expectedVersion:entity.version,principal:{kind:'person',id:actors.warehouse.subject},permission:'read'});
    await context.getByRole('button',{name:'Tải lại dữ liệu liên kết'}).click();await context.getByText('Kho B',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Ngắt kết nối API',exact:true}).click();await context.waitFor({state:'detached'});assert.equal(await page.getByTestId('lattice-context-entity').count(),0);assert.deepEqual(errors,[]);
    const result={result:'PASS',title,runId:run.id,entityId:entity.id,schemaId,workflowReadDoesNotGrantEntity:true,explicitShare:true,currentFields:true,pinnedVersionPreserved:true,reload:true,revokeHidesData:true,disconnect:true,broker:'not connected',pageErrors:0};writeFileSync('output/context-smoke-result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
  }finally{await browser.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1});
