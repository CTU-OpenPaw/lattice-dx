/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { Pool } from 'pg';
import { createBrokerPort } from './broker-adapter.js';
import { runAssetJob } from './worker.js';

const databaseUrl = process.env.DATABASE_URL;
const organizationId = process.env.UC1_SAMPLE_TENANT ?? 'org-a';
const brokerUrl = process.env.NGSI_LD_URL;

if (
  !databaseUrl ||
  !brokerUrl ||
  !/^[A-Za-z0-9_-]{1,128}$/.test(organizationId)
) {
  throw new Error('Valid DATABASE_URL, NGSI_LD_URL and tenant required');
}

const pool = new Pool({
  connectionString: databaseUrl,
  max: 2,
  connectionTimeoutMillis: 5000,
  statement_timeout: 5000,
});

pool.on('error', () => {
  console.error('UC1 broker database connection error');
});

const broker = await createBrokerPort({
  baseUrl: brokerUrl,
  tenant: organizationId,
});

let stopping = false;
process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });

const once = process.argv.includes('--once');

try {
  await pool.query('SELECT 1 FROM uc1_integration.asset_jobs LIMIT 0');
  await pool.query('SELECT 1 FROM uc1_integration.asset_attempts LIMIT 0');
  await pool.query('SELECT 1 FROM uc1_integration.asset_heads LIMIT 0');

  console.info('UC1 broker worker ready');

  do {
    try {
      const outcome = await runAssetJob(pool, broker, organizationId);

      if (once && ['retry', 'failed', 'conflict'].includes(outcome)) {
        process.exitCode = 1;
      }
    } catch {
      console.error('UC1 broker worker tick failed');

      if (once) process.exitCode = 1;
    }

    if (!once && !stopping) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  } while (!once && !stopping);
} finally {
  await pool.end();
}