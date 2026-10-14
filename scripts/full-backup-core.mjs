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
 const value=sql(target,`SELECT coalesce(jsonb_agg(jsonb_build_object('fileId',id::text,'objectKey',object_key::text,'size',size,'sha256',content_sha256) ORDER BY id),'[]'::jsonb) FROM foundation_files WHERE storage_provider='filesystem'`);
 if(Buffer.byteLength(value)>maxObjectManifestBytes)throw new Error('Object inventory exceeds bound.');return validateObjectInventory(JSON.parse(value));
}
function apiSource(source,input){
 return execFileSync('docker',['--context','desktop-linux','compose','-f','infra/compose/core.yml','exec','-T','-w','/app/apps/api','api','pnpm','exec','tsx','--eval',source],{cwd:root,input,timeout:30000,maxBuffer:2*1024*1024,stdio:['pipe','pipe','pipe']});
}
function readCurrentObject(entry){
 const source=`import {createFilesystemStore} from './src/files/filesystem-store.ts';(async()=>{if(!process.env.FILE_STORAGE_ROOT)throw new Error('Object store is not configured');const store=await createFilesystemStore(process.env.FILE_STORAGE_ROOT);process.stdout.write(await store.readVerified(${JSON.stringify({provider:'filesystem',objectKey:entry.objectKey,size:entry.size,sha256:entry.sha256})}));})().catch(()=>{console.error('Object source unavailable');process.exitCode=1;});`;
 const bytes=apiSource(source);verifyObjectBytes(bytes,entry);return bytes;
}
export function backupFull(){
 const db=backup(),bytes=boundedRead(db.path,256*1024*1024);verifyBackup(bytes,db.manifest);
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
  return {format:'latticedx.full-restore-rehearsal',version:1,scope:'database-and-objects',objectsVerified:true,downloadVerified:false,completedAt:new Date().toISOString(),fixtureDatabase:target,dumpSha256:manifest.dump.sha256,count:manifest.count,totalBytes:manifest.totalBytes,extraObjects};
 });
 // The production loader acceptance gate is added with the storage integration.
 // Until then verified copies do not claim a successful application download.
 writeFileSync(join(path,'rehearsal-'+randomUUID().replaceAll('-','')+'.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});return report;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const [mode,path,...extra]=process.argv.slice(2);if(extra.length)throw new Error('Unexpected arguments.');if(mode==='backup'&&path===undefined)console.log(JSON.stringify(backupFull()));else if(mode==='rehearse'&&path)console.log(JSON.stringify(rehearseFull(path)));else throw new Error('Usage: full-backup-core.mjs backup | rehearse <full-directory>');}
 catch(error){console.error(error instanceof AggregateError?error.errors.map(item=>item.message).join('; '):error instanceof Error?error.message:'Full recovery failed');process.exitCode=1;}
}
