// SPDX-License-Identifier: Apache-2.0
import { expect, test } from 'vitest';
import { createApi } from '../app.js';
import { parseNotification, shouldApply } from './policy.js';
import type { AssetContext, ContextRepository } from './types.js';
const tenant = 'org-a', token = 'a'.repeat(64), subscriptionId = 'urn:ngsi-ld:Subscription:latticedx:org-a:asset-context-v1';
const entityId = 'urn:ngsi-ld:Asset:org-a:asset-1';
const observedAt = '2026-01-01T00:00:00.000Z';
const headers = { 'x-lattice-broker-token': token, 'ngsild-tenant': tenant, 'content-type': 'application/json' };
const body = () => ({ id: 'urn:ngsi-ld:Notification:test-1', type: 'Notification', subscriptionId, data: [{ id: entityId, type: 'Asset', businessId: { type: 'Property', value: 'asset-1' }, organizationId: { type: 'Property', value: tenant }, status: { type: 'Property', value: 'ready', observedAt } }] });
function setup() {
  let writes = 0;
  const contexts = new Map<string, AssetContext>();
  const repository: ContextRepository = {
    async find(org, id) { return contexts.get(`${org}:${id}`); },
    async apply(org, notification) {
      const next = new Map(contexts);
      let applied = 0, ignored = 0;
      for (const value of notification.observations) {
        const key = `${org}:${value.entityId}`;
        if (shouldApply(next.get(key), value)) { next.set(key, { ...value, organizationId: org, notificationId: notification.id, subscriptionId: notification.subscriptionId, receivedAt: observedAt }); applied++; }
        else ignored++;
      }
      contexts.clear(); for (const [key, value] of next) contexts.set(key, value);
      writes += applied;
      return { applied, ignored };
    },
  };
  const app = createApi({ workerUrl: 'http://localhost:1', ngsiLd: { token, tenant, subscriptionId, repository } });
  return { app, contexts, writes: () => writes };
}
const url = '/v1/integrations/ngsi-ld/notifications';
test('source credentials and tenant are checked before JSON parsing or storage', async () => {
  const { app, writes } = setup();
  try {
    for (const h of [{}, { ...headers, 'x-lattice-broker-token': 'wrong' }, { ...headers, 'ngsild-tenant': 'org-b' }]) {
      expect((await app.inject({ method: 'POST', url, headers: { ...h, 'content-type': 'application/json' }, payload: 'invalid-json' })).statusCode).toBe(403);
    }
    expect(writes()).toBe(0);
  } finally { await app.close(); }
});
test('normalized JSON-LD notification persists scoped context and operational read-back is protected', async () => {
  const { app } = setup();
  try {
    const response = await app.inject({ method: 'POST', url, headers: { ...headers, 'content-type': 'application/ld+json' }, payload: body() });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'processed', applied: 1, ignored: 0 });
    const read = `/v1/integrations/ngsi-ld/context?entityId=${encodeURIComponent(entityId)}`;
    expect((await app.inject({ url: read })).statusCode).toBe(403);
    expect((await app.inject({ url: read, headers })).json()).toMatchObject({ entityId, organizationId: tenant, status: 'ready', observedAt });
  } finally { await app.close(); }
});
test('missing fields, wrong tenant, foreign subscription, and malformed batches cannot write', async () => {
  const { app, writes } = setup();
  try {
    const invalid: unknown[] = [null, {}, { ...body(), data: [] }, { ...body(), data: [body().data[0], body().data[0]] }];
    for (const field of ['businessId', 'organizationId', 'status', 'id', 'type']) {
      const value = body(); delete (value.data[0] as Record<string, unknown>)[field]; invalid.push(value);
    }
    const otherTenant = body(); otherTenant.data[0].organizationId.value = 'org-b'; invalid.push(otherTenant);
    for (const payload of invalid) expect((await app.inject({ method: 'POST', url, headers, payload: payload === null ? 'null' : JSON.stringify(payload) })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url, headers, payload: { ...body(), subscriptionId: 'foreign' } })).statusCode).toBe(403);
    expect(writes()).toBe(0);
  } finally { await app.close(); }
});
test('invalid/future/absent observedAt and non-default status instances reject', () => {
  for (const observedAt of [undefined, '2026-02-30T00:00:00Z', '2026-01-01T00:00:00.000001Z', '2026-01-01T00:06:00Z', '2026-01-01', 'invalid']) {
    const value = body(); (value.data[0].status as Record<string, unknown>).observedAt = observedAt;
    expect(() => parseNotification(value, tenant, subscriptionId, Date.parse('2026-01-01T00:00:00Z'))).toThrow();
  }
  const value = body(); (value.data[0].status as Record<string, unknown>).datasetId = 'urn:dataset:other';
  expect(() => parseNotification(value, tenant, subscriptionId)).toThrow();
});
test('replay and stale values are ignored; equal-time conflicts reject and newer values apply', async () => {
  const { app, writes } = setup();
  const post = (payload: unknown) => app.inject({ method: 'POST', url, headers, payload: JSON.stringify(payload) });
  try {
    await post(body());
    expect((await post(body())).json()).toMatchObject({ applied: 0, ignored: 1 });
    const stale = body(); stale.data[0].status = { type: 'Property', value: 'repair', observedAt: '2025-12-31T00:00:00Z' };
    expect((await post(stale)).json()).toMatchObject({ applied: 0, ignored: 1 });
    const conflict = body(); conflict.data[0].status.value = 'repair';
    expect((await post(conflict)).statusCode).toBe(409);
    const newer = body(); newer.data[0].status.observedAt = '2026-01-02T00:00:00Z'; newer.data[0].status.value = 'in_use';
    expect((await post(newer)).json()).toMatchObject({ applied: 1, ignored: 0 });
    expect(writes()).toBe(2);
  } finally { await app.close(); }
});
test('receiver is unavailable without config or storage, and unsafe config fails startup', async () => {
  const disabled = createApi({ workerUrl: 'http://localhost:1' });
  const noStorage = createApi({ workerUrl: 'http://localhost:1', ngsiLd: { token, tenant, subscriptionId } });
  try {
    expect((await disabled.inject({ method: 'POST', url, payload: body() })).statusCode).toBe(503);
    expect((await noStorage.inject({ method: 'POST', url, headers, payload: body() })).statusCode).toBe(503);
    expect(() => createApi({ workerUrl: 'http://localhost:1', ngsiLd: { token: 'short', tenant, subscriptionId } })).toThrow();
  } finally { await disabled.close(); await noStorage.close(); }
});
