/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import type {PoolClient} from 'pg';
export interface QueueItem {queue:'outbox'|'timers'|'waitTimeouts'|'automations';status:string;count:string;oldestPendingAt:string|null}
// Server-owned table names and status mappings only; no client identifiers enter SQL.
const QUEUES=[
 {queue:'outbox',table:'workflow_jobs',statuses:['pending','processing','succeeded','failed','cancelled']},
 {queue:'timers',table:'workflow_timers',statuses:['pending','succeeded','failed','cancelled']},
 {queue:'waitTimeouts',table:'workflow_waits',statuses:['pending','succeeded','failed','timed_out','cancelled']},
 {queue:'automations',table:'entity_automation_deliveries',statuses:['pending','succeeded','failed','cancelled']},
] as const;
export async function readQueuesWithClient(client:PoolClient,organizationId:string):Promise<QueueItem[]> {
 const items:QueueItem[]=[];
 for(const config of QUEUES){
  const result=await client.query<{status:string;count:string;oldestPendingAt:Date|null}>(`SELECT status,count(*)::text AS count,min(created_at) FILTER (WHERE status='pending') AS "oldestPendingAt" FROM ${config.table} WHERE organization_id=$1 GROUP BY status`,[organizationId]);
  for(const status of config.statuses){
   const row=result.rows.find(row=>row.status===status);
   items.push({queue:config.queue,status,count:row?.count??'0',oldestPendingAt:status==='pending'&&row?.oldestPendingAt?row.oldestPendingAt.toISOString():null});
  }
 }
 return items;
}
