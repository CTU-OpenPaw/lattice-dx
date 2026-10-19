// SPDX-License-Identifier: Apache-2.0
import { test, expect } from 'vitest';
import { generateKeyPair, SignJWT, createLocalJWKSet, exportJWK } from 'jose';
import { createApi } from './app';
import { unitDirectory } from './directory-fixture';
import type { FoundationRepository } from './foundation';
const { privateKey, publicKey } = await generateKeyPair('RS256');
const key = createLocalJWKSet({ keys: [{ ...await exportJWK(publicKey), kid: 'links', alg: 'RS256' }] });
const recordId = '11111111-1111-4111-8111-111111111111';
async function auth(subject = 'alice', organizationId = 'org-a') {
  const token = await new SignJWT({ organization_id: organizationId, realm_access: { roles: ['records:read', 'records:write', 'tasks:assign', 'files:write', 'files:read'] } })
    .setProtectedHeader({ alg: 'RS256', kid: 'links' }).setSubject(subject)
    .setIssuer('https://identity.test').setAudience('dx-api').setExpirationTime('5m').sign(privateKey);
  return { authorization: `Bearer ${token}` };
}
function setup(withRecords = true, lookupFailure = false) {
  const writes: unknown[] = []; let scans = 0;
  const foundation: FoundationRepository = {
    async listTasks() { return []; },
    async createTask(input) { writes.push(input); return { ...input, id: 'task-1', status: 'pending', version: 1 }; },
    async decideTask() { return undefined; },
    async createFile(input) { writes.push(input); const { content, ...metadata } = input; return { ...metadata, id: 'file-1', size: content.length, scanStatus: 'pending' }; },
    async markFile() {}, async readFile() { return undefined; },
  };
  const records = {
    async create(title: string, ownerId: string, organizationId: string) { return { id: recordId, title, ownerId, organizationId, createdAt: '2026-10-12T00:00:00Z' }; },
    async list() { return []; },
    async find(id: string, ownerId: string, organizationId: string) {
      if (lookupFailure) throw new Error('database unavailable');
      return id === recordId && ownerId === 'alice' && organizationId === 'org-a'
        ? { id, title: 'Business record', ownerId, organizationId, createdAt: '2026-10-12T00:00:00Z' } : undefined;
    },
  };
  return { app: createApi({ workerUrl: 'http://localhost:1', identity: { key, issuer: 'https://identity.test', audience: 'dx-api' }, foundation,directory:unitDirectory,
    records: withRecords ? records : undefined, scan: async () => { scans++; return 'clean'; } }), writes, scans: () => scans };
}
const paths = ['/v1/tasks', '/v1/actions/tasks.create/run', '/v1/files'];
function payload(path: string, id: unknown = recordId) {
  if (path === '/v1/files') return { filename: 'a.txt', contentBase64: 'YQ==', recordId: id };
  const input = { title: 'Review', assigneeId: 'alice', recordId: id };
  return path.includes('/actions/') ? { version: 1, input } : input;
}
test.each(paths)('%s persists an owned business record reference', async path => {
  const { app, writes } = setup();
  try {
    const response = await app.inject({ method: 'POST', url: path, headers: await auth(), payload: payload(path) });
    expect(response.statusCode).toBe(path.includes('/actions/') ? 200 : 201);
    const item = path.includes('/actions/') ? response.json().result : response.json();
    expect(item.recordId).toBe(recordId); expect(writes).toHaveLength(1);
  } finally { await app.close(); }
});
test.each(paths)('%s reports lookup outage without writing or scanning', async path => {
  const { app, writes, scans } = setup(true, true);
  try {
    expect((await app.inject({method:'POST',url:path,headers:await auth(),payload:payload(path)})).statusCode).toBe(503);
    expect(writes).toEqual([]); expect(scans()).toBe(0);
  } finally {await app.close();}
});
test.each(paths)('%s denies another owner and organization without writes or scanning', async path => {
  const { app, writes, scans } = setup();
  try {
    for (const [subject, org] of [['bob', 'org-a'], ['alice', 'org-b']]) {
      expect((await app.inject({ method: 'POST', url: path, headers: await auth(subject, org), payload: payload(path) })).statusCode).toBe(404);
    }
    expect(writes).toEqual([]); expect(scans()).toBe(0);
  } finally { await app.close(); }
});
test.each(paths)('%s denies a missing business record before writing', async path => {
  const { app, writes } = setup();
  try {
    expect((await app.inject({ method: 'POST', url: path, headers: await auth(), payload: payload(path, '22222222-2222-4222-8222-222222222222') })).statusCode).toBe(404);
    expect(writes).toEqual([]);
  } finally { await app.close(); }
});
test.each(paths)('%s validates reference shape and fails closed without lookup dependency', async path => {
  const { app, writes } = setup(false);
  try {
    for (const invalid of ['bad-id', null, 123, {}, []]) {
      expect((await app.inject({ method: 'POST', url: path, headers: await auth(), payload: payload(path, invalid) })).statusCode).toBe(400);
    }
    expect((await app.inject({ method: 'POST', url: path, headers: await auth(), payload: payload(path) })).statusCode).toBe(503);
    expect(writes).toEqual([]);
  } finally { await app.close(); }
});
