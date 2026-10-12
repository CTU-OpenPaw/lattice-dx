// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
const compose=['compose','-f','infra/compose/core.yml'];
const r=await fetch('http://localhost:8081/realms/lattice/protocol/openid-connect/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'password',client_id:'dx-local',username:'alice',password:'local-alice-password'})});
assert.equal(r.status,200);const {access_token}=await r.json();
const headers={authorization:`Bearer ${access_token}`,'content-type':'application/json'};
try{
  execFileSync('docker',[...compose,'stop','clamav'],{stdio:'pipe',timeout:30000});
  const upload=await fetch('http://localhost:8080/v1/files',{method:'POST',headers,body:JSON.stringify({filename:'scanner-offline.txt',contentBase64:Buffer.from('Outage smoke').toString('base64')}),signal:AbortSignal.timeout(25000)});
  assert.equal(upload.status,201);const file=await upload.json();assert.equal(file.scanStatus,'error');
  assert.equal((await fetch(`http://localhost:8080/v1/files/${file.id}/content`,{headers,signal:AbortSignal.timeout(10000)})).status,409);
  console.log('Scanner outage passed: unavailable real scanner results in error quarantine; download blocked.');
}finally{
  execFileSync('docker',[...compose,'start','clamav'],{stdio:'pipe',timeout:30000});
  console.log('ClamAV restart requested after outage test.');
}
