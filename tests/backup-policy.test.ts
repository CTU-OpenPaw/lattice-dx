/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import {describe,it,expect} from 'vitest';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {mkdtempSync,writeFileSync,truncateSync,unlinkSync,rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {assertRestoreTarget,assertBackupPath,assertRegularBackup,verifyBackup,runRestoreFixture} from '../scripts/lib/backup-policy.mjs';
describe('recovery safety boundaries',()=>{
 it('cannot restore or drop a source database',()=>{
  for(const name of ['lattice','keycloak','dx_restore_;DROP DATABASE lattice','dx_restore_123'])expect(()=>assertRestoreTarget(name)).toThrow();
  expect(()=>assertRestoreTarget('dx_restore_'+ 'a'.repeat(32))).not.toThrow();
 });
 it('rejects traversals and unrelated dump files',()=>{
  const root=resolve('output/backups');
  expect(()=>assertBackupPath(resolve(root,'..','arbitrary.dump'),root)).toThrow();
  expect(()=>assertBackupPath(resolve(root,'anything.dump'),root)).toThrow();
  expect(assertBackupPath(resolve(root,'core-'+ 'a'.repeat(32)+'.dump'),root)).toContain('core-');
 });
 it('detects corrupt dump bytes before restore',()=>{
  const bytes=Buffer.from('right bytes'),manifest={format:'latticedx.pg-backup',version:1,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length};
  expect(()=>verifyBackup(bytes,manifest)).not.toThrow();
  expect(()=>verifyBackup(Buffer.from('wrong bytes'),manifest)).toThrow('Backup checksum mismatch');
  expect(()=>verifyBackup(Buffer.from('wrong bytes'),{...manifest,version:2})).toThrow();
 });
 it('rejects byte length mismatches and oversize manifests',()=>{
  const bytes=Buffer.from('verified'),manifest={format:'latticedx.pg-backup',version:1,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length};
  expect(()=>verifyBackup(bytes,manifest)).not.toThrow();
  expect(()=>verifyBackup(bytes,{...manifest,bytes:bytes.length+1})).toThrow('Backup byte length invalid');
  expect(()=>verifyBackup(Buffer.alloc(1),{...manifest,bytes:256*1024*1024+1})).toThrow('Backup byte length invalid');
 });
 it('rejects an oversize file before allocating its contents',()=>{
  const root=mkdtempSync(join(tmpdir(),'dx-backup-test-')),file=join(root,'core-'+ 'a'.repeat(32)+'.dump');
  try{writeFileSync(file,'small');expect(assertRegularBackup(file,root)).toBe(file);truncateSync(file,256*1024*1024+1);expect(()=>assertRegularBackup(file,root)).toThrow('Backup exceeds 256 MiB');}
  finally{unlinkSync(file);rmdirSync(root);}
 });
 it('preserves restore and cleanup failures without dropping a source',()=>{
  const original=new Error('restore timeout'),cleanup=new Error('cleanup failed');
  let failure;try{runRestoreFixture('dx_restore_'+'a'.repeat(32),()=>{},()=>{throw original;},()=>{throw cleanup;});}catch(error){failure=error;}
  expect(failure).toBeInstanceOf(AggregateError);expect(failure.errors).toEqual([original,cleanup]);
  let dropped=false;expect(()=>runRestoreFixture('lattice',()=>{},()=>{},()=>{dropped=true;})).toThrow();expect(dropped).toBe(false);
 });
 it('cleans an uncertain create and propagates cleanup-only failure',()=>{
  let cleaned=false;expect(()=>runRestoreFixture('dx_restore_'+'b'.repeat(32),()=>{throw new Error('create timeout');},()=>{},()=>{cleaned=true;})).toThrow('create timeout');expect(cleaned).toBe(true);
  expect(()=>runRestoreFixture('dx_restore_'+'c'.repeat(32),()=>{},()=>42,()=>{throw new Error('cleanup timeout');})).toThrow('cleanup timeout');
 });
});
