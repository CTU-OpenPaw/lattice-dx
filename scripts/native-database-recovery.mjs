/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync,readFileSync,lstatSync,realpathSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {assertBackupPath,assertRegularBackup,assertRestoreTarget,verifyBackup,runRestoreFixture,maxBackupBytes} from './lib/backup-policy.mjs';
import {dockerContextArgs} from './lib/docker-context.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const backupRoot=join(root,'output/backups/native');
export const requiredNativeTables=['users','roles','collections','fields','uiSchemas','flowModels','workflows','executions','jobs',
  'latticeDepartments','latticeEmployees','latticeLocations','latticeAssets','latticeRequests','latticeOrders','latticeContextOutbox'];

function validateInventory(rows){
  if(!Array.isArray(rows)||rows.length>10000)throw Error('Invalid native store inventory');
  const names=new Set();
  for(const row of rows){
    if(!row||typeof row.table!=='string'||!row.table.length||row.table.length>255||names.has(row.table)||
      !Number.isSafeInteger(row.rows)||row.rows<0||!/^[a-f0-9]{32}$/.test(row.fingerprint))throw Error('Invalid native store inventory');
    names.add(row.table);
  }
  for(const table of requiredNativeTables)if(!names.has(table))throw Error('Missing native store: '+table);
  return rows;
}

export function assertNativeBackup(bytes,manifest){
  verifyBackup(bytes,manifest);
  if(bytes.subarray(0,5).toString()!=='PGDMP'||manifest.database!=='nocobase'||manifest.scope!=='nocobase-database-only')throw Error('Not a native database snapshot');
  validateInventory(manifest.inventory);
}

export function compareNativeInventory(expected,actual){
  validateInventory(expected);validateInventory(actual);
  const current=new Map(actual.map(row=>[row.table,row]));
  if(expected.length!==actual.length||expected.some(row=>{
    const restored=current.get(row.table);return !restored||restored.rows!==row.rows||restored.fingerprint!==row.fingerprint;
  }))throw Error('Restored native data differs from the backup snapshot');
}

export function nativePostgres(args,input){
  const container=process.env.NATIVE_DATABASE_CONTAINER??'lattice-dx-nocobase-db-1';
  if(!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}$/.test(container))throw Error('Invalid database container');
  try{return execFileSync('docker',[...dockerContextArgs(),'exec','-i',container,...args],
    {cwd:root,input,timeout:120000,maxBuffer:maxBackupBytes,windowsHide:true,stdio:['pipe','pipe','pipe']});}
  catch{throw Error('Native database command failed; command output withheld');}
}

function sql(run,database,statement){
  return run(['psql','-X','-v','ON_ERROR_STOP=1','-U','nocobase','-d',database,'-At','-c',statement]).toString().trim();
}

// Fingerprints compare data in isolated restores, including native metadata and
// bytea attachments. They are not signatures; the archive uses SHA-256 separately.
const inventorySql=`SET TIME ZONE 'UTC';
  CREATE TEMP TABLE native_restore_inventory("table" text,rows bigint,fingerprint text);
  DO $$ DECLARE t record; n bigint; digest text; BEGIN
    FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename LOOP
      EXECUTE format('SELECT count(*),md5(coalesce(string_agg(md5(to_jsonb(r)::text),'''' ORDER BY md5(to_jsonb(r)::text)),'''')) FROM public.%I r',t.tablename) INTO n,digest;
      INSERT INTO native_restore_inventory VALUES(t.tablename,n,digest);
    END LOOP;
  END $$;
  SELECT coalesce(jsonb_agg(to_jsonb(native_restore_inventory) ORDER BY "table"),'[]'::jsonb) FROM native_restore_inventory;`;

export function restoreNativeSnapshot(bytes,target,run=nativePostgres){
  assertRestoreTarget(target);
  return runRestoreFixture(target,()=>sql(run,'postgres','CREATE DATABASE '+target),()=>{
    run(['pg_restore','--exit-on-error','--no-owner','--no-acl','-U','nocobase','-d',target],bytes);
    const rows=JSON.parse(sql(run,target,inventorySql).split('\n').at(-1));
    return validateInventory(rows);
  },()=>sql(run,'postgres','DROP DATABASE IF EXISTS '+assertRestoreTarget(target)+' WITH (FORCE)'));
}

const fixture=()=>assertRestoreTarget('dx_restore_'+randomUUID().replaceAll('-',''));

export function backupNative({run=nativePostgres,directory=backupRoot}={}){
  const bytes=run(['pg_dump','--format=custom','--no-owner','--no-acl','-U','nocobase','-d','nocobase']);
  if(bytes.length>maxBackupBytes||bytes.subarray(0,5).toString()!=='PGDMP')throw Error('Native dump is invalid or too large');
  const inventory=restoreNativeSnapshot(bytes,fixture(),run);
  const manifest={format:'latticedx.pg-backup',version:1,scope:'nocobase-database-only',database:'nocobase',createdAt:new Date().toISOString(),
    bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),inventory,
    fullRecoverability:false,objectsVerified:false};
  assertNativeBackup(bytes,manifest);
  mkdirSync(directory,{recursive:true});
  const normalize=value=>process.platform==='win32'?value.toLowerCase():value;
  if(normalize(realpathSync(directory))!==normalize(resolve(directory)))throw Error('Backup directory links are forbidden');
  const path=assertBackupPath(join(directory,'core-'+randomUUID().replaceAll('-','')+'.dump'),directory);
  writeFileSync(path,bytes,{flag:'wx',mode:0o600});
  writeFileSync(path+'.json',JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
  return {path,scope:manifest.scope,sha256:manifest.sha256,tables:inventory.length,fullRecoverability:false,objectsVerified:false};
}

function readManifest(path){
  const file=path+'.json',stat=lstatSync(file);
  const normalize=value=>process.platform==='win32'?value.toLowerCase():value;
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>8*1024*1024||normalize(realpathSync(file))!==normalize(resolve(file)))throw Error('Invalid native backup manifest file');
  return JSON.parse(readFileSync(file,'utf8'));
}

export function rehearseNative(file,{run=nativePostgres,directory=backupRoot}={}){
  const path=assertRegularBackup(file,directory),bytes=readFileSync(path),manifest=readManifest(path);
  assertNativeBackup(bytes,manifest);
  const target=fixture(),inventory=restoreNativeSnapshot(bytes,target,run);
  compareNativeInventory(manifest.inventory,inventory);
  const report={format:'latticedx.native-restore-rehearsal',version:1,scope:'nocobase-database-only',completedAt:new Date().toISOString(),
    backupSha256:manifest.sha256,fixtureDatabase:target,inventory,metadataVerified:true,
    nativeAttachmentBytesVerified:inventory.some(row=>row.table==='lattice_native_request_attachments'&&row.rows>0),
    fullRecoverability:false,objectsVerified:false,applicationHealthVerified:false};
  const reportPath=path+'.restore-'+randomUUID().replaceAll('-','')+'.json';
  writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
  return {reportPath,...report};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const [mode,file,...extra]=process.argv.slice(2);
    if(mode==='backup'&&!file)console.log(JSON.stringify(backupNative()));
    else if(mode==='rehearse'&&file&&!extra.length)console.log(JSON.stringify(rehearseNative(file)));
    else throw Error('Usage: node scripts/native-database-recovery.mjs backup | rehearse <dump>');
  }catch(error){console.error(error instanceof AggregateError?'Restore and fixture cleanup failed':error.message);process.exitCode=1;}
}
