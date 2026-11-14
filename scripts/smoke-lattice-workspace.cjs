/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
// Browser test uses isolated contexts, public local fixture accounts, no data writes.
const assert = require('node:assert/strict');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
async function run() {
  const browser=await chromium.launch({headless:true,channel:'msedge'});
  try {
    const page=await browser.newPage();
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    const base='http://localhost:13000';
    await page.goto(base+'/signin?redirect=%2Flattice');
    await page.locator('input[type=password]').waitFor();
    await page.locator('input:not([type=password])').first().fill('admin@nocobase.com');
    await page.locator('input[type=password]').fill('admin123');
    await page.getByRole('button',{name:/sign in/i}).click();
    await page.waitForURL('**/lattice');
    await page.getByRole('heading',{name:'Công việc của tôi',exact:true}).waitFor();
    await page.getByRole('link',{name:'Mở Mua sắm nội bộ',exact:true}).waitFor();
    await page.getByRole('link',{name:'Mở Logistics',exact:true}).click();
    await page.waitForURL('**/lattice/apps/logistics');
    await page.getByRole('heading',{name:'Kho nhận việc',exact:true}).waitFor();
    await page.getByRole('button',{name:'Kết nối tài khoản nghiệp vụ',exact:true}).click();
    await page.waitForURL('http://localhost:8081/**');
    await page.locator('#username').fill('alice');
    await page.locator('#password').fill('local-alice-password');
    await page.locator('#kc-login').click();
    await page.waitForURL('**/lattice/apps/logistics',{timeout:30000});
    await page.getByTestId('api-status').filter({hasText:'Đã kết nối'}).waitFor();
    await page.getByRole('link',{name:'← Chọn ứng dụng khác'}).click();
    await page.waitForURL('**/lattice?view=apps');
    await page.getByTestId('api-status').filter({hasText:'Đã kết nối'}).waitFor();
    await page.screenshot({path:'output/lattice-workspace.png',fullPage:true});
    await page.getByRole('button',{name:'Ngắt kết nối API',exact:true}).click();
    await page.getByTestId('api-status').filter({hasText:'Chưa kết nối'}).waitFor();
    await page.getByRole('button',{name:'Đăng xuất',exact:true}).click();
    await page.waitForURL('**/signin?redirect=**');
    await page.locator('input[type=password]').waitFor();
    assert.deepEqual(errors,[]);
    console.log('PASS: login, manifest navigation, actual Keycloak PKCE, return to selected app, shared connection status, disconnect and logout.');
    // A separate signed-in context tests UI handling of controlled HTTP failures.
    await page.locator('input:not([type=password])').first().fill('admin@nocobase.com');
    await page.locator('input[type=password]').fill('admin123');
    await page.getByRole('button',{name:/sign in/i}).click();
    await page.waitForURL('**/lattice');
    await page.getByRole('link',{name:'Mở Logistics',exact:true}).waitFor();
    await page.route('**/api/latticeApps:list*',route=>route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({errors:[{message:'Test denied'}]})}));
    await page.reload();
    await page.getByRole('alert').filter({hasText:'không có quyền'}).waitFor();
    await page.unroute('**/api/latticeApps:list*');
    await page.route('**/api/auth:check*',route=>route.fulfill({status:401,contentType:'application/json',body:JSON.stringify({errors:[{message:'Test expired'}]})}));
    await page.reload();
    await page.getByRole('link',{name:'Đăng nhập lại',exact:true}).waitFor();
    console.log('PASS: simulated 403 notification and 401 sign-in recovery.');
    assert.deepEqual(errors,[]);
  } finally {await browser.close();}
}
run().catch(error=>{console.error(error.message);process.exitCode=1;});
