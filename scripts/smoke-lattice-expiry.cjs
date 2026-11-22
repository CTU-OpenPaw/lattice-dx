/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
// Wait for the real server expiry; no clock/response mocks or realm changes.
const assert=require('node:assert/strict');const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{const browser=await chromium.launch({headless:true,channel:'msedge'});try{
  const page=await browser.newPage();await page.goto('http://localhost:13000/signin?redirect=%2Flattice%2Fapps%2Fpurchasing');await page.locator('input[type=password]').waitFor();await page.locator('input:not([type=password])').first().fill('admin@nocobase.com');await page.locator('input[type=password]').fill('admin123');await page.getByRole('button',{name:/sign in/i}).click();await page.waitForURL('**/lattice/apps/purchasing');
  await page.getByRole('button',{name:'Kết nối tài khoản nghiệp vụ',exact:true}).click();await page.waitForURL('http://localhost:8081/**');await page.locator('#username').fill('alice');await page.locator('#password').fill('local-alice-password');await page.locator('#kc-login').click();await page.waitForURL('**/lattice/apps/purchasing');await page.getByTestId('api-status').filter({hasText:'Đã kết nối'}).waitFor();
  const started=Date.now();console.log('Waiting for real bridge/session expiry (up to 320 seconds); no writes.');
  await page.getByTestId('api-status').filter({hasText:'Chưa kết nối'}).waitFor({timeout:320000});
  assert.equal(await page.locator('[data-block-id="create-request"] button[type=submit]').isDisabled(),true);
  await page.locator('[data-block-id="request-list"] table').waitFor({state:'detached'});
  console.log(JSON.stringify({result:'PASS',expiry:'real',elapsedSeconds:Math.round((Date.now()-started)/1000),formDisabled:true,listCleared:true}));
}finally{await browser.close()}})().catch(e=>{console.error(e.message);process.exitCode=1});
