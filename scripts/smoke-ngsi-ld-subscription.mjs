/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { subscriptionConfig, brokerRequest, registerSubscription } from './lib/ngsi-ld-subscription.mjs';

async function main() {
  const config = await subscriptionConfig();
  const gateway = (process.env.DX_GATEWAY_URL || 'http://localhost:8080').replace(/\/+$/, '');
  const businessId = `subscription-${randomUUID()}`;
  const entityId = `urn:ngsi-ld:Asset:${config.tenant}:${businessId}`;
  // The target broker serialized .428Z as .000Z in the live notification.
  // Use distinct whole-second fixtures; keep exact read-back assertions rather than adding a tolerance.
  const baseTime = Math.floor(Date.now() / 1_000) * 1_000;
  const firstAt = new Date(baseTime - 5_000).toISOString();
  const secondAt = new Date(baseTime - 2_000).toISOString();
  const headers = { 'X-Lattice-Broker-Token': config.token, 'NGSILD-Tenant': config.tenant };
  async function api(method, path, body, override = headers) {
    return fetch(`${gateway}/v1/integrations/ngsi-ld${path}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { ...override, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }
  const readPath = `/context?entityId=${encodeURIComponent(entityId)}`;
  console.log(`Demo Asset for this run: ${entityId}`);
  async function snapshot() {
    const response = await api('GET', readPath);
    assert.equal(response.status, 200, 'Context read-back must return 200');
    return response.json();
  }
  async function waitFor(status, observedAt) {
    const deadline = Date.now() + 20_000;
    let lastRead = { http: null };
    while (Date.now() < deadline) {
      const response = await api('GET', readPath);
      lastRead = { http: response.status };
      if (response.status === 200) {
        const value = await response.json();
        lastRead = { http: response.status, status: value.status, observedAt: value.observedAt };
        if (value.status === status && value.observedAt === observedAt) return value;
      } else assert.equal(response.status, 404, 'Receiver must be configured and reachable');
      await delay(500);
    }
    console.error('Expected context:', JSON.stringify({ status, observedAt }));
    console.error('Last context read:', JSON.stringify(lastRead));
    throw new Error('Timed out waiting for actual broker notification. Inspect API logs and subscription notification counters locally; do not share token-bearing subscription responses.');
  }
  await registerSubscription(config);
  const asset = { id: entityId, type: 'Asset', businessId: { type: 'Property', value: businessId }, organizationId: { type: 'Property', value: config.tenant }, status: { type: 'Property', value: 'ready', observedAt: firstAt }, '@context': config.context };
  await brokerRequest(config, 'POST', '/entities', asset, [201]);
  await waitFor('ready', firstAt);
  console.log('PASS broker create → receiver → PostgreSQL read-back');
  await brokerRequest(config, 'PATCH', `/entities/${encodeURIComponent(entityId)}/attrs`, { status: { type: 'Property', value: 'in_use', observedAt: secondAt }, '@context': config.context }, [204]);
  await waitFor('in_use', secondAt);
  console.log('PASS broker update → receiver: newer observedAt applied');

  // Negative/replay checks call the receiver directly. Only the two checks above prove broker delivery.
  const notification = { id: `urn:ngsi-ld:Notification:${randomUUID()}`, type: 'Notification', subscriptionId: config.id, data: [structuredClone(asset)] };
  notification.data[0].status = { type: 'Property', value: 'in_use', observedAt: secondAt };
  const before = await snapshot();
  for (const override of [{ 'NGSILD-Tenant': config.tenant }, { ...headers, 'X-Lattice-Broker-Token': 'invalid-test-token' }, { ...headers, 'NGSILD-Tenant': 'wrong-tenant' }]) {
    assert.equal((await api('POST', '/notifications', notification, override)).status, 403);
  }
  console.log('PASS receiver source checks: missing token / wrong token / wrong tenant → 403');
  const wrongSubscription = { ...notification, subscriptionId: `${config.id}-untrusted` };
  assert.equal((await api('POST', '/notifications', wrongSubscription)).status, 403);
  const replay = await api('POST', '/notifications', notification);
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), { status: 'processed', applied: 0, ignored: 1 });
  const stale = structuredClone(notification);
  stale.data[0].status = { type: 'Property', value: 'repair', observedAt: firstAt };
  const staleResponse = await api('POST', '/notifications', stale);
  assert.equal(staleResponse.status, 200);
  assert.equal((await staleResponse.json()).ignored, 1);
  const conflict = structuredClone(notification);
  conflict.data[0].status.value = 'repair';
  assert.equal((await api('POST', '/notifications', conflict)).status, 409);
  console.log('PASS receiver ordering: duplicate/stale ignored; equal-time conflicting value → 409');
  for (const field of ['businessId', 'organizationId', 'status']) {
    const missing = structuredClone(notification);
    delete missing.data[0][field];
    assert.equal((await api('POST', '/notifications', missing)).status, 400, `Missing ${field} must reject`);
  }
  for (const observedAt of [undefined, 'invalid-date', '2026-02-30T00:00:00Z', new Date(Date.now() + 600_000).toISOString()]) {
    const invalid = structuredClone(notification);
    invalid.data[0].status.observedAt = observedAt;
    assert.equal((await api('POST', '/notifications', invalid)).status, 400);
  }
  assert.deepEqual(await snapshot(), before, 'Negative/replay checks must not mutate the accepted context');
  console.log('PASS missing/invalid data rejected; stored context unchanged');
  console.log(`Demo Asset retained: ${entityId}`);
  console.log('No business order or workflow transition was changed.');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
