// SPDX-License-Identifier: Apache-2.0
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,lstatSync,realpathSync,readdirSync} from 'node:fs';
import {join,resolve,dirname,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {backup,postgres,sql} from './backup-core.mjs';
import {assertRestoreTarget,verifyBackup,runRestoreFixture} from './lib/backup-policy.mjs';
import {validateObjectInventory,validateFullManifest,verifyObjectBytes,compareObjectInventories,maxObjectManifestBytes} from './lib/object-backup-policy.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),backupRoot=join(root,'output','backups');
const normalize=value=>process.platform==='win32'?value.toLowerCase():value;
function artifactDirectory(value){
 const path=resolve(value);
 if(dirname(path)!==resolve(backupRoot)||!/^full-[a-f0-9]{32}$/.test(basename(path)))throw new Error('Invalid full backup directory.');
 const stat=lstatSync(path);if(!stat.isDirectory()||stat.isSymbolicLink()||normalize(realpathSync(path))!==normalize(path))throw new Error('Backup directory links are forbidden.');
 return path;
}
function boundedRead(path,maxBytes){
 const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>maxBytes||normalize(realpathSync(path))!==normalize(resolve(path)))throw new Error('Invalid backup artifact.');
 const bytes=readFileSync(path);if(bytes.length>maxBytes)throw new Error('Backup artifact grew beyond bound.');return bytes;
}
function restore(bytes,work){
 const target=assertRestoreTarget('dx_restore_'+randomUUID().replaceAll('-',''));
 return runRestoreFixture(target,()=>sql('postgres','CREATE DATABASE '+target),()=>{
  postgres(['pg_restore','--exit-on-error','--no-owner','--no-acl','-U','lattice','-d',target],bytes);
  return work(target);
 },()=>sql('postgres','DROP DATABASE IF EXISTS '+assertRestoreTarget(target)+' WITH (FORCE)'));
}
function restoredInventory(target){
 const exists=sql(target,"SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='foundation_files' AND column_name='storage_provider'");
 if(exists==='0')return [];
 const value=sql(target,`WITH bounded AS (
  SELECT id,object_key,size,content_sha256 FROM foundation_files
  WHERE storage_provider='filesystem' ORDER BY id LIMIT 10001
 ) SELECT coalesce(jsonb_agg(jsonb_build_object('fileId',id::text,'objectKey',object_key::text,'size',size,'sha256',content_sha256) ORDER BY id),'[]'::jsonb) FROM bounded`);
 if(Buffer.byteLength(value)>maxObjectManifestBytes)throw new Error('Object inventory exceeds bound.');return validateObjectInventory(JSON.parse(value));
}
function apiSource(source,input){
 return execFileSync('docker',['--context','desktop-linux','compose','-f','infra/compose/core.yml','exec','-T','-w','/app/apps/api','api','pnpm','exec','tsx','--eval',source],{cwd:root,input,timeout:30000,maxBuffer:2*1024*1024,stdio:['pipe','pipe','pipe']});
}
function readCurrentObject(entry){
 const source=`import {createFilesystemStore} from './src/files/filesystem-store.ts';(async()=>{if(!process.env.FILE_STORAGE_ROOT)throw new Error('Object store is not configured');const store=await createFilesystemStore(process.env.FILE_STORAGE_ROOT);process.stdout.write(await store.readVerified(${JSON.stringify({provider:'filesystem',objectKey:entry.objectKey,size:entry.size,sha256:entry.sha256})}));})().catch(()=>{console.error('Object source unavailable');process.exitCode=1;});`;
 const bytes=apiSource(source);verifyObjectBytes(bytes,entry);return bytes;
}
function restoreObjectRoot(path,inventory){
 const source=`import {mkdtemp} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';(async()=>{process.stdout.write(await mkdtemp(join(tmpdir(),'latticedx-restore-')));})().catch(()=>{process.exitCode=1;});`;
 const objectRoot=apiSource(source).toString('utf8');
 if(!/^\/tmp\/latticedx-restore-[A-Za-z0-9_-]+$/.test(objectRoot))throw new Error('Invalid isolated object restore root.');
 for(const entry of inventory){
  const bytes=boundedRead(join(path,'objects',entry.objectKey),1048576);verifyObjectBytes(bytes,entry);
  const copy=`import {open} from 'node:fs/promises';import {join} from 'node:path';import {createFilesystemStore} from './src/files/filesystem-store.ts';(async()=>{const chunks=[];let size=0;for await(const chunk of process.stdin){size+=chunk.length;if(size>1048576)throw new Error('Object too large');chunks.push(chunk);}const bytes=Buffer.concat(chunks),file=await open(join(${JSON.stringify(objectRoot)},${JSON.stringify(entry.objectKey)}),'wx',0o600);try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}const store=await createFilesystemStore(${JSON.stringify(objectRoot)});await store.readVerified(${JSON.stringify({provider:'filesystem',objectKey:entry.objectKey,size:entry.size,sha256:entry.sha256})});})().catch(()=>{console.error('Restored object verification failed');process.exitCode=1;});`;
  apiSource(copy,bytes);
 }
 return objectRoot;
}
function verifyRestoredDownload(database,objectRoot,inventory){
 if(!inventory.length)return false;
 const source=`import pg from 'pg';import {createFilesystemStore} from './src/files/filesystem-store.ts';import {loadFileContentWithClient} from './src/files/content.ts';import {createHash} from 'node:crypto';(async()=>{const url=new URL(process.env.DATABASE_URL);url.pathname='/'+${JSON.stringify(database)};const pool=new pg.Pool({connectionString:url.toString(),max:1});try{const client=await pool.connect();try{await client.query('BEGIN');const row=(await client.query("SELECT id,owner_id,organization_id FROM foundation_files WHERE storage_provider='filesystem' AND scan_status='clean' ORDER BY id LIMIT 1")).rows[0];if(!row)throw new Error('No clean restored download fixture');const store=await createFilesystemStore(${JSON.stringify(objectRoot)});const file=await loadFileContentWithClient(client,{subject:row.owner_id,organizationId:row.organization_id,roles:['files:read','data:read']},row.id,{kind:'foundation'},store);if(!file)throw new Error('Restored download denied');await client.query('COMMIT');process.stdout.write(JSON.stringify({fileId:row.id,sha256:createHash('sha256').update(file.content).digest('hex'),size:file.content.length}));}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}}finally{await pool.end();}})().catch(()=>{console.error('Restored application download failed');process.exitCode=1;});`;
 const result=JSON.parse(apiSource(source).toString('utf8')),expected=inventory.find(entry=>entry.fileId===result.fileId);
 if(!expected||expected.sha256!==result.sha256||expected.size!==result.size)throw new Error('Restored application bytes differ.');return true;
}
export function backupFull(options={}){
 const db=backup(),bytes=boundedRead(db.path,256*1024*1024);verifyBackup(bytes,db.manifest);
 // Internal synchronous seam for proving inventory follows the dump while live rows change.
 options.afterDump?.();
 const inventory=restore(bytes,target=>restoredInventory(target));
 const path=join(backupRoot,'full-'+randomUUID().replaceAll('-',''));mkdirSync(path);artifactDirectory(path);mkdirSync(join(path,'objects'));
 const dump={name:basename(db.path),sha256:db.manifest.sha256,bytes:bytes.length};writeFileSync(join(path,dump.name),bytes,{flag:'wx'});
 for(const entry of inventory){const object=readCurrentObject(entry);writeFileSync(join(path,'objects',entry.objectKey),object,{flag:'wx',mode:0o600});verifyObjectBytes(boundedRead(join(path,'objects',entry.objectKey),1048576),entry);}
 const manifest={format:'latticedx.full-backup',version:1,createdAt:new Date().toISOString(),scope:'database-and-objects',dump,inventory,count:inventory.length,totalBytes:inventory.reduce((sum,entry)=>sum+entry.size,0)};
 validateFullManifest(JSON.stringify(manifest));writeFileSync(join(path,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
 return {path,count:manifest.count,totalBytes:manifest.totalBytes,dumpSha256:dump.sha256};
}
export function rehearseFull(directory){
 const path=artifactDirectory(directory),manifest=validateFullManifest(boundedRead(join(path,'manifest.json'),maxObjectManifestBytes).toString('utf8'));
 const bytes=boundedRead(join(path,manifest.dump.name),256*1024*1024);verifyBackup(bytes,{format:'latticedx.pg-backup',version:1,sha256:manifest.dump.sha256,bytes:manifest.dump.bytes});
 const report=restore(bytes,target=>{
  compareObjectInventories(manifest.inventory,restoredInventory(target));
  const objectRoot=join(path,'objects');const objectStat=lstatSync(objectRoot);if(!objectStat.isDirectory()||objectStat.isSymbolicLink()||normalize(realpathSync(objectRoot))!==normalize(objectRoot))throw new Error('Invalid object directory.');
  for(const entry of manifest.inventory)verifyObjectBytes(boundedRead(join(objectRoot,entry.objectKey),1048576),entry);
  const referenced=new Set(manifest.inventory.map(entry=>entry.objectKey)),extraObjects=readdirSync(objectRoot).filter(name=>!referenced.has(name));if(extraObjects.length>10000)throw new Error('Unreferenced object count exceeds bound.');
  const restoredObjectRoot=restoreObjectRoot(path,manifest.inventory);
  const downloadVerified=verifyRestoredDownload(target,restoredObjectRoot,manifest.inventory);
  return {format:'latticedx.full-restore-rehearsal',version:1,scope:'database-and-objects',objectsVerified:true,downloadVerified,completedAt:new Date().toISOString(),fixtureDatabase:target,restoredObjectRoot,dumpSha256:manifest.dump.sha256,count:manifest.count,totalBytes:manifest.totalBytes,extraObjects};
 });
 writeFileSync(join(path,'rehearsal-'+randomUUID().replaceAll('-','')+'.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});return report;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const [mode,path,...extra]=process.argv.slice(2);if(extra.length)throw new Error('Unexpected arguments.');if(mode==='backup'&&path===undefined)console.log(JSON.stringify(backupFull()));else if(mode==='rehearse'&&path)console.log(JSON.stringify(rehearseFull(path)));else throw new Error('Usage: full-backup-core.mjs backup | rehearse <full-directory>');}
 catch(error){console.error(error instanceof AggregateError?error.errors.map(item=>item.message).join('; '):error instanceof Error?error.message:'Full recovery failed');process.exitCode=1;}
}
