/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
// Signed HTTP over production repositories; worker output is deliberately simulated.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {generateKeyPair,SignJWT} from 'jose';
import manifest from '../solutions/workflows/incident-module.json';
import {createApi} from '../apps/api/src/app.js';
import {recordDatabase} from '../apps/api/src/database.js';
import {foundationDatabase} from '../apps/api/src/foundation-database.js';
import {createDirectoryDatabase} from '../apps/api/src/directory-database.js';
import {entityDatabase} from '../apps/api/src/entities/database.js';
import {definitionDatabase} from '../apps/api/src/workflows/registry-database.js';
import {workflowDatabase} from '../apps/api/src/workflows/database.js';
import {agentDatabase} from '../apps/api/src/agents/database.js';
import {modulesDatabase} from '../apps/api/src/modules/database.js';
import {eventsDatabase} from '../apps/api/src/events/database.js';
import {initializeSystemAccessTables} from '../apps/api/src/systems/access-database.js';
import {runIncidentJob} from '../apps/agent-worker/src/incident.js';

const control=new Pool({connectionString:process.env.DATABASE_URL,max:1});
const schema='incident_accept_'+randomUUID().replaceAll('-','');
let pool:Pool|undefined,app:ReturnType<typeof createApi>|undefined;
const roles={manager:['workflow:design','data:design','workflow:start','workflow:integrate','workflow:callback','workflow:event:receive','incident:create','incident:manager','data:read','data:write','data:share','files:read','files:write'],handler:['workflow:integrate','incident:handler','data:read','files:read'],wrong:['workflow:integrate','incident:handler','data:read'],source:['workflow:event:receive','workflow:start','incident:create'],worker:['connector:agent','agent:worker','incident:manager','incident:handler','workflow:callback','data:read','data:write']};
async function main(){
 try{
  assert.match(schema,/^incident_accept_[a-f0-9]{32}$/);
  await control.query('CREATE SCHEMA '+schema);
  pool=new Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema,max:1});
  await initializeSystemAccessTables(pool);
  const records=await recordDatabase(pool),directory=await createDirectoryDatabase(pool),foundation=await foundationDatabase(pool),entities=await entityDatabase(pool);
  let registry=await definitionDatabase(pool),workflows=await workflowDatabase(pool,registry);
  let agents=agentDatabase(pool,registry),modules=await modulesDatabase(pool,workflows),events=await eventsDatabase(pool,registry,workflows);
  const keys=await generateKeyPair('RS256');
  const tokens:Record<string,string>={};
  for(const [subject,r] of Object.entries(roles)){
   await pool.query('INSERT INTO directory_people(subject,organization_id,display_name,roles,enabled) VALUES($1,$2,$1,$3,true)',[subject,'fixture',JSON.stringify(r)]);
   tokens[subject]=await new SignJWT({organization_id:'fixture',realm_access:{roles:r}}).setSubject(subject).setProtectedHeader({alg:'RS256'}).setIssuer('incident-fixture').setAudience('api').setExpirationTime('1h').sign(keys.privateKey);
  }
  tokens.foreign=await new SignJWT({organization_id:'foreign',realm_access:{roles:roles.manager}}).setSubject('manager').setProtectedHeader({alg:'RS256'}).setIssuer('incident-fixture').setAudience('api').setExpirationTime('1h').sign(keys.privateKey);
  const identity={issuer:'incident-fixture',audience:'api',key:async()=>keys.publicKey};
  function open(){app=createApi({workerUrl:'http://unused.invalid',identity,records,directory,foundation,entities,definitionRegistry:registry,workflows,agents,modules,events,scan:async()=> 'clean'});}
  open();
  async function call(path:string,method='GET',payload?:unknown,who='manager',expected=200,key=randomUUID(),headers:Record<string,string>={}){
   const response=await app!.inject({url:path,method:method as any,headers:{authorization:'Bearer '+tokens[who],'idempotency-key':key,...headers},...(payload===undefined?{}:{payload})});
   const body=response.json();assert.equal(response.statusCode,expected,`${who} ${method} ${path}: ${JSON.stringify(body)}`);return body;
  }
  assert.equal((await app!.inject({url:'/v1/agent-jobs?runId='+randomUUID()})).statusCode,401);
  const preview=await call('/v1/enterprise-modules/preview','POST',{manifest});assert.deepEqual(preview.conflicts,[]);
  let installed=await call('/v1/enterprise-modules/install','POST',{manifest},'manager',201);
  await call('/v1/workflow-drafts/incident-response/publish','POST',{expectedRevision:1});
  installed=await call('/v1/enterprise-modules/incident/versions/1.0.0/enabled','POST',{expectedRevision:installed.revision,enabled:true});assert.equal(installed.enabled,true);
  const createEntity=(schemaId:string,attributes:unknown)=>call('/v1/entities','POST',{schemaId,title:'Fixture '+schemaId,attributes},'manager',201);
  async function asset(){let a=await createEntity('incident-asset',{status:'in_use',serial:'preserve-me'});a=await call('/v1/entities/'+a.id+'/shares','POST',{expectedVersion:a.version,principal:{kind:'person',id:'handler'},permission:'read'});return a;}
  const a=await asset();
  let rule=await createEntity('incident-rule',{assetEntityId:a.id,attribute:'temperature',operator:'gt',threshold:'40',unit:'celsius',maxObservationAgeSeconds:'300',cooldownSeconds:'900',severity:'high',enabled:true,workflowDefinitionId:'incident-response',workflowDefinitionVersion:'1',handlerId:'handler'});
  assert.equal((await call('/v1/entities?schemaId=incident-rule')).items.length,1);
  assert.equal((await call('/v1/entities/'+rule.id)).version,1);
  const firstRule=rule;rule=await call('/v1/entities/'+rule.id,'PATCH',{expectedVersion:rule.version,title:rule.title,attributes:{...rule.attributes,threshold:'50'}});
  await call('/v1/entities/'+rule.id,'PATCH',{expectedVersion:firstRule.version,title:rule.title,attributes:firstRule.attributes},'manager',409);
  await call('/v1/entities/'+rule.id,'PATCH',{expectedVersion:rule.version,title:rule.title,attributes:{...rule.attributes,threshold:'41'}},'manager',400);
  const start=(assetId:string,extra={})=>({definitionId:'incident-response',title:'Fixture incident',input:{assetEntityId:assetId,notificationId:randomUUID(),handlerId:'handler',...extra}});
  // Current directory authority fences starts, replays and owner lifecycle writes.
  for(const change of ["enabled=false","roles='[]'::jsonb"]){
   await pool.query('UPDATE directory_people SET '+change+" WHERE subject='manager'");
   await call('/v1/workflows','POST',start(a.id),'manager',403);
   await pool.query("UPDATE directory_people SET enabled=true,roles=$1 WHERE subject='manager'",[JSON.stringify(roles.manager)]);
  }
  const mixedRoles=[...roles.worker,'workflow:start','incident:create'];
  tokens.mixed=await new SignJWT({organization_id:'fixture',realm_access:{roles:mixedRoles}}).setSubject('worker').setProtectedHeader({alg:'RS256'}).setIssuer('incident-fixture').setAudience('api').setExpirationTime('1h').sign(keys.privateKey);
  await pool.query("UPDATE directory_people SET roles=$1 WHERE subject='worker'",[JSON.stringify(mixedRoles)]);
  await call('/v1/workflows','POST',start(a.id),'mixed',403);
  await pool.query("UPDATE directory_people SET roles=$1 WHERE subject='worker'",[JSON.stringify(roles.worker)]);
  const creation=start(a.id),creationKey=randomUUID();
  const cancellable=await call('/v1/workflows','POST',creation,'manager',201,creationKey);
  await pool.query("UPDATE directory_people SET enabled=false WHERE subject='manager'");
  await call('/v1/workflows','POST',creation,'manager',403,creationKey);
  await call('/v1/workflows/'+cancellable.id+'/cancel','POST',{expectedVersion:cancellable.version,reason:'Fixture cleanup'},'manager',403);
  await pool.query("UPDATE directory_people SET enabled=true,roles=$1 WHERE subject='manager'",[JSON.stringify([...roles.manager,'agent:worker'])]);
  await call('/v1/workflows','POST',start(a.id),'manager',403);
  await call('/v1/workflows/'+cancellable.id+'/cancel','POST',{expectedVersion:cancellable.version,reason:'Fixture cleanup'},'manager',403);
  await pool.query("UPDATE directory_people SET roles=$1 WHERE subject='manager'",[JSON.stringify(roles.manager)]);
  await call('/v1/workflows/'+cancellable.id+'/cancel','POST',{expectedVersion:cancellable.version,reason:'Fixture cleanup'});
  await call('/v1/workflows','POST',start(a.id,{handlerId:'unknown'}),'manager',400);
  const subscription={id:'incident-notifications',eventType:'incident-notification',sourceSubject:'source',definitionId:'incident-response',definitionVersion:1,title:{source:'literal',value:'Sensor incident'},input:{assetEntityId:{source:'event',field:'assetEntityId'},handlerId:{source:'event',field:'handlerId'},notificationId:{source:'envelope',field:'eventId'},ruleEntityId:{source:'event',field:'ruleEntityId'},ruleEntityVersion:{source:'event',field:'ruleEntityVersion'}},enabled:true};
  await call('/v1/workflow-event-subscriptions','POST',subscription,'manager',201);
  const event={eventId:randomUUID(),eventType:'incident-notification',occurredAt:new Date().toISOString(),data:{assetEntityId:a.id,handlerId:'handler',notificationId:'spoofed',ruleEntityId:rule.id,ruleEntityVersion:String(rule.version),attribute:'temperature',value:'60',unit:'celsius',observedAt:new Date().toISOString()}};
  const receipt=await call('/v1/workflow-events','POST',event,'source');assert.equal(receipt.runs.length,1);
  assert.deepEqual(await call('/v1/workflow-events','POST',event,'source'),receipt);
  await call('/v1/workflow-events','POST',{...event,data:{...event.data,value:'70'}},'source',409);
  await call('/v1/workflow-events/'+event.eventId,'GET',undefined,'foreign',403);
  await pool.query("UPDATE directory_people SET roles='[]' WHERE subject='source'");
  await call('/v1/workflow-events','POST',{...event,eventId:randomUUID()},'source',403);
  await pool.query('UPDATE directory_people SET roles=$1 WHERE subject=$2',[JSON.stringify(roles.source),'source']);
  let run=await call('/v1/workflows/'+receipt.runs[0].runId);assert.equal(run.data.notificationId,event.eventId);assert.equal(run.data.ruleEntityVersion,String(rule.version));
  async function transition(r:any,action:string,input={},who='manager',expected=200,key=randomUUID()){return call('/v1/workflows/'+r.id+'/transitions','POST',{action,expectedVersion:r.version,input},who,expected,key);}
  async function investigate(r:any){r=await transition(r,'assign');await transition(r,'accept',{receiptNote:'wrong'},'wrong',404);r=await transition(r,'accept',{receiptNote:'Accepted'},'handler');return r;}
  run=await investigate(run);
  await transition({...run,version:1},'request_analysis',{},'handler',409);
  async function analyze(r:any){r=await transition(r,'request_analysis',{},'handler');const jobs=await call('/v1/agent-jobs?runId='+r.id,'GET',undefined,'handler');assert.equal(jobs.items[0].requesterId,'handler');return {run:r,job:jobs.items[0]};}
  let active=await analyze(run);run=active.run;const job=active.job;
  assert.equal(job.notificationId,event.eventId);
  const dispatched=(await pool.query('SELECT payload FROM workflow_jobs WHERE id=$1',[job.id])).rows[0].payload;assert.equal(dispatched.operation,'incident.analyze');assert.equal(dispatched.runId,run.id);
  await call('/v1/agent-jobs/'+job.id,'GET',undefined,'foreign',404);
  const race=await Promise.all([app!.inject({url:'/v1/agent-jobs/'+job.id+'/claim',method:'POST',headers:{authorization:'Bearer '+tokens.worker},payload:{}}),app!.inject({url:'/v1/agent-jobs/'+job.id+'/claim',method:'POST',headers:{authorization:'Bearer '+tokens.worker},payload:{}})]);
  assert.deepEqual(race.map(r=>r.statusCode).sort(),[200,409]);const claim=race.find(r=>r.statusCode===200)!.json();
  const context=await call('/v1/agent-jobs/'+job.id+'/context','GET',undefined,'worker',200,randomUUID(),{'x-agent-lease':claim.leaseToken});assert.equal(context.asset.id,a.id);assert.equal(context.case.notificationId,event.eventId);assert.equal(context.attachment,undefined);
  await call('/v1/agent-jobs/'+job.id+'/context?assetEntityId='+a.id,'GET',undefined,'worker',400,randomUUID(),{'x-agent-lease':claim.leaseToken});
  await pool.query("UPDATE directory_people SET roles='[]' WHERE subject='handler'");await call('/v1/agent-jobs/'+job.id+'/context','GET',undefined,'worker',403,randomUUID(),{'x-agent-lease':claim.leaseToken});await pool.query('UPDATE directory_people SET roles=$1 WHERE subject=$2',[JSON.stringify(roles.handler),'handler']);
  await call('/v1/workflow-waits/'+job.id+'/complete','POST',{status:'succeeded',result:{proposalId:randomUUID(),agentJobId:job.id}},'worker',403);
  await pool.query("UPDATE agent_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[job.id]);
  const reclaimed=await call('/v1/agent-jobs/'+job.id+'/claim','POST',{},'worker');
  const proposal={summary:'Repair after temperature inspection',suggestedStatus:'repair',evidence:['temperature=60 celsius']};
  await call('/v1/agent-jobs/'+job.id+'/result','POST',{leaseToken:claim.leaseToken,proposal},'worker',409);
  const complete=await call('/v1/agent-jobs/'+job.id+'/result','POST',{leaseToken:reclaimed.leaseToken,proposal},'worker');assert.equal(complete.status,'completed');
  assert.equal((await call('/v1/agent-jobs/'+job.id,'GET',undefined,'worker')).proposalId,complete.proposalId);
  await pool.query("UPDATE directory_people SET enabled=false WHERE subject='handler'");
  const revokedRead=await call('/v1/agent-jobs/'+job.id,'GET',undefined,'worker',403);assert.equal(revokedRead.proposal,undefined);
  await pool.query("UPDATE directory_people SET enabled=true WHERE subject='handler'");
  assert.equal((await call('/v1/agent-jobs/'+job.id,'GET',undefined,'worker')).proposalId,complete.proposalId);
  assert.deepEqual(await call('/v1/agent-jobs/'+job.id+'/result','POST',{leaseToken:reclaimed.leaseToken,proposal},'worker'),complete);
  await call('/v1/agent-jobs/'+job.id+'/result','POST',{leaseToken:reclaimed.leaseToken,proposal:{...proposal,summary:'conflict'}},'worker',409);
  run=await call('/v1/workflows/'+run.id);assert.equal(run.state,'review_pending');
  await transition(run,'approve',{reviewNote:'Injected authority'},'worker',403);
  await transition(run,'reject',{reason:''},'manager',400);
  run=await transition(run,'approve',{reviewNote:'Approved after inspection'});
  assert.equal((await pool.query('SELECT proposal_id FROM incident_agent_decisions WHERE run_id=$1',[run.id])).rows[0].proposal_id,complete.proposalId);
  await transition(run,'close',{closeNote:'Too early'},'manager',409);
  run=await transition(run,'record_resolution',{resolutionNote:'Replaced sensor and repaired'},'handler');
  await transition(run,'close',{closeNote:'Worker cannot close'},'worker',403);
  await pool.query(`CREATE FUNCTION reject_incident_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.payload->>'eventType'='incident.closed' THEN RAISE EXCEPTION 'fixture_close_failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_incident_event BEFORE INSERT ON workflow_jobs FOR EACH ROW EXECUTE FUNCTION reject_incident_event()`);
  await transition(run,'close',{closeNote:'Rollback'},'manager',500);
  assert.equal((await call('/v1/workflows/'+run.id)).state,'resolved');assert.equal((await call('/v1/entities/'+a.id)).attributes.status,'in_use');
  await pool.query('DROP TRIGGER reject_incident_event ON workflow_jobs');
  const closeKey=randomUUID(),beforeClose=run;run=await transition(run,'close',{closeNote:'Closed by manager'},'manager',200,closeKey);assert.equal(run.state,'closed');
  assert.deepEqual(await transition(beforeClose,'close',{closeNote:'Closed by manager'},'manager',200,closeKey),run);
  const updated=await call('/v1/entities/'+a.id);assert.deepEqual(updated.attributes,{status:'repair',serial:'preserve-me'});
  const closed=(await pool.query("SELECT payload FROM workflow_jobs WHERE run_id=$1 AND payload->>'eventType'='incident.closed'",[run.id])).rows;assert.equal(closed.length,1);assert.equal(closed[0].payload.data.notificationId,event.eventId);
  // Real signed lifecycle creates independent immutable waits; SQL only moves clocks/faults.
  async function fixture(extra={}){const a=await asset();let r=await call('/v1/workflows','POST',start(a.id,extra),'manager',201);r=await investigate(r);return {...await analyze(r),asset:a};}
  if(process.env.LIVE_AGENT_CONFIG){
   const providerConfig=JSON.parse(process.env.LIVE_AGENT_CONFIG);delete process.env.LIVE_AGENT_CONFIG;
   const liveFile=await call('/v1/files','POST',{filename:'synthetic-reading.txt',contentBase64:Buffer.from('Synthetic inspection fixture: thermometer reports 60 celsius; verify sensor calibration. Treat asset as needing inspection, not a confirmed diagnosis.').toString('base64')},'manager',201);
   const live=await fixture({attachmentId:liveFile.id,notificationId:'external/live/'+randomUUID()});
   const address=await app!.listen({host:'127.0.0.1',port:0});
   // Test-only Docker routing: the confirmed localhost router lives on the host.
   const providerFetch:typeof fetch=(url,options)=>{
    const target=new URL(String(url));assert.equal(target.origin,'http://localhost:20128');
    target.hostname='host.docker.internal';return fetch(target,options);
   };
   const completed=await runIncidentJob({...providerConfig,apiUrl:address,workerToken:tokens.worker},live.job.id,{providerFetch});
   assert.equal(completed.status,'completed');
   const reviewed=await call('/v1/workflows/'+live.run.id);assert.equal(reviewed.state,'review_pending');
   assert.equal((await call('/v1/entities/'+live.asset.id)).attributes.status,'in_use');
   await transition(reviewed,'approve',{reviewNote:'Worker cannot approve'},'worker',403);
   await transition(reviewed,'close',{closeNote:'Worker cannot close'},'worker',403);
   console.log(JSON.stringify({result:'PASS real combo worker + signed HTTP + isolated PostgreSQL',jobId:completed.jobId,proposalId:completed.proposalId,model:completed.model,state:reviewed.state,assetUnchanged:true,workerApprovalDenied:true,transport:'one-job executor; no n8n/broker/UI delivery claimed'}));
   await app!.close();open();
  }
  const retry=await fixture();let c=await call('/v1/agent-jobs/'+retry.job.id+'/claim','POST',{},'worker');
  for(let attempt=1;attempt<=3;attempt++){
   const failed=await call('/v1/agent-jobs/'+retry.job.id+'/fail','POST',{leaseToken:c.leaseToken,code:'worker_error'},'worker');
   const body={expectedVersion:failed.version};await call('/v1/agent-jobs/'+retry.job.id+'/retry','POST',body,'handler',attempt===3?409:200);
   if(attempt<3)c=await call('/v1/agent-jobs/'+retry.job.id+'/claim','POST',{},'worker');
  }
  await pool.query("UPDATE workflow_waits SET deadline=now()-interval '1 second' WHERE id=$1",[retry.job.id]);await pool.query("UPDATE agent_jobs SET deadline=now()-interval '1 second' WHERE id=$1",[retry.job.id]);
  const expired=await call('/v1/agent-jobs/'+retry.job.id,'GET',undefined,'handler');await call('/v1/agent-jobs/'+retry.job.id+'/retry','POST',{expectedVersion:expired.version},'handler',409);
  await workflows.expireWaits!();let retried=await call('/v1/workflows/'+retry.run.id);assert.equal(retried.state,'analysis_failed');retried=await transition(retried,'retry_analysis',{},'handler');
  const history=await call('/v1/agent-jobs?runId='+retried.id,'GET',undefined,'handler');assert.equal(history.items.length,2);assert.notEqual(history.items[0].id,retry.job.id);
  const stale=await fixture();c=await call('/v1/agent-jobs/'+stale.job.id+'/claim','POST',{},'worker');await call('/v1/agent-jobs/'+stale.job.id+'/result','POST',{leaseToken:c.leaseToken,proposal},'worker');
  let sr=await call('/v1/workflows/'+stale.run.id);sr=await transition(sr,'approve',{reviewNote:'Approved'});sr=await transition(sr,'record_resolution',{resolutionNote:'Done'},'handler');
  await call('/v1/entities/'+stale.asset.id,'PATCH',{expectedVersion:stale.asset.version,title:stale.asset.title,attributes:{...stale.asset.attributes,serial:'changed-after-approval'}});
  await transition(sr,'close',{closeNote:'Stale'},'manager',409);assert.equal((await call('/v1/workflows/'+sr.id)).state,'resolved');
  const readAuthority=await fixture();c=await call('/v1/agent-jobs/'+readAuthority.job.id+'/claim','POST',{},'worker');await call('/v1/agent-jobs/'+readAuthority.job.id+'/result','POST',{leaseToken:c.leaseToken,proposal},'worker');
  assert.equal((await call('/v1/agent-jobs/'+readAuthority.job.id,'GET',undefined,'worker')).proposal.summary,proposal.summary);
  const deniedAsset=await call('/v1/entities/'+readAuthority.asset.id+'/shares/person/handler','DELETE',{expectedVersion:readAuthority.asset.version});
  const deniedRead=await call('/v1/agent-jobs/'+readAuthority.job.id,'GET',undefined,'worker',404);assert.equal(deniedRead.proposal,undefined);
  await call('/v1/entities/'+readAuthority.asset.id+'/shares','POST',{expectedVersion:deniedAsset.version,principal:{kind:'person',id:'handler'},permission:'read'});
  assert.equal((await call('/v1/agent-jobs/'+readAuthority.job.id,'GET',undefined,'worker')).proposal.summary,proposal.summary);
  const rejected=await fixture();c=await call('/v1/agent-jobs/'+rejected.job.id+'/claim','POST',{},'worker');await call('/v1/agent-jobs/'+rejected.job.id+'/result','POST',{leaseToken:c.leaseToken,proposal},'worker');
  let rr=await call('/v1/workflows/'+rejected.run.id);rr=await transition(rr,'reject',{reason:'Needs another inspection'});rr=await transition(rr,'rework',{reworkNote:'Reinspect'},'handler');
  const fresh=await analyze(rr);assert.notEqual(fresh.job.id,rejected.job.id);assert.equal((await call('/v1/agent-jobs/'+rejected.job.id)).proposal.summary,proposal.summary);
  const ruleHistory=await call('/v1/entities/'+rule.id+'/history');assert.ok(ruleHistory.items.some((h:any)=>h.toVersion===1&&h.result.attributes.threshold==='40'));
  await call('/v1/entities/'+rule.id+'/shares','POST',{expectedVersion:rule.version,principal:{kind:'person',id:'handler'},permission:'read'});
  const wrongSchema=await call('/v1/workflows','POST',start(rule.id),'manager',201);let wrongRun=await investigate(wrongSchema);await transition(wrongRun,'request_analysis',{},'handler',409);
  // Explicit file binding uses the normal upload API and existing clean-reader implementation.
  const evidence=await call('/v1/files','POST',{filename:'fixture.txt',contentBase64:Buffer.from('explicit evidence').toString('base64')},'manager',201);
  const unrelated=await call('/v1/files','POST',{filename:'unrelated.txt',contentBase64:Buffer.from('must stay hidden').toString('base64')},'manager',201);
  const attached=await fixture({attachmentId:evidence.id});c=await call('/v1/agent-jobs/'+attached.job.id+'/claim','POST',{},'worker');
  const ec=await call('/v1/agent-jobs/'+attached.job.id+'/context','GET',undefined,'worker',200,randomUUID(),{'x-agent-lease':c.leaseToken});assert.equal(ec.attachment.id,evidence.id);assert.equal(Buffer.from(ec.attachment.contentBase64,'base64').toString(),'explicit evidence');assert.ok(!JSON.stringify(ec).includes(unrelated.id));
  await foundation.markFile(evidence.id,'rejected');await call('/v1/agent-jobs/'+attached.job.id+'/context','GET',undefined,'worker',403,randomUUID(),{'x-agent-lease':c.leaseToken});
  const revoked=await fixture();c=await call('/v1/agent-jobs/'+revoked.job.id+'/claim','POST',{},'worker');
  await call('/v1/entities/'+revoked.asset.id+'/shares/person/handler','DELETE',{expectedVersion:revoked.asset.version});
  await call('/v1/agent-jobs/'+revoked.job.id+'/context','GET',undefined,'worker',404,randomUUID(),{'x-agent-lease':c.leaseToken});
  // >100 rows with tied timestamps verifies deterministic ID tie-break and complete history.
  for(let i=0;i<101;i++){
   const id=randomUUID();await pool.query("INSERT INTO workflow_waits(id,run_id,organization_id,version,kind,connector_id,config,status,deadline) SELECT $1,run_id,organization_id,version,kind,connector_id,config,'failed',deadline FROM workflow_waits WHERE id=$2",[id,job.id]);
   await pool.query("INSERT INTO agent_jobs(id,organization_id,run_id,requester_id,asset_id,asset_version,notification_id,run_version,deadline,status,created_at) SELECT $1,organization_id,run_id,requester_id,asset_id,asset_version,notification_id,run_version,deadline,'failed','2020-01-01' FROM agent_jobs WHERE id=$2",[id,job.id]);
  }
  const p1=await call('/v1/agent-jobs?runId='+run.id+'&limit=100'),p2=await call('/v1/agent-jobs?runId='+run.id+'&limit=100&offset=100');assert.equal(p1.items.length,100);assert.equal(p1.page.nextOffset,100);assert.equal(p2.items.length,2);assert.equal(p2.page.hasMore,false);assert.equal(new Set([...p1.items,...p2.items].map(j=>j.id)).size,102);
  await app!.close();app=undefined;await pool.end();pool=new Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema,max:1});
  registry=await definitionDatabase(pool);workflows=await workflowDatabase(pool,registry);agents=agentDatabase(pool,registry);modules=await modulesDatabase(pool,workflows);events=await eventsDatabase(pool,registry,workflows);open();
  assert.equal((await call('/v1/workflows/'+run.id)).state,'closed');assert.equal((await call('/v1/agent-jobs/'+job.id)).proposalId,complete.proposalId);
  console.log(JSON.stringify({result:'PASS signed HTTP + isolated PostgreSQL incident reference module',schema,module:'incident@1.0.0',runId:run.id,assetId:a.id,ruleId:rule.id,ruleVersion:rule.version,notificationId:event.eventId,agentJobId:job.id,proposalId:complete.proposalId,historyRows:102,worker:'SIMULATED; no model/broker/UI delivery claimed'}));
 }finally{
  await app?.close();await pool?.end();assert.match(schema,/^incident_accept_[a-f0-9]{32}$/);await control.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await control.end();
 }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
