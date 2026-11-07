// SPDX-License-Identifier: Apache-2.0
import {describe,it,expect} from 'vitest';
import {createHash} from 'node:crypto';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {assertNativeBackup,compareNativeInventory,requiredNativeTables,restoreNativeSnapshot,backupNative,rehearseNative} from '../scripts/native-database-recovery.mjs';

const bytes=Buffer.from('PGDMP native fixture');
const inventory=()=>requiredNativeTables.map(table=>({table,rows:0,fingerprint:'d41d8cd98f00b204e9800998ecf8427e'}));
const manifest=()=>({format:'latticedx.pg-backup',version:1,scope:'nocobase-database-only',database:'nocobase',
  bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),inventory:inventory()});

describe('native database recovery',()=>{
  it('accepts only native snapshot artifacts with the full required inventory',()=>{
    expect(()=>assertNativeBackup(bytes,manifest())).not.toThrow();
    for(const patch of [{database:'lattice'},{scope:'database-only'},{inventory:[]},{inventory:[...inventory(),inventory()[0]]}]){
      expect(()=>assertNativeBackup(bytes,{...manifest(),...patch})).toThrow();
    }
    expect(()=>assertNativeBackup(Buffer.from('corrupt'),manifest())).toThrow();
    const invalid=Buffer.from('not-a-pg-dump');
    expect(()=>assertNativeBackup(invalid,{...manifest(),bytes:invalid.length,sha256:createHash('sha256').update(invalid).digest('hex')})).toThrow();
  });
  it('detects omitted tables and changes in metadata or same-size attachment bytes',()=>{
    const expected=[...inventory(),{table:'lattice_native_request_attachments',rows:1,fingerprint:'a'.repeat(32)}];
    expect(()=>compareNativeInventory(expected,[...expected].reverse())).not.toThrow();
    expect(()=>compareNativeInventory(expected,inventory())).toThrow();
    expect(()=>compareNativeInventory(expected,expected.map(row=>row.table==='roles'?{...row,rows:1}:row))).toThrow();
    expect(()=>compareNativeInventory(expected,expected.map(row=>row.table==='lattice_native_request_attachments'?{...row,fingerprint:'b'.repeat(32)}:row))).toThrow();
  });
  it('rejects a source restore target before executing any command',()=>{
    const calls:unknown[]=[];
    expect(()=>restoreNativeSnapshot(bytes,'nocobase',(...args)=>calls.push(args))).toThrow();
    expect(calls).toEqual([]);
  });
  it('restores only to a generated fixture and cleans it when restore fails',()=>{
    const calls:{args:string[],input?:Buffer}[]=[];
    const target='dx_restore_'+'a'.repeat(32);
    const run=(args:string[],input?:Buffer)=>{
      calls.push({args,input});
      if(args[0]==='pg_restore')throw Error('restore failed');
      return Buffer.alloc(0);
    };
    expect(()=>restoreNativeSnapshot(bytes,target,run)).toThrow('restore failed');
    expect(calls).toHaveLength(3);
    expect(calls[0].args.at(-1)).toBe('CREATE DATABASE '+target);
    expect(calls[1].args).toContain('--exit-on-error');
    expect(calls[1].input).toEqual(bytes);
    expect(calls[2].args.at(-1)).toBe('DROP DATABASE IF EXISTS '+target+' WITH (FORCE)');
  });
  it('preserves restore and cleanup errors without exposing driver details',()=>{
    const run=(args:string[])=>{if(args[0]==='pg_restore')throw Error('restore failed');if(args.at(-1)?.startsWith('DROP'))throw Error('cleanup failed');return Buffer.alloc(0);};
    expect(()=>restoreNativeSnapshot(bytes,'dx_restore_'+'b'.repeat(32),run)).toThrow(AggregateError);
  });
  it('writes and rehearses a complete artifact, rejects corruption before running any database command',()=>{
    const directory=mkdtempSync(join(tmpdir(),'native-recovery-')),calls:string[][]=[];
    const run=(args:string[])=>{
      calls.push(args);
      if(args[0]==='pg_dump')return bytes;
      if(args[0]==='psql'&&args.at(-1)?.includes('native_restore_inventory'))return Buffer.from(JSON.stringify(inventory()));
      return Buffer.alloc(0);
    };
    try{
      const backup=backupNative({run,directory});
      const report=rehearseNative(backup.path,{run,directory});
      expect(report.metadataVerified).toBe(true);
      expect(report.fullRecoverability).toBe(false);
      expect(report.objectsVerified).toBe(false);
      expect(report.applicationHealthVerified).toBe(false);
      expect(JSON.parse(readFileSync(report.reportPath,'utf8')).backupSha256).toBe(backup.sha256);
      expect(calls.filter(args=>args.at(-1)?.startsWith('DROP'))).toHaveLength(2);
      calls.length=0;writeFileSync(backup.path,Buffer.from('corrupt artifact'));
      expect(()=>rehearseNative(backup.path,{run,directory})).toThrow();
      expect(calls).toEqual([]);
    }finally{rmSync(directory,{recursive:true,force:true});}
  });
});
