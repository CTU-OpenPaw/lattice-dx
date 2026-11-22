/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import Fastify from 'fastify';
import { Pool } from 'pg';
import { timingSafeEqual } from 'node:crypto';
import type { WorkflowEvent } from '@dx/contracts';
import {
  enqueueAssetJob,
  loadBrokerMapping,
} from '../uc1-integration/enqueue.js';

const databaseUrl = process.env.DATABASE_URL;
const token = process.env.UC1_SAMPLE_TOKEN;
const tenant = process.env.UC1_SAMPLE_TENANT ?? 'org-a';

if (!databaseUrl || !token?.trim()) {
  throw new Error('DATABASE_URL and UC1_SAMPLE_TOKEN are required');
}

const mappingPath = process.env.UC1_BROKER_MAPPING_FILE;
const brokerMapping = mappingPath
  ? loadBrokerMapping(mappingPath)
  : undefined;

if (brokerMapping && brokerMapping.organizationId !== tenant) {
  throw new Error('Broker mapping organization must match the sample tenant');
}

const pool = new Pool({
  connectionString: databaseUrl,
  max: 5,
  connectionTimeoutMillis: 5000,
  statement_timeout: 5000,
});

// Disable automatic request logging to avoid logging credentials.
const app = Fastify({ logger: false, bodyLimit: 65_536 });

function authorized(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const actual = Buffer.from(value);
  const expected = Buffer.from(`Bearer ${token}`);

  return actual.length === expected.length &&
    timingSafeEqual(actual, expected);
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= 255 &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

function validate(value: unknown, key: unknown): string[] {
  if (!object(value)) return ['Body must be a JSON object'];

  const errors: string[] = [];

  for (const field of [
    'eventId', 'organizationId', 'runId', 'recordId',
  ]) {
    if (!text(value[field])) errors.push(`${field}: invalid`);
  }

  if (value.eventType !== 'asset.handed_over') {
    errors.push('eventType: must be asset.handed_over');
  }

  if (value.definitionId !== 'procurement') {
    errors.push('definitionId: must be procurement');
  }

  if (
    typeof value.version !== 'number' ||
    !Number.isInteger(value.version) ||
    value.version < 1 ||
    value.version > 2147483647
  ) {
    errors.push('version: positive 32-bit integer required');
  }

  const timestamp = value.occurredAt;
  const shape = typeof timestamp === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(timestamp);
  const parsed = shape ? Date.parse(timestamp) : NaN;

  if (
    !Number.isFinite(parsed) ||
    new Date(parsed).toISOString().slice(0, 19) !==
      String(timestamp).slice(0, 19)
  ) {
    errors.push('occurredAt: valid UTC timestamp required');
  }

  if (!object(value.data)) {
    errors.push('data: object required');
  } else {
    if (Object.values(value.data).some(v => typeof v !== 'string')) {
      errors.push('data: all values must be strings');
    }

    for (const field of [
      'assetId', 'recipientId', 'departmentId',
      'locationId', 'attachmentId',
    ]) {
      const fieldValue = value.data[field];
      if (
        typeof fieldValue !== 'string' ||
        !fieldValue.trim() ||
        /[\u0000-\u001f\u007f]/.test(fieldValue)
      ) {
        errors.push(`data.${field}: nonblank string required`);
      }
    }
  }

  if (
    typeof key !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(key) ||
    key !== value.eventId
  ) {
    errors.push('Idempotency-Key: must be valid and equal eventId');
  }

  return errors;
}

app.get('/healthz', async (_request, reply) => {
  try {
    // Readiness requires both database tables to exist.
    await pool.query('SELECT 1 FROM uc1_sample.handovers LIMIT 0');
    await pool.query('SELECT 1 FROM uc1_sample.delivery_attempts LIMIT 0');
    return { status: 'ready' };
  } catch {
    return reply.code(503).send({ status: 'not_ready' });
  }
});

app.post('/sample/handovers', async (request, reply) => {
  if (!authorized(request.headers.authorization)) {
    return reply.code(403).send({ error: 'Forbidden' });
  }

  const errors = validate(
    request.body,
    request.headers['idempotency-key'],
  );

  if (errors.length) {
    return reply.code(400).send({ status: 'invalid_payload', errors });
  }

  const event = request.body as WorkflowEvent;

  if (event.organizationId !== tenant) {
    return reply.code(403).send({ error: 'Forbidden' });
  }

  const client = await pool.connect().catch(() => undefined);

  if (!client) {
    console.error('UC1 sample storage unavailable');
    return reply.code(503).send({ status: 'storage_unavailable' });
  }

  try {
    await client.query('BEGIN');

    const payload = JSON.stringify(event);
    const inserted = await client.query(
      `INSERT INTO uc1_sample.handovers (
         organization_id, event_id, run_id, record_id,
         definition_id, run_version, occurred_at, payload
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
       ON CONFLICT (organization_id, event_id) DO NOTHING
       RETURNING event_id`,
      [
        event.organizationId, event.eventId,
        event.runId, event.recordId,
        event.definitionId, event.version,
        event.occurredAt, payload,
      ],
    );

    let outcome: 'accepted' | 'duplicate' | 'conflict' = 'accepted';
    let httpStatus = 201;

    if (inserted.rowCount === 0) {
      const existing = await client.query<{ same: boolean }>(
        `SELECT payload = $3::jsonb AS same
         FROM uc1_sample.handovers
         WHERE organization_id = $1 AND event_id = $2`,
        [event.organizationId, event.eventId, payload],
      );

      if (existing.rows[0]?.same === true) {
        outcome = 'duplicate';
        httpStatus = 200;
      } else {
        outcome = 'conflict';
        httpStatus = 409;
      }
    }

    await client.query(
      `INSERT INTO uc1_sample.delivery_attempts (
         organization_id, event_id, outcome, http_status
       ) VALUES ($1,$2,$3,$4)`,
      [event.organizationId, event.eventId, outcome, httpStatus],
    );

    if (outcome !== 'conflict' && brokerMapping) {
  await enqueueAssetJob(client, event, brokerMapping);
    }

    await client.query('COMMIT');

    console.info(JSON.stringify({
      component: 'uc1-sample',
      eventId: event.eventId,
      outcome,
      httpStatus,
    }));

    return reply.code(httpStatus).send({
      status: outcome,
      eventId: event.eventId,
      ...(outcome === 'conflict'
        ? { error: 'Event ID already used with different payload' }
        : {}),
    });
  } catch {
    await client.query('ROLLBACK').catch(() => undefined);

    console.error(JSON.stringify({
      component: 'uc1-sample',
      eventId: event.eventId,
      status: 'storage_error',
    }));

    return reply.code(503).send({ status: 'storage_unavailable' });
  } finally {
    client.release();
  }
});

app.addHook('onClose', async () => {
  await pool.end();
});

await app.listen({ host: '0.0.0.0', port: 4100 });

console.info('UC1 sample system listening on port 4100');