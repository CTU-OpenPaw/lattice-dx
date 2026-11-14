// SPDX-License-Identifier: Apache-2.0
import { expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { createNativeSensorClient } from '../apps/api/src/sensors/native-client.js';
import { runSensorDelivery } from '../apps/api/src/sensors/worker.js';

it('keeps a native job pending after a lost receipt and completes it on replay', async () => {
  const payload = {
    schemaVersion: 1, eventId: 'sim:lost-receipt', assetUrn: 'urn:ngsi-ld:Asset:org-a:native:12',
    attribute: 'temperature', unit: 'celsius', value: 39, observedAt: new Date().toISOString(),
    source: { system: 'latticedx-simulator', deviceId: 'worker-test' }, simulated: true,
  };
  const fetchImpl = vi.fn<typeof fetch>()
    .mockRejectedValueOnce(new Error('Connection closed after commit'))
    .mockResolvedValueOnce(Response.json({ data: { id: '42', accepted: true, duplicate: true } }));
  const sourceSystem = payload.source.system;
  const native = createNativeSensorClient({ baseUrl: 'http://localhost:13003', token: 'fixture', organizationId: 'org-a', sourceSystem, fetchImpl });
  const updates: unknown[][] = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('FOR UPDATE OF d')) {
      expect(params).toEqual(['org-a', 'urn:ngsi-ld:Asset:org-a:native:', true, sourceSystem]);
      return { rows: [{ reading_id: '7', asset_urn: payload.assetUrn, attribute: payload.attribute, source_payload: payload, attempts: updates.length }] };
    }
    if (sql.includes('pg_try_advisory')) return { rows: [{ acquired: true }] };
    if (sql.includes('UPDATE uc2_integration.sensor_deliveries')) updates.push(params);
    return { rows: [], rowCount: 1 };
  });
  const pool = { connect: async () => ({ query, release: vi.fn() }) } as unknown as Pool;

  await expect(runSensorDelivery(pool, { native, sourceSystem }, 'org-a')).resolves.toMatchObject({ outcome: 'retry', attempt: 1 });
  await expect(runSensorDelivery(pool, { native, sourceSystem }, 'org-a')).resolves.toMatchObject({ outcome: 'succeeded', attempt: 2 });
  expect(updates).toEqual([['7', 'pending', 'NATIVE_TRANSPORT_FAILED', 0], ['7', 'succeeded', null, 1]]);
  expect(fetchImpl.mock.calls[0][1]?.body).toBe(fetchImpl.mock.calls[1][1]?.body);
});
