// SPDX-License-Identifier: Apache-2.0
import { createRequire } from 'node:module';
import { createSensorBrokerClient } from '../apps/api/src/sensors/broker-client.js';
import { runSensorDelivery } from '../apps/api/src/sensors/worker.js';

const require = createRequire(
  new URL('../apps/api/package.json', import.meta.url),
);
const { Pool } = require('pg');

async function main() {
  const args = process.argv.slice(2);

  if (args.length !== 1 || args[0] !== '--once') {
    throw new Error('Use --once to process at most one delivery.');
  }

  const databaseUrl = process.env.DATABASE_URL;
  const brokerUrl = process.env.NGSI_LD_URL;
  const tenant = process.env.UC2_SENSOR_TENANT;

  if (!databaseUrl || !brokerUrl || !tenant) {
    throw new Error('Required worker configuration is missing.');
  }

  const broker = createSensorBrokerClient({
    baseUrl: brokerUrl,
    tenant,
    timeoutMs: 5000,
  });

  const pool = new Pool({
    connectionString: databaseUrl,
    max: 1,
    connectionTimeoutMillis: 5000,
    query_timeout: 20000,
  });

  try {
    const result = await runSensorDelivery(pool, broker, tenant);

    // Bounded operational fields only; no credentials or source payload.
    console.log(JSON.stringify({
      component: 'uc2-sensor-worker',
      ...result,
    }));

    if (result.outcome === 'retry' || result.outcome === 'failed') {
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

main().catch(() => {
  console.error(JSON.stringify({
    component: 'uc2-sensor-worker',
    errorCode: 'WORKER_START_OR_DATABASE_FAILED',
  }));
  process.exitCode = 1;
});