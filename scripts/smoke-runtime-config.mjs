// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const prefix=['--context','desktop-linux','compose','-f','infra/compose/core.yml','exec','-T','-w','/app/apps/api','api'];
for(const [key,value] of [['ENTITY_AUTOMATION_WORKER','invalid'],['API_PORT','0'],['WORKFLOW_OUTBOX_WORKER','true']]){
 let failure;
 try{execFileSync('docker',[...prefix,'env','DATABASE_URL=postgres://not-real.invalid/unreachable','FILE_STORAGE_ROOT=/unavailable-fixture',key+'='+value,'pnpm','exec','tsx','src/index.ts'],{cwd:root,encoding:'utf8',timeout:15000,stdio:['ignore','pipe','pipe']});}
 catch(error){failure=error;}
 assert.ok(failure);assert.ok(failure.stderr.includes('Invalid runtime configuration:'),failure.stderr);assert.ok(!failure.stderr.includes('ENOENT'),failure.stderr);assert.ok(!failure.stderr.includes('getaddrinfo'),failure.stderr);
}
const source=`
import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import pg from 'pg';import {mkdtemp} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {recordDatabase,connectRecords} from './src/database.ts';import {foundationDatabase} from './src/foundation-database.ts';import {createFilesystemStore} from './src/files/filesystem-store.ts';import {offloadFileWithClient} from './src/files/storage-database.ts';
(async()=>{const control=new pg.Pool({connectionString:process.env.DATABASE_URL}),schema='runtime_smoke_'+randomUUID().replaceAll('-','');let pool,database;
try{await control.query('CREATE SCHEMA '+schema);const url=new URL(process.env.DATABASE_URL);url.searchParams.set('options','-c search_path='+schema);pool=new pg.Pool({connectionString:url.toString(),max:1});await recordDatabase(pool);const foundation=await foundationDatabase(pool),store=await createFilesystemStore(await mkdtemp(join(tmpdir(),'latticedx-runtime-')));const file=await foundation.createFile({filename:'runtime.txt',ownerId:'owner',organizationId:'a',content:Buffer.from('Runtime preserved bytes')});await foundation.markFile(file.id,'clean');const client=await pool.connect();try{await client.query('BEGIN');await offloadFileWithClient(client,file.id,1,store);await client.query('COMMIT');}finally{client.release();}
await assert.rejects(()=>connectRecords(url.toString()),error=>error.message==='Filesystem storage requires a configured root');database=await connectRecords(url.toString(),{store});const content=await database.foundation.loadFileContent(file.id,{subject:'owner',organizationId:'a',roles:['files:read']});assert.equal(content.content.toString(),'Runtime preserved bytes');await database.close();database=undefined;console.log('Runtime PostgreSQL passed: filesystem metadata without configured reader fails startup; configured store restores actual downloads and pool closes.');
}finally{await database?.close();await pool?.end();if(!/^runtime_smoke_[a-f0-9]{32}$/.test(schema))throw new Error('Unsafe fixture');await control.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await control.end();}})().catch(error=>{console.error(error);process.exitCode=1;});
`;
console.log(execFileSync('docker',[...prefix,'pnpm','exec','tsx','--eval',source],{cwd:root,encoding:'utf8',timeout:90000,stdio:['ignore','pipe','pipe']}).trim());
console.log('Runtime actual process validation passed before missing filesystem root or unreachable database connection.');
