// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { parseCreateKey } from '../create-command.js';
import { bad, canonicalJson, EntityError } from './policy.js';
import type { Scope } from './types.js';
export async function withEntityTransaction<T>(pool:Pool, work:(client:PoolClient)=>Promise<T>):Promise<T> {
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const result=await work(client);
    await client.query('COMMIT');
    return result;
  } catch(error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
export async function runEntityCommandInTransaction<T>(client:PoolClient,scope:Scope,operation:string,key:string,input:unknown,validate:(client:PoolClient)=>Promise<void>,execute:(client:PoolClient)=>Promise<T>,validateReplay?:(client:PoolClient,result:T)=>Promise<void>):Promise<T> {
  if(!parseCreateKey(key)) bad('Idempotency-Key is required.');
    const tuple=[scope.organizationId,scope.actorId,operation,key];
    const lock=createHash('sha256').update(canonicalJson(tuple)).digest().readBigInt64BE(0).toString();
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)',[lock]);
    await validate(client);
    const fingerprint=createHash('sha256').update(canonicalJson(input)).digest('hex');
    const receipt=(await client.query('SELECT fingerprint,result FROM enterprise_commands WHERE organization_id=$1 AND actor_id=$2 AND operation=$3 AND key=$4',tuple)).rows[0];
    if(receipt) {
      if(receipt.fingerprint!==fingerprint) throw new EntityError(409,'Idempotency-Key was used with different input.');
      await validateReplay?.(client,receipt.result as T);
      return receipt.result as T;
    }
    const result=await execute(client);
    await client.query('INSERT INTO enterprise_commands(organization_id,actor_id,operation,key,fingerprint,result) VALUES($1,$2,$3,$4,$5,$6::jsonb)',[...tuple,fingerprint,JSON.stringify(result)]);
    return result;
}
