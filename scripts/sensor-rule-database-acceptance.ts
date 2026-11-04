// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { Pool as PgPool } from 'pg';

const requireApi = createRequire(
  new URL('../apps/api/package.json', import.meta.url),
);
const { Pool } = requireApi('pg') as {
  Pool: typeof PgPool;
};
import {
  createSensorRuleRepository,
  SensorRuleConflictError,
} from '../apps/api/src/sensor-rules/database.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required.');

const databaseName = `uc2_rule_acceptance_${randomUUID().replaceAll('-', '')}`;
const temporaryUrl = new URL(connectionString);
temporaryUrl.pathname = `/${databaseName}`;

const admin = new Pool({ connectionString });
let pool: PgPool | undefined;
let created = false;

const mapping = {
  assetEntityId: randomUUID(),
  assetUrn: 'urn:ngsi-ld:Asset:org-a:uc1-demo-asset-001',
};

function rule(cooldownSeconds = '300') {
  return {
    id: randomUUID(),
    schemaId: 'incident-rule',
    schemaVersion: 1,
    version: 1,
    archivedAt: null,
    attributes: {
      assetEntityId: mapping.assetEntityId,
      attribute: 'temperature',
      operator: 'gt',
      threshold: '80',
      unit: 'celsius',
      maxObservationAgeSeconds: '600',
      cooldownSeconds,
      severity: 'high',
      enabled: true,
      workflowDefinitionId: 'incident-response',
      workflowDefinitionVersion: '1',
      handlerId: 'fixture-handler',
    },
  };
}

function reading(value = 85) {
  const referenceTime = new Date().toISOString();

  return {
    eventId: `sim:${randomUUID().replaceAll('-', '')}`,
    schemaVersion: 1,
    assetUrn: mapping.assetUrn,
    attribute: 'temperature',
    unit: 'celsius',
    value,
    observedAt: referenceTime,
    source: {
      system: 'latticedx-simulator',
      deviceId: 'simulated-temperature-001',
    },
    simulated: true,
    simulation: {
      scenario: value > 80 ? 'anomalous' : 'normal',
      seed: 'uc2-rule-database-acceptance',
      referenceTime,
    },
  };
}

