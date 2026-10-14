// SPDX-License-Identifier: Apache-2.0
import {describe,it,expect} from 'vitest';
import {createHash} from 'node:crypto';
// @ts-expect-error local JavaScript policy module
import {validateObjectInventory,verifyObjectBytes,validateFullManifest,compareObjectInventories} from '../scripts/lib/object-backup-policy.mjs';
const bytes=Buffer.from('verified object');
const entry={fileId:'00000000-0000-4000-8000-000000000001',objectKey:'00000000-0000-4000-8000-000000000002',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
const manifest={format:'latticedx.full-backup',version:1,createdAt:'2026-10-14T00:00:00.000Z',scope:'database-and-objects',dump:{name:'core-'+'a'.repeat(32)+'.dump',sha256:'b'.repeat(64),bytes:100},inventory:[entry],count:1,totalBytes:bytes.length};
describe('paired object backup policies',()=>{
 it('verifies exact immutable references and content',()=>{
  expect(validateObjectInventory([entry])).toEqual([entry]);expect(()=>verifyObjectBytes(bytes,entry)).not.toThrow();expect(validateFullManifest(JSON.stringify(manifest))).toEqual(manifest);expect(()=>compareObjectInventories([entry],[entry])).not.toThrow();
 });
 it('rejects path keys, duplicates, invalid sizes and extra fields',()=>{
  for(const value of [[{...entry,objectKey:'../outside'}],[entry,entry],[{...entry,size:-1}],[{...entry,size:1048577}],[{...entry,sha256:'f'.repeat(63)}],[{...entry,path:'secret'}]])expect(()=>validateObjectInventory(value)).toThrow();
  expect(()=>validateObjectInventory(Array.from({length:10001},()=>entry))).toThrow();
 });
 it('rejects incomplete inventories and corrupted bytes',()=>{
  expect(()=>verifyObjectBytes(Buffer.from('wrong'),entry)).toThrow();expect(()=>verifyObjectBytes(Buffer.alloc(bytes.length),entry)).toThrow();
  expect(()=>compareObjectInventories([entry],[])).toThrow();expect(()=>compareObjectInventories([entry],[{...entry,size:1}])).toThrow();
 });
 it('bounds before JSON parsing and validates exact manifest totals',()=>{
  expect(()=>validateFullManifest(' '.repeat(8*1024*1024+1))).toThrow();
  for(const patch of [{count:2},{totalBytes:1},{scope:'database-only'},{extra:1},{dump:{...manifest.dump,name:'../../dump'}}])expect(()=>validateFullManifest(JSON.stringify({...manifest,...patch}))).toThrow();
 });
});
