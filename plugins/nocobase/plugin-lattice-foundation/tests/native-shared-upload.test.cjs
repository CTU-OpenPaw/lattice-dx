/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createSharedUploadReceipts}=require('../src/server/native-shared-upload');

function fixture(){
  const rows=[];
  const query=async(sql,bind)=>{
    if(sql.startsWith('INSERT')){const [id,org,user,key,filename,digest]=bind;rows.push({request_id:id,organization_id:org,uploader_id:user,upload_key:key,filename,content_digest:digest,state:'pending',attempts:1});return [rows.at(-1)];}
    if(sql.startsWith('SELECT'))return rows.filter(row=>row.request_id===bind[0]&&row.organization_id===bind[1]&&
      (sql.includes("SELECT 1")?row.state==='pending':sql.includes(' OR ')?((row.uploader_id===bind[2]&&row.upload_key===bind[3])||row.state==='pending'):(row.uploader_id===bind[2]&&row.upload_key===bind[3])));
    if(sql.startsWith('UPDATE')){const row=rows.find(row=>row.request_id===bind[0]&&row.organization_id===bind[1]&&row.upload_key===bind[2]);if(sql.includes('attempts + 1'))row.attempts++;else{row.state=bind[3];row.result=JSON.parse(bind[4]);}return [row];}
    throw Error('Unexpected query');
  };
  const ctx={throw(status,message){throw Object.assign(Error(message),{status});}};
  const scope={id:'10',actor:{organizationId:'org-a',userId:'5'},transaction:{}};
  const input={key:'11111111-1111-4111-8111-111111111111',filename:'proof.txt',content:Buffer.from('proof')};
  return {receipts:createSharedUploadReceipts(query),scope,input,ctx,rows};
}
test('a durable pending receipt blocks submit before the remote call',async()=>{
  const {receipts,scope,input,ctx,rows}=fixture();
  await receipts.prepare(ctx,scope,input);
  assert.equal(rows[0].state,'pending');
  await assert.rejects(receipts.assertSettled(ctx,scope),{status:409});
});
test('timeout and late commit keep submit blocked until successful retry',async()=>{
  const {receipts,scope,input,ctx}=fixture();await receipts.prepare(ctx,scope,input);
  const uncertain=await receipts.execute(ctx,scope,input,async()=>{ctx.throw(503,'timeout');});
  assert.equal(uncertain.error.status,503);
  await assert.rejects(receipts.assertSettled(ctx,scope),{status:409});
  const newKey={...input,key:'22222222-2222-4222-8222-222222222222'};
  const resumed=await receipts.prepare(ctx,scope,newKey);assert.equal(resumed.key,input.key);
  const result=await receipts.execute(ctx,scope,resumed,async canonical=>{assert.equal(canonical.key,input.key);return {status:200,data:{fileId:'same-file'}};});
  assert.equal(result.data.fileId,'same-file');await receipts.assertSettled(ctx,scope);
});
test('completed duplicates replay metadata without calling the shared service',async()=>{
  const {receipts,scope,input,ctx}=fixture();await receipts.prepare(ctx,scope,input);
  await receipts.execute(ctx,scope,input,async()=>({status:201,data:{fileId:'file'}}));
  const replay=await receipts.execute(ctx,scope,input,async()=>{throw Error('Must not call');});
  assert.deepEqual(replay,{status:200,data:{fileId:'file'}});
});
test('definitive first-attempt rejection releases submit but uncertain retries do not',async()=>{
  for(const retried of [false,true]){
    const {receipts,scope,input,ctx}=fixture();await receipts.prepare(ctx,scope,input);
    if(retried)await receipts.prepare(ctx,scope,input);
    const result=await receipts.execute(ctx,scope,input,async()=>ctx.throw(409,'scanner rejected'));
    assert.equal(result.error.status,409);
    if(retried)await assert.rejects(receipts.assertSettled(ctx,scope),{status:409});
    else await receipts.assertSettled(ctx,scope);
  }
});
test('changed content or another uploader cannot replace or resume an uncertain receipt',async()=>{
  const {receipts,scope,input,ctx}=fixture();await receipts.prepare(ctx,scope,input);
  await assert.rejects(receipts.prepare(ctx,scope,{...input,content:Buffer.from('changed')}),{status:409});
  await assert.rejects(receipts.prepare(ctx,{...scope,actor:{...scope.actor,userId:'6'}},input),{status:409});
});
test('concurrent preparations cannot clear an earlier uncertain remote writer on rejection',async()=>{
  const {receipts,scope,input,ctx}=fixture();
  await receipts.prepare(ctx,scope,input);await receipts.prepare(ctx,scope,input);
  await receipts.execute(ctx,scope,input,async()=>ctx.throw(503,'timeout'));
  await receipts.execute(ctx,scope,input,async()=>ctx.throw(409,'rejected on retry'));
  await assert.rejects(receipts.assertSettled(ctx,scope),{status:409});
});
