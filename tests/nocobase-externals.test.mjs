/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
test('plugin dependency metadata contains pinned host externals and rejects unsupported names',async()=>{
  const {externalVersionSource}=await import('../scripts/lib/nocobase-externals.mjs');
  const source=externalVersionSource(['@nocobase/server','@nocobase/client','react']);
  const module={exports:{}};new Function('module',source)(module);
  assert.deepEqual(module.exports,{'@nocobase/server':'2.2.38','@nocobase/client':'2.2.38',react:'18.2.0'});
  assert.throws(()=>externalVersionSource(['unknown-library']));
  assert.ok(!source.includes('require('),'metadata must record verified build target, not echo current host');
});
