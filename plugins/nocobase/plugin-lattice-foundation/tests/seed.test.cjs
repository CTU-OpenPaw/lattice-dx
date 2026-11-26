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

test('seedFoundation, LatticeFoundationPlugin.install(), and FoundationSeed.up() skip demo rows when LATTICE_SKIP_DEMO_SEED=1', async () => {
  const Module = require('node:module');
  const makeDb = () => {
    const tables = new Map();
    const db = {
      sequelize: { transaction: async (fn) => fn({}) },
      getRepository(name) {
        if (!tables.has(name)) tables.set(name, []);
        const rows = tables.get(name);
        return {
          async findOne({ filter }) { return rows.find((row) => row.values.code === filter.code); },
          async create({ values }) {
            const row = { values: { id: rows.length + 1, ...values }, get(key) { return this.values[key]; } };
            rows.push(row);
            return row;
          },
        };
      },
    };
    return { tables, db };
  };

  // 1. Direct seedFoundation call with env: { LATTICE_SKIP_DEMO_SEED: '1' } skips all inserts
  const skipped = makeDb();
  const skipRes = await seedFoundation(skipped.db, null, { env: { LATTICE_SKIP_DEMO_SEED: '1' } });
  assert.deepEqual(skipRes, { skipped: true, reason: 'LATTICE_SKIP_DEMO_SEED' });
  assert.equal(skipped.tables.size, 0);

  // 2. Default (unset) still seeds demo units
  const seeded = makeDb();
  await seedFoundation(seeded.db, null, { env: {} });
  assert.equal(seeded.tables.get('latticeDepartments').length, 2);
  assert.equal(seeded.tables.get('latticeAssets').length, 2);

  // 3. LatticeFoundationPlugin.install() and FoundationSeed.up() honor process.env.LATTICE_SKIP_DEMO_SEED=1
  const origLoad = Module._load;
  const prevSkip = process.env.LATTICE_SKIP_DEMO_SEED;
  class MockPlugin {
    constructor(app) { this.app = app; this.db = app?.db; }
  }
  class MockMigration {
    constructor(ctx) { this.context = ctx; }
  }
  Module._load = function (request, parent, isMain) {
    if (request === '@nocobase/server') return { Plugin: MockPlugin, Migration: MockMigration };
    return origLoad.call(this, request, parent, isMain);
  };
  try {
    process.env.LATTICE_SKIP_DEMO_SEED = '1';
    const FoundationPlugin = require('../src/server/index');
    const pluginHarness = makeDb();
    await new FoundationPlugin({ db: pluginHarness.db }).install();
    assert.equal(pluginHarness.tables.size, 0, 'LatticeFoundationPlugin.install() must skip demo seed when LATTICE_SKIP_DEMO_SEED=1');

    const FoundationSeed = require('../src/server/migrations/20261013000100-foundation-seed');
    const migHarness = makeDb();
    await new FoundationSeed({ db: migHarness.db }).up();
    assert.equal(migHarness.tables.size, 0, 'FoundationSeed.up() must skip demo seed when LATTICE_SKIP_DEMO_SEED=1');
  } finally {
    Module._load = origLoad;
    if (prevSkip === undefined) delete process.env.LATTICE_SKIP_DEMO_SEED;
    else process.env.LATTICE_SKIP_DEMO_SEED = prevSkip;
  }
});
