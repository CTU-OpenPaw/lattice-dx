/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import type {Pool,QueryConfig} from 'pg';
import {parseCutoff} from './policy.js';
import type {OperationsRepository} from './types.js';
import {readQueuesWithClient} from './queues.js';
export function operationsDatabase(pool:Pool):OperationsRepository{
 const bounded=(text:string,values?:unknown[]):QueryConfig & {query_timeout:number}=>({text,values,query_timeout:2000});
 return {
  async queues(organizationId){
   const client=await pool.connect();
   try{
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout='3s'");
    const items=await readQueuesWithClient(client,organizationId);
    await client.query('COMMIT');return items;
   }catch(error){try{await client.query('ROLLBACK');}catch{}throw error;}finally{client.release();}
  },
  async ready(){
   try{await pool.query(bounded('SELECT 1'));return true;}catch{return false;}
  },
  async retentionPreview(organizationId,before){
   before=parseCutoff(before);
   const result=await pool.query<{store:string;count:string}>(bounded(`
    SELECT 'archived_entities' AS store,count(*)::text AS count FROM enterprise_entities WHERE organization_id=$1 AND archived_at<$2::timestamptz
    UNION ALL SELECT 'settled_waits',count(*)::text FROM workflow_waits WHERE organization_id=$1 AND status<>'pending' AND completed_at<$2::timestamptz
    UNION ALL SELECT 'terminal_tasks',count(*)::text FROM foundation_tasks WHERE organization_id=$1 AND status<>'pending' AND decided_at<$2::timestamptz
    UNION ALL SELECT 'enterprise_audit',count(*)::text FROM enterprise_audit WHERE organization_id=$1 AND occurred_at<$2::timestamptz`,[organizationId,before]));
   return {before,dryRun:true,warning:'review_only',items:result.rows};
  },
 };
}
