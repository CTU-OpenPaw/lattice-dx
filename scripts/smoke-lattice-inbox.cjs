/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
// Loopback fixture only. Retains demo requests; credentials/tokens stay in memory.
const assert=require('node:assert/strict');const {randomUUID}=require('node:crypto');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{
  const tokens={};for(const username of ['alice','manager','hr-demo','receiver']){
    const response=await fetch('http://localhost:8081/realms/lattice/protocol/openid-connect/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'password',client_id:'dx-local',username,password:'local-'+username+'-password'})});assert.equal(response.status,200);tokens[username]=(await response.json()).access_token;
  }
  async function call(username,path,method='GET',body){const response=await fetch('http://localhost:8080/v1/'+path,{method,headers:{authorization:'Bearer '+tokens[username],'content-type':'application/json','idempotency-key':randomUUID()},...(body?{body:JSON.stringify(body)}:{})});assert.ok(response.ok,`${method} ${path}: ${response.status}`);return response.json();}
  const prefix='Generic Inbox '+Date.now();const runs=[];
  for(const [definitionId,username,suffix] of [['procurement','alice','approve'],['procurement','alice','reject'],['onboarding','hr-demo','onboarding']]){
    const input=definitionId==='onboarding'?{recipientId:JSON.parse(Buffer.from(tokens.receiver.split('.')[1],'base64url')).sub}:{};
    const run=await call(username,'workflows','POST',{definitionId,title:prefix+' '+suffix,input});await call(username,`workflows/${run.id}/transitions`,'POST',{action:'submit',expectedVersion:1,input:{}});runs.push({...run,username,suffix});
  }
  const browser=await chromium.launch({headless:true,channel:'msedge'});const errors=[];
  async function login(username){const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto('http://localhost:13000/signin?redirect=%2Flattice%2Fapps%2Fwork');await page.locator('input[type=password]').waitFor();await page.locator('input:not([type=password])').first().fill('admin@nocobase.com');await page.locator('input[type=password]').fill('admin123');await page.getByRole('button',{name:/sign in/i}).click();await page.waitForURL('**/lattice/apps/work');await page.getByRole('button',{name:'Kết nối tài khoản nghiệp vụ',exact:true}).click();await page.waitForURL('http://localhost:8081/**');await page.locator('#username').fill(username);await page.locator('#password').fill('local-'+username+'-password');await page.locator('#kc-login').click();await page.waitForURL('**/lattice/apps/work');await page.getByTestId('api-status').filter({hasText:username}).waitFor();return page;}
  try{
    const manager=await login('manager');const inbox=manager.getByTestId('lattice-task-inbox');
    await inbox.getByLabel('Tìm công việc',{exact:true}).fill(prefix);await inbox.getByRole('button',{name:'Tìm',exact:true}).click();
    await inbox.getByRole('button',{name:'Mở '+runs[0].title,exact:true}).click();const approval=manager.getByTestId('lattice-approval');await approval.getByRole('button',{name:'Duyệt',exact:true}).waitFor();
    let drop=true;const keys=[];await manager.route('**/api/dxActions:workflow',async route=>{const data=route.request().postDataJSON();if(data.operation==='transition'){keys.push(data.key);if(drop){drop=false;const result=await route.fetch();assert.equal(result.status(),200);return route.fulfill({status:502,contentType:'application/json',body:JSON.stringify({error:'Fixture lost response after commit'})});}}return route.continue();});
    await approval.getByRole('button',{name:'Duyệt',exact:true}).click();await approval.getByRole('button',{name:'Thử lại lệnh cũ',exact:true}).waitFor();assert.equal(await inbox.getByRole('button',{name:'Mở '+runs[1].title,exact:true}).isDisabled(),true);
    await approval.getByRole('button',{name:'Thử lại lệnh cũ',exact:true}).click();await approval.getByTestId('approval-state').filter({hasText:'— approved — v3'}).waitFor();assert.equal(keys.length,2);assert.equal(keys[0],keys[1]);await manager.unroute('**/api/dxActions:workflow');
    await inbox.getByRole('button',{name:'Mở '+runs[1].title,exact:true}).click();await approval.getByRole('button',{name:'Từ chối',exact:true}).waitFor();await approval.getByRole('button',{name:'Từ chối',exact:true}).click();await approval.getByRole('alert').filter({hasText:'reason'}).waitFor();
    await approval.getByLabel('Lý do từ chối',{exact:true}).fill('Cần bổ sung thông tin');await approval.getByRole('button',{name:'Từ chối',exact:true}).click();await approval.getByTestId('approval-state').filter({hasText:'— rejected — v3'}).waitFor();
    await inbox.getByRole('button',{name:'Mở '+runs[2].title,exact:true}).click();await approval.getByRole('button',{name:'Duyệt',exact:true}).click();await approval.getByTestId('approval-state').filter({hasText:'— approved — v3'}).waitFor();
    await inbox.getByRole('button',{name:'Có quyền xem',exact:true}).click();await inbox.getByLabel('Trạng thái công việc',{exact:true}).selectOption('rejected');await inbox.getByRole('button',{name:'Mở '+runs[1].title,exact:true}).waitFor();assert.equal(await inbox.getByRole('button',{name:'Mở '+runs[0].title,exact:true}).count(),0);
    const employee=await login('alice'),employeeInbox=employee.getByTestId('lattice-task-inbox');await employeeInbox.getByRole('button',{name:'Có quyền xem',exact:true}).click();await employeeInbox.getByLabel('Tìm công việc',{exact:true}).fill(runs[0].title);await employeeInbox.getByRole('button',{name:'Tìm',exact:true}).click();await employeeInbox.getByRole('button',{name:'Mở '+runs[0].title,exact:true}).click();await employee.getByTestId('approval-state').waitFor();assert.equal(await employee.getByTestId('lattice-approval').getByRole('button',{name:'Duyệt',exact:true}).count(),0);
    const approved=await call('manager',`workflows/${runs[0].id}`);assert.equal(approved.version,3);assert.equal(approved.state,'approved');const history=await call('manager',`workflows/${runs[0].id}/history`);assert.equal(history.items.filter(entry=>entry.action==='approve').length,1);
    await inbox.getByRole('button',{name:'Mở '+runs[1].title,exact:true}).click();await approval.getByTestId('approval-state').filter({hasText:'— rejected — v3'}).waitFor();
    await manager.screenshot({path:'output/lattice-task-inbox.png',fullPage:true});assert.deepEqual(errors,[]);
    console.log(JSON.stringify({result:'PASS',runs:runs.map(r=>({id:r.id,definitionId:r.definitionId})),approval:'PASS',reason:'PASS',filter:'PASS',employeeRestriction:'PASS',lostResponseSameKeyReplay:'PASS',singleAudit:'PASS',pageErrors:0}));
  }finally{await browser.close();}
})().catch(error=>{console.error(error.message);process.exitCode=1});
