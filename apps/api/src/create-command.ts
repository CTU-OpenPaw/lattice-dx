/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
export class CreateCommandError extends Error {
  constructor(public readonly statusCode:400|409|503,message:string){super(message);}
}
export function parseCreateKey(value:unknown,rawHeaders?:string[]):string|undefined {
  if(rawHeaders && rawHeaders.filter((v,i)=>i%2===0&&v.toLowerCase()==='idempotency-key').length>1)throw new CreateCommandError(400,'Idempotency-Key phải là một header duy nhất.');
  if(value===undefined)return;
  if(typeof value!=='string'||!/^[A-Za-z0-9._:-]{1,128}$/.test(value))throw new CreateCommandError(400,'Idempotency-Key không hợp lệ.');
  return value;
}
export function requireCreateCapability(key:string|undefined,repository:{supportsCreateCommands?:boolean}) {
  if(key!==undefined&&!repository.supportsCreateCommands)throw new CreateCommandError(503,'Create command chưa được cấu hình.');
}
export function createFingerprint(input:Record<string,unknown>):string {
  const normalized=Object.fromEntries(Object.keys(input).sort().filter(k=>input[k]!==undefined).map(k=>[k,k==='title'&&typeof input[k]==='string'?input[k].trim():k==='recordId'&&typeof input[k]==='string'?input[k].toLowerCase():input[k]]));
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}
export async function initializeCreateCommands(pool:Pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS foundation_create_commands (
    organization_id text NOT NULL, actor_id text NOT NULL, operation text NOT NULL, key text NOT NULL,
    fingerprint text NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(organization_id,actor_id,operation,key)
  )`);
}
export async function runCreateCommand<T>(pool:Pool,identity:{organizationId:string;actorId:string;operation:'records.create'|'tasks.create';key?:string},input:Record<string,unknown>,validate:(client:PoolClient)=>Promise<void>,create:(client:PoolClient)=>Promise<T>):Promise<T> {
  const key=parseCreateKey(identity.key);
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const tuple=[identity.organizationId,identity.actorId,identity.operation,key];
    if(key!==undefined) {
      const lock=createHash('sha256').update(JSON.stringify(tuple)).digest().readBigInt64BE(0).toString();
      await client.query('SELECT pg_advisory_xact_lock($1::bigint)',[lock]);
    }
    await validate(client);
    const fingerprint=createFingerprint(input);
    if(key!==undefined) {
      const receipt=(await client.query('SELECT fingerprint,result FROM foundation_create_commands WHERE organization_id=$1 AND actor_id=$2 AND operation=$3 AND key=$4',tuple)).rows[0];
      if(receipt) {
        if(receipt.fingerprint!==fingerprint)throw new CreateCommandError(409,'Idempotency-Key đã được dùng với nội dung khác.');
        await client.query('COMMIT');
        return receipt.result as T;
      }
    }
    const result=await create(client);
    if(key!==undefined)await client.query('INSERT INTO foundation_create_commands(organization_id,actor_id,operation,key,fingerprint,result) VALUES($1,$2,$3,$4,$5,$6::jsonb)',[...tuple,fingerprint,JSON.stringify(result)]);
    await client.query('COMMIT');
    return result;
  } catch(error) {await client.query('ROLLBACK');throw error;}
  finally {client.release();}
}
