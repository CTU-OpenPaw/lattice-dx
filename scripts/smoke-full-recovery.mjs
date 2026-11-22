/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {backupFull,rehearseFull} from './full-backup-core.mjs';
import { dockerContextArgs } from './lib/docker-context.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),bytes=Buffer.from('LatticeDX paired recovery verification');
const login=await fetch('http://localhost:8081/realms/lattice/protocol/openid-connect/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'password',client_id:'dx-local',username:'alice',password:'local-alice-password'}),signal:AbortSignal.timeout(15000)});assert.equal(login.status,200);const token=(await login.json()).access_token;
const upload=await fetch('http://localhost:8080/v1/files',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({filename:'paired-recovery-'+randomUUID()+'.txt',contentBase64:bytes.toString('base64')}),signal:AbortSignal.timeout(25000)});assert.equal(upload.status,201);const file=await upload.json();assert.equal(file.scanStatus,'clean');
function offload(file){const source=`import pg from 'pg';import assert from 'node:assert/strict';import {createFilesystemStore} from './src/files/filesystem-store.ts';import {offloadFileWithClient} from './src/files/storage-database.ts';(async()=>{const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1});try{const store=await createFilesystemStore(process.env.FILE_STORAGE_ROOT),client=await pool.connect();try{await client.query('BEGIN');const row=(await client.query('SELECT owner_id,organization_id FROM foundation_files WHERE id=$1',[${JSON.stringify(file.id)}])).rows[0];assert.equal(row.owner_id,${JSON.stringify(file.ownerId)});assert.equal(row.organization_id,${JSON.stringify(file.organizationId)});await offloadFileWithClient(client,${JSON.stringify(file.id)},1,store);await client.query('COMMIT');}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}}finally{await pool.end();}})().catch(error=>{console.error(error);process.exitCode=1;});`;
execFileSync('docker',[...dockerContextArgs(), 'compose','-f','infra/compose/core.yml','exec','-T','-w','/app/apps/api','api','pnpm','exec','tsx','--eval',source],{cwd:root,encoding:'utf8',timeout:30000,stdio:['ignore','pipe','pipe']});}
offload(file);
const download=await fetch('http://localhost:8080/v1/files/'+file.id+'/content',{headers:{authorization:'Bearer '+token},signal:AbortSignal.timeout(20000)});assert.equal(download.status,200);assert.deepEqual(Buffer.from(await download.arrayBuffer()),bytes);
const lateUpload=await fetch('http://localhost:8080/v1/files',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({filename:'late-recovery-'+randomUUID()+'.txt',contentBase64:bytes.toString('base64')}),signal:AbortSignal.timeout(25000)});assert.equal(lateUpload.status,201);const lateFile=await lateUpload.json();assert.equal(lateFile.scanStatus,'clean');
const backup=backupFull({afterDump:()=>offload(lateFile)}),report=rehearseFull(backup.path);assert.equal(report.objectsVerified,true);assert.equal(report.downloadVerified,true);assert.ok(report.count>=1);
const manifest=JSON.parse(readFileSync(join(backup.path,'manifest.json'),'utf8'));assert.ok(!manifest.inventory.some(entry=>entry.fileId===lateFile.id));
for(const failure of ['missing','corrupt','omitted']){
 const path=join(dirname(backup.path),'full-'+randomUUID().replaceAll('-',''));mkdirSync(path);mkdirSync(join(path,'objects'));writeFileSync(join(path,manifest.dump.name),readFileSync(join(backup.path,manifest.dump.name)),{flag:'wx'});
 for(const [index,entry] of manifest.inventory.entries())if(failure!=='missing'||index!==0)writeFileSync(join(path,'objects',entry.objectKey),failure==='corrupt'&&index===0?Buffer.alloc(entry.size,1):readFileSync(join(backup.path,'objects',entry.objectKey)),{flag:'wx'});
 const value=failure==='omitted'?{...manifest,inventory:[],count:0,totalBytes:0}:manifest;writeFileSync(join(path,'manifest.json'),JSON.stringify(value),{flag:'wx'});assert.throws(()=>rehearseFull(path));
}
console.log(JSON.stringify({result:'Paired recovery passed: actual scanned/offloaded download, snapshot-matched object inventory, restored isolated root and application loader, missing/corrupt/omitted references denied.',backupPath:backup.path,objects:report.count,totalBytes:report.totalBytes,downloadVerified:report.downloadVerified,fileId:file.id}));
