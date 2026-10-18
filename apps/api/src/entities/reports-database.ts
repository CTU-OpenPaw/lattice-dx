// SPDX-License-Identifier: Apache-2.0
import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {runEntityCommandInTransaction,withEntityTransaction} from './commands.js';
import {authorizeSnapshotSources,captureAggregateWithSources} from './reports-capture.js';
import {parseReportInput} from './reports-policy.js';
import {bad,EntityError,uuid} from './policy.js';
import {missing} from './client.js';
import {pageResult} from '../pagination.js';
import type {ReportsRepository,ReportSnapshot} from './reports-types.js';
import type {Scope} from './types.js';
const metadata='id,title,version,created_at AS "createdAt"';
async function transaction<T>(pool:Pool,work:(client:PoolClient)=>Promise<T>){
 try{return await withEntityTransaction(pool,async client=>{
  await client.query("SET LOCAL statement_timeout = '3s'");await client.query("SET LOCAL lock_timeout = '1s'");return work(client);
 });}catch(error){if(['57014','55P03'].includes((error as {code?:string}).code??''))throw new EntityError(503,'Report query timed out.');throw error;}
}
async function authorizedReport(client:PoolClient,scope:Scope,id:string):Promise<ReportSnapshot>{
 const row=(await client.query(`SELECT ${metadata},query,result,as_of AS "asOf" FROM enterprise_report_snapshots WHERE id=$1 AND organization_id=$2 AND owner_id=$3`,[id,scope.organizationId,scope.actorId])).rows[0];
 if(!row)throw missing();
 const sources=(await client.query('SELECT entity_id AS id FROM enterprise_report_snapshot_sources WHERE snapshot_id=$1 ORDER BY entity_id',[id])).rows;
 await authorizeSnapshotSources(client,scope,sources.map(source=>source.id as string));
 return {...row,createdAt:new Date(row.createdAt).toISOString(),asOf:new Date(row.asOf).toISOString()} as ReportSnapshot;
}
export async function reportsDatabase(pool:Pool):Promise<ReportsRepository>{
 await pool.query(`CREATE TABLE IF NOT EXISTS enterprise_report_snapshots(
  id uuid PRIMARY KEY,organization_id text NOT NULL,owner_id text NOT NULL,title text NOT NULL,version integer NOT NULL DEFAULT 1 CHECK(version=1),
  query jsonb NOT NULL,result jsonb NOT NULL,as_of timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
 CREATE INDEX IF NOT EXISTS enterprise_report_snapshots_owner_idx ON enterprise_report_snapshots(organization_id,owner_id,created_at,id);
 CREATE TABLE IF NOT EXISTS enterprise_report_snapshot_sources(snapshot_id uuid NOT NULL REFERENCES enterprise_report_snapshots(id),entity_id uuid NOT NULL REFERENCES enterprise_entities(id),PRIMARY KEY(snapshot_id,entity_id));
 CREATE TABLE IF NOT EXISTS enterprise_report_snapshot_audit(id uuid PRIMARY KEY,snapshot_id uuid NOT NULL REFERENCES enterprise_report_snapshots(id),organization_id text NOT NULL,owner_id text NOT NULL,actor_id text NOT NULL,operation text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());`);
 return {
  async create(scope,input,key){
   const normalized=parseReportInput(input);
   return transaction(pool,async client=>{
    let replay:ReportSnapshot|undefined;
    const receipt=await runEntityCommandInTransaction(client,scope,'entity.report.snapshot',key,normalized,async()=>{},async db=>{
     const capture=await captureAggregateWithSources(db,scope,normalized.query);
     await authorizeSnapshotSources(db,scope,capture.ids);
     const snapshotId=randomUUID();
     await db.query('INSERT INTO enterprise_report_snapshots(id,organization_id,owner_id,title,query,result,as_of) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)',[snapshotId,scope.organizationId,scope.actorId,normalized.title,JSON.stringify(normalized.query),JSON.stringify(capture.result),capture.asOf]);
     await db.query('INSERT INTO enterprise_report_snapshot_sources(snapshot_id,entity_id) SELECT $1,unnest($2::uuid[])',[snapshotId,capture.ids]);
     await db.query("INSERT INTO enterprise_report_snapshot_audit(id,snapshot_id,organization_id,owner_id,actor_id,operation) VALUES($1,$2,$3,$4,$5,'entity.report.snapshot')",[randomUUID(),snapshotId,scope.organizationId,scope.actorId,scope.actorId]);
     return {snapshotId};
    },undefined,async(db,stored)=>{replay=await authorizedReport(db,scope,uuid(stored.snapshotId));});
    return replay??authorizedReport(client,scope,receipt.snapshotId);
   });
  },
  get:(scope,id)=>transaction(pool,client=>authorizedReport(client,scope,uuid(id))),
  async list(scope,page){
   if(!Number.isSafeInteger(page.limit)||page.limit<1||page.limit>100||!Number.isSafeInteger(page.offset)||page.offset<0||page.offset>Number.MAX_SAFE_INTEGER-101||typeof page.q!=='string'||Array.from(page.q).length>200)bad('Invalid pagination.');
   return transaction(pool,async client=>{
    const rows=(await client.query(`SELECT ${metadata} FROM enterprise_report_snapshots WHERE organization_id=$1 AND owner_id=$2 AND ($3='' OR strpos(lower(title),lower($3))>0) ORDER BY created_at DESC,id DESC LIMIT $4 OFFSET $5`,[scope.organizationId,scope.actorId,page.q,page.limit+1,page.offset])).rows;
    return pageResult(rows.map(row=>({...row,createdAt:new Date(row.createdAt).toISOString()})),page);
   });
  }
 };
}
