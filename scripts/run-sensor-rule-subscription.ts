// SPDX-License-Identifier: Apache-2.0
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { createSensorRuleRepository, SensorRuleConflictError } from '../apps/api/src/sensor-rules/database.js';
import { parseSensorRule } from '../apps/api/src/sensor-rules/policy.js';
import { parseSensorAssetUrn } from '../apps/api/src/sensors/asset-identity.js';
import { sensorReadingsFromNotification } from '../apps/api/src/sensor-rules/broker-notification.js';

const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { Pool } = require('pg');
const { DATABASE_URL, UC2_SENSOR_TENANT, UC2_RULE_FILE, UC2_SENSOR_SOURCE, NGSI_LD_NOTIFICATION_TOKEN, NGSI_LD_SUBSCRIPTION_ID } = process.env;
if (!DATABASE_URL || !UC2_SENSOR_TENANT || !UC2_RULE_FILE || !UC2_SENSOR_SOURCE ||
    !/^[A-Za-z0-9._~-]{32,256}$/.test(NGSI_LD_NOTIFICATION_TOKEN ?? '') ||
    !/^urn:ngsi-ld:Subscription:[A-Za-z0-9._:-]{1,200}$/.test(NGSI_LD_SUBSCRIPTION_ID ?? '')) {
  throw new Error('Missing UC2 sensor subscription configuration');
}
const { ruleEntity, mapping } = JSON.parse(await readFile(UC2_RULE_FILE, 'utf8'));
const rule = parseSensorRule(ruleEntity);
if (String(mapping?.assetEntityId ?? '').toLowerCase() !== rule.assetEntityId ||
    parseSensorAssetUrn(mapping.assetUrn, UC2_SENSOR_TENANT).kind !== 'native' ||
    !/^[1-9]\d{0,18}$/.test(String(rule.handlerId ?? ''))) {
  throw new Error('Invalid rule Asset mapping or handlerId');
}
const port = Number(process.env.UC2_SENSOR_NOTIFICATION_PORT ?? '15454');
const host = process.env.UC2_SENSOR_NOTIFICATION_HOST ?? '127.0.0.1';
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid sensor listener port');
const database = new Pool({ connectionString: DATABASE_URL, max: 4, connectionTimeoutMillis: 5000, query_timeout: 20000 });
database.on('error', (error: { code?: string; message?: string }) => {
  console.error('Sensor listener pool error:', error?.code || error?.message || 'unknown');
});
const repo = createSensorRuleRepository(database, { organizationId: UC2_SENSOR_TENANT, sourceSystem: UC2_SENSOR_SOURCE });
const expectedToken = Buffer.from(NGSI_LD_NOTIFICATION_TOKEN!);
function safeReply(res: import('node:http').ServerResponse, status: number, headers?: Record<string, string>) {
  if (!res.headersSent && !res.destroyed) {
    res.writeHead(status, headers).end();
  }
}
const server = createServer({ requestTimeout: 10000 }, async (req, res) => {
  try {
    if (!['/uc2/sensor-notifications', '/uc2/sensor-notifications/'].includes(req.url?.split('?')[0] ?? '') ||
        req.method !== 'POST') { safeReply(res, 404); return; }
    const supplied = Buffer.from(String(req.headers['x-lattice-broker-token'] ?? ''));
    if (supplied.length !== expectedToken.length || !timingSafeEqual(supplied, expectedToken) ||
        req.headers['ngsild-tenant'] !== UC2_SENSOR_TENANT) { safeReply(res, 403); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    let readings;
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 65536) {
          safeReply(res, 413, { Connection: 'close' });
          req.destroy();
          return;
        }
        chunks.push(chunk);
      }
      const notification = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      readings = sensorReadingsFromNotification(notification, {
        tenant: UC2_SENSOR_TENANT, subscriptionId: NGSI_LD_SUBSCRIPTION_ID!, mapping, rule,
      });
      if (readings.some(reading => reading.source.system !== UC2_SENSOR_SOURCE)) throw new Error('Unexpected source');
    } catch {
      safeReply(res, 400); return;
    }
    try {
      for (const sourcePayload of readings) {
        const result = await repo.evaluate({ ruleEntity, mapping, sourcePayload });
        console.log(JSON.stringify({ outcome: result.outcome, duplicate: result.duplicate, alertId: result.alertId }));
      }
      safeReply(res, 204);
    } catch (error) {
      safeReply(res, error instanceof SensorRuleConflictError ? 409 : 503);
    }
  } catch (error) {
    console.error('Unhandled sensor listener request error:', (error as Error)?.message || 'unknown');
    safeReply(res, 500, { Connection: 'close' });
  }
});
server.on('error', error => {
  console.error('Sensor listener server error:', (error as { code?: string; message?: string })?.code || (error as Error)?.message || 'unknown');
  process.exitCode = 1;
});
server.listen(port, host, () => console.log('UC2 sensor notification listener ready'));
let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.closeIdleConnections?.();
    server.close(() => { void database.end().catch(() => {}); });
  });
}
