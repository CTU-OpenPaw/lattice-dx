/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import {createHash,randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import type {WorkflowActor,WorkflowDefinition} from '@dx/contracts';
import {pageResult} from '../pagination.js';
import type {DefinitionRegistry} from '../workflows/registry.js';
import type {WorkflowRepository} from '../workflows/types.js';
import {validateReferences} from '../workflows/database.js';
import {validateInput,WorkflowError} from '../workflows/policy.js';
import {canonical,canonicalEvent,eventStartKey,parseEvent,parseSubscription,requireDesigner,requireReceiver,resolveBinding,validEventId} from './policy.js';
import type {EventRepository,EventSubscription,SubscriptionInput,SubscriptionUpdate,EventReceipt} from './types.js';

const columns='id,event_type AS "eventType",source_subject AS "sourceSubject",definition_id AS "definitionId",definition_version AS "definitionVersion",title,input,enabled,revision';
function hash(value:string):string {return createHash('sha256').update(value).digest('hex');}
async function transaction<T>(pool:Pool,fn:(client:PoolClient)=>Promise<T>):Promise<T> {
 const client=await pool.connect();
 try {
  await client.query('BEGIN');
  const result=await fn(client);
  await client.query('COMMIT');
  return result;
 } catch(error) {
  await client.query('ROLLBACK');
  throw error;
 } finally {client.release();}
}
async function lock(client:PoolClient,scope:unknown[]):Promise<void> {
 await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(scope)]);
}
async function currentSource(client:PoolClient,org:string,subject:string):Promise<{roles:string[]}> {
 const row=(await client.query('SELECT roles FROM directory_people WHERE organization_id=$1 AND subject=$2 AND enabled=true FOR SHARE',[org,subject])).rows[0];
 if(!row)throw new WorkflowError(403,'Event source is inactive or unavailable in this organization.');
 return row;
}

