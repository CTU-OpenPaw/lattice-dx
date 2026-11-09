// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {nativePostgres,backupNative,rehearseNative,compareNativeInventory} from './native-database-recovery.mjs';
import {assertRestoreTarget,runRestoreFixture} from './lib/backup-policy.mjs';

const source=assertRestoreTarget('dx_restore_'+randomUUID().replaceAll('-',''));
const sql=(database,statement)=>nativePostgres(['psql','-X','-v','ON_ERROR_STOP=1','-U','nocobase','-d',database,'-At','-c',statement]).toString().trim();
const dump=nativePostgres(['pg_dump','--format=custom','--no-owner','--no-acl','-U','nocobase','-d','nocobase']);
const result=runRestoreFixture(source,()=>sql('postgres','CREATE DATABASE '+source),()=>{
  nativePostgres(['pg_restore','--exit-on-error','--no-owner','--no-acl','-U','nocobase','-d',source],dump);
  // Only the isolated source clone receives fixture writes. No app or workers
  // connect to it; production metadata and configuration remain untouched.
  sql(source,`CREATE TABLE native_recovery_byte_fixture(id integer PRIMARY KEY,content bytea NOT NULL);
    INSERT INTO native_recovery_byte_fixture VALUES(1,decode('0001ff7f414243','hex'));`);
  const run=(args,input)=>{
    const mapped=[...args];
    if(mapped[0]==='pg_dump'){
      assert.equal(mapped.at(-1),'nocobase');mapped[mapped.length-1]=source;
    }
    return nativePostgres(mapped,input);
  };
  const backup=backupNative({run});
  sql(source,`UPDATE native_recovery_byte_fixture SET content=decode('ff01007f414243','hex') WHERE id=1;`);
  const changed=backupNative({run});
  const changedInventory=JSON.parse(readFileSync(changed.path+'.json','utf8')).inventory;
  sql(source,`INSERT INTO native_recovery_byte_fixture VALUES(2,decode('01','hex'));`);
  const report=rehearseNative(backup.path,{run});
  assert.equal(report.metadataVerified,true);
  assert.equal(report.objectsVerified,false);
  assert.equal(report.fullRecoverability,false);
  assert.equal(report.applicationHealthVerified,false);
  const probe=report.inventory.find(row=>row.table==='native_recovery_byte_fixture');
  assert.equal(probe?.rows,1,'Restore used the changed live source instead of the snapshot');
  const changedProbe=changedInventory.find(row=>row.table==='native_recovery_byte_fixture');
  assert.equal(changedProbe?.rows,1);
  assert.notEqual(changedProbe?.fingerprint,probe?.fingerprint,'Same-size byte change was not detected');
  assert.throws(()=>compareNativeInventory(report.inventory,changedInventory),/differs/);
  const original=JSON.parse(readFileSync(backup.path+'.json','utf8'));
  const bad=join(dirname(backup.path),'core-'+randomUUID().replaceAll('-','')+'.dump');
  writeFileSync(bad,Buffer.from('corrupt archive'),{flag:'wx',mode:0o600});
  writeFileSync(bad+'.json',JSON.stringify(original),{flag:'wx',mode:0o600});
  let commands=0;
  assert.throws(()=>rehearseNative(bad,{run:(...args)=>{commands++;return run(...args);}}));
  assert.equal(commands,0,'Corrupt dump reached PostgreSQL');
  return {result:'PASS',checks:['native_snapshot_and_metadata_restore','binary_fixture_preserved',
    'live_source_changes_do_not_change_snapshot','changed_data_detected','corruption_denied_before_database_command',
    'scope_flags_do_not_claim_full_system_recovery'],tables:report.inventory.length,backupPath:backup.path,reportPath:report.reportPath};
},()=>sql('postgres','DROP DATABASE IF EXISTS '+assertRestoreTarget(source)+' WITH (FORCE)'));
assert.equal(sql('postgres',`SELECT count(*) FROM pg_database WHERE datname='${source}'`),'0','Fixture source was not cleaned');
console.log(JSON.stringify({...result,fixtureSourceCleaned:true}));
