// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
const origin=new URL(process.env.NOCOBASE_URL??'http://localhost:13000');
assert(['localhost','127.0.0.1'].includes(origin.hostname),'Local acceptance only');
const base=new URL('/api/',origin).href,suffix=randomUUID().replaceAll('-','').slice(0,12),org='ingress_'+suffix,fixtures=[],flows=[],checks=[],brokerFixtures=[];
async function call(path,{method='GET',token,values}={}){
 const r=await fetch(base+path,{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},...(values?{body:JSON.stringify(values)}:{}),signal:AbortSignal.timeout(15000)});
 const raw=await r.text();let b;try{b=JSON.parse(raw);}catch{b={};}return {status:r.status,data:b.data,error:b.errors?.[0]?.message};
}
async function ok(path,options){const r=await call(path,options);assert.ok(r.status<300,path+' HTTP '+r.status+' '+(r.error??''));return r.data;}
const deadline=Date.now()+45000;while(true){try{const r=await fetch(base+'app:getLang',{signal:AbortSignal.timeout(2000)});if(r.ok)break;}catch{}if(Date.now()>deadline)throw Error('Native runtime not ready');await new Promise(r=>setTimeout(r,500));}
const root=(await ok('auth:signIn',{method:'POST',values:{email:'admin@nocobase.com',password:'admin123'}})).token;
async function create(resource,values,token=root){const row=await ok(resource+':create',{method:'POST',token,values});fixtures.push({resource,id:row.id});return row;}
async function actor(role,organizationId=org){
 const password=randomUUID(),email=randomUUID()+'@example.invalid';
 const user=await create('users',{username:randomUUID(),email,password,roles:[role]});
 const employee=await create('latticeEmployees',{code:randomUUID(),name:'Integration acceptance',organizationId,userId:user.id,active:true});
 return {user,employee,token:(await ok('auth:signIn',{method:'POST',values:{email,password}})).token};
}
const tool=(actor,action,values)=>call('latticeIntegrations:'+action,{method:'POST',token:actor?.token,values});
const query=filter=>'filter='+encodeURIComponent(JSON.stringify(filter));
async function observer(collection){
 const w=await create('workflows',{title:'Acceptance observer '+suffix+' '+collection,type:'collection',enabled:false,sync:false,config:{collection,mode:1,condition:{organizationId:org}}});flows.push(w.id);
 await ok(`workflows/${w.id}/nodes:create`,{method:'POST',token:root,values:{key:'end',type:'end',title:'Observe native event',config:{endStatus:1}}});
 await ok('workflows:update?filterByTk='+w.id,{method:'POST',token:root,values:{enabled:true}});return w;
}
async function waitExecution(w,count){
 const deadline=Date.now()+15000;
 do{const rows=await ok('executions:list?'+query({workflowId:w.id}),{token:root});if(rows.length===count&&rows.every(r=>r.status===1))return rows;await new Promise(r=>setTimeout(r,200));}while(Date.now()<deadline);
 throw Error('Native observer execution count mismatch');
}
const specialRole='integration_fields_'+suffix;
let roleCreated=false;
try{
 const connector=await actor('ldx_connector'),employee=await actor('ldx_employee'),foreign=await actor('ldx_employee','foreign_'+suffix),director=await actor('ldx_director');
 const asset=await create('latticeAssets',{code:randomUUID(),name:'Integration scanner',organizationId:org,status:'available'});
 const otherAsset=await create('latticeAssets',{code:randomUUID(),name:'Foreign scanner',organizationId:'foreign_'+suffix});
 brokerFixtures.push({org,id:`urn:ngsi-ld:Asset:${org}:native:${asset.id}`},{org:'foreign_'+suffix,id:`urn:ngsi-ld:Asset:foreign_${suffix}:native:${otherAsset.id}`});
 const order=await create('latticeOrders',{code:randomUUID(),name:'Integration order',customer:'Private customer',quantity:3},employee.token);
 const inboxObserver=await observer('latticeIntegrationInbox'),proposalObserver=await observer('latticeAgentProposals');
 const queue=await ok('latticeContextSync:status?pageSize=100',{token:root});const projection=queue.items.find(e=>e.collectionName==='latticeAssets'&&String(e.recordId)===String(asset.id));assert.ok(projection);
 if(projection.state!=='delivered')assert.equal((await ok('latticeContextSync:dispatch',{method:'POST',token:root,values:{eventId:projection.eventId}})).state,'delivered');
 const ctxRead=await tool(employee,'context',{collection:'latticeAssets',recordId:asset.id});assert.equal(ctxRead.status,200);assert.equal(ctxRead.data.context.id,projection.entityId);assert.equal(ctxRead.data.context.status.value,'available');checks.push('context_tool_reads_real_scoped_native_orion_projection');
 assert.equal((await tool(foreign,'context',{collection:'latticeAssets',recordId:asset.id})).status,404);
 const input={eventId:'sensor-'+suffix,kind:'observation',observedAt:new Date().toISOString(),data:{assetId:asset.id,attribute:'temperature',value:39,unit:'CEL'}};
 assert.equal((await tool(null,'receive',input)).status,401);assert.equal((await tool(employee,'receive',input)).status,403);checks.push('native_auth_and_connector_role_required');
 const concurrent=await Promise.all([tool(connector,'receive',input),tool(connector,'receive',input)]);
 assert.ok(concurrent.every(r=>r.status===200));assert.equal(concurrent[0].data.id,concurrent[1].data.id);assert.equal(concurrent.filter(r=>r.data.duplicate).length,1);checks.push('concurrent_ingress_replay_single_native_record');
 const inbox=(await ok('latticeIntegrationInbox:list?'+query({organizationId:org}),{token:root}));assert.equal(inbox.length,1);assert.equal(inbox[0].sourceUserId,connector.user.id);assert.equal(inbox[0].organizationId,org);checks.push('verified_source_and_organization_are_server_owned');
 await waitExecution(inboxObserver,1);checks.push('ingress_triggers_native_workflow_once');
 assert.equal((await tool(connector,'receive',{...input,data:{...input.data,value:40}})).status,409);
 assert.equal((await tool(connector,'receive',{...input,organizationId:'foreign_'+suffix})).status,400);
 assert.equal((await tool(connector,'receive',{...input,eventId:123})).status,400);
 assert.equal((await tool(connector,'receive',{...input,eventId:'foreign-'+suffix,data:{...input.data,assetId:otherAsset.id}})).status,404);checks.push('conflicting_replay_forged_scope_and_foreign_asset_denied');
 const late=await tool(connector,'receive',{...input,eventId:'late-'+suffix,observedAt:new Date(Date.now()-360000).toISOString()});assert.equal(late.status,200);
 const lateRow=await ok('latticeIntegrationInbox:get?filterByTk='+late.data.id,{token:root});assert.equal(lateRow.late,true);checks.push('late_observation_labelled_without_mutating_asset');
 for(const kind of ['external-order','external-request']){
  const received=await tool(connector,'receive',{eventId:kind+'-'+suffix,kind,observedAt:new Date().toISOString(),data:{code:kind+'-'+suffix,name:'External integration fixture',...(kind==='external-order'?{quantity:2,customer:'Fixture only'}:{description:'Fixture request'})}});
  assert.equal(received.status,200);assert.equal(received.data.accepted,true);
 }
 await waitExecution(inboxObserver,4);checks.push('external_order_and_request_use_native_inbox_event_boundary');
 const unchanged=await ok('latticeAssets:get?filterByTk='+asset.id,{token:root});assert.equal(unchanged.status,'available');
 const visible=await tool(employee,'record',{collection:'latticeOrders',recordId:order.id});assert.equal(visible.status,200);assert.equal(visible.data.record.customer,'Private customer');
 assert.equal((await tool(foreign,'record',{collection:'latticeOrders',recordId:order.id})).status,404);checks.push('record_tool_reuses_native_data_scope_acl');
 await ok('roles:create',{method:'POST',token:root,values:{name:specialRole,title:specialRole,strategy:{actions:[]},resources:[{name:'latticeOrders',dataSourceKey:'main',usingActionsConfig:true,actions:[{name:'view',fields:['id','name']}]}]}});roleCreated=true;
 const restricted=await actor(specialRole);
 const limited=await tool(restricted,'record',{collection:'latticeOrders',recordId:order.id});assert.equal(limited.status,200);assert.equal(limited.data.record.customer,undefined);assert.equal(limited.data.record.quantity,undefined);checks.push('record_tool_preserves_native_field_acl');
 const proposal={eventId:'proposal-'+suffix,collection:'latticeOrders',recordId:order.id,fingerprint:visible.data.fingerprint,text:'Please verify inventory before fulfillment.'};
 assert.equal((await tool(director,'propose',proposal)).status,403);assert.equal((await tool(connector,'propose',proposal)).status,403);checks.push('native_proposal_capability_not_granted_to_readonly_or_connector_roles');
 const p=await tool(employee,'propose',proposal);assert.equal(p.status,200);assert.equal(p.data.requiresHumanApproval,true);
 const again=await tool(employee,'propose',proposal);assert.equal(again.data.id,p.data.id);assert.equal(again.data.duplicate,true);await waitExecution(proposalObserver,1);checks.push('proposal_idempotent_and_native_workflow_triggered_once');
 const journal=await ok('latticeAgentProposals:get?filterByTk='+p.data.id,{token:root});assert.equal(journal.state,'proposed');assert.equal(journal.evidence[0].fingerprint,visible.data.fingerprint);
 const assetRead=await tool(employee,'record',{collection:'latticeAssets',recordId:asset.id});
 const contextProposal=await tool(employee,'propose',{eventId:'context-proposal-'+suffix,collection:'latticeAssets',recordId:asset.id,fingerprint:assetRead.data.fingerprint,contextFingerprint:ctxRead.data.fingerprint,text:'Check this asset using its verified broker context.'});assert.equal(contextProposal.status,200);
 const contextJournal=await ok('latticeAgentProposals:get?filterByTk='+contextProposal.data.id,{token:root});assert.equal(contextJournal.evidence[1].kind,'ngsi-ld');checks.push('proposal_binds_native_and_context_evidence');
 assert.equal((await tool(employee,'propose',{eventId:'wrong-context-'+suffix,collection:'latticeAssets',recordId:asset.id,fingerprint:assetRead.data.fingerprint,contextFingerprint:'a'.repeat(64),text:'Invalid context hash'})).status,409);
 const page=await tool(employee,'proposals',{collection:'latticeOrders',recordId:order.id,page:1,pageSize:1});assert.equal(page.data.pageSize,1);assert.equal(page.data.total,1);checks.push('proposal_list_has_native_pagination_metadata');
 for(const action of ['approve','execute'])assert.ok([403,404].includes((await tool(employee,action,{id:p.data.id})).status));
 assert.equal((await tool(employee,'propose',{...proposal,state:'approved'})).status,400);checks.push('agent_has_no_approval_or_execution_endpoint');
 assert.equal((await tool(restricted,'proposals',{collection:'latticeOrders',recordId:order.id})).data.items[0].stale,true);checks.push('proposal_text_hidden_when_current_field_visibility_differs');
 await ok('latticeOrders:update?filterByTk='+order.id,{method:'POST',token:root,values:{name:'Changed order'}});
 assert.equal((await tool(employee,'propose',{...proposal,eventId:'stale-'+suffix})).status,409);
 const stale=await tool(employee,'proposals',{collection:'latticeOrders',recordId:order.id});assert.equal(stale.data.items[0].stale,true);assert.equal(stale.data.items[0].recommendation,undefined);checks.push('stale_evidence_cannot_create_or_disclose_proposal_text');
 for(const resource of ['latticeIntegrationInbox','latticeAgentProposals'])assert.equal((await call(resource+':list',{token:employee.token})).status,403);checks.push('journals_not_exposed_through_generic_collection_api');
 await ok('latticeEmployees:update?filterByTk='+connector.employee.id,{method:'POST',token:root,values:{active:false}});assert.equal((await tool(connector,'receive',input)).status,403);checks.push('revoked_membership_blocks_existing_connector_session');
 await mkdir('output/native-platform',{recursive:true});await writeFile('output/native-platform/native-integration-acceptance.json',JSON.stringify({at:new Date().toISOString(),checks,scope:'Real native HTTP auth/ACL + PostgreSQL receipts + disposable native collection-trigger observers. No live model, n8n workflow, production broker subscription or UI claim.'},null,2));console.log(JSON.stringify({result:'PASS',checks}));
}finally{
 for(const id of flows)await ok('workflows:update?filterByTk='+id,{method:'POST',token:root,values:{enabled:false}});
 for(const resource of ['latticeAgentProposals','latticeIntegrationInbox'])await ok(resource+':destroy?'+query({organizationId:org}),{method:'POST',token:root});
 for(const fixture of fixtures.reverse())await ok(fixture.resource+':destroy?filterByTk='+fixture.id,{method:'POST',token:root});
 for(const organizationId of [org,'foreign_'+suffix])await ok('latticeContextOutbox:destroy?'+query({organizationId}),{method:'POST',token:root});
 for(const fixture of brokerFixtures){const r=await fetch('http://localhost:1026/ngsi-ld/v1/entities/'+encodeURIComponent(fixture.id),{method:'DELETE',headers:{'NGSILD-Tenant':fixture.org},signal:AbortSignal.timeout(5000)});assert.ok([204,404].includes(r.status));}
 if(roleCreated)await ok('roles:destroy?filterByTk='+specialRole,{method:'POST',token:root});
}
