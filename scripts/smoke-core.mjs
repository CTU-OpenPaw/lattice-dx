/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict';
const gateway = process.env.GATEWAY_URL ?? 'http://localhost:8080';
const identity = process.env.KEYCLOAK_URL ?? 'http://localhost:8081';
async function ready(url) {
  for (let attempt = 0; attempt < 60; attempt++) {
    try { const response = await fetch(url, { signal: AbortSignal.timeout(2000) }); if (response.ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`Service did not become ready: ${url}`);
}
async function token(username, password) {
  const response = await fetch(`${identity}/realms/lattice/protocol/openid-connect/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', client_id: 'dx-local', username, password }),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200, 'Development account must obtain a token');
  const data = await response.json();
  assert.equal(typeof data.access_token, 'string');
  return data.access_token;
}
await ready(`${identity}/realms/lattice/.well-known/openid-configuration`);
await ready(`${gateway}/health`);
const alice = await token('alice', 'local-alice-password');
const bob = await token('bob', 'local-bob-password');
assert.equal((await fetch(`${gateway}/v1/records`)).status, 401, 'Unauthenticated request must fail');
const headers = { authorization: `Bearer ${alice}`, 'content-type': 'application/json' };
const created = await fetch(`${gateway}/v1/records`, { method: 'POST', headers, body: JSON.stringify({ title: `Smoke ${new Date().toISOString()}` }) });
assert.equal(created.status, 201, 'Writer must create a persisted record');
const record = await created.json();
assert.equal(record.organizationId, 'org-a', 'Organization must come from signed Keycloak claims');
const own = await fetch(`${gateway}/v1/records`, { headers });
assert.equal(own.status, 200);
assert.ok((await own.json()).items.some(item => item.id === record.id), 'Record must be queryable');
const other = await fetch(`${gateway}/v1/records`, { headers: { authorization: `Bearer ${bob}` } });
assert.equal(other.status, 200);
assert.ok(!(await other.json()).items.some(item => item.id === record.id), 'Other user cannot read this record');
assert.equal((await fetch(`${gateway}/v1/records`, { method: 'POST', headers: { authorization: `Bearer ${bob}`, 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Denied' }) })).status, 403);
console.log('Core smoke passed: Keycloak → APISIX → API → PostgreSQL; role, owner and organization checks passed.');
