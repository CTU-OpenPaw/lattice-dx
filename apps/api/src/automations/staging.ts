// SPDX-License-Identifier: Apache-2.0
import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {EntityEvent} from '../entities/events.js';
/** Metadata-only enqueue. Never acquire rule locks or invoke workflow code here. */
export async function stageEntityEvent(client:Pick<PoolClient,'query'>,organizationId:string,event:EntityEvent&{automationDepth?:number}):Promise<void>{
 if((event.automationDepth??0)>=8)return;
 const existence=(await client.query('SELECT to_regclass($1) IS NOT NULL AND to_regclass($2) IS NOT NULL AS present',['entity_automation_rules','entity_automation_deliveries'])).rows[0];
 if(!existence?.present)return;
 const rules=(await client.query(`SELECT id,revision,snapshot FROM entity_automation_rules WHERE organization_id=$1 AND enabled=true AND schema_id=$2 AND schema_version=$3 AND operations @> ARRAY[$4]::text[] ORDER BY id LIMIT 10`,[organizationId,event.schemaId,event.schemaVersion,event.operation])).rows;
 for(const rule of rules)await client.query(`INSERT INTO entity_automation_deliveries(id,organization_id,event_id,rule_id,rule_revision,rule_snapshot,event_snapshot) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb) ON CONFLICT(event_id,rule_id) DO NOTHING`,[randomUUID(),organizationId,event.id,rule.id,rule.revision,JSON.stringify(rule.snapshot),JSON.stringify(event)]);
}
