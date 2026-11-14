/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
test('native UI fixture reuses host blocks and gets independent schema IDs',async()=>{
  const {instantiateNativePage}=await import('../scripts/lib/native-ui-fixture.mjs');
  const source=JSON.parse(await readFile(new URL('../scripts/fixtures/native-ui-page.json',import.meta.url),'utf8'));
  const before=JSON.stringify(source),page=instantiateNativePage(source,'newRoot');
  assert.equal(page.schema['x-uid'],'newRoot');assert.ok(page.tabUid);assert.notEqual(page.tabUid,source.properties[Object.keys(source.properties)[0]]['x-uid']);
  assert.equal(JSON.stringify(source),before);
  const serialized=JSON.stringify(page.schema);assert.ok(serialized.includes('TableBlockProvider'));assert.ok(serialized.includes('FormBlockProvider'));assert.ok(serialized.includes('WorkflowTodo.Decorator'));
  assert.ok(!serialized.includes('LatticeConfiguredBlock'));assert.ok(!serialized.includes('dxActions'));
  assert.throws(()=>instantiateNativePage({},'newRoot'));
});
