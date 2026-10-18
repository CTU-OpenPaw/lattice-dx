// SPDX-License-Identifier: Apache-2.0
// Creates exactly one demo record and one linked task through the visible blocks.
const assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
async function run(){
  const tokenResponse=await fetch('http://localhost:8081/realms/lattice/protocol/openid-connect/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({grant_type:'password',client_id:'dx-local',username:'alice',password:'local-alice-password'})});
  assert.equal(tokenResponse.status,200);
  const token=(await tokenResponse.json()).access_token;
  const subject=JSON.parse(Buffer.from(token.split('.')[1],'base64url')).sub;
  const browser=await chromium.launch({headless:true,channel:'msedge'});
  try{
    const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto('http://localhost:13000/signin?redirect=%2Flattice%2Fapps%2Fpurchasing');
    await page.locator('input[type=password]').waitFor();
    await page.locator('input:not([type=password])').first().fill('admin@nocobase.com');
    await page.locator('input[type=password]').fill('admin123');
    await page.getByRole('button',{name:/sign in/i}).click();
    await page.waitForURL('**/lattice/apps/purchasing');
    await page.getByRole('button',{name:'Kết nối tài khoản nghiệp vụ',exact:true}).click();
    await page.waitForURL('http://localhost:8081/**');
    await page.locator('#username').fill('alice');await page.locator('#password').fill('local-alice-password');await page.locator('#kc-login').click();
    await page.waitForURL('**/lattice/apps/purchasing');
    const form=page.locator('[data-block-id="create-request"]');
    await form.getByRole('button',{name:'Lưu',exact:true}).waitFor();
    await page.waitForFunction(()=>!document.querySelector('[data-block-id="create-request"] button[type=submit]').disabled);
    await form.getByRole('button',{name:'Lưu',exact:true}).click();
    await form.getByRole('alert').filter({hasText:'Thiếu'}).waitFor();
    const title='Block UI E2E '+Date.now();await form.getByRole('textbox',{name:'Nội dung yêu cầu'}).fill(title);
    await form.getByRole('button',{name:'Lưu',exact:true}).click();
    await form.getByRole('status').filter({hasText:'Đã lưu thành công'}).waitFor();
    const recordId=(await form.getByRole('status').innerText()).match(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/)[0];
    const list=page.locator('[data-block-id="request-list"]');
    await list.getByRole('textbox',{name:'Lọc Hồ sơ của tôi'}).fill(title);
    await list.getByRole('cell',{name:title,exact:true}).waitFor();
    await list.getByRole('textbox',{name:'Lọc Hồ sơ của tôi'}).fill('khong-co-ban-ghi-'+Date.now());
    await list.getByText('Không có bản ghi phù hợp.').waitFor();
    await list.getByRole('textbox',{name:'Lọc Hồ sơ của tôi'}).fill(title);
    await list.getByRole('combobox',{name:'Số bản ghi mỗi trang'}).selectOption('5');
    assert.equal(await list.getByRole('button',{name:'Trước',exact:true}).isDisabled(),true);
    assert.equal(await list.getByRole('button',{name:'Sau',exact:true}).isDisabled(),true);
    await page.screenshot({path:'output/lattice-form-list.png',fullPage:true});
    await page.goto('http://localhost:13000/lattice/apps/logistics');
    const taskForm=page.locator('[data-block-id="assign-warehouse-task"]');
    await taskForm.getByRole('textbox',{name:'Công việc'}).waitFor();
    await page.waitForFunction(()=>!document.querySelector('[data-block-id="assign-warehouse-task"] button[type=submit]').disabled);
    await taskForm.getByRole('textbox',{name:'Công việc'}).fill(title+' kho');
    await taskForm.getByRole('textbox',{name:'Keycloak subject của người nhận'}).fill(subject);
    await taskForm.getByLabel('ID hồ sơ đơn hàng đã tạo').fill(recordId);
    await taskForm.getByRole('button',{name:'Lưu',exact:true}).click();
    await taskForm.getByRole('status').filter({hasText:'Đã lưu thành công'}).waitFor();
    const taskId=(await taskForm.getByRole('status').innerText()).match(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/)[0];
    const inbox=page.locator('[data-block-id="warehouse-inbox"]');
    await inbox.getByRole('textbox',{name:'Lọc Kho nhận việc'}).fill(title+' kho');
    await inbox.getByRole('cell',{name:recordId,exact:true}).waitFor();
    await page.getByRole('button',{name:'Ngắt kết nối API',exact:true}).click();
    await page.getByTestId('api-status').filter({hasText:'Chưa kết nối'}).waitFor();
    assert.equal(await inbox.getByRole('cell',{name:recordId,exact:true}).count(),0);
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({result:'PASS',recordId,taskId,validation:'PASS',filter:'PASS',paginationBoundary:'PASS',readback:'PASS',clearOnDisconnect:'PASS'}));
  }finally{await browser.close()}
}
run().catch(e=>{console.error(e.message);process.exitCode=1});
