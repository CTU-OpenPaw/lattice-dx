// SPDX-License-Identifier: Apache-2.0
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {assertBackupPath,assertRegularBackup,assertRestoreTarget,verifyBackup,runRestoreFixture} from './lib/backup-policy.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const backupRoot=join(root,'output','backups');
const dockerPrefix=['--context','desktop-linux','compose','-f','infra/compose/core.yml','exec','-T','postgres'];
function postgres(args,input){
 return execFileSync('docker',[...dockerPrefix,...args],{cwd:root,input,timeout:120000,maxBuffer:256*1024*1024,stdio:['pipe','pipe','pipe']});
}
function sql(database,statement){
 return postgres(['psql','-X','-v','ON_ERROR_STOP=1','-U','lattice','-d',database,'-At','-c',statement]).toString().trim();
}
export function backup(){
 mkdirSync(backupRoot,{recursive:true});
 const path=assertBackupPath(join(backupRoot,'core-'+randomUUID().replaceAll('-','')+'.dump'),backupRoot);
 const bytes=postgres(['pg_dump','--format=custom','--no-owner','--no-acl','-U','lattice','-d','lattice']);
 const manifest={format:'latticedx.pg-backup',version:1,createdAt:new Date().toISOString(),sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,database:'lattice'};
 // Fail rather than overwrite any existing artifact; retain both files locally.
 writeFileSync(path,bytes,{flag:'wx'});writeFileSync(path+'.json',JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
 return {path,manifest};
}
export function rehearse(file,recordId){
 const path=assertRegularBackup(file,backupRoot),bytes=readFileSync(path),manifest=JSON.parse(readFileSync(path+'.json','utf8'));
 verifyBackup(bytes,manifest);
 if(recordId!==undefined&&!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(recordId))throw new Error('Sentinel record ID must be a UUID.');
 const archive=postgres(['pg_restore','--list'],bytes).toString();
 if(!archive.includes('TABLE public records ')||!archive.includes('TABLE public enterprise_entities '))throw new Error('Archive does not contain the engine data stores.');
 const database=assertRestoreTarget('dx_restore_'+randomUUID().replaceAll('-',''));
 return runRestoreFixture(database,()=>sql('postgres',`CREATE DATABASE ${database}`),()=>{
  postgres(['pg_restore','--exit-on-error','--no-owner','--no-acl','-U','lattice','-d',database],bytes);
  const inventory=JSON.parse(sql(database,`CREATE TEMP TABLE restore_inventory(name text,rows bigint);
   DO $$ DECLARE t record; n bigint; BEGIN
    FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename LOOP
     EXECUTE format('SELECT count(*) FROM public.%I',t.tablename) INTO n;
     INSERT INTO restore_inventory VALUES(t.tablename,n);
    END LOOP;
   END $$;
   SELECT jsonb_agg(to_jsonb(restore_inventory) ORDER BY name) FROM restore_inventory;`).split('\n').at(-1));
  for(const name of ['records','foundation_tasks','enterprise_entities','enterprise_commands','workflow_runs']){
   if(!inventory.some(table=>table.name===name))throw new Error('Restored store missing: '+name);
  }
  if(recordId!==undefined&&sql(database,`SELECT count(*) FROM records WHERE id='${recordId}'::uuid`)!=='1')throw new Error('Sentinel row did not survive restore.');
  const report={format:'latticedx.restore-rehearsal',version:1,completedAt:new Date().toISOString(),backupSha256:manifest.sha256,fixtureDatabase:database,inventory,...(recordId?{sentinelRecordId:recordId}:{})};
  writeFileSync(path+'.restore-'+randomUUID().replaceAll('-','')+'.json',JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  return report;
 },()=>{assertRestoreTarget(database);sql('postgres',`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);});
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const [mode,file,flag,recordId]=process.argv.slice(2);
  if(mode==='backup'&&file===undefined)console.log(JSON.stringify(backup()));
  else if(mode==='rehearse'&&file&&(flag===undefined||flag==='--record-id')&&(flag===undefined||recordId))console.log(JSON.stringify(rehearse(file,recordId)));
  else throw new Error('Usage: node scripts/backup-core.mjs backup | rehearse <dump> [--record-id UUID]');
 }catch(error){console.error(error instanceof AggregateError?error.errors.map(item=>item.message).join('; '):error instanceof Error?error.message:'Recovery failed');process.exitCode=1;}
}
