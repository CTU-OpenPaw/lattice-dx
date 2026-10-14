// SPDX-License-Identifier: Apache-2.0
import type {Pool,PoolClient} from 'pg';
import type {ObjectStore} from './object-store.js';
export async function initializeFileStorage(database:Pick<Pool,'query'>) {
 await database.query(`ALTER TABLE foundation_files
 ADD COLUMN IF NOT EXISTS storage_provider text NOT NULL DEFAULT 'postgres',
 ADD COLUMN IF NOT EXISTS object_key uuid,
 ADD COLUMN IF NOT EXISTS content_sha256 text,
 ADD COLUMN IF NOT EXISTS storage_version integer NOT NULL DEFAULT 1`);
 await database.query('ALTER TABLE foundation_files ALTER COLUMN content DROP NOT NULL');
 const invalid=await database.query(`SELECT id FROM foundation_files WHERE NOT (
 storage_version > 0 AND size BETWEEN 0 AND 1048576 AND (
 (storage_provider='postgres' AND content IS NOT NULL AND object_key IS NULL AND content_sha256 IS NULL AND octet_length(content)=size)
 OR (storage_provider='filesystem' AND content IS NULL AND object_key IS NOT NULL AND content_sha256 IS NOT NULL AND content_sha256 ~ '^[a-f0-9]{64}$'))) LIMIT 1`);
 if(invalid.rows.length)throw new Error('Existing file storage shape is invalid');
 await database.query(`DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='foundation_files_storage_shape' AND conrelid='foundation_files'::regclass) THEN
 ALTER TABLE foundation_files ADD CONSTRAINT foundation_files_storage_shape CHECK (
 storage_version > 0 AND size BETWEEN 0 AND 1048576 AND (
 (storage_provider='postgres' AND content IS NOT NULL AND object_key IS NULL AND content_sha256 IS NULL AND octet_length(content)=size)
 OR (storage_provider='filesystem' AND content IS NULL AND object_key IS NOT NULL AND content_sha256 IS NOT NULL AND content_sha256 ~ '^[a-f0-9]{64}$')));
 END IF; END $$`);
 await database.query('CREATE UNIQUE INDEX IF NOT EXISTS foundation_files_object_key_unique ON foundation_files(object_key) WHERE object_key IS NOT NULL');
}
/** Caller owns transaction, commit and rollback. Published objects are never removed. */
export async function offloadFileWithClient(client:PoolClient,fileId:string,expectedStorageVersion:number,store:ObjectStore):Promise<'switched'|'already_switched'> {
 const row=(await client.query('SELECT storage_provider,object_key,content_sha256,storage_version,size,scan_status,content FROM foundation_files WHERE id=$1 FOR UPDATE',[fileId])).rows[0];
 if(!row)throw new Error('File not found');
 if(row.storage_provider==='filesystem'){
  await store.readVerified({provider:'filesystem',objectKey:row.object_key,sha256:row.content_sha256,size:row.size});return 'already_switched';
 }
 if(row.storage_provider!=='postgres'||row.storage_version!==expectedStorageVersion||row.scan_status!=='clean'||!Buffer.isBuffer(row.content)||row.content.length!==row.size)throw new Error('File is not eligible for offload');
 const object=await store.writeVerified(row.content);
 if(object.size!==row.size)throw new Error('Verified object size mismatch');
 const result=await client.query(`UPDATE foundation_files SET storage_provider='filesystem',object_key=$2::uuid,
 content_sha256=$3,content=NULL,storage_version=storage_version+1
 WHERE id=$1 AND storage_provider='postgres' AND storage_version=$4 AND scan_status='clean'`,[fileId,object.objectKey,object.sha256,expectedStorageVersion]);
 if(result.rowCount!==1)throw new Error('File storage revision changed');return 'switched';
}
export async function offloadOneFile(pool:Pool,store:ObjectStore):Promise<'switched'|'idle'> {
 const client=await pool.connect();
 try {
  await client.query('BEGIN');
  const row=(await client.query(`SELECT id,storage_version FROM foundation_files WHERE storage_provider='postgres' AND scan_status='clean' ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`)).rows[0];
  if(row)await offloadFileWithClient(client,row.id,row.storage_version,store);
  await client.query('COMMIT');return row?'switched':'idle';
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
