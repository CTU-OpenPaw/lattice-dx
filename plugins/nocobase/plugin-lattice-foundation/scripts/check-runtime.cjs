// SPDX-License-Identifier: Apache-2.0
// Run inside the NocoBase container after installation. Uses existing DB only.
const assert = require('node:assert/strict');
const {Database} = require('@nocobase/database');
const schemas = require('../dist/server/schema');
const SeedMigration = require('../dist/server/migrations/20261013000100-foundation-seed');
const db = new Database({dialect: process.env.DB_DIALECT, host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432), database: process.env.DB_DATABASE,
  username: process.env.DB_USER, password: process.env.DB_PASSWORD, logging: false});
async function run() {
  try {
    for (const schema of Object.values(schemas)) db.collection(schema);
    await db.sequelize.authenticate();
    const before = {};
    for (const schema of Object.values(schemas)) {
      before[schema.name] = await db.getRepository(schema.name).count();
      // Only these four registries are populated by FoundationSeed. New
      // document/incident collections can be empty on a clean installation.
      const seeded = ['latticeDepartments', 'latticeEmployees', 'latticeLocations', 'latticeAssets'];
      assert.ok(before[schema.name] >= (seeded.includes(schema.name) ? 2 : 0));
    }
    const migration = new SeedMigration({db});
    assert.equal(migration.on, 'afterSync');
    await migration.up();
    await migration.up();
    for (const schema of Object.values(schemas)) {
      assert.equal(await db.getRepository(schema.name).count(), before[schema.name]);
    }
    const assets = await db.getRepository('latticeAssets').find({filter: {code: {$startsWith: 'DEMO-ASSET-'}}});
    assert.equal(assets.length, 2);
    for (const asset of assets) {
      for (const [collection, key] of [['latticeDepartments', 'departmentId'], ['latticeEmployees', 'custodianId'], ['latticeLocations', 'locationId']]) {
        const linked = await db.getRepository(collection).findOne({filter: {id: asset.get(key)}});
        assert.equal(linked.get('organizationId'), asset.get('organizationId'));
      }
    }
    console.log(JSON.stringify({result: 'PASS', migrationRepeated: true, counts: before, relations: 'PASS'}));
  } finally {await db.close();}
}
run().catch(error => {console.error(error.message); process.exitCode = 1;});
