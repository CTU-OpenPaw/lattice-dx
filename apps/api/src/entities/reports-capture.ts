// SPDX-License-Identifier: Apache-2.0
import type {EntityClient} from './client.js';
import {publication,missing} from './client.js';
import {accessPredicate} from './access.js';
import {compileAggregateQuery,parseAggregateQuery} from './aggregate-policy.js';
import type {AggregateQuery,AggregateResult} from './aggregate-types.js';
import type {Scope} from './types.js';
import {EntityError} from './policy.js';
/** Private report capture: every eligible source, including missing metric values. */
export async function captureAggregateWithSources(client:EntityClient,scope:Scope,input:AggregateQuery){
 const query=parseAggregateQuery(input),schema=await publication(client,scope,query.schemaId,query.schemaVersion);
 const compiled=compileAggregateQuery(query,schema,5);
 const row=(await client.query(`WITH eligible AS MATERIALIZED (
  SELECT id,attributes FROM enterprise_entities WHERE ${accessPredicate('enterprise_entities','$2','$1','read')}
  AND archived_at IS NULL AND schema_id=$3 AND schema_version=$4 AND ${compiled.sourcePredicate} LIMIT 5001
 ), aggregated AS (SELECT ${compiled.select} FROM eligible ${compiled.group} LIMIT 201)
 SELECT ARRAY(SELECT id FROM eligible ORDER BY id) AS "sourceIds",
 COALESCE((SELECT jsonb_agg(to_jsonb(a)) FROM aggregated a),'[]'::jsonb) AS groups,
 statement_timestamp() AS "asOf"`,[scope.organizationId,scope.actorId,query.schemaId,query.schemaVersion,...compiled.values])).rows[0];
 const ids=row.sourceIds as string[],groups=row.groups as Record<string,string|boolean|null>[];
 if(ids.length>5000)throw new EntityError(409,'Report exceeds 5000 sources.');
 if(groups.length>200)throw new EntityError(409,'Aggregate exceeds 200 groups.');
 const result:AggregateResult={schemaId:query.schemaId,schemaVersion:query.schemaVersion,groupBy:query.groupBy,groups:groups.map(group=>({keys:query.groupBy.map((_,i)=>group[`g${i}`]),metrics:Object.fromEntries(query.metrics.map((metric,i)=>[metric.name,group[`m${i}`]]))}))} as AggregateResult;
 return {ids,result,asOf:new Date(row.asOf).toISOString()};
}
/** Metadata locks block edits, archival and grant mutation until transaction commit. */
export async function authorizeSnapshotSources(client:EntityClient,scope:Scope,ids:string[]){
 if(!ids.length)return;
 const unique=[...new Set(ids)].sort();
 const rows=(await client.query(`SELECT e.id,e.owner_id AS "ownerId",e.organization_id AS "organizationId",e.archived_at AS "archivedAt"
 FROM enterprise_entities e WHERE e.id=ANY($1::uuid[]) AND e.organization_id=$2 ORDER BY e.id FOR SHARE OF e`,[unique,scope.organizationId])).rows;
 if(rows.length!==unique.length||rows.some(row=>row.archivedAt!==null))throw missing();
 if(rows.some(row=>row.ownerId!==scope.actorId)){
  const people=await client.query('SELECT p.subject FROM directory_people p WHERE p.organization_id=$1 AND p.subject=$2 AND p.enabled=true FOR SHARE OF p',[scope.organizationId,scope.actorId]);
  if(!people.rows.length)throw missing();
 }
 const allowed=await client.query(`SELECT e.id FROM enterprise_entities e WHERE e.id=ANY($1::uuid[]) AND e.archived_at IS NULL AND ${accessPredicate('e','$3','$2','read')}`,[unique,scope.organizationId,scope.actorId]);
 if(allowed.rows.length!==unique.length)throw missing();
}
