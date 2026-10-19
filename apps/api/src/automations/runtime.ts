// SPDX-License-Identifier: Apache-2.0
import {createHash} from 'node:crypto';
import type {Pool} from 'pg';
import type {WorkflowActor} from '@dx/contracts';
import type {EntityEvent} from '../entities/events.js';
import type {DefinitionRegistry} from '../workflows/registry.js';
import type {WorkflowRepository} from '../workflows/types.js';
import {validateInput} from '../workflows/policy.js';
import {lockContextEntity} from '../workflows/entity-context.js';
import {assertModuleStartEligible} from '../modules/database.js';
import {automationTransaction,validateConfiguredRule,deliveryColumns,serializeDelivery} from './database.js';
import {AutomationError,classifyAutomationError,parseRule,requireConfiguration,requireKey} from './policy.js';
import type {AutomationBinding,AutomationDelivery} from './types.js';
function mapBinding(binding:AutomationBinding,event:EntityEvent):string{return binding.source==='literal'?binding.value:String(binding.field==='eventId'?event.id:binding.field==='entityVersion'?event.toVersion:event[binding.field]);}
export function automationRuntime(pool:Pool,registry:DefinitionRegistry,workflows:WorkflowRepository){
 async function tickOne():Promise<{deliveryId:string;status:AutomationDelivery['status']}|undefined>{
  const candidates=(await pool.query("SELECT id FROM entity_automation_deliveries WHERE status='pending' AND available_at<=clock_timestamp() ORDER BY available_at,id LIMIT 20")).rows;
  for(const candidate of candidates){const result=await automationTransaction(pool,async client=>{
   await client.query("SET LOCAL statement_timeout='15s'");await client.query("SET LOCAL lock_timeout='2s'");
   const row=(await client.query("SELECT *,available_at<=clock_timestamp() AS due FROM entity_automation_deliveries WHERE id=$1 FOR UPDATE SKIP LOCKED",[candidate.id])).rows[0];
   if(!row||row.status!=='pending'||!row.due)return;
   await client.query('SAVEPOINT automation_attempt');let status:AutomationDelivery['status']='succeeded',errorCode:string|null=null;
   const attempts=row.attempts+1;
   try{
    const current=(await client.query('SELECT enabled,revision,snapshot FROM entity_automation_rules WHERE organization_id=$1 AND id=$2 FOR SHARE',[row.organization_id,row.rule_id])).rows[0];
    if(!current?.enabled||current.revision!==row.rule_revision)throw new AutomationError('rule_changed');
    const rule=parseRule(row.rule_snapshot),event=row.event_snapshot as EntityEvent&{automationDepth?:number};
    const {actor,definition}=await validateConfiguredRule(client,registry,rule,row.organization_id);
    await assertModuleStartEligible(client,row.organization_id,rule.definitionId,rule.definitionVersion);
    const entity=await lockContextEntity(client,event.entityId,actor,true);
    if(entity.schemaId!==rule.schemaId||entity.schemaVersion!==rule.schemaVersion)throw new AutomationError('entity_pin_changed');
    if(!workflows.createWithClient||rule.transitionId&&!workflows.transitionWithClient)throw new AutomationError('runtime_unavailable',503);
    const input=validateInput(definition.startFields,Object.fromEntries(Object.entries(rule.input).map(([name,value])=>[name,mapBinding(value,event)])),definition.optionalStartFields);
    const depth=event.automationDepth??0;if(!Number.isInteger(depth)||depth<0||depth>=8)throw new AutomationError('automation_depth_limit');
    await client.query("SELECT set_config('latticedx.automation_depth',$1,true)",[String(depth+1)]);
    let run=await workflows.createWithClient(client,{definitionId:rule.definitionId,definitionVersion:rule.definitionVersion,title:mapBinding(rule.title,event),input,entityContext:{entityId:event.entityId}},actor,`automation:${row.id}`);
    if(rule.transitionId)run=await workflows.transitionWithClient!(client,run.id,{action:rule.transitionId,expectedVersion:run.version,input:{}},actor,`automation:${row.id}`);
    const receipt={runId:run.id,definitionId:run.definitionId,definitionVersion:run.definitionVersion};
    await client.query('INSERT INTO entity_automation_receipts(delivery_id,event_id,rule_id,rule_revision,run_id,organization_id) VALUES($1,$2,$3,$4,$5,$6)',[row.id,row.event_id,row.rule_id,row.rule_revision,run.id,row.organization_id]);
    await client.query("UPDATE entity_automation_deliveries SET status='succeeded',version=version+1,attempts=$2,last_error_code=NULL,completed_at=now(),receipt=$3::jsonb WHERE id=$1",[row.id,attempts,JSON.stringify(receipt)]);
   }catch(error){
    await client.query('ROLLBACK TO SAVEPOINT automation_attempt');const classified=classifyAutomationError(error);errorCode=classified.code;
    status=errorCode==='rule_changed'?'cancelled':classified.transient&&attempts<3?'pending':'failed';
    await client.query("UPDATE entity_automation_deliveries SET status=$2,version=version+1,attempts=$3,last_error_code=$4,available_at=now()+$5*interval '1 second',completed_at=CASE WHEN $2 IN ('failed','cancelled') THEN now() ELSE NULL END WHERE id=$1",[row.id,status,attempts,errorCode,5*2**(attempts-1)]);
   }
   await client.query('INSERT INTO entity_automation_attempts(delivery_id,version,attempt,status,error_code) VALUES($1,$2,$3,$4,$5)',[row.id,row.version+1,attempts,status,errorCode]);
   await client.query('RELEASE SAVEPOINT automation_attempt');return {deliveryId:row.id,status};
  });if(result)return result;}
 }
 async function retry(id:string,deliveryId:string,expectedVersion:number,actor:WorkflowActor,key:string):Promise<AutomationDelivery>{
  requireConfiguration(actor);requireKey(key);if(!Number.isSafeInteger(expectedVersion)||expectedVersion<1)throw new AutomationError('validation_failed',400);
  return automationTransaction(pool,async client=>{
   await client.query("SET LOCAL statement_timeout='15s'");await client.query("SET LOCAL lock_timeout='2s'");
   await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['automation-retry',actor.organizationId,actor.subject,key])]);
   const row=(await client.query('SELECT * FROM entity_automation_deliveries WHERE id=$1 AND organization_id=$2 AND rule_id=$3 FOR UPDATE',[deliveryId,actor.organizationId,id])).rows[0];
   if(!row)throw new AutomationError('delivery_unavailable',404);
   const current=(await client.query('SELECT enabled,revision FROM entity_automation_rules WHERE organization_id=$1 AND id=$2 FOR SHARE',[actor.organizationId,id])).rows[0];
   if(!current?.enabled||current.revision!==row.rule_revision)throw new AutomationError('rule_changed');
   const rule=parseRule(row.rule_snapshot),{actor:service}=await validateConfiguredRule(client,registry,rule,actor.organizationId);
   await assertModuleStartEligible(client,actor.organizationId,rule.definitionId,rule.definitionVersion);
   const entity=await lockContextEntity(client,row.event_snapshot.entityId,service,true);if(entity.schemaId!==rule.schemaId||entity.schemaVersion!==rule.schemaVersion)throw new AutomationError('entity_pin_changed');
   const fingerprint=createHash('sha256').update(JSON.stringify({id,deliveryId,expectedVersion})).digest('hex');
   const replay=(await client.query("SELECT fingerprint,result FROM entity_automation_commands WHERE organization_id=$1 AND actor_id=$2 AND operation='retry' AND key=$3",[actor.organizationId,actor.subject,key])).rows[0];
   if(replay){if(replay.fingerprint!==fingerprint)throw new AutomationError('idempotency_conflict');return replay.result;}
   if(row.status!=='failed'||row.version!==expectedVersion)throw new AutomationError('version_conflict');
   const result=serializeDelivery((await client.query(`UPDATE entity_automation_deliveries SET status='pending',version=version+1,attempts=0,last_error_code=NULL,completed_at=NULL,available_at=now() WHERE id=$1 RETURNING ${deliveryColumns}`,[deliveryId])).rows[0]);
   await client.query("INSERT INTO entity_automation_commands(organization_id,actor_id,operation,key,fingerprint,result) VALUES($1,$2,'retry',$3,$4,$5::jsonb)",[actor.organizationId,actor.subject,key,fingerprint,JSON.stringify(result)]);
   await client.query("INSERT INTO entity_automation_audit(organization_id,actor_id,rule_id,revision,operation) VALUES($1,$2,$3,$4,'retry')",[actor.organizationId,actor.subject,id,row.rule_revision]);
   return result;
  });
 }
 return {tickOne,retry};
}
