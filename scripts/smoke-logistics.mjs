/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const base='http://localhost:8080',actors={};
for(const username of ['alice','sales2','warehouse','warehouse2','warehouse-b']) {
  const r=await fetch('http://localhost:8081/realms/lattice/protocol/openid-connect/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'password',client_id:'dx-local',username,password:`local-${username}-password`}),signal:AbortSignal.timeout(15000)});
  assert.equal(r.status,200,`Login ${username}`);const {access_token}=await r.json();
  actors[username]={token:access_token,subject:JSON.parse(Buffer.from(access_token.split('.')[1],'base64url').toString()).sub};
}
async function call(path,actor='alice',method='GET',body,expected=200,key=randomUUID()) {
  const r=await fetch(base+path,{method,headers:{authorization:`Bearer ${actors[actor].token}`,'content-type':'application/json','Idempotency-Key':key},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(20000)});
  assert.equal(r.status,expected,`${actor} ${method} ${path}: ${r.status}`);
  return path.endsWith('/content')?r.text():r.json();
}
function sql(query){return execFileSync('docker',['--context','desktop-linux','compose','-f','infra/compose/core.yml','exec','-T','postgres','psql','-U','lattice','-d','lattice','-v','ON_ERROR_STOP=1','-t','-A'],{cwd:root,input:query,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();}
const literal=value=>"'"+String(value).replace(/'/g,"''")+"'";
const directory=await call('/v1/directory/people?role=logistics%3Awarehouse&department=warehouse&limit=1');
assert.equal(directory.items.length,1);assert.equal(directory.page.hasMore,true);
assert.ok(directory.items.every(p=>p.organizationId==='org-a'));
const second=await call(`/v1/directory/people?role=logistics%3Awarehouse&department=warehouse&limit=1&offset=${directory.page.nextOffset}`);
assert.notEqual(directory.items[0].subject,second.items[0].subject);
await call('/v1/directory/people','warehouse','GET',undefined,403);
await call('/v1/directory/people?limit=101','alice','GET',undefined,400);
const disabled=sql("SELECT subject FROM directory_people WHERE enabled=false AND organization_id='org-a' LIMIT 1;");assert.ok(disabled,'Need disabled local fixture');
for(const assigneeId of [randomUUID(),actors['warehouse-b'].subject,disabled]) {
  await call('/v1/tasks','alice','POST',{title:'Denied task',assigneeId},400);
  await call('/v1/actions/tasks.create/run','alice','POST',{version:1,input:{title:'Denied action task',assigneeId}},400);
}
async function upload(actor,recordId,infected=false){return call('/v1/files',actor,'POST',{filename:'logistics-evidence.txt',contentBase64:infected?'WDVPIVAlQEFQWzRcUFpYNTQoUF4pN0NDKTd9JEVJQ0FSLVNUQU5EQVJELUFOVElWSVJVUy1URVNULUZJTEUhJEgrSCo=':Buffer.from('Logistics clean evidence').toString('base64'),...(recordId?{recordId}:{})},201);}
const file=await upload('alice');assert.equal(file.scanStatus,'clean');
const payload={title:'Logistics acceptance '+randomUUID(),customerName:'CTU',deliveryAddress:'Can Tho',sku:'BOX-1',quantity:4,warehouseAssigneeId:actors.warehouse.subject,attachmentId:file.id};
const rejected=await upload('alice',undefined,true),foreignFile=await upload('sales2');assert.equal(rejected.scanStatus,'rejected');
for(const attachmentId of [rejected.id,foreignFile.id])await call('/v1/logistics/orders','alice','POST',{...payload,attachmentId},400);
const createKey=randomUUID();let order=await call('/v1/logistics/orders','alice','POST',payload,201,createKey);
assert.equal((await call('/v1/logistics/orders','alice','POST',payload,201,createKey)).id,order.id);
for(const fields of [{quantity:0},{quantity:1.5},{warehouseAssigneeId:actors.alice.subject},{warehouseAssigneeId:actors['warehouse-b'].subject},{attachmentId:randomUUID()},{organizationId:'org-b'}])await call('/v1/logistics/orders','alice','POST',{...payload,...fields},400);
await call(`/v1/logistics/orders/${order.id}`,'warehouse','GET',undefined,404);
await call(`/v1/files/${file.id}/content`,'warehouse','GET',undefined,404);
const submit={expectedVersion:order.version},submitKey=randomUUID();order=await call(`/v1/logistics/orders/${order.id}/submit`,'alice','POST',submit,200,submitKey);
assert.ok(order.taskId);assert.equal(order.state,'submitted');
assert.equal((await call(`/v1/logistics/orders/${order.id}/submit`,'alice','POST',submit,200,submitKey)).taskId,order.taskId);
assert.equal(sql(`SELECT count(*) FROM workflow_task_links WHERE run_id=${literal(order.id)};`),'1');
assert.ok((await call(`/v1/tasks?recordId=${order.id}&status=pending`,'warehouse')).items.some(t=>t.id===order.taskId));
assert.equal((await call(`/v1/tasks/${order.taskId}`,'warehouse')).recordId,order.id);
assert.equal((await call(`/v1/logistics/orders/${order.id}`,'warehouse')).quantity,4);
assert.equal(await call(`/v1/files/${file.id}/content`,'warehouse'),'Logistics clean evidence');
for(const peer of ['warehouse2','warehouse-b','sales2']) {
  await call(`/v1/logistics/orders/${order.id}`,peer,'GET',undefined,404);
  await call(`/v1/tasks/${order.taskId}`,peer,'GET',undefined,404);
  await call(`/v1/files/${file.id}/content`,peer,'GET',undefined,404);
}
await call(`/v1/tasks/${order.taskId}/decisions`,'warehouse','POST',{decision:'approve',expectedVersion:1},409);
await call(`/v1/logistics/orders/${order.id}/receive`,'warehouse2','POST',{expectedVersion:2,receiptNote:'Denied'},404);
const receive={expectedVersion:2,receiptNote:'Kho đã nhận việc'};
const responses=await Promise.all([1,2].map(()=>fetch(`${base}/v1/logistics/orders/${order.id}/receive`,{method:'POST',headers:{authorization:`Bearer ${actors.warehouse.token}`,'content-type':'application/json','Idempotency-Key':randomUUID()},body:JSON.stringify(receive)})));
assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);order=await responses.find(r=>r.status===200).json();
assert.equal(order.state,'received');assert.equal((await call(`/v1/tasks/${order.taskId}`,'warehouse')).status,'completed');
assert.equal((await call(`/v1/workflows/${order.id}/history`,'warehouse')).items.length,3);
const record=await call('/v1/records','alice','POST',{title:'Generic shared work '+randomUUID()},201);
const recordFile=await upload('alice',record.id);
const task=await call('/v1/actions/tasks.create/run','alice','POST',{version:1,input:{title:'Check generic record',assigneeId:actors.warehouse.subject,recordId:record.id}});
assert.equal(task.result.recordId,record.id);
assert.equal((await call(`/v1/records/${record.id}`,'warehouse')).id,record.id);
assert.equal(await call(`/v1/files/${recordFile.id}/content`,'warehouse'),'Logistics clean evidence');
await call(`/v1/records/${record.id}`,'warehouse2','GET',undefined,404);
await call(`/v1/files/${recordFile.id}/content`,'warehouse2','GET',undefined,404);
await call('/v1/tasks?limit=101','warehouse','GET',undefined,400);
await call('/v1/workflows?offset=-1','warehouse','GET',undefined,400);
const marker='Pagination-'+randomUUID(),ids=Array.from({length:106},()=>randomUUID()),taskIds=ids.map(()=>randomUUID());
try {
  const data=JSON.stringify({warehouseAssigneeId:actors.warehouse.subject,customerName:'Pagination fixture',deliveryAddress:'CTU',sku:'BOX',quantity:'1'});
  sql('BEGIN;\n'+ids.map((id,i)=>`INSERT INTO records(id,title,owner_id,organization_id) VALUES(${literal(id)},${literal(marker+' '+i)},${literal(actors.alice.subject)},'org-a');
INSERT INTO workflow_runs(id,definition_id,definition_version,title,owner_id,organization_id,state,version,data) VALUES(${literal(id)},'logistics_order',1,${literal(marker+' '+i)},${literal(actors.alice.subject)},'org-a','submitted',2,${literal(data)});
INSERT INTO foundation_tasks(id,title,organization_id,assignee_id,created_by,record_id) VALUES(${literal(taskIds[i])},${literal(marker+' '+i)},'org-a',${literal(actors.warehouse.subject)},${literal(actors.alice.subject)},${literal(id)});
INSERT INTO workflow_task_links(run_id,task_id) VALUES(${literal(id)},${literal(taskIds[i])});`).join('\n')+'\nCOMMIT;');
  for(const [path,actor] of [['/v1/logistics/orders','warehouse'],['/v1/workflows','warehouse'],['/v1/tasks','warehouse'],['/v1/records','alice']]) {
    const first=await call(`${path}?q=${marker}&limit=100`,actor);assert.equal(first.items.length,100);assert.equal(first.page.nextOffset,100);
    const rest=await call(`${path}?q=${marker}&limit=100&offset=100`,actor);assert.equal(rest.items.length,6);assert.equal(rest.page.hasMore,false);
    assert.equal(new Set([...first.items,...rest.items].map(r=>r.id)).size,106);
  }
  assert.equal((await call(`/v1/logistics/orders?q=${marker}&limit=100`,'warehouse2')).items.length,0);
  assert.equal((await call(`/v1/workflows?inbox=true&q=${marker}&limit=100`,'warehouse2')).items.length,0);
} finally {
  const set=ids.map(literal).join(','),tasks=taskIds.map(literal).join(',');
  sql(`BEGIN; DELETE FROM workflow_task_links WHERE run_id IN (${set}); DELETE FROM foundation_tasks WHERE id IN (${tasks}); DELETE FROM workflow_runs WHERE id IN (${set}); DELETE FROM records WHERE id IN (${set}); COMMIT;`);
}
console.log(JSON.stringify({result:'Logistics backend acceptance passed: scoped directory, REST/action assignees, exact warehouse work, shared evidence, atomic task/state, replay/concurrency and pagination beyond 100.',orderId:order.id,taskId:order.taskId,recordId:record.id}));
