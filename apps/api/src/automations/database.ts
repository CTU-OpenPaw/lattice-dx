// SPDX-License-Identifier: Apache-2.0
import {createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import type {WorkflowActor} from '@dx/contracts';
import type {DefinitionRegistry} from '../workflows/registry.js';
import type {WorkflowRepository} from '../workflows/types.js';
import {resolveServiceActor} from '../workflows/timer-database.js';
import {pageResult} from '../pagination.js';
import {AutomationError,parseRule,requireConfiguration,requireKey,validateRuleDefinition} from './policy.js';
import type {AutomationRepository,AutomationRule,AutomationRuleInput,AutomationDelivery} from './types.js';
export const deliveryColumns='id,event_id AS "eventId",rule_id AS "ruleId",rule_revision AS "ruleRevision",status,version,attempts,last_error_code AS "lastErrorCode",available_at AS "availableAt",created_at AS "createdAt",completed_at AS "completedAt",receipt';
export function serializeDelivery(row:AutomationDelivery):AutomationDelivery{return {...row,availableAt:new Date(row.availableAt).toISOString(),createdAt:new Date(row.createdAt).toISOString(),completedAt:row.completedAt?new Date(row.completedAt).toISOString():null};}
function serializeRule(row:{snapshot:AutomationRuleInput;revision:number;createdAt:Date|string;updatedAt:Date|string}):AutomationRule{return {...row.snapshot,revision:row.revision,createdAt:new Date(row.createdAt).toISOString(),updatedAt:new Date(row.updatedAt).toISOString()};}
export async function automationTransaction<T>(pool:Pool,fn:(client:PoolClient)=>Promise<T>):Promise<T>{const client=await pool.connect();try{await client.query('BEGIN');const result=await fn(client);await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}}
export async function validateConfiguredRule(client:PoolClient,registry:DefinitionRegistry,rule:AutomationRuleInput,organizationId:string){
 if(!(await client.query('SELECT version FROM enterprise_schema_versions WHERE organization_id=$1 AND schema_id=$2 AND version=$3',[organizationId,rule.schemaId,rule.schemaVersion])).rows[0])throw new AutomationError('schema_unavailable',404);
 const actor=await resolveServiceActor(client,organizationId,rule.serviceId);
 const definition=await registry.get(organizationId,rule.definitionId,rule.definitionVersion,client);
 if(!definition)throw new AutomationError('definition_unavailable',404);
 validateRuleDefinition(rule,definition,actor);return {actor,definition};
}
export async function automationsDatabase(pool:Pool,registry:DefinitionRegistry,workflows:WorkflowRepository):Promise<AutomationRepository>{
 await pool.query(`CREATE TABLE IF NOT EXISTS entity_automation_rules(
 organization_id text NOT NULL,id text NOT NULL,revision integer NOT NULL,enabled boolean NOT NULL,schema_id text NOT NULL,schema_version integer NOT NULL,operations text[] NOT NULL,snapshot jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(organization_id,id));
 CREATE TABLE IF NOT EXISTS entity_automation_rule_versions(organization_id text NOT NULL,rule_id text NOT NULL,revision integer NOT NULL,snapshot jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(organization_id,rule_id,revision),FOREIGN KEY(organization_id,rule_id) REFERENCES entity_automation_rules(organization_id,id));
 CREATE TABLE IF NOT EXISTS entity_automation_commands(organization_id text NOT NULL,actor_id text NOT NULL,operation text NOT NULL,key text NOT NULL,fingerprint text NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(organization_id,actor_id,operation,key));
 CREATE TABLE IF NOT EXISTS entity_automation_audit(id bigserial PRIMARY KEY,organization_id text NOT NULL,actor_id text NOT NULL,rule_id text NOT NULL,revision integer NOT NULL,operation text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
 CREATE TABLE IF NOT EXISTS entity_automation_deliveries(id uuid PRIMARY KEY,organization_id text NOT NULL,event_id uuid NOT NULL REFERENCES enterprise_entity_events(id),rule_id text NOT NULL,rule_revision integer NOT NULL,rule_snapshot jsonb NOT NULL,event_snapshot jsonb NOT NULL,status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','succeeded','failed','cancelled')),version integer NOT NULL DEFAULT 1,attempts integer NOT NULL DEFAULT 0,last_error_code text,available_at timestamptz NOT NULL DEFAULT now(),created_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz,receipt jsonb,UNIQUE(event_id,rule_id),FOREIGN KEY(organization_id,rule_id,rule_revision) REFERENCES entity_automation_rule_versions(organization_id,rule_id,revision));
 CREATE INDEX IF NOT EXISTS entity_automation_due_idx ON entity_automation_deliveries(available_at,id) WHERE status='pending';
 CREATE TABLE IF NOT EXISTS entity_automation_attempts(delivery_id uuid NOT NULL REFERENCES entity_automation_deliveries(id),version integer NOT NULL,attempt integer NOT NULL,status text NOT NULL,error_code text,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(delivery_id,version));
 CREATE TABLE IF NOT EXISTS entity_automation_receipts(delivery_id uuid PRIMARY KEY REFERENCES entity_automation_deliveries(id),event_id uuid NOT NULL,rule_id text NOT NULL,rule_revision integer NOT NULL,run_id uuid NOT NULL,organization_id text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());`);
 async function mutate(value:AutomationRuleInput&{expectedRevision?:number},actor:WorkflowActor,key:string,update:boolean):Promise<AutomationRule>{
  requireConfiguration(actor);requireKey(key);const parsed=parseRule(value,update);const {expectedRevision,...rule}=parsed;
  return automationTransaction(pool,async client=>{
   await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`automation-rules:${actor.organizationId}`]);
   await validateConfiguredRule(client,registry,rule,actor.organizationId);
   const operation=update?'update':'create',fingerprint=createHash('sha256').update(JSON.stringify(parsed)).digest('hex');
   const replay=(await client.query('SELECT fingerprint,result FROM entity_automation_commands WHERE organization_id=$1 AND actor_id=$2 AND operation=$3 AND key=$4',[actor.organizationId,actor.subject,operation,key])).rows[0];
   if(replay){if(replay.fingerprint!==fingerprint)throw new AutomationError('idempotency_conflict');return replay.result;}
   const current=(await client.query('SELECT revision FROM entity_automation_rules WHERE organization_id=$1 AND id=$2 FOR UPDATE',[actor.organizationId,rule.id])).rows[0];
   if(update?(!current||current.revision!==expectedRevision):!!current)throw new AutomationError('revision_conflict');
   if(!update&&Number((await client.query('SELECT count(*) AS count FROM entity_automation_rules WHERE organization_id=$1',[actor.organizationId])).rows[0]?.count)>=100)throw new AutomationError('rule_limit');
   if(rule.enabled)for(const operation of rule.operations){const count=Number((await client.query('SELECT count(*) AS count FROM entity_automation_rules WHERE organization_id=$1 AND id<>$2 AND enabled=true AND schema_id=$3 AND schema_version=$4 AND operations @> ARRAY[$5]::text[]',[actor.organizationId,rule.id,rule.schemaId,rule.schemaVersion,operation])).rows[0]?.count);if(count>=10)throw new AutomationError('match_limit');}
   const revision=update?current.revision+1:1;const values=[actor.organizationId,rule.id,revision,rule.enabled,rule.schemaId,rule.schemaVersion,rule.operations,JSON.stringify(rule)];
   const columns='snapshot,revision,created_at AS "createdAt",updated_at AS "updatedAt"';
   const result=serializeRule((await client.query(update?`UPDATE entity_automation_rules SET revision=$3,enabled=$4,schema_id=$5,schema_version=$6,operations=$7,snapshot=$8::jsonb,updated_at=now() WHERE organization_id=$1 AND id=$2 RETURNING ${columns}`:`INSERT INTO entity_automation_rules(organization_id,id,revision,enabled,schema_id,schema_version,operations,snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) RETURNING ${columns}`,values)).rows[0]);
   await client.query('INSERT INTO entity_automation_rule_versions(organization_id,rule_id,revision,snapshot) VALUES($1,$2,$3,$4::jsonb)',[actor.organizationId,rule.id,revision,JSON.stringify(rule)]);
   await client.query('INSERT INTO entity_automation_audit(organization_id,actor_id,rule_id,revision,operation) VALUES($1,$2,$3,$4,$5)',[actor.organizationId,actor.subject,rule.id,revision,operation]);
   await client.query('INSERT INTO entity_automation_commands(organization_id,actor_id,operation,key,fingerprint,result) VALUES($1,$2,$3,$4,$5,$6::jsonb)',[actor.organizationId,actor.subject,operation,key,fingerprint,JSON.stringify(result)]);
   return result;
  });
 }
 return {
  create:(value,actor,key)=>mutate(value,actor,key,false),
  update:(id,value,actor,key)=>{if(id!==value.id)throw new AutomationError('validation_failed',400);return mutate(value,actor,key,true);},
  async list(actor,page){requireConfiguration(actor);const rows=(await pool.query('SELECT snapshot,revision,created_at AS "createdAt",updated_at AS "updatedAt" FROM entity_automation_rules WHERE organization_id=$1 ORDER BY id LIMIT $2 OFFSET $3',[actor.organizationId,page.limit+1,page.offset])).rows;return pageResult(rows.map(serializeRule),page);},
  async deliveries(id,actor,page){requireConfiguration(actor);if(!(await pool.query('SELECT 1 FROM entity_automation_rules WHERE organization_id=$1 AND id=$2',[actor.organizationId,id])).rowCount)throw new AutomationError('rule_unavailable',404);return pageResult((await pool.query(`SELECT ${deliveryColumns} FROM entity_automation_deliveries WHERE organization_id=$1 AND rule_id=$2 ORDER BY created_at,id LIMIT $3 OFFSET $4`,[actor.organizationId,id,page.limit+1,page.offset])).rows.map(serializeDelivery),page);},
  async retry(){throw new AutomationError('runtime_unavailable',503);},
  async tickOne(){return undefined;},
 };
}
