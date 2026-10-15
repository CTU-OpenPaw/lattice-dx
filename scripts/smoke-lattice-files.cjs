// SPDX-License-Identifier: Apache-2.0
// Local fixtures: creates two records, one linked task and one small clean file.
const assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
async function run(){
  const tokenResponse=await fetch('http://localhost:8081/realms/lattice/protocol/openid-connect/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'password',client_id:'dx-local',username:'warehouse-demo',password:'local-warehouse-demo-password'})});
  assert.equal(tokenResponse.status,200,'warehouse fixture login');
  const subject=JSON.parse(Buffer.from((await tokenResponse.json()).access_token.split('.')[1],'base64url')).sub;
  const browser=await chromium.launch({headless:true,channel:'msedge'});
  try{
    let page=await browser.newPage({acceptDownloads:true});const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto('http://localhost:13000/signin?redirect=%2Flattice%2Fapps%2Fpurchasing');
    await page.locator('input[type=password]').waitFor();await page.locator('input:not([type=password])').first().fill('admin@nocobase.com');await page.locator('input[type=password]').fill('admin123');await page.getByRole('button',{name:/sign in/i}).click();await page.waitForURL('**/lattice/apps/purchasing');
    async function connect(username){await page.getByRole('button',{name:'Kết nối tài khoản nghiệp vụ',exact:true}).click();await page.waitForURL('http://localhost:8081/**');await page.locator('#username').fill(username);await page.locator('#password').fill('local-'+username+'-password');await page.locator('#kc-login').click();await page.waitForURL('**/lattice/apps/**');}
    await connect('alice');
    const purchasing=page.locator('[data-block-id="create-request"]');
    await page.waitForFunction(()=>document.querySelector('[data-block-id="create-request"] button[type=submit]')?.disabled===false);
    const title='Step5 UI '+Date.now();await purchasing.getByRole('textbox',{name:'Nội dung yêu cầu'}).fill(title);await purchasing.getByRole('button',{name:'Lưu',exact:true}).click();
    await purchasing.getByRole('status').filter({hasText:'Đã lưu thành công'}).waitFor();
    const recordId=(await purchasing.getByRole('status').filter({hasText:'Đã lưu thành công'}).innerText()).match(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/)[0];
    const panel=purchasing.getByRole('region',{name:'Tệp hồ sơ'});
    await panel.locator('input[type=file]').setInputFiles({name:'step5-proof.txt',mimeType:'text/plain',buffer:Buffer.from('Lattice Step 5 file proof\n')});
    await panel.getByRole('button',{name:'Tải tệp lên',exact:true}).click();await panel.getByRole('status').filter({hasText:'scan: clean'}).waitFor({timeout:35000});
    const fileId=(await panel.getByRole('status').filter({hasText:'scan: clean'}).innerText()).match(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/)[0];
    await panel.getByRole('button',{name:'Kiểm tra tệp',exact:true}).click();await panel.getByRole('status').filter({hasText:'scan: clean'}).waitFor();
    const downloadPromise=page.waitForEvent('download');await panel.getByRole('button',{name:'Tải tệp xuống',exact:true}).click();const download=await downloadPromise;assert.equal(download.suggestedFilename(),'step5-proof.txt');assert.equal(await download.failure(),null);
    const stream=await download.createReadStream();const chunks=[];for await(const chunk of stream)chunks.push(chunk);assert.equal(Buffer.concat(chunks).toString(),'Lattice Step 5 file proof\n');
    await panel.locator('input[type=file]').setInputFiles({name:'too-large.txt',mimeType:'text/plain',buffer:Buffer.alloc(1048577)});await panel.getByRole('button',{name:'Tải tệp lên',exact:true}).click();await panel.getByRole('alert').filter({hasText:'không quá 1 MiB'}).waitFor();
    await page.goto('http://localhost:13000/lattice/apps/logistics');const order=page.locator('[data-block-id="create-order-record"]');await page.waitForFunction(()=>document.querySelector('[data-block-id="create-order-record"] button[type=submit]')?.disabled===false);
    await order.getByRole('textbox',{name:'Nội dung đơn hàng'}).fill(title+' order');await order.getByRole('button',{name:'Lưu',exact:true}).click();await order.getByRole('status').filter({hasText:'Đã lưu thành công'}).waitFor();
    const orderId=(await order.getByRole('status').filter({hasText:'Đã lưu thành công'}).innerText()).match(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/)[0];
    // Reload so the fixed 100-record lookup includes the newly-created order.
    await page.reload();const task=page.locator('[data-block-id="assign-warehouse-task"]');await page.waitForFunction(()=>document.querySelector('[data-block-id="assign-warehouse-task"] button[type=submit]')?.disabled===false);
    await page.waitForFunction(id=>!!document.querySelector(`datalist option[value="${id}"]`),orderId);
    await task.getByRole('textbox',{name:'Công việc'}).fill(title+' warehouse');await task.getByRole('textbox',{name:'Keycloak subject của người nhận'}).fill(subject);await task.getByLabel('ID hồ sơ đơn hàng đã tạo').fill(orderId);await task.getByRole('button',{name:'Lưu',exact:true}).click();await task.getByRole('status').filter({hasText:'Đã lưu thành công'}).waitFor();
    const taskId=(await task.getByRole('status').filter({hasText:'Đã lưu thành công'}).innerText()).match(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/)[0];
    await page.getByRole('button',{name:'Ngắt kết nối API',exact:true}).click();await page.getByTestId('api-status').filter({hasText:'Chưa kết nối'}).waitFor();await page.close();
    page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));
    await page.goto('http://localhost:13000/signin?redirect=%2Flattice%2Fapps%2Flogistics');await page.locator('input[type=password]').waitFor();await page.locator('input:not([type=password])').first().fill('admin@nocobase.com');await page.locator('input[type=password]').fill('admin123');await page.getByRole('button',{name:/sign in/i}).click();await page.waitForURL('**/lattice/apps/logistics');await connect('warehouse-demo');
    const inbox=page.locator('[data-block-id="warehouse-inbox"]');await inbox.getByRole('textbox',{name:'Lọc Kho nhận việc'}).fill(title+' warehouse');await inbox.getByRole('cell',{name:orderId,exact:true}).waitFor();
    await page.getByTestId('api-status').filter({hasText:'warehouse-demo'}).waitFor();
    assert.equal(await page.locator('[data-block-id="create-order-record"]').getByRole('button',{name:'Lưu',exact:true}).isDisabled(),true,'warehouse cannot create sales records');
    await page.screenshot({path:'output/lattice-step5-warehouse.png',fullPage:true});assert.deepEqual(errors,[]);
    console.log(JSON.stringify({result:'PASS',recordId,orderId,taskId,fileId,scan:'clean',downloadBytes:'PASS',fileSizeLimit:'PASS',warehouseInbox:'PASS',warehouseCreateDenied:'PASS'}));
    await page.getByRole('button',{name:'Ngắt kết nối API',exact:true}).click();
  }finally{await browser.close()}
}
run().catch(e=>{console.error(e.stack);process.exitCode=1});
