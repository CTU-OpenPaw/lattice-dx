// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import {
  createSensorRepository,
  SensorConflictError,
} from '../apps/api/src/sensors/database.js';
import { SensorInputError } from '../apps/api/src/sensors/policy.js';
import { generateSensorFixtures } from './lib/sensor-simulator.mjs';

// Resolve pg from the API workspace that owns this dependency.
const require = createRequire(
  new URL('../apps/api/package.json', import.meta.url),
);
const { Pool } = require('pg');

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required.');
  }

  const databaseName =
    `uc2_sensor_accept_${randomUUID().replaceAll('-', '')}`;

  assert.match(databaseName, /^uc2_sensor_accept_[a-f0-9]{32}$/);

  const baseUrl = new URL(process.env.DATABASE_URL);
  const testUrl = new URL(baseUrl);
  testUrl.pathname = `/${databaseName}`;

  const poolOptions = {
    connectionTimeoutMillis: 5000,
    query_timeout: 10000,
  };

  const admin = new Pool({
    ...poolOptions,
    connectionString: baseUrl.toString(),
    max: 1,
  });

  let pool: InstanceType<typeof Pool> | undefined;
  let created = false;

  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    created = true;

    pool = new Pool({
      ...poolOptions,
      connectionString: testUrl.toString(),
      max: 4,
    });

  for (const filename of [
      'sensor-readings.sql',
      'sensor-deliveries.sql',
    ]) {
    const sql = await readFile(
        new URL(`../infra/config/uc2/${filename}`, import.meta.url),
        'utf8',
      );

    await pool.query(sql);
  }


    const scope = {
      organizationId: 'org-a',
      sourceSystem: 'latticedx-simulator',
    };

    const options = {
      assetUrn: 'urn:ngsi-ld:Asset:org-a:uc1-demo-asset-001',
      referenceTime: '2026-10-24T08:00:00.000Z',
      seed: 'database-acceptance',
    };

    let repository = createSensorRepository(pool, scope);
    const readings = generateSensorFixtures(options);
    const original = readings[0];

    const first = await repository.record(original);
    assert.equal(first.duplicate, false);
    assert.equal(first.quality, 'good');
    assert.equal(first.observedAt, original.observedAt);

    const replay = await repository.record(original);
    assert.equal(replay.duplicate, true);
    assert.equal(replay.id, first.id);
    assert.equal(replay.receivedAt, first.receivedAt);

    console.log('PASS insert and exact replay preserve one receipt');

    // Object-key order is not a payload conflict.
    const reordered = Object.fromEntries(
      Object.entries(original).reverse(),
    );

    assert.equal((await repository.record(reordered)).id, first.id);

    await assert.rejects(
      repository.record({ ...original, value: 99 }),
      SensorConflictError,
    );

    const preserved = await pool.query(
      `SELECT value, source_payload
       FROM uc2_integration.sensor_readings
       WHERE id = $1`,
      [first.id],
    );

    assert.equal(preserved.rows[0].value, 25);
    assert.deepEqual(preserved.rows[0].source_payload, original);

    console.log('PASS payload conflict leaves the original unchanged');

    const concurrent = generateSensorFixtures({
      ...options,
      seed: 'concurrent-acceptance',
    })[0];

    const results = await Promise.all(
      Array.from({ length: 12 }, () => repository.record(concurrent)),
    );

    assert.equal(results.filter(r => !r.duplicate).length, 1);
    assert.equal(new Set(results.map(r => r.id)).size, 1);

    const count = await pool.query(
      `SELECT count(*)::integer AS records
       FROM uc2_integration.sensor_readings
       WHERE organization_id = $1
         AND source_system = $2
         AND event_id = $3`,
      [scope.organizationId, scope.sourceSystem, concurrent.eventId],
    );

    assert.equal(count.rows[0].records, 1);
    console.log('PASS concurrent delivery creates exactly one reading');

    for (const scenario of ['missing', 'malformed']) {
      const input = readings.find(
        r => r.simulation.scenario === scenario,
      )!;

      const stored = await repository.record(input);

      assert.equal(
        stored.quality,
        scenario === 'missing' ? 'missing' : 'invalid',
      );

      const row = await pool.query(
        `SELECT value, source_payload
        FROM uc2_integration.sensor_readings
        WHERE id = $1`,
        [stored.id],
      );

      assert.equal(row.rows[0].value, null);
      assert.deepEqual(row.rows[0].source_payload, input);
    }

    // Check deliveries after both readings have been stored.
    const deliveries = await pool.query(
      `SELECT
        count(*)::integer AS total,
        count(*) FILTER (
          WHERE r.quality = 'good' AND d.status = 'pending'
        )::integer AS pending_good,
        count(*) FILTER (
          WHERE r.quality IN ('missing', 'invalid')
            AND d.status = 'skipped'
        )::integer AS skipped_bad
      FROM uc2_integration.sensor_readings r
      JOIN uc2_integration.sensor_deliveries d
        ON d.reading_id = r.id`,
    );

    assert.deepEqual(deliveries.rows[0], {
      total: 4,
      pending_good: 2,
      skipped_bad: 2,
    });

    console.log('PASS each reading has one correctly classified delivery');
    console.log('PASS missing and malformed source payloads are retained');

    await assert.rejects(
      repository.record({
        ...original,
        assetUrn: 'urn:ngsi-ld:Asset:org-b:foreign-asset',
      }),
      SensorInputError,
    );

    await assert.rejects(
      repository.record({
        ...original,
        source: { ...original.source, system: 'different-source' },
      }),
      SensorInputError,
    );

    console.log('PASS tenant and configured source mismatch are rejected');

    await pool.end();

    pool = new Pool({
      ...poolOptions,
      connectionString: testUrl.toString(),
      max: 1,
    });

    repository = createSensorRepository(pool, scope);
    const reopened = await repository.record(original);

    assert.equal(reopened.id, first.id);
    assert.equal(reopened.duplicate, true);
    assert.equal(reopened.receivedAt, first.receivedAt);

    console.log('PASS receipt survives connection-pool replacement');
  } finally {
    try {
      if (pool) await pool.end();
    } finally {
      try {
        if (created) {
          await admin.query(`DROP DATABASE "${databaseName}"`);
          console.log('PASS temporary acceptance database removed');
        }
      } finally {
        await admin.end();
      }
    }
  }
}

main().catch(() => {
  console.error(
    'Sensor database acceptance failed. ' +
    'Check database permissions, connectivity and assertions.',
  );
  process.exitCode = 1;
});