export async function eventsDatabase(pool:Pool,registry:Pick<DefinitionRegistry,'get'>,workflows:Pick<WorkflowRepository,'createWithClient'>):Promise<EventRepository> {
 await pool.query(`
  CREATE TABLE IF NOT EXISTS workflow_event_subscriptions (
   organization_id text NOT NULL,id text NOT NULL,event_type text NOT NULL,source_subject text NOT NULL,
   definition_id text NOT NULL,definition_version integer NOT NULL CHECK(definition_version>0),
   title jsonb NOT NULL,input jsonb NOT NULL,enabled boolean NOT NULL,revision integer NOT NULL CHECK(revision>0),
   created_by text NOT NULL,updated_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
   PRIMARY KEY(organization_id,id)
  );
  CREATE INDEX IF NOT EXISTS workflow_event_subscriptions_match_idx ON workflow_event_subscriptions(organization_id,source_subject,event_type,id) WHERE enabled;
  CREATE TABLE IF NOT EXISTS workflow_event_subscription_versions (
   organization_id text NOT NULL,subscription_id text NOT NULL,revision integer NOT NULL,snapshot jsonb NOT NULL,
   actor_id text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
   PRIMARY KEY(organization_id,subscription_id,revision),
   FOREIGN KEY(organization_id,subscription_id) REFERENCES workflow_event_subscriptions(organization_id,id)
  );
  CREATE TABLE IF NOT EXISTS workflow_event_subscription_receipts (
   organization_id text NOT NULL,actor_id text NOT NULL,key text NOT NULL,fingerprint text NOT NULL,result jsonb NOT NULL,
   created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(organization_id,actor_id,key)
  );
  CREATE TABLE IF NOT EXISTS workflow_event_subscription_audit (
   id uuid PRIMARY KEY,organization_id text NOT NULL,subscription_id text NOT NULL,revision integer NOT NULL,
   actor_id text NOT NULL,action text NOT NULL,occurred_at timestamptz NOT NULL DEFAULT now(),
   FOREIGN KEY(organization_id,subscription_id,revision) REFERENCES workflow_event_subscription_versions(organization_id,subscription_id,revision)
  );
  CREATE TABLE IF NOT EXISTS workflow_inbound_events (
   organization_id text NOT NULL,source_subject text NOT NULL,event_id text NOT NULL,event_type text NOT NULL,
   external_occurred_at timestamptz NOT NULL,received_at timestamptz NOT NULL DEFAULT now(),fingerprint text NOT NULL,result jsonb NOT NULL,
   PRIMARY KEY(organization_id,source_subject,event_id)
  );
  CREATE TABLE IF NOT EXISTS workflow_event_provenance (
   organization_id text NOT NULL,source_subject text NOT NULL,event_id text NOT NULL,event_type text NOT NULL,
   external_occurred_at timestamptz NOT NULL,received_at timestamptz NOT NULL DEFAULT now(),
   subscription_id text NOT NULL,subscription_revision integer NOT NULL,run_id uuid NOT NULL REFERENCES workflow_runs(id),
   PRIMARY KEY(organization_id,source_subject,event_id,subscription_id),UNIQUE(run_id),
   FOREIGN KEY(organization_id,source_subject,event_id) REFERENCES workflow_inbound_events(organization_id,source_subject,event_id),
   FOREIGN KEY(organization_id,subscription_id,subscription_revision) REFERENCES workflow_event_subscription_versions(organization_id,subscription_id,revision)
  );
 `);

 async function published(client:PoolClient,org:string,value:SubscriptionInput):Promise<WorkflowDefinition> {
  const definition=await registry.get(org,value.definitionId,value.definitionVersion,client);
  if(!definition||definition.version!==value.definitionVersion)throw new WorkflowError(400,'Pinned published workflow version is unavailable.');
  return definition;
 }
 async function validateSubscription(client:PoolClient,value:SubscriptionInput,actor:WorkflowActor):Promise<void> {
  const definition=await published(client,actor.organizationId,value);
  const source=await currentSource(client,actor.organizationId,value.sourceSubject);
  if(!source.roles.includes('workflow:start')||!source.roles.includes(definition.startRole))throw new WorkflowError(403,'Source directory metadata lacks workflow start roles.');
  const fields={...definition.startFields,...definition.optionalStartFields};
  if(Object.keys(value.input).some(name=>!Object.hasOwn(fields,name))||Object.keys(definition.startFields).some(name=>!Object.hasOwn(value.input,name)))throw new WorkflowError(400,'Subscription must map declared required and optional start fields only.');
  const literals=Object.fromEntries(Object.entries(value.input).filter(([,binding])=>binding.source==='literal').map(([name,binding])=>[name,binding.source==='literal'?binding.value:'']));
  const input=validateInput({},literals,fields);
  const sourceActor={subject:value.sourceSubject,organizationId:actor.organizationId,roles:source.roles};
  if(definition.assignedReader&&input[definition.assignedReader.field]!==undefined) {
   const assigned=definition.assignedReader;
   const row=await client.query('SELECT 1 FROM directory_people WHERE organization_id=$1 AND subject=$2 AND enabled=true AND roles @> $3::jsonb FOR SHARE',[actor.organizationId,input[assigned.field],JSON.stringify([assigned.role])]);
   if(!row.rowCount)throw new WorkflowError(400,'Mapped assignee is unavailable.');
   delete fields[assigned.field];
  }
  await validateReferences(client,fields,input,sourceActor,async run=>{
   const linked=await registry.get(run.organizationId,run.definitionId,run.definitionVersion,client);
   if(!linked)throw new WorkflowError(400,'Referenced workflow publication is unavailable.');
   return linked;
  });
 }
 async function mutate(value:SubscriptionInput|SubscriptionUpdate,actor:WorkflowActor,key:string,update:boolean):Promise<EventSubscription> {
  requireDesigner(actor);
  const parsed=update?parseSubscription(value,true):parseSubscription(value);
  if(!parsed)throw new WorkflowError(400,'Invalid subscription.');
  if(!/^[A-Za-z0-9._:-]{1,128}$/.test(key))throw new WorkflowError(400,'Invalid Idempotency-Key.');
  return transaction(pool,async client=>{
   await lock(client,['subscription-mutation',actor.organizationId,actor.subject,key]);
   await validateSubscription(client,parsed,actor);
   const fingerprint=hash(canonical({operation:update?'update':'create',value:parsed}));
   const replay=(await client.query('SELECT fingerprint,result FROM workflow_event_subscription_receipts WHERE organization_id=$1 AND actor_id=$2 AND key=$3',[actor.organizationId,actor.subject,key])).rows[0];
   if(replay) {
    if(replay.fingerprint!==fingerprint)throw new WorkflowError(409,'Idempotency-Key has different subscription content.');
    return replay.result;
   }
   // Serialize all mutations in one tenant, including moves between match groups.
   await lock(client,['subscription-limit',actor.organizationId]);
   const existing=(await client.query(`SELECT ${columns} FROM workflow_event_subscriptions WHERE organization_id=$1 AND id=$2 FOR UPDATE`,[actor.organizationId,parsed.id])).rows[0] as EventSubscription|undefined;
   if(update&&!existing)throw new WorkflowError(404,'Subscription not found.');
   if(!update&&existing)throw new WorkflowError(409,'Subscription already exists.');
   if(update&&existing!.revision!==(parsed as SubscriptionUpdate).expectedRevision)throw new WorkflowError(409,'Subscription revision has changed.');
   if(parsed.enabled) {
    const count=(await client.query('SELECT count(*)::integer AS count FROM workflow_event_subscriptions WHERE organization_id=$1 AND source_subject=$2 AND event_type=$3 AND enabled=true AND id<>$4',[actor.organizationId,parsed.sourceSubject,parsed.eventType,parsed.id])).rows[0].count;
    if(count>=10)throw new WorkflowError(409,'At most ten enabled subscriptions can match a source and event type.');
   }
   const revision=existing?existing.revision+1:1;
   const values=[actor.organizationId,parsed.id,parsed.eventType,parsed.sourceSubject,parsed.definitionId,parsed.definitionVersion,JSON.stringify(parsed.title),JSON.stringify(parsed.input),parsed.enabled,revision,actor.subject];
   const sql=update
    ? `UPDATE workflow_event_subscriptions SET event_type=$3,source_subject=$4,definition_id=$5,definition_version=$6,title=$7,input=$8,enabled=$9,revision=$10,updated_by=$11,updated_at=now() WHERE organization_id=$1 AND id=$2 RETURNING ${columns}`
    : `INSERT INTO workflow_event_subscriptions(organization_id,id,event_type,source_subject,definition_id,definition_version,title,input,enabled,revision,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) RETURNING ${columns}`;
   const result=(await client.query(sql,values)).rows[0] as EventSubscription;
   await client.query('INSERT INTO workflow_event_subscription_versions(organization_id,subscription_id,revision,snapshot,actor_id) VALUES($1,$2,$3,$4,$5)',[actor.organizationId,parsed.id,revision,JSON.stringify(result),actor.subject]);
   await client.query('INSERT INTO workflow_event_subscription_audit(id,organization_id,subscription_id,revision,actor_id,action) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),actor.organizationId,parsed.id,revision,actor.subject,update?'update':'create']);
   await client.query('INSERT INTO workflow_event_subscription_receipts(organization_id,actor_id,key,fingerprint,result) VALUES($1,$2,$3,$4,$5)',[actor.organizationId,actor.subject,key,fingerprint,JSON.stringify(result)]);
   return result;
  });
 }
 return {
  createSubscription(value,actor,key) {return mutate(value,actor,key,false);},
  updateSubscription(id,value,actor,key) {
   if(id.toLowerCase()!==value.id.toLowerCase())throw new WorkflowError(400,'Subscription ID is fixed.');
   return mutate(value,actor,key,true);
  },
  async listSubscriptions(actor,page) {
   requireDesigner(actor);
   const rows=(await pool.query(`SELECT ${columns} FROM workflow_event_subscriptions WHERE organization_id=$1 AND ($2='' OR strpos(lower(event_type),lower($2))>0) ORDER BY id LIMIT $3 OFFSET $4`,[actor.organizationId,page.q,page.limit+1,page.offset])).rows;
   return pageResult(rows,page);
  },
  async receive(value,actor) {
   requireReceiver(actor);
   const parsed=parseEvent(value);
   if(!parsed)throw new WorkflowError(400,'Invalid inbound event.');
   return transaction(pool,async client=>{
    await lock(client,['inbound-event',actor.organizationId,actor.subject,parsed.eventId]);
    const source=await currentSource(client,actor.organizationId,actor.subject);
    const fingerprint=hash(canonicalEvent(parsed));
    const replay=(await client.query('SELECT fingerprint,result FROM workflow_inbound_events WHERE organization_id=$1 AND source_subject=$2 AND event_id=$3',[actor.organizationId,actor.subject,parsed.eventId])).rows[0];
    if(replay) {
     if(replay.fingerprint!==fingerprint)throw new WorkflowError(409,'Event ID has different content.');
     return replay.result;
    }
    const subscriptions=(await client.query(`SELECT ${columns} FROM workflow_event_subscriptions WHERE organization_id=$1 AND source_subject=$2 AND event_type=$3 AND enabled=true ORDER BY id FOR SHARE`,[actor.organizationId,actor.subject,parsed.eventType])).rows as EventSubscription[];
    const receipt:EventReceipt={eventId:parsed.eventId,status:'accepted',runs:[]};
    for(const subscription of subscriptions) {
     const definition=await published(client,actor.organizationId,subscription);
     if(!['workflow:start',definition.startRole].every(role=>actor.roles.includes(role)&&source.roles.includes(role)))throw new WorkflowError(403,'Current source JWT and directory must grant workflow start roles.');
     const title=resolveBinding(subscription.title,parsed.data,parsed);
     if(!title.trim()||Array.from(title).length>200)throw new WorkflowError(400,'Mapped workflow title is invalid.');
     const input=Object.fromEntries(Object.entries(subscription.input).map(([name,binding])=>[name,resolveBinding(binding,parsed.data,parsed)]));
     if(!workflows.createWithClient)throw new WorkflowError(503,'Transactional workflow start is unavailable.');
     const run=await workflows.createWithClient(client,{definitionId:subscription.definitionId,definitionVersion:subscription.definitionVersion,title,input},actor,eventStartKey(actor.organizationId,actor.subject,parsed.eventId,subscription.id,subscription.revision));
     receipt.runs.push({subscriptionId:subscription.id,runId:run.id});
    }
    await client.query('INSERT INTO workflow_inbound_events(organization_id,source_subject,event_id,event_type,external_occurred_at,fingerprint,result) VALUES($1,$2,$3,$4,$5,$6,$7)',[actor.organizationId,actor.subject,parsed.eventId,parsed.eventType,parsed.occurredAt,fingerprint,JSON.stringify(receipt)]);
    for(let index=0;index<subscriptions.length;index++) {
     const subscription=subscriptions[index];
     await client.query('INSERT INTO workflow_event_provenance(organization_id,source_subject,event_id,event_type,external_occurred_at,subscription_id,subscription_revision,run_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[actor.organizationId,actor.subject,parsed.eventId,parsed.eventType,parsed.occurredAt,subscription.id,subscription.revision,receipt.runs[index].runId]);
    }
    return receipt;
   });
  },
  async get(eventId,actor) {
   requireReceiver(actor);
   if(!validEventId(eventId))throw new WorkflowError(400,'Invalid event ID.');
   return transaction(pool,async client=>{
    await currentSource(client,actor.organizationId,actor.subject);
    const row=(await client.query('SELECT result FROM workflow_inbound_events WHERE organization_id=$1 AND source_subject=$2 AND event_id=$3',[actor.organizationId,actor.subject,eventId])).rows[0];
    if(!row)throw new WorkflowError(404,'Event receipt not found.');
    return row.result;
   });
  },
 };
}
