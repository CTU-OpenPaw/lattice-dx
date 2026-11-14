/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { createRequire } from 'node:module';
import { generateSensorFixtures } from './lib/sensor-simulator.mjs';
import { createSensorRepository } from '../apps/api/src/sensors/database.js';

const require = createRequire(
  new URL('../apps/api/package.json', import.meta.url),
);
const { Pool } = require('pg');

async function main() {
  const args = process.argv.slice(2);

  if (args.length !== 4) {
    throw new Error(
      'Usage: <asset-urn> <reference-time> <seed> <scenario>',
    );
  }

  const [assetUrn, referenceTime, seed, scenario] = args;
  const tenant = process.env.UC2_SENSOR_TENANT;
  const databaseUrl = process.env.DATABASE_URL;

  if (!tenant || !databaseUrl) {
    throw new Error('Database URL and tenant are required.');
  }

  const input = generateSensorFixtures({
    assetUrn,
    referenceTime,
    seed,
  }).find(reading => reading.simulation.scenario === scenario);

  if (!input) {
    throw new Error('Unknown simulation scenario.');
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    max: 1,
    connectionTimeoutMillis: 5000,
    query_timeout: 10000,
  });

  try {
    const repository = createSensorRepository(pool, {
      organizationId: tenant,
      sourceSystem: 'latticedx-simulator',
    });

    const receipt = await repository.record(input);

    console.log(JSON.stringify({
      ...receipt,
      scenario,
      simulated: true,
    }));
  } finally {
    await pool.end();
  }
}

main().catch(() => {
  console.error('Sensor fixture ingestion failed; inspect configuration and input.');
  process.exitCode = 1;
});