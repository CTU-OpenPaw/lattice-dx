/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const {test} = require('node:test');
const assert = require('node:assert/strict');
let expose;
try { expose = require('../src/server/native-metadata').exposeNativeCollections; } catch(e) {if(e.code !== 'MODULE_NOT_FOUND')throw e;}

test('native metadata uses the host collection manager and preserves existing designer edits', async () => {
  assert.equal(typeof expose,'function');
  const names = new Set(['latticeDepartments']);
  const calls=[];
  const repository={findOne:async({filter})=>names.has(filter.name)?{name:filter.name}:null,
    db2cm:async name=>{calls.push(name);names.add(name);}};
  const db={getRepository:name=>{assert.equal(name,'collections');return repository;},hasCollection:()=>true};
  const definitions={a:{name:'latticeDepartments',uiManageable:true},b:{name:'latticeAssets',uiManageable:true}};
  await expose(db,definitions);
  await expose(db,definitions);
  assert.deepEqual(calls,['latticeAssets']);
});

test('native metadata preflights every collection before making changes', async () => {
  assert.equal(typeof expose,'function');
  let writes=0;
  const db={getRepository:()=>({findOne:async()=>null,db2cm:async()=>writes++}),hasCollection:name=>name!=='missing'};
  await assert.rejects(expose(db,{a:{name:'first',uiManageable:true},b:{name:'missing',uiManageable:true}}),/missing/);
  assert.equal(writes,0);
});
