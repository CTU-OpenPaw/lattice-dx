/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
// Creates one complete procurement run and one clean evidence file via the UI.
const assert=require('node:assert/strict');const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{
  const browser=await chromium.launch({headless:true,channel:'msedge'}),pages=[],errors=[];const title='Workflow UI '+Date.now();
  async function login(username){const page=await browser.newPage({acceptDownloads:true});pages.push(page);page.on('pageerror',e=>errors.push(e.message));await page.goto('http://localhost:13000/signin?redirect=%2Flattice%2Fapps%2Fpurchasing');await page.locator('input[type=password]').waitFor();await page.locator('input:not([type=password])').first().fill('admin@nocobase.com');await page.locator('input[type=password]').fill('admin123');await page.getByRole('button',{name:/sign in/i}).click();await page.waitForURL('**/lattice/apps/purchasing');await page.getByRole('button',{name:'Kết nối tài khoản nghiệp vụ',exact:true}).click();await page.waitForURL('http://localhost:8081/**');await page.locator('#username').fill(username);await page.locator('#password').fill('local-'+username+'-password');await page.locator('#kc-login').click();await page.waitForURL('**/lattice/apps/purchasing');await page.getByTestId('api-status').filter({hasText:username}).waitFor();return page;}
  const state=(page,name)=>page.getByTestId('workflow-state').filter({hasText:'— '+name+' —'}).waitFor();
  try{
    const alice=await login('alice'),a=alice.getByTestId('procurement-workflow');await a.getByRole('textbox',{name:'Nội dung workflow'}).fill(title);await a.getByRole('button',{name:'Tạo yêu cầu workflow',exact:true}).click();await state(alice,'draft');
    const runId=(await alice.getByTestId('workflow-state').innerText()).match(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/)[0];await a.getByRole('button',{name:'Gửi yêu cầu',exact:true}).click();await state(alice,'submitted');
    const manager=await login('manager'),m=manager.getByTestId('procurement-workflow');await m.getByRole('button',{name:title+' — submitted',exact:true}).click();await state(manager,'submitted');assert.equal(await m.getByRole('button',{name:'Nhận hàng',exact:true}).count(),0);await m.getByRole('button',{name:'Duyệt',exact:true}).click();await state(manager,'approved');
    const warehouse=await login('warehouse'),w=warehouse.getByTestId('procurement-workflow');await w.getByRole('button',{name:title+' — approved',exact:true}).click();await state(warehouse,'approved');
    await w.getByLabel('Tệp bằng chứng workflow').setInputFiles({name:'workflow-proof.txt',mimeType:'text/plain',buffer:Buffer.from('Procurement UI evidence\n')});await w.getByRole('button',{name:'Tải bằng chứng lên',exact:true}).click();await w.getByRole('status').filter({hasText:'scan: clean'}).waitFor({timeout:35000});
    const fileId=(await w.getByRole('status').filter({hasText:'scan: clean'}).innerText()).match(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/)[0];await w.getByLabel('ID tệp biên nhận',{exact:true}).fill(fileId);await w.getByRole('button',{name:'Nhận hàng',exact:true}).click();await state(warehouse,'received');await w.getByLabel('Ghi chú nghiệm thu',{exact:true}).fill('UI kiểm nghiệm thu');await w.getByRole('button',{name:'Nghiệm thu',exact:true}).click();await state(warehouse,'accepted');
    const tokenResponse=await fetch('http://localhost:8081/realms/lattice/protocol/openid-connect/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'password',client_id:'dx-local',username:'receiver',password:'local-receiver-password'})});assert.equal(tokenResponse.status,200);const receiver=JSON.parse(Buffer.from((await tokenResponse.json()).access_token.split('.')[1],'base64url')).sub;
    await w.getByLabel('Mã tài sản',{exact:true}).fill('asset-ui-'+Date.now());await w.getByLabel('Subject người nhận đã đăng ký',{exact:true}).fill(receiver);await w.getByLabel('Đơn vị',{exact:true}).selectOption('it');await w.getByLabel('Địa điểm',{exact:true}).selectOption('office-1');await w.getByLabel('ID tệp bàn giao',{exact:true}).fill(fileId);await w.getByRole('button',{name:'Bàn giao',exact:true}).click();await state(warehouse,'handed_over');
    await manager.getByTestId('procurement-workflow').getByRole('button',{name:'Tải lại workflow',exact:true}).click();await state(manager,'handed_over');
    const downloadPromise=manager.waitForEvent('download');await m.getByRole('button',{name:'Tải ID tệp bàn giao',exact:true}).click();const download=await downloadPromise;assert.equal(await download.failure(),null);const stream=await download.createReadStream();const parts=[];for await(const part of stream)parts.push(part);assert.equal(Buffer.concat(parts).toString(),'Procurement UI evidence\n');
    await warehouse.screenshot({path:'output/lattice-procurement-workflow.png',fullPage:true});assert.deepEqual(errors,[]);console.log(JSON.stringify({result:'PASS',runId,fileId,state:'handed_over',version:6,roleTransitions:'PASS',sharedEvidenceDownload:'PASS',history:'visible'}));
    for(const page of pages)await page.getByRole('button',{name:'Ngắt kết nối API',exact:true}).click();
  }finally{await browser.close()}
})().catch(e=>{console.error(e.stack);process.exitCode=1});
