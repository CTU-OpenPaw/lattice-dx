/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {seedFoundation} = require('../src/server/seed');
test('seed preserves edits and links assets within the same demo unit', async () => {
  const tables = new Map();
  const db = {getRepository(name) {
    if (!tables.has(name)) tables.set(name, []);
    const rows = tables.get(name);
    return {
      async findOne({filter}) {return rows.find(row => row.values.code === filter.code);},
      async create({values}) {const row = {values: {id: rows.length + 1, ...values}, get(key) {return this.values[key];}}; rows.push(row); return row;},
    };
  }};
  await seedFoundation(db);
  tables.get('latticeDepartments')[0].values.name = 'Tên đã chỉnh sửa';
  await seedFoundation(db);
  for (const rows of tables.values()) assert.equal(rows.length, 2);
  assert.equal(tables.get('latticeDepartments')[0].values.name, 'Tên đã chỉnh sửa');
  for (const asset of tables.get('latticeAssets')) {
    for (const [table, key] of [['latticeDepartments', 'departmentId'], ['latticeLocations', 'locationId'], ['latticeEmployees', 'custodianId']]) {
      const related = tables.get(table).find(row => row.get('id') === asset.get(key));
      assert.equal(related.get('organizationId'), asset.get('organizationId'));
    }
  }
  tables.get('latticeDepartments')[0].values.organizationId = 'different';
  await assert.rejects(seedFoundation(db), /Seed identity conflict/);
});
