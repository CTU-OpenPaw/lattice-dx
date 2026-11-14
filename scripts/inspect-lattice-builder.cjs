/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
// Read-only UI inspection, no schema writes.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{const browser=await chromium.launch({headless:true,channel:'msedge'});try{
const page=await browser.newPage();await page.goto('http://localhost:13000/signin?redirect=%2Fadmin%2Fannfbogrejf');await page.locator('input[type=password]').waitFor();await page.locator('input:not([type=password])').first().fill('admin@nocobase.com');await page.locator('input[type=password]').fill('admin123');await page.getByRole('button',{name:/sign in/i}).click();await page.waitForURL('**/admin/annfbogrejf');await page.getByText(/Total \d+ items/).waitFor();if(!await page.getByText('Add block',{exact:true}).isVisible())await page.getByTitle('UI Editor',{exact:true}).click();await page.getByText('Add block',{exact:true}).waitFor();console.log((await page.locator('body').innerText()).slice(0,3500));
console.log(JSON.stringify(await page.getByRole('button').allTextContents()));
await page.locator('button:not([disabled])').filter({hasText:'Add menu item'}).last().click();console.log((await page.locator('body').innerText()).slice(-2500));
}finally{await browser.close()}})().catch(e=>{console.error(e.message);process.exitCode=1});
