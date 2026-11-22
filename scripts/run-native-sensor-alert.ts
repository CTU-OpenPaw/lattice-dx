/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { createRequire } from 'node:module';
import { createSensorAlertQueue } from '../apps/api/src/sensor-rules/alert-queue.js';
import { AlertDeliveryError, createSensorAlertWorker } from '../apps/api/src/sensor-rules/alert-worker.js';
import { parseSensorAssetUrn } from '../apps/api/src/sensors/asset-identity.js';
import { runNativeAlertLoop } from './lib/native-alert-loop.mjs';

const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { Pool } = require('pg');

function formatWorkerError(error: unknown): string {
  const err = error as { code?: unknown; name?: unknown; message?: unknown } | null;
  const code = typeof err?.code === 'string' ? err.code : (typeof err?.name === 'string' ? err.name : 'Error');
  const msg = String(err?.message || '').replace(/\b(postgres(?:ql)?|https?):\/\/\S+/gi, '[redacted]').slice(0, 160);
  return `(${code}): ${msg}`;
}

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
  const pool = new Pool({ connectionString: DATABASE_URL, max: 1, connectionTimeoutMillis: 5000, query_timeout: 20000 });
  pool.on('error', (error: { code?: string; message?: string }) => {
    console.error('Native alert pool error:', error?.code || error?.message || 'unknown');
  });
  try {
    const worker = createSensorAlertWorker({
      queue: createSensorAlertQueue(pool, { organizationId: UC2_SENSOR_TENANT }),
      transport: {
        async deliver({ alert, idempotencyKey, signal }) {
          let identity;
          try {
            identity = parseSensorAssetUrn(alert.assetUrn, UC2_SENSOR_TENANT);
          } catch {
            throw new AlertDeliveryError('ALERT_NATIVE_ASSET_REQUIRED', false);
          }
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
          let body: { data?: { id?: unknown; duplicate?: unknown } } | null = null;
          try { body = await response.json(); } catch { body = null; }
          const data = body?.data;
          if (!/^[1-9]\d{0,18}$/.test(String(data?.id)) || typeof data?.duplicate !== 'boolean') {
            throw new AlertDeliveryError('ALERT_NATIVE_INVALID_RECEIPT', true);
          }
          return { targetRecordId: String(data.id), receipt: { duplicate: data.duplicate } };
        },
      },
    });
    if (!watch) {
      const result = await worker.runOnce();
      console.log(JSON.stringify(result));
      if (result.outcome === 'failed' || result.outcome === 'retry') process.exitCode = 1;
      return;
    }
    const stop = new AbortController();
    const shutdown = () => stop.abort();
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    try {
      await runNativeAlertLoop({
        runOnce: () => worker.runOnce(),
        onResult: (result: { outcome: string }) => {
          if (result.outcome !== 'idle') console.log(JSON.stringify(result));
        },
        onError: (error: unknown) => {
          console.error(`Native alert loop iteration failed ${formatWorkerError(error)}`);
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

main().catch((error: unknown) => {
  console.error(`Native alert worker could not run ${formatWorkerError(error)}`);
  process.exitCode = 1;
});
