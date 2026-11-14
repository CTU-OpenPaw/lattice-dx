/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const {test} = require('node:test');
const assert = require('node:assert/strict');
const schemas = require('../src/server/schema');

test('foundation collections are manageable by the native data source designer', () => {
  for (const schema of Object.values(schemas)) {
    assert.equal(schema.uiManageable, true, schema.name);
  }
});

test('employee links to a unique native user without replacing the legacy subject', () => {
  const fields = schemas.employees.fields;
  const userId = fields.find(f => f.name === 'userId');
  assert.equal(userId?.type, 'bigInt');
  assert.equal(userId?.unique, true);
  assert.equal(userId?.allowNull, true);
  assert.ok(fields.some(f => f.name === 'identitySubject'));
  assert.ok(fields.some(f => f.name === 'user' && f.type === 'belongsTo' && f.target === 'users' && f.foreignKey === 'userId'));
});

test('requests and orders have native business fields without introducing another task engine',()=>{
  for(const key of ['requests','orders']){
    const fields=schemas[key].fields;
    assert.ok(fields.some(f=>f.name==='status'&&f.defaultValue==='draft'));
    assert.ok(fields.some(f=>f.name==='version'&&f.defaultValue===1));
    assert.ok(fields.some(f=>f.name==='requester'&&f.target==='latticeEmployees'));
  }
  assert.equal(schemas.tasks,undefined);
});
