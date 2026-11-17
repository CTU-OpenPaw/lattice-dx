// SPDX-License-Identifier: Apache-2.0
import { createRequire } from 'node:module';
import { createSensorAlertQueue } from '../apps/api/src/sensor-rules/alert-queue.js';
import { AlertDeliveryError, createSensorAlertWorker } from '../apps/api/src/sensor-rules/alert-worker.js';
import { parseSensorAssetUrn } from '../apps/api/src/sensors/asset-identity.js';
import { runNativeAlertLoop } from './lib/native-alert-loop.mjs';

const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { Pool } = require('pg');

async function main() {
  const args = process.argv.slice(2);
  const watch = args.length === 1 && args[0] === '--watch';
  if (args.length && !watch) throw new Error('Use --watch or no arguments');
  const intervalMs = Number(process.env.UC2_SENSOR_ALERT_POLL_MS ?? '2000');
  if (watch && (!Number.isSafeInteger(intervalMs) || intervalMs < 500 || intervalMs > 60000)) {
    throw new Error('UC2_SENSOR_ALERT_POLL_MS must be between 500 and 60000');
  }
  const { DATABASE_URL, UC2_SENSOR_TENANT, UC2_NATIVE_URL, UC2_NATIVE_TOKEN } = process.env;
  if (!DATABASE_URL || !UC2_SENSOR_TENANT || !UC2_NATIVE_URL || !UC2_NATIVE_TOKEN) {
    throw new Error('Missing native alert worker configuration');
  }
  const origin = new URL(UC2_NATIVE_URL);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password ||
      origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Invalid native origin');
  const pool = new Pool({ connectionString: DATABASE_URL, max: 1, connectionTimeoutMillis: 5000 });
  try {
    const worker = createSensorAlertWorker({
      queue: createSensorAlertQueue(pool, { organizationId: UC2_SENSOR_TENANT }),
      transport: {
        async deliver({ alert, idempotencyKey, signal }) {
          const identity = parseSensorAssetUrn(alert.assetUrn, UC2_SENSOR_TENANT);
          if (identity.kind !== 'native') throw new AlertDeliveryError('ALERT_NATIVE_ASSET_REQUIRED', false);
          const { handlerId, severity } = alert.ruleSnapshot;
          if (typeof handlerId !== 'string' || !/^[1-9]\d{0,18}$/.test(handlerId) ||
              typeof severity !== 'string') throw new AlertDeliveryError('ALERT_NATIVE_RULE_INVALID', false);
          const response = await fetch(new URL('/api/latticeIntegrations:receiveAlert', origin), {
            method: 'POST', signal, redirect: 'error',
            headers: { Authorization: 'Bearer ' + UC2_NATIVE_TOKEN, 'Content-Type': 'application/json', 'X-Role': 'ldx_connector' },
            body: JSON.stringify({ eventId: idempotencyKey, assetId: identity.recordId, handlerId, severity }),
          });
          if (!response.ok) {
            await response.body?.cancel();
            throw new AlertDeliveryError('ALERT_NATIVE_HTTP_' + response.status, response.status === 429 || response.status >= 500);
          }
          const { data } = await response.json();
          if (!/^[1-9]\d{0,18}$/.test(String(data?.id)) || typeof data.duplicate !== 'boolean') {
            throw new AlertDeliveryError('ALERT_NATIVE_INVALID_RECEIPT', true);
          }
          return { targetRecordId: String(data.id), receipt: { duplicate: data.duplicate } };
        },
      },
    });
    if (!watch) {
      console.log(JSON.stringify(await worker.runOnce()));
      return;
    }
    const stop = new AbortController();
    const shutdown = () => stop.abort();
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    try {
      await runNativeAlertLoop({
        runOnce: () => worker.runOnce(),
        onResult: result => {
          if (result.outcome !== 'idle') console.log(JSON.stringify(result));
        },
        intervalMs, signal: stop.signal,
      });
    } finally {
      process.off('SIGINT', shutdown);
      process.off('SIGTERM', shutdown);
    }
  } finally {
    await pool.end();
  }
}

main().catch(() => {
  console.error('Native alert worker could not run. Check configuration and database availability.');
  process.exitCode = 1;
});