try {
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  created = true;

  pool = new Pool({
    connectionString: temporaryUrl.toString(),
    max: 16,
  });

  const sql = await readFile(
    new URL('../infra/config/uc2/sensor-rule-runtime.sql', import.meta.url),
    'utf8',
  );
  await pool.query(sql.replace(/^\uFEFF/, ''));

  let repository = createSensorRuleRepository(pool, {
    organizationId: 'org-a',
    sourceSystem: 'latticedx-simulator',
  });

  const configuredRule = rule();
  const firstReading = reading();
  const input = {
    ruleEntity: configuredRule,
    sourcePayload: firstReading,
    mapping,
  };

  const first = await repository.evaluate(input);
  assert.equal(first.outcome, 'queued');
  assert.equal(first.duplicate, false);
  assert.ok(first.alertId);

  const replay = await repository.evaluate(input);
  assert.equal(replay.evaluationId, first.evaluationId);
  assert.equal(replay.alertId, first.alertId);
  assert.equal(replay.duplicate, true);
  console.log('PASS exact replay preserves evaluation and alert IDs');

  await assert.rejects(
    () => repository.evaluate({
      ...input,
      sourcePayload: { ...firstReading, value: 95 },
    }),
    SensorRuleConflictError,
  );

  const original = await pool.query(
    `SELECT source_payload->>'value' AS value
     FROM uc2_integration.sensor_rule_evaluations
     WHERE id = $1`,
    [first.evaluationId],
  );
  assert.equal(original.rows[0].value, '85');
  console.log('PASS conflicting payload leaves original unchanged');

  const suppressed = await repository.evaluate({
    ...input,
    sourcePayload: reading(),
  });
  assert.equal(suppressed.outcome, 'cooldown');
  assert.equal(suppressed.alertId, null);
  console.log('PASS another event during cooldown creates no alert');

  // Change only isolated fixture state to test expiry without waiting.
  await pool.query(
    `UPDATE uc2_integration.sensor_rule_state
     SET last_alert_at = clock_timestamp() - interval '301 seconds'
     WHERE organization_id = $1 AND rule_id = $2`,
    ['org-a', configuredRule.id],
  );

  const afterExpiry = await repository.evaluate({
    ...input,
    sourcePayload: reading(),
  });
  assert.equal(afterExpiry.outcome, 'queued');
  assert.ok(afterExpiry.alertId);
  assert.notEqual(afterExpiry.alertId, first.alertId);
  console.log('PASS cooldown expiry allows a new alert');

  const concurrentRule = rule('0');
  const concurrentInput = {
    ruleEntity: concurrentRule,
    sourcePayload: reading(),
    mapping,
  };

  const concurrent = await Promise.all(
    Array.from({ length: 12 }, () =>
      repository.evaluate(concurrentInput),
    ),
  );

  assert.equal(concurrent.filter(r => !r.duplicate).length, 1);
  assert.equal(
    new Set(concurrent.map(r => r.evaluationId)).size,
    1,
  );
  assert.equal(new Set(concurrent.map(r => r.alertId)).size, 1);
  console.log('PASS concurrent duplicate delivery queues one alert');

  const cooldownRule = rule();
  const competing = await Promise.all(
    Array.from({ length: 12 }, () => repository.evaluate({
      ruleEntity: cooldownRule,
      sourcePayload: reading(),
      mapping,
    })),
  );

  assert.equal(competing.filter(r => r.outcome === 'queued').length, 1);
  assert.equal(competing.filter(r => r.outcome === 'cooldown').length, 11);
  console.log('PASS concurrent distinct events respect cooldown');

  const normal = await repository.evaluate({
    ruleEntity: rule(),
    sourcePayload: reading(25),
    mapping,
  });
  assert.equal(normal.outcome, 'not_matched');
  assert.equal(normal.alertId, null);

  const staleReading = reading();
  staleReading.observedAt = new Date(Date.now() - 3_600_000).toISOString();

  const stale = await repository.evaluate({
    ruleEntity: rule(),
    sourcePayload: staleReading,
    mapping,
  });
  assert.equal(stale.outcome, 'not_matched');

  const staleResult = await pool.query(
    `SELECT evaluation->>'reason' AS reason
     FROM uc2_integration.sensor_rule_evaluations
     WHERE id = $1`,
    [stale.evaluationId],
  );
  assert.equal(staleResult.rows[0].reason, 'STALE_OBSERVATION');
  console.log('PASS normal and stale readings do not queue alerts');

  const revisedRule = structuredClone(configuredRule);
  revisedRule.version = 2;

  const revisedReplay = await repository.evaluate({
    ...input,
    ruleEntity: revisedRule,
  });
  assert.equal(revisedReplay.duplicate, true);
  assert.equal(revisedReplay.evaluationId, first.evaluationId);
  console.log('PASS a rule edit does not reprocess an accepted event');

  // Force an outbox insert failure and verify the whole transaction rolls back.
  await pool.query(`
    CREATE FUNCTION uc2_integration.reject_test_alert()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'acceptance_forced_alert_failure';
    END;
    $$;

    CREATE TRIGGER reject_test_alert
    BEFORE INSERT ON uc2_integration.sensor_rule_alerts
    FOR EACH ROW
    EXECUTE FUNCTION uc2_integration.reject_test_alert();
  `);

  const rollbackRule = rule();

  await assert.rejects(
    () => repository.evaluate({
      ruleEntity: rollbackRule,
      sourcePayload: reading(),
      mapping,
    }),
    /acceptance_forced_alert_failure/,
  );

  for (const table of [
    'sensor_rule_state',
    'sensor_rule_evaluations',
  ]) {
    const count = await pool.query(
      `SELECT count(*)::integer AS count
       FROM uc2_integration.${table}
       WHERE organization_id = $1 AND rule_id = $2`,
      ['org-a', rollbackRule.id],
    );
    assert.equal(count.rows[0].count, 0);
  }

  await pool.query(`
    DROP TRIGGER reject_test_alert
      ON uc2_integration.sensor_rule_alerts;
    DROP FUNCTION uc2_integration.reject_test_alert();
  `);
  console.log('PASS alert failure rolls back evaluation and cooldown state');

  await assert.rejects(
    () => repository.evaluate({
      ...input,
      sourcePayload: {
        ...firstReading,
        source: { ...firstReading.source, system: 'untrusted-source' },
      },
    }),
    /configured scope/,
  );

  await assert.rejects(
    () => repository.evaluate({
      ...input,
      mapping: {
        ...mapping,
        assetUrn: 'urn:ngsi-ld:Asset:org-b:another-asset',
      },
    }),
    /tenant-scoped Asset mapping/,
  );
  console.log('PASS source and tenant mapping mismatches are rejected');

  await pool.end();
  pool = new Pool({
    connectionString: temporaryUrl.toString(),
  });

  repository = createSensorRuleRepository(pool, {
    organizationId: 'org-a',
    sourceSystem: 'latticedx-simulator',
  });

  const persisted = await repository.evaluate(input);
  assert.equal(persisted.duplicate, true);
  assert.equal(persisted.evaluationId, first.evaluationId);
  assert.equal(persisted.alertId, first.alertId);
  console.log('PASS receipt survives connection-pool replacement');
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