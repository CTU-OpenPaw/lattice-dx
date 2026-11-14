/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import type {EntityClient} from './client.js';
import {publication} from './client.js';
import {accessPredicate} from './access.js';
import {EntityError} from './policy.js';
import {compileAggregateQuery,parseAggregateQuery} from './aggregate-policy.js';
import type {Scope} from './types.js';
import type {AggregateQuery,AggregateResult} from './aggregate-types.js';
// The materialized eligible relation keeps every source row, including missing
// metric attributes. A future capture statement can consume the same relation.
export async function aggregateEntitiesWithClient(client:EntityClient,scope:Scope,input:AggregateQuery):Promise<AggregateResult> {
 const query=parseAggregateQuery(input);
 try {
  await client.query("SET LOCAL statement_timeout = '3s'");
  await client.query("SET LOCAL lock_timeout = '1s'");
  const schema=await publication(client,scope,query.schemaId,query.schemaVersion);
  const compiled=compileAggregateQuery(query,schema,5);
  const values=[scope.organizationId,scope.actorId,query.schemaId,query.schemaVersion,...compiled.values];
  const result=await client.query(`WITH eligible AS MATERIALIZED (
   SELECT id,attributes FROM enterprise_entities
   WHERE ${accessPredicate('enterprise_entities','$2','$1','read')}
   AND archived_at IS NULL AND schema_id=$3 AND schema_version=$4 AND ${compiled.sourcePredicate}
  ) SELECT ${compiled.select} FROM eligible ${compiled.group} LIMIT 201`,values);
  if(result.rows.length>200)throw new EntityError(409,'Aggregate exceeds 200 groups.');
  return {schemaId:query.schemaId,schemaVersion:query.schemaVersion,groupBy:query.groupBy,groups:result.rows.map(row=>({
   keys:query.groupBy.map((_,index)=>row[`g${index}`] as string|boolean|null),
   metrics:Object.fromEntries(query.metrics.map((metric,index)=>[metric.name,row[`m${index}`] as string|null]))
  }))};
 } catch(error) {
  const code=(error as {code?:string}).code;
  if(code==='57014'||code==='55P03')throw new EntityError(503,'Aggregate query timed out.');
  throw error;
 }
}
