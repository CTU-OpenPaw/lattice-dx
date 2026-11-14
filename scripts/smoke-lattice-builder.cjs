/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
// Inspect Add block menu, close without inserting or saving any page schema.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
(async()=>{
  const browser=await chromium.launch({headless:true,channel:'msedge'});
  try{
    const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
    const target=process.env.NATIVE_PAGE_PATH||'/admin/annfbogrejf';
    await page.goto('http://localhost:13000/signin?redirect='+encodeURIComponent(target));
    await page.locator('input[type=password]').waitFor();await page.locator('input:not([type=password])').first().fill('admin@nocobase.com');await page.locator('input[type=password]').fill('admin123');await page.getByRole('button',{name:/sign in/i}).click();
    await page.waitForURL('**'+target);await page.getByText(/Total \d+ items/).waitFor();
    if(!(await page.getByText('Add block',{exact:true}).isVisible()))await page.getByTitle('UI Editor',{exact:true}).click();
    await page.getByText('Add block',{exact:true}).click();
    for(const name of ['Lattice Form','Lattice Danh sách','Lattice Task Inbox','Lattice Approval','Lattice Attachment','Lattice Activity Timeline','Lattice Context Entity','Lattice Workflow Form'])await page.getByText(name,{exact:true}).waitFor({timeout:5000});
    await page.keyboard.press('Escape');
    assert.deepEqual(errors,[]);console.log(JSON.stringify({result:'PASS',menu:['Lattice Form','Lattice Danh sách','Lattice Task Inbox','Lattice Approval','Lattice Attachment','Lattice Activity Timeline','Lattice Context Entity','Lattice Workflow Form'],noSchemaInsert:true}));
  }finally{await browser.close()}
})().catch(error=>{console.error(error.message);process.exitCode=1});
