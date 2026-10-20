// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {parseEnv} from 'node:util';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url)),actors={};
const docker=['--context','desktop-linux','compose','-f',resolve(root,'infra/compose/core.yml'),'exec','-T','-w','/app/apps/api','api','node'];
function sqlRead(query,params=[]){
 const source=`const {Pool}=require('pg');const p=new Pool({connectionString:process.env.DATABASE_URL});p.query(${JSON.stringify(query)},${JSON.stringify(params)}).then(r=>process.stdout.write(JSON.stringify(r.rows))).catch(()=>{process.exitCode=1}).finally(()=>p.end());`;
 return JSON.parse(execFileSync('docker',docker,{cwd:root,input:source,windowsHide:true,stdio:['pipe','pipe','pipe'],encoding:'utf8',timeout:15000,maxBuffer:4*1024*1024}));
}
async function main(){
 const env=parseEnv(await readFile(resolve(root,'.env.integration'),'utf8'));
 assert.equal(env.WORKFLOW_OUTBOX_WORKER,'true');assert.equal(env.WORKFLOW_OUTBOX_EVENT_TYPE,'asset.handed_over');assert.equal(env.WORKFLOW_OUTBOX_ORGANIZATION_ID,'org-a');assert.ok(env.WORKFLOW_OUTBOX_CREATED_AFTER);
 const backlog=sqlRead('SELECT id,status,attempts,lease_token,last_error FROM workflow_jobs ORDER BY id');
 for(const name of ['alice','manager','warehouse','warehouse2','receiver']){
  const r=await fetch('http://localhost:8081/realms/lattice/protocol/openid-connect/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'password',client_id:'dx-local',username:name,password:`local-${name}-password`}),signal:AbortSignal.timeout(10000)});
  assert.equal(r.status,200);const {access_token}=await r.json();actors[name]={token:access_token,subject:JSON.parse(Buffer.from(access_token.split('.')[1],'base64url').toString()).sub};
 }
 async function api(path,actor,body,status=200){const r=await fetch('http://localhost:8080'+path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+actors[actor].token,'Content-Type':'application/json','Idempotency-Key':randomUUID()},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000)});assert.equal(r.status,status,actor+' '+path);return r.json();}
 for(const actor of Object.keys(actors))await api('/v1/workflow-members/me',actor,{});
 let run=await api('/v1/workflows','alice',{definitionId:'procurement',title:'UC1 automatic handover '+randomUUID(),input:{}},201);
 const file=await api('/v1/files','warehouse',{filename:'uc1-handover-proof.txt',contentBase64:Buffer.from('UC1 automatic handover acceptance').toString('base64')},201);assert.equal(file.scanStatus,'clean');
 for(const [action,actor,input] of [['submit','alice',{}],['approve','manager',{}],['receive','warehouse',{receiptAttachmentId:file.id}],['accept','warehouse',{acceptanceNote:'Automatic UC1 integration acceptance'}],['handover','warehouse2',{assetId:'urn:ngsi-ld:Asset:org-a:'+randomUUID(),recipientId:actors.receiver.subject,departmentId:'warehouse',locationId:'office-1',attachmentId:file.id}]])run=await api('/v1/workflows/'+run.id+'/transitions',actor,{action,expectedVersion:run.version,input});
 assert.equal(run.state,'handed_over');
 let job;const deadline=Date.now()+20000;
 do{job=(await api('/v1/workflows/'+run.id+'/sync','manager')).items[0];if(job?.status==='succeeded')break;await new Promise(r=>setTimeout(r,1000));}while(Date.now()<deadline);
 assert.equal(job?.status,'succeeded','Automatic outbox did not finish');
 const event=sqlRead('SELECT payload FROM workflow_jobs WHERE id=$1',[job.id])[0].payload;
 assert.equal(event.runId,run.id);assert.deepEqual(event.data,run.data);
 assert.deepEqual(sqlRead('SELECT id,status,attempts,lease_token,last_error FROM workflow_jobs WHERE run_id<>$1 ORDER BY id',[run.id]),backlog,'Pre-existing backlog changed');
 await mkdir(resolve(root,'output/uc1-handoff'),{recursive:true});
 const artifact=resolve(root,'output/uc1-handoff',job.id+'.json');await writeFile(artifact,JSON.stringify({format:'latticedx.uc1-handoff',event,workflow:{id:run.id,state:run.state,version:run.version},automaticDelivery:true},null,2));
 console.log('Automatic UC1 producer and outbox passed; prior backlog unchanged.');
 const output=execFileSync(process.execPath,[resolve(root,'scripts/smoke-uc1-handover.mjs'),artifact],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],encoding:'utf8',timeout:45000,maxBuffer:1024*1024});console.log(output.trim());
 console.log(JSON.stringify({automatic:true,runId:run.id,eventId:job.id,attempts:job.attempts,artifact}));
}
main().catch(()=>{console.error('Automatic UC1 acceptance failed; raw responses and tokens withheld.');process.exitCode=1;});
