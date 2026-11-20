/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { generateKeyPair, SignJWT, createLocalJWKSet, exportJWK } from 'jose';
import { expect, test } from 'vitest';
import { createApi } from './app';
import type { RecordItem, RecordRepository } from './records';

const { publicKey, privateKey } = await generateKeyPair('RS256');
const key = createLocalJWKSet({ keys: [{ ...await exportJWK(publicKey), kid: 'test-key', alg: 'RS256' }] });
async function token(subject = 'alice', roles = ['records:read', 'records:write'], issuer = 'https://identity.test', audience = 'dx-api', organizationId: string | null = 'org-a', expiration = '5m') {
  return new SignJWT({ realm_access: { roles }, ...(organizationId ? { organization_id: organizationId } : {}) }).setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(issuer).setAudience(audience).setSubject(subject).setIssuedAt().setExpirationTime(expiration).sign(privateKey);
}
function setup() {
  const rows: RecordItem[] = [];
  const records: RecordRepository = {
    async create(title, ownerId, organizationId) { const row = { id: crypto.randomUUID(), title, ownerId, organizationId, createdAt: new Date().toISOString() }; rows.push(row); return row; },
    async list(ownerId, organizationId) { return rows.filter(row => row.ownerId === ownerId && row.organizationId === organizationId); },
  };
  return createApi({ workerUrl: 'http://127.0.0.1:1', records, identity: { key, issuer: 'https://identity.test', audience: 'dx-api' } });
}

test('records require authentication', async () => {
  const app = setup();
  try { expect((await app.inject({ url: '/v1/records' })).statusCode).toBe(401); } finally { await app.close(); }
});

test('signed organization scope cannot be overridden by request body', async () => {
  const app = setup();
  try {
    const headers = { authorization: `Bearer ${await token()}` };
    expect((await app.inject({ method: 'POST', url: '/v1/records', headers, payload: { title: 'Scoped', organizationId: 'org-b' } })).statusCode).toBe(400);
    const created = await app.inject({ method: 'POST', url: '/v1/records', headers, payload: { title: 'Scoped' } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ organizationId: 'org-a' });
    const anotherOrganization = await app.inject({ url: '/v1/records', headers: { authorization: `Bearer ${await token('alice', ['records:read'], 'https://identity.test', 'dx-api', 'org-b')}` } });
    expect(anotherOrganization.statusCode).toBe(200);
    expect(anotherOrganization.json().items).toEqual([]);
  } finally { await app.close(); }
});

test('a valid token without organization scope is forbidden', async () => {
  const app = setup();
  try { expect((await app.inject({ url: '/v1/records', headers: { authorization: `Bearer ${await token('alice', ['records:read'], 'https://identity.test', 'dx-api', null)}` } })).statusCode).toBe(403); } finally { await app.close(); }
});

test('an expired signed token is rejected', async () => {
  const app = setup();
  try { expect((await app.inject({ url: '/v1/records', headers: { authorization: `Bearer ${await token('alice', ['records:read'], 'https://identity.test', 'dx-api', 'org-a', '-1m')}` } })).statusCode).toBe(401); } finally { await app.close(); }
});
test.each([
  ['issuer', 'https://wrong.test', 'dx-api'], ['audience', 'https://identity.test', 'other-api'],
])('rejects a signed token with wrong %s', async (_, issuer, audience) => {
  const app = setup();
  try { expect((await app.inject({ url: '/v1/records', headers: { authorization: `Bearer ${await token('alice', ['records:read'], issuer, audience)}` } })).statusCode).toBe(401); } finally { await app.close(); }
});
test('a reader cannot create a record', async () => {
  const app = setup();
  try { expect((await app.inject({ method: 'POST', url: '/v1/records', headers: { authorization: `Bearer ${await token('bob', ['records:read'])}` }, payload: { title: 'Denied' } })).statusCode).toBe(403); } finally { await app.close(); }
});
test('records cannot be read by another owner', async () => {
  const app = setup();
  try {
    const alice = { authorization: `Bearer ${await token()}` };
    const created = await app.inject({ method: 'POST', url: '/v1/records', headers: alice, payload: { title: '  Hồ sơ mẫu  ' } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ title: 'Hồ sơ mẫu', ownerId: 'alice' });
    expect((await app.inject({ url: '/v1/records', headers: alice })).json().items).toHaveLength(1);
    expect((await app.inject({ url: '/v1/records', headers: { authorization: `Bearer ${await token('bob', ['records:read'])}` } })).json().items).toEqual([]);
  } finally { await app.close(); }
});
test('rejects a blank title', async () => {
  const app = setup();
  try { expect((await app.inject({ method: 'POST', url: '/v1/records', headers: { authorization: `Bearer ${await token()}` }, payload: { title: ' ' } })).statusCode).toBe(400); } finally { await app.close(); }
});
test.each([null, [], {title:'ok',ownerId:'bob'}, {title:'ok',extra:true}, {title:'x'.repeat(201)}])('REST record parser strictly rejects malformed body %j',async payload=>{
 const app=setup();try {expect((await app.inject({method:'POST',url:'/v1/records',headers:{authorization:`Bearer ${await token()}`,'content-type':'application/json'},payload:payload===null?'null':payload})).statusCode).toBe(400);}finally{await app.close();}
});
test('REST accepts code point title length, rejects malformed keys and missing keyed capability',async()=>{
 const app=setup();try {
 const headers={authorization:`Bearer ${await token()}`};
 expect((await app.inject({method:'POST',url:'/v1/records',headers,payload:{title:'😀'.repeat(200)}})).statusCode).toBe(201);
 for(const value of ['a,b','bad key','x'.repeat(129)])expect((await app.inject({method:'POST',url:'/v1/records',headers:{...headers,'idempotency-key':value},payload:{title:'ok'}})).statusCode).toBe(400);
 expect((await app.inject({method:'POST',url:'/v1/records',headers:{...headers,'idempotency-key':'valid'},payload:{title:'ok'}})).statusCode).toBe(503);
 }finally{await app.close();}
});
