// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { Pool as PgPool } from 'pg';
import { createSensorAlertQueue } from '../apps/api/src/sensor-rules/alert-queue.js';

const requireApi = createRequire(
  new URL('../apps/api/package.json', import.meta.url),
);
const { Pool } = requireApi('pg') as { Pool: typeof PgPool };

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required.');

const databaseName = `uc2_alert_acceptance_${randomUUID().replaceAll('-', '')}`;
const temporaryUrl = new URL(connectionString);
temporaryUrl.pathname = `/${databaseName}`;

const admin = new Pool({ connectionString });
let pool: PgPool | undefined;
let created = false;

async function enqueue(database: PgPool, organizationId = 'org-a') {
  // Isolated queue fixture; evaluator behavior has its own acceptance suite.
  const ruleId = randomUUID();
  const assetId = randomUUID();

  await database.query(
    `INSERT INTO uc2_integration.sensor_rule_state (
       organization_id, rule_id, asset_entity_id
     ) VALUES ($1,$2,$3)`,
    [organizationId, ruleId, assetId],
  );

  const evaluation = await database.query(
    `INSERT INTO uc2_integration.sensor_rule_evaluations (
       organization_id, source_system, event_id,
       rule_id, rule_version, asset_entity_id, asset_urn,
       observed_at, evaluated_at, outcome,
       source_payload, rule_snapshot, mapping_snapshot, evaluation
     )
     VALUES (
       $1,'latticedx-simulator',$2,$3,1,$4,$5,
       clock_timestamp(),clock_timestamp(),'queued',
       '{"value":85}'::jsonb,
       '{"threshold":80}'::jsonb,
       '{}'::jsonb,
       '{"matched":true}'::jsonb
     )
     RETURNING id`,
    [
      organizationId,
      `fixture:${randomUUID()}`,
      ruleId,
      assetId,
      `urn:ngsi-ld:Asset:${organizationId}:fixture`,
    ],
  );

  const alert = await database.query(
    `INSERT INTO uc2_integration.sensor_rule_alerts (
       organization_id, evaluation_id
     ) VALUES ($1,$2)
     RETURNING id`,
    [organizationId, evaluation.rows[0].id],
  );

  return alert.rows[0].id as string;
}

async function expireLease(database: PgPool, id: string) {
  // Test clock changes only in the temporary acceptance database.
  await database.query(
    `UPDATE uc2_integration.sensor_rule_alerts
     SET lease_until = clock_timestamp() - interval '1 second'
     WHERE id = $1 AND status = 'processing'`,
    [id],
  );
}

