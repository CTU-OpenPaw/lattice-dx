/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import { dockerContextArgs } from './lib/docker-context.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const prefix=[...dockerContextArgs(), 'compose','-f','infra/compose/core.yml','exec','-T','-w','/app/apps/api','api'];
for(const [key,value] of [['ENTITY_AUTOMATION_WORKER','invalid'],['API_PORT','0'],['WORKFLOW_OUTBOX_WORKER','true']]){
 let failure;
 try{execFileSync('docker',[...prefix,'env','DATABASE_URL=postgres://not-real.invalid/unreachable','FILE_STORAGE_ROOT=/unavailable-fixture',key+'='+value,'pnpm','exec','tsx','src/index.ts'],{cwd:root,encoding:'utf8',timeout:15000,stdio:['ignore','pipe','pipe']});}
 catch(error){failure=error;}
 assert.ok(failure);assert.ok(failure.stderr.includes('Invalid runtime configuration:'),failure.stderr);assert.ok(!failure.stderr.includes('ENOENT'),failure.stderr);assert.ok(!failure.stderr.includes('getaddrinfo'),failure.stderr);
}
const source=`
import {spawn} from 'node:child_process';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import pg from 'pg';import {mkdtemp} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {recordDatabase,connectRecords} from './src/database.ts';import {foundationDatabase} from './src/foundation-database.ts';import {createFilesystemStore} from './src/files/filesystem-store.ts';import {offloadFileWithClient} from './src/files/storage-database.ts';
(async()=>{const control=new pg.Pool({connectionString:process.env.DATABASE_URL}),schema='runtime_smoke_'+randomUUID().replaceAll('-','');let pool,database;
try{await control.query('CREATE SCHEMA '+schema);const url=new URL(process.env.DATABASE_URL);url.searchParams.set('options','-c search_path='+schema);pool=new pg.Pool({connectionString:url.toString(),max:1});await recordDatabase(pool);const foundation=await foundationDatabase(pool),store=await createFilesystemStore(await mkdtemp(join(tmpdir(),'latticedx-runtime-')));const file=await foundation.createFile({filename:'runtime.txt',ownerId:'owner',organizationId:'a',content:Buffer.from('Runtime preserved bytes')});await foundation.markFile(file.id,'clean');const client=await pool.connect();try{await client.query('BEGIN');await offloadFileWithClient(client,file.id,1,store);await client.query('COMMIT');}finally{client.release();}
await assert.rejects(()=>connectRecords(url.toString()),error=>error.message==='Filesystem storage requires a configured root');database=await connectRecords(url.toString(),{store});const content=await database.foundation.loadFileContent(file.id,{subject:'owner',organizationId:'a',roles:['files:read']});assert.equal(content.content.toString(),'Runtime preserved bytes');await database.close();database=undefined;
const login=await fetch('http://keycloak:8080/realms/lattice/protocol/openid-connect/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'password',client_id:'dx-local',username:'alice',password:'local-alice-password'})});assert.equal(login.status,200);const token=(await login.json()).access_token;let previous;
for(let cycle=0;cycle<2;cycle++){const child=spawn(process.execPath,['--import','tsx','src/index.ts'],{env:{...process.env,DATABASE_URL:url.toString(),API_HOST:'127.0.0.1',API_PORT:'14583',ENTITY_AUTOMATION_WORKER:'true',WORKFLOW_TIMER_WORKER:'true',WORKFLOW_WAIT_TIMEOUT_WORKER:'true',WORKFLOW_OUTBOX_WORKER:'false',FILE_STORAGE_WORKER:'false',FILE_STORAGE_ROOT:process.env.FILE_STORAGE_ROOT},stdio:['ignore','pipe','pipe']});let logs='';child.stdout.on('data',chunk=>logs+=chunk.toString());child.stderr.on('data',chunk=>logs+=chunk.toString());const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));try{let metrics;for(let attempt=0;attempt<100;attempt++){if(child.exitCode!==null)throw new Error('Fixture runtime exited before acceptance');try{const response=await fetch('http://127.0.0.1:14583/v1/operations/metrics',{headers:{authorization:'Bearer '+token},signal:AbortSignal.timeout(1000)});if(response.status===200){metrics=await response.json();if(metrics.workers.filter(item=>item.result==='idle').length===3)break;}}catch{}await new Promise(resolve=>setTimeout(resolve,100));}assert.ok(metrics);assert.equal(metrics.workers.filter(item=>item.result==='idle').length,3);if(previous)assert.notEqual(metrics.startedAt,previous);previous=metrics.startedAt;assert.ok(metrics.workers.every(item=>item.count<10));child.kill('SIGTERM');child.kill('SIGTERM');const result=await Promise.race([exited,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('Fixture shutdown exceeded bound')),10000);timer.unref();})]);assert.equal(result.code,0);assert.equal(result.signal,null);}finally{if(child.exitCode===null&&!child.signalCode){child.kill('SIGKILL');await exited;}}}
console.log('Runtime actual process passed: three explicit durable workers emit idle telemetry, repeated SIGTERM exits cleanly, restart resets process metrics and resumes worker schedules.');console.log('Runtime PostgreSQL passed: filesystem metadata without configured reader fails startup; configured store restores actual downloads and pool closes.');
}finally{await database?.close();await pool?.end();if(!/^runtime_smoke_[a-f0-9]{32}$/.test(schema))throw new Error('Unsafe fixture');await control.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await control.end();}})().catch(error=>{console.error(error);process.exitCode=1;});
`;
console.log(execFileSync('docker',[...prefix,'pnpm','exec','tsx','--eval',source],{cwd:root,encoding:'utf8',timeout:90000,stdio:['ignore','pipe','pipe']}).trim());
console.log('Runtime actual process validation passed before missing filesystem root or unreachable database connection.');
