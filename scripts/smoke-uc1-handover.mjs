/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {parseEnv} from 'node:util';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import { dockerContextArgs } from './lib/docker-context.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),require=createRequire(import.meta.url),esbuild=createRequire(require.resolve('tsx/package.json'))('esbuild');
async function main(){
 if(process.argv.length!==3)throw Error('Usage: node scripts/smoke-uc1-handover.mjs output/uc1-handoff/<eventId>.json');
 const artifact=JSON.parse(await readFile(resolve(process.argv[2]),'utf8')),event=artifact.event;
 assert.equal(artifact.format,'latticedx.uc1-handoff');assert.match(event.eventId,/^[0-9a-f-]{36}$/);
 const env=parseEnv(await readFile(resolve(root,'.env.integration'),'utf8'));
 assert.match(env.UC1_HANDOVER_WEBHOOK_TOKEN??'',/^[A-Za-z0-9._~-]{32,256}$/);
 const url='http://localhost:5678/webhook/latticedx/uc1/handovers';
 async function deliver(body,token=env.UC1_HANDOVER_WEBHOOK_TOKEN,key=event.eventId){return fetch(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/json',Authorization:'Bearer '+token,'Idempotency-Key':key},body:JSON.stringify(body)});}
 const denied=await deliver(event,'invalid-fixture-credential');assert.equal(denied.status,403);await denied.body?.cancel();
 const bundle=esbuild.buildSync({entryPoints:[resolve(root,'scripts/uc1-dispatch-acceptance.ts')],bundle:true,platform:'node',format:'cjs',external:['pg'],write:false,logLevel:'silent'}).outputFiles[0].contents;
 const input=Buffer.concat([Buffer.from('process.env.UC1_ACCEPTANCE_INPUT='+JSON.stringify(JSON.stringify({eventId:event.eventId,token:env.UC1_HANDOVER_WEBHOOK_TOKEN}))+';\n'),bundle]);
 const result=execFileSync('docker',[...dockerContextArgs(), 'compose','--env-file',resolve(root,'.env.integration'),'-f',resolve(root,'infra/compose/core.yml'),'exec','-T','-w','/app/apps/api','api','node'],{cwd:root,input,windowsHide:true,stdio:['pipe','pipe','pipe'],encoding:'utf8',timeout:30000,maxBuffer:1024*1024});
 console.log(result.trim());
 const replay=await deliver(event);assert.equal(replay.status,200);const receipt=await replay.json();assert.equal(receipt.sourceEventId,event.eventId);assert.equal(receipt.assetId,event.data.assetId);
 const changed=await deliver({...event,data:{...event.data,locationId:'different'}});assert.equal(changed.status,409);await changed.body?.cancel();
 const noKey=await deliver(event,env.UC1_HANDOVER_WEBHOOK_TOKEN,'');assert.equal(noKey.status,400);await noKey.body?.cancel();
 const broker=await fetch('http://localhost:1026/ngsi-ld/v1/entities/'+encodeURIComponent(event.data.assetId),{headers:{'NGSILD-Tenant':event.organizationId,Accept:'application/ld+json'},signal:AbortSignal.timeout(5000)});
 assert.equal(broker.status,200);const asset=await broker.json(),ns='https://latticedx.example/ns/';
 const attr=name=>asset[name]??asset[ns+(name==='belongsToDepartment'?'department':name)];
 assert.equal(attr('status').value,'in_use');assert.equal(attr('sourceEventId').value,event.eventId);
 assert.equal(attr('belongsToDepartment').object,`urn:ngsi-ld:Department:${event.organizationId}:${event.data.departmentId}`);
 assert.equal(attr('locatedAt').object,`urn:ngsi-ld:Location:${event.organizationId}:${event.data.locationId}`);
 let projected;const deadline=Date.now()+10000;
 do{
  const response=await fetch('http://localhost:8080/v1/integrations/ngsi-ld/context?entityId='+encodeURIComponent(event.data.assetId),{headers:{'NGSILD-Tenant':event.organizationId,'X-Lattice-Broker-Token':env.NGSI_LD_NOTIFICATION_TOKEN},signal:AbortSignal.timeout(3000)});
  if(response.status===200){projected=await response.json();break;}assert.equal(response.status,404);await response.body?.cancel();await new Promise(r=>setTimeout(r,500));
 }while(Date.now()<deadline);
 assert.equal(projected?.entityId,event.data.assetId,'Broker notification must reach engine context storage');assert.equal(projected.status,'in_use');
 const evidence={format:'latticedx.uc1-end-to-end',eventId:event.eventId,runId:event.runId,assetId:event.data.assetId,backendJob:'succeeded',brokerStatus:'in_use',contextProjected:true,replay:true,deniedCredential:true,changedPayloadConflict:true,missingKeyRejected:true,uiAccepted:false,verifiedAt:new Date().toISOString()};
 await mkdir(resolve(root,'output/uc1-e2e'),{recursive:true});await writeFile(resolve(root,'output/uc1-e2e',event.eventId+'.json'),JSON.stringify(evidence,null,2)+'\n');
 console.log(JSON.stringify(evidence));
}
main().catch(()=>{console.error('UC1 end-to-end acceptance failed; no raw response or credential printed.');process.exitCode=1;});