try {
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  created = true;

  pool = new Pool({
    connectionString: temporaryUrl.toString(),
    max: 12,
  });

  const sql = await readFile(
    new URL('../infra/config/uc2/sensor-rule-runtime.sql', import.meta.url),
    'utf8',
  );
  await pool.query(sql.replace(/^\uFEFF/, ''));

  const queue = createSensorAlertQueue(pool, {
    organizationId: 'org-a',
    maxAttempts: 2,
  });

  assert.equal(await queue.claim(), null);
  console.log('PASS empty queue returns no work');

  const firstId = await enqueue(pool);
  const claims = await Promise.all(
    Array.from({ length: 8 }, () => queue.claim()),
  );
  const winners = claims.filter(item => item !== null);

  assert.equal(winners.length, 1);
  const first = winners[0]!;
  assert.equal(first.id, firstId);
  assert.equal(first.attempt, 1);
  assert.deepEqual(first.sourcePayload, { value: 85 });
  assert.equal(await queue.claim(), null);
  console.log('PASS concurrent workers claim one alert exactly once');

  const success = {
    status: 'succeeded' as const,
    targetRecordId: 'fixture-case-001',
    receipt: { accepted: true },
  };

  assert.equal(await queue.settle(first, success), true);
  assert.equal(await queue.settle(first, success), false);

  const delivered = await pool.query(
    `SELECT status, target_record_id, receipt,
            lease_token, lease_until, completed_at
     FROM uc2_integration.sensor_rule_alerts WHERE id = $1`,
    [firstId],
  );
  assert.equal(delivered.rows[0].status, 'succeeded');
  assert.equal(delivered.rows[0].target_record_id, 'fixture-case-001');
  assert.deepEqual(delivered.rows[0].receipt, { accepted: true });
  assert.equal(delivered.rows[0].lease_token, null);
  assert.equal(delivered.rows[0].lease_until, null);
  assert.ok(delivered.rows[0].completed_at);
  console.log('PASS successful settlement persists receipt and clears lease');

  const retryId = await enqueue(pool);
  const attemptOne = await queue.claim();
  assert.ok(attemptOne);
  assert.equal(attemptOne.id, retryId);

  assert.equal(await queue.settle(attemptOne, {
    status: 'pending',
    errorCode: 'NATIVE_UNAVAILABLE',
    retrySeconds: 300,
  }), true);

  assert.equal(await queue.claim(), null);

  await pool.query(
    `UPDATE uc2_integration.sensor_rule_alerts
     SET available_at = clock_timestamp() - interval '1 second'
     WHERE id = $1`,
    [retryId],
  );

  const attemptTwo = await queue.claim();
  assert.ok(attemptTwo);
  assert.equal(attemptTwo.id, attemptOne.id);
  assert.equal(attemptTwo.evaluationId, attemptOne.evaluationId);
  assert.equal(attemptTwo.attempt, 2);
  assert.notEqual(attemptTwo.leaseToken, attemptOne.leaseToken);
  assert.deepEqual(attemptTwo.sourcePayload, attemptOne.sourcePayload);

  assert.equal(await queue.settle(attemptOne, success), false);
  assert.equal(await queue.settle(attemptTwo, success), true);
  console.log('PASS retry honors backoff and preserves alert identity');

  const expiredId = await enqueue(pool);
  const oldOwner = await queue.claim();
  assert.ok(oldOwner);
  assert.equal(oldOwner.id, expiredId);

  await expireLease(pool, expiredId);

  // Even without a replacement worker, an expired owner cannot settle.
  assert.equal(await queue.settle(oldOwner, success), false);

  const newOwner = await queue.claim();
  assert.ok(newOwner);
  assert.equal(newOwner.id, oldOwner.id);
  assert.equal(newOwner.attempt, 2);
  assert.notEqual(newOwner.leaseToken, oldOwner.leaseToken);

  assert.equal(await queue.settle(oldOwner, success), false);
  assert.equal(await queue.settle(newOwner, success), true);
  console.log('PASS expired lease is recovered and old owner is rejected');

  const exhaustedId = await enqueue(pool);
  const exhaustedFirst = await queue.claim();
  assert.ok(exhaustedFirst);

  await expireLease(pool, exhaustedId);
  const exhaustedSecond = await queue.claim();
  assert.ok(exhaustedSecond);
  assert.equal(exhaustedSecond.id, exhaustedId);
  assert.equal(exhaustedSecond.attempt, 2);

  await expireLease(pool, exhaustedId);
  assert.equal(await queue.claim(), null);

  const exhausted = await pool.query(
    `SELECT status, attempts, last_error_code, completed_at,
            lease_token, lease_until
     FROM uc2_integration.sensor_rule_alerts WHERE id = $1`,
    [exhaustedId],
  );
  assert.equal(exhausted.rows[0].status, 'failed');
  assert.equal(exhausted.rows[0].attempts, 2);
  assert.equal(
    exhausted.rows[0].last_error_code,
    'ALERT_ATTEMPTS_EXHAUSTED',
  );
  assert.equal(exhausted.rows[0].lease_token, null);
  assert.equal(exhausted.rows[0].lease_until, null);
  assert.ok(exhausted.rows[0].completed_at);
  console.log('PASS repeated worker crashes stop at the attempt limit');

  const limitedId = await enqueue(pool);
  const limitedFirst = await queue.claim();
  assert.ok(limitedFirst);
  await expireLease(pool, limitedId);

  const limitedSecond = await queue.claim();
  assert.ok(limitedSecond);

  assert.equal(await queue.settle(limitedSecond, {
    status: 'pending',
    errorCode: 'NATIVE_UNAVAILABLE',
    retrySeconds: 0,
  }), true);

  const limited = await pool.query(
    `SELECT status FROM uc2_integration.sensor_rule_alerts WHERE id = $1`,
    [limitedId],
  );
  assert.equal(limited.rows[0].status, 'failed');
  console.log('PASS queue enforces the attempt limit on retry settlement');

  const foreignId = await enqueue(pool, 'org-b');
  assert.equal(await queue.claim(), null);

  const foreignQueue = createSensorAlertQueue(pool, {
    organizationId: 'org-b',
    maxAttempts: 2,
  });
  const foreignAlert = await foreignQueue.claim();
  assert.ok(foreignAlert);
  assert.equal(foreignAlert.id, foreignId);

  assert.equal(await queue.settle(foreignAlert, success), false);
  assert.equal(await foreignQueue.settle(foreignAlert, success), true);
  console.log('PASS tenant isolation applies to claim and settlement');

  await pool.end();
  pool = new Pool({ connectionString: temporaryUrl.toString() });

  const reopened = createSensorAlertQueue(pool, {
    organizationId: 'org-a',
    maxAttempts: 2,
  });
  assert.equal(await reopened.claim(), null);

  const persisted = await pool.query(
    `SELECT status, target_record_id
     FROM uc2_integration.sensor_rule_alerts WHERE id = $1`,
    [firstId],
  );
  assert.equal(persisted.rows[0].status, 'succeeded');
  assert.equal(persisted.rows[0].target_record_id, 'fixture-case-001');
  console.log('PASS delivery state survives connection-pool replacement');
} finally {
  try {
    await pool?.end();
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