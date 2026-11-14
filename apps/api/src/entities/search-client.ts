/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import type {Pool,PoolClient} from 'pg';
import {accessPredicate} from './access.js';
import {entity,entityColumns,publication} from './client.js';
import {withEntityTransaction} from './commands.js';
import {pageResult,type Page} from '../pagination.js';
import {EntityError} from './policy.js';
import {parseEntitySearch} from './search-policy.js';
import type {Entity,EntitySearch,Scope} from './types.js';

export class SearchUnavailableError extends EntityError {
 readonly code='search_unavailable';
 constructor(){super(503,'search_unavailable');}
}

// The caller owns the transaction and connection; the helper never acquires one.
export async function searchEntitiesWithClient(client:PoolClient,scope:Scope,input:EntitySearch):Promise<Page<Entity>> {
 const query=parseEntitySearch(input);
 try {
  await client.query("SET LOCAL statement_timeout = '3s'");
  if(query.schemaId!==undefined)await publication(client,scope,query.schemaId,query.schemaVersion);
  const result=await client.query(`SELECT ${entityColumns} FROM enterprise_entities e
   WHERE ${accessPredicate('e','$2','$1','read')} AND e.archived_at IS NULL
   AND ($4::text IS NULL OR (e.schema_id=$4 AND e.schema_version=$5::integer))
   AND e.search_vector @@ plainto_tsquery('simple'::regconfig,$3)
   ORDER BY e.created_at DESC,e.id DESC LIMIT $6 OFFSET $7`,
   [scope.organizationId,scope.actorId,query.q,query.schemaId??null,query.schemaVersion??null,query.limit+1,query.offset]);
  return pageResult(result.rows.map(entity),query);
 } catch(error) {
  if((error as {code?:string}).code==='57014')throw new SearchUnavailableError();
  throw error;
 }
}

export async function searchEntities(pool:Pool,scope:Scope,query:EntitySearch):Promise<Page<Entity>> {
 try {return await withEntityTransaction(pool,client=>searchEntitiesWithClient(client,scope,query));}
 catch(error) {
  if(error instanceof EntityError)throw error;
  throw new SearchUnavailableError();
 }
}
