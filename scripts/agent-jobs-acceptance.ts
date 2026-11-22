/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
// Disposable real PostgreSQL fixture. Worker output is simulated, no model delivery claimed.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {recordDatabase} from '../apps/api/src/database.js';
import {foundationDatabase} from '../apps/api/src/foundation-database.js';
import {entityDatabase} from '../apps/api/src/entities/database.js';
import {workflowDatabase} from '../apps/api/src/workflows/database.js';
import {agentDatabase} from '../apps/api/src/agents/database.js';
const control=new Pool({connectionString:process.env.DATABASE_URL}),schema='agent_smoke_'+randomUUID().replaceAll('-','');
let pool:Pool|undefined;
async function main(){
 try{
  await control.query('CREATE SCHEMA '+schema);pool=new Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema,max:5});
  await recordDatabase(pool);await foundationDatabase(pool);const entities=await entityDatabase(pool);
  const human={subject:'human',organizationId:'org',roles:['workflow:start','incident:manager','workflow:integrate','data:read','data:write','files:read']};
  const worker={subject:'worker',organizationId:'org',roles:['connector:agent','agent:worker']};
  for(const a of [human,worker])await pool.query('INSERT INTO directory_people(subject,organization_id,display_name,roles,enabled) VALUES($1,$2,$1,$3,true)',[a.subject,a.organizationId,JSON.stringify(a.roles)]);
  const config={stepId:'analyze',successState:'review_pending',failureState:'analysis_failed',timeoutSeconds:300,resultFields:{proposalId:'text',agentJobId:'text'}};
  const definition:any={id:'incident-response',version:1,title:'Incident',startRole:'incident:manager',initialState:'investigating',startFields:{assetEntityId:'text',notificationId:'text',handlerId:'text'},readerRoles:['incident:manager'],transitions:[{id:'request_analysis',from:'investigating',to:'analyzing',role:'incident:manager',fields:{},steps:[{id:'analyze',action:'connectors.dispatch',input:{connectorId:{source:'literal',value:'agent'},operation:{source:'literal',value:'incident.analyze'},payload:{}}}],wait:config},{id:'approve',from:'review_pending',to:'approved',role:'incident:manager',fields:{reviewNote:'text'}},{id:'record_resolution',from:'approved',to:'resolved',role:'incident:manager',fields:{resolutionNote:'text'}},{id:'close',from:'resolved',to:'closed',role:'incident:manager',fields:{closeNote:'text'},eventType:'incident.closed'}]};
  const registry:any={get:async()=>definition,list:async()=>[definition]};const workflows=await workflowDatabase(pool,registry),agents=agentDatabase(pool,registry);
  const scope={actorId:human.subject,organizationId:human.organizationId};
  await entities.createSchema(scope,{id:'incident-asset',title:'Asset',fields:{status:{type:'enum',choices:['ready','in_use','repair','retired']},serial:{type:'text'}},relations:{}});await entities.publishSchema(scope,'incident-asset',1);
  async function fixture(assetSchema='incident-asset'){const asset=await entities.create(scope,{schemaId:assetSchema,title:'Pump',attributes:{status:'in_use',serial:'keep-me'}},randomUUID());let run=await workflows.create({definitionId:'incident-response',title:'Fixture incident',input:{assetEntityId:asset.id,notificationId:randomUUID(),handlerId:'human'}},human,randomUUID());await pool!.query("UPDATE workflow_runs SET owner_id='event:source' WHERE id=$1",[run.id]);run=await workflows.transition(run.id,{action:'request_analysis',expectedVersion:1,input:{}},human,randomUUID());const id=(await pool!.query('SELECT id FROM agent_jobs WHERE run_id=$1',[run.id])).rows[0].id;return {asset,run,id};}
  // Independent gate regressions: collect failures so RED demonstrates all boundaries.
  const gateFailures:string[]=[];
  async function gate(name:string,fn:()=>Promise<void>){try{await fn();console.log('PASS gate '+name);}catch(error){gateFailures.push(name);console.error('FAIL gate '+name,error);}}
  await gate('unrelated callback operation remains usable',async()=>{const other=await fixture();await pool!.query('DELETE FROM agent_jobs WHERE id=$1',[other.id]);await pool!.query("UPDATE workflow_runs SET definition_id='unrelated-agent-flow' WHERE id=$1",[other.run.id]);const result=await workflows.completeWait!(other.id,{status:'succeeded',result:{proposalId:randomUUID(),agentJobId:other.id}},{...worker,roles:[...worker.roles,'workflow:callback']},randomUUID());assert.equal(result.state,'review_pending');});
  await gate('wrong schema cannot enqueue incident analysis',async()=>{await entities.createSchema(scope,{id:'unrelated',title:'Unrelated',fields:{status:{type:'enum',choices:['ready','in_use','repair','retired']},serial:{type:'text'}},relations:{}});await entities.publishSchema(scope,'unrelated',1);await assert.rejects(()=>fixture('unrelated'),(e:any)=>e.statusCode===409);});
  async function blockedExpiry(operation:'result'|'claim'|'context'){
   const delayed=await fixture();const claim=operation==='claim'?undefined:await agents.claim(delayed.id,worker);
   if(claim)await pool!.query("UPDATE agent_jobs SET lease_until=clock_timestamp()+interval '400 milliseconds' WHERE id=$1",[delayed.id]);
   else {await pool!.query("UPDATE workflow_waits SET deadline=clock_timestamp()+interval '400 milliseconds' WHERE id=$1",[delayed.id]);await pool!.query("UPDATE agent_jobs SET deadline=clock_timestamp()+interval '400 milliseconds' WHERE id=$1",[delayed.id]);}
   const blocker=await pool!.connect();
   try{await blocker.query('BEGIN');const pid=(await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;await blocker.query('SELECT id FROM enterprise_entities WHERE id=$1 FOR UPDATE',[delayed.asset.id]);
    const pending=(operation==='claim'?agents.claim(delayed.id,worker):operation==='context'?agents.context(delayed.id,worker,claim!.leaseToken):agents.result(delayed.id,worker,claim!.leaseToken,{summary:'Delayed',suggestedStatus:'repair',evidence:[]})).then(value=>({value,error:undefined}),error=>({value:undefined,error}));
    let waiting=false;for(let n=0;n<100;n++){waiting=(await pool!.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS waiting',[pid])).rows[0].waiting;if(waiting)break;await new Promise(resolve=>setTimeout(resolve,10));}assert.equal(waiting,true,'operation must be blocked on authoritative Asset lock');
    await blocker.query('SELECT pg_sleep(0.5)');await blocker.query('COMMIT');const outcome=await pending;assert.equal(outcome.error?.statusCode,409,'operation expired while waiting for Asset authorization');const stored=(await pool!.query('SELECT status,proposal_id FROM agent_jobs WHERE id=$1',[delayed.id])).rows[0];assert.equal(stored.proposal_id,null);assert.equal(stored.status,operation==='claim'?'queued':'running');assert.equal((await workflows.get(delayed.run.id,human)).state,'analyzing');
   }finally{await blocker.query('ROLLBACK');blocker.release();}
  }
  for(const operation of ['result','claim','context'] as const)await gate('lock-delayed '+operation+' expiry',()=>blockedExpiry(operation));
  assert.deepEqual(gateFailures,[],'independent review gates');
  const f=await fixture();assert.equal((await agents.list(f.run.id,human)).items.length,1);assert.equal((await agents.get(f.id,human)).requesterId,'human');assert.equal((await pool.query('SELECT status FROM workflow_jobs WHERE id=$1',[f.id])).rows[0].status,'pending');await agents.create(f.run.id,f.id,human,'create-once');assert.equal((await agents.create(f.run.id,f.id,human,'create-once')).id,f.id);
  await assert.rejects(()=>agents.get(f.id,{...worker,organizationId:'foreign'}),(e:any)=>e.statusCode===404);
  const outcomes=await Promise.allSettled([agents.claim(f.id,worker),agents.claim(f.id,worker)]);assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
  const first=(outcomes.find(x=>x.status==='fulfilled') as PromiseFulfilledResult<any>).value;
  assert.equal((await agents.context(f.id,worker,first.leaseToken)).asset.attributes.serial,'keep-me');
  await assert.rejects(()=>workflows.completeWait!(f.id,{status:'succeeded',result:{proposalId:randomUUID(),agentJobId:f.id}},{...worker,roles:[...worker.roles,'workflow:callback']},randomUUID()),(e:any)=>e.statusCode===403);
  await pool.query("UPDATE agent_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[f.id]);
  const second=await agents.claim(f.id,worker);assert.equal(second.attempts,2);
  const proposal={summary:'Repair pump',suggestedStatus:'repair' as const,evidence:['Temperature high']};
  await assert.rejects(()=>agents.result(f.id,worker,first.leaseToken,proposal),(e:any)=>e.statusCode===409);
  // A late SQL failure must roll back proposal, attempt and workflow writes together.
  await pool.query(`CREATE FUNCTION reject_settlement() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='succeeded' THEN RAISE EXCEPTION 'fixture_settlement_failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_settlement BEFORE UPDATE ON workflow_waits FOR EACH ROW EXECUTE FUNCTION reject_settlement()`);
  await assert.rejects(()=>agents.result(f.id,worker,second.leaseToken,proposal));
  assert.equal((await agents.get(f.id,human)).status,'running');assert.equal((await agents.get(f.id,human)).proposalId,null);assert.equal((await workflows.get(f.run.id,human)).state,'analyzing');
  await pool.query('DROP TRIGGER reject_settlement ON workflow_waits');
  const done=await agents.result(f.id,worker,second.leaseToken,proposal);assert.equal(done.status,'completed');await assert.rejects(()=>pool!.query("UPDATE agent_jobs SET proposal='{}'::jsonb WHERE id=$1",[f.id]));assert.equal((await workflows.get(f.run.id,human)).state,'review_pending');
  await pool.query("UPDATE agent_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[f.id]);
  assert.equal((await agents.result(f.id,worker,second.leaseToken,proposal)).proposalId,done.proposalId);
  await assert.rejects(()=>agents.result(f.id,worker,second.leaseToken,{...proposal,summary:'Changed'}),(e:any)=>e.statusCode===409);
  await pool.query("UPDATE directory_people SET enabled=false WHERE subject='human'");
  await assert.rejects(()=>agents.result(f.id,worker,second.leaseToken,proposal),(e:any)=>e.statusCode===403);
  await pool.query("UPDATE directory_people SET enabled=true WHERE subject='human'");
  let run=await workflows.get(f.run.id,human);
  await assert.rejects(()=>workflows.transition(run.id,{action:'approve',expectedVersion:run.version,input:{reviewNote:'x'}},{...worker,roles:[...worker.roles,'incident:manager']},randomUUID()),(e:any)=>e.statusCode===403);
  run=await workflows.transition(run.id,{action:'approve',expectedVersion:run.version,input:{reviewNote:'Approved'}},human,randomUUID());
  run=await workflows.transition(run.id,{action:'record_resolution',expectedVersion:run.version,input:{resolutionNote:'Repaired'}},human,randomUUID());
  await pool.query(`CREATE FUNCTION reject_close_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.payload->>'eventType'='incident.closed' THEN RAISE EXCEPTION 'fixture_close_failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_close_event BEFORE INSERT ON workflow_jobs FOR EACH ROW EXECUTE FUNCTION reject_close_event()`);await assert.rejects(()=>workflows.transition(run.id,{action:'close',expectedVersion:run.version,input:{closeNote:'Rollback'}},human,randomUUID()));assert.equal((await entities.find(scope,f.asset.id))!.attributes.status,'in_use');assert.equal((await workflows.get(run.id,human)).state,'resolved');await pool.query('DROP TRIGGER reject_close_event ON workflow_jobs');run=await workflows.transition(run.id,{action:'close',expectedVersion:run.version,input:{closeNote:'Closed'}},human,randomUUID());
  assert.equal(run.state,'closed');assert.deepEqual((await entities.find(scope,f.asset.id))!.attributes,{status:'repair',serial:'keep-me'});
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM workflow_jobs WHERE run_id=$1 AND payload->>'eventType'='incident.closed'",[run.id])).rows[0].n,1);
  const acl=await fixture();await assert.rejects(()=>agents.create(acl.run.id,acl.id,human,'create-once'),(e:any)=>e.statusCode===409);await pool.query("UPDATE enterprise_entities SET owner_id='asset-owner' WHERE id=$1",[acl.asset.id]);await pool.query("INSERT INTO enterprise_entity_shares(entity_id,organization_id,kind,principal_id,permission) VALUES($1,'org','person','human','read')",[acl.asset.id]);const aclClaim=await agents.claim(acl.id,worker);await pool.query('DELETE FROM enterprise_entity_shares WHERE entity_id=$1',[acl.asset.id]);await assert.rejects(()=>agents.context(acl.id,worker,aclClaim.leaseToken),(e:any)=>e.statusCode===404);await assert.rejects(()=>agents.result(acl.id,worker,aclClaim.leaseToken,proposal),(e:any)=>e.statusCode===404);const fileCase=await fixture();const fileId=randomUUID();await pool.query("INSERT INTO foundation_files(id,filename,owner_id,organization_id,content,size,scan_status) VALUES($1,'fixture.txt','human','org',$2,4,'infected')",[fileId,Buffer.from('test')]);await pool.query('INSERT INTO workflow_files(run_id,file_id) VALUES($1,$2)',[fileCase.run.id,fileId]);await pool.query("UPDATE workflow_runs SET data=data||$2::jsonb WHERE id=$1",[fileCase.run.id,JSON.stringify({attachmentId:fileId})]);await pool.query('UPDATE agent_jobs SET attachment_id=$2 WHERE id=$1',[fileCase.id,fileId]);await assert.rejects(()=>agents.claim(fileCase.id,worker),(e:any)=>e.statusCode===403);const cap=await fixture();for(let n=1;n<=3;n++){const c=await agents.claim(cap.id,worker);const failure=await agents.fail(cap.id,worker,c.leaseToken,'worker_error');if(n<3)await agents.retry(cap.id,human,failure.version,'cap-'+n);else await assert.rejects(()=>agents.retry(cap.id,human,failure.version,'cap-final'),(e:any)=>e.statusCode===409);}const retry=await fixture();let claim=await agents.claim(retry.id,worker);const failed=await agents.fail(retry.id,worker,claim.leaseToken,'worker_error');
  const queued=await agents.retry(retry.id,human,failed.version,'retry-once');assert.equal(queued.status,'queued');assert.deepEqual(await agents.retry(retry.id,human,failed.version,'retry-once'),queued);
  claim=await agents.claim(retry.id,worker);await agents.fail(retry.id,worker,claim.leaseToken,'invalid_output');const expired=await agents.get(retry.id,human);
  await pool.query("UPDATE workflow_waits SET deadline=now()-interval '1 second' WHERE id=$1",[retry.id]);await pool.query("UPDATE agent_jobs SET deadline=now()-interval '1 second' WHERE id=$1",[retry.id]);
  await assert.rejects(()=>agents.retry(retry.id,human,expired.version,'retry-too-late'),(e:any)=>e.statusCode===409);assert.equal((await agents.get(retry.id,human)).status,'timed_out');await workflows.expireWaits!();assert.equal((await workflows.get(retry.run.id,human)).state,'analysis_failed');
  console.log('PASS isolated PostgreSQL agent fixture: enqueue, concurrent claim, tenant denial, context, stale lease fencing, generic callback bypass, atomic rollback, result replay/conflict/revoked requester, human approval/close preserving Asset fields, durable closed event, bounded retry/deadline and timeout. Simulated worker only.');
 }finally{await pool?.end();if(!/^agent_smoke_[a-f0-9]{32}$/.test(schema))throw Error('Unsafe schema');await control.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await control.end();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
