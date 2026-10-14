// SPDX-License-Identifier: Apache-2.0
import { test, expect } from 'vitest';
import { generateKeyPair, SignJWT, createLocalJWKSet, exportJWK } from 'jose';
import { createApi } from './app';
import { unitDirectory } from './directory-fixture';
import type { FoundationRepository } from './foundation';

const { privateKey, publicKey } = await generateKeyPair('RS256');
const key = createLocalJWKSet({ keys: [{ ...await exportJWK(publicKey), kid: 'actions', alg: 'RS256' }] });
async function auth(roles: string[], organizationId: string | undefined = 'org-a') {
  const token = await new SignJWT({ organization_id: organizationId, realm_access: { roles } })
    .setProtectedHeader({ alg: 'RS256', kid: 'actions' }).setSubject('alice')
    .setIssuer('https://identity.test').setAudience('dx-api').setExpirationTime('5m').sign(privateKey);
  return { authorization: `Bearer ${token}` };
}
function setup() {
  const writes: unknown[] = [];
  const foundation: FoundationRepository = {
    async listTasks() { return []; },
    async createTask(input) { writes.push(input); return { ...input, id: 'task-1', status: 'pending', version: 1 }; },
    async decideTask() { return undefined; },
    async createFile() { throw new Error('unused'); },
    async markFile() { throw new Error('unused'); },
    async readFile() { throw new Error('unused'); },
  };
  const app = createApi({ workerUrl: 'http://localhost:1', identity: { key, issuer: 'https://identity.test', audience: 'dx-api' },
    records: { async list() { return []; }, async create(title, ownerId, organizationId) {
      const record = { id: 'record-1', title, ownerId, organizationId, createdAt: '2026-10-12T00:00:00Z' };
      writes.push(record); return record;
    } }, foundation, directory:unitDirectory });
  return { app, writes };
}

test('catalog exposes only actions authorized for the caller', async () => {
  const { app } = setup();
  try {
    const response = await app.inject({ url: '/v1/actions', headers: await auth(['records:write']) });
    expect(response.statusCode).toBe(200);
    expect(response.json().items.map((item: { id: string }) => item.id)).toEqual(['records.create']);
    const item = response.json().items[0];
    expect(item.version).toBe(1); expect(item.requiredRole).toBe('records:write');
    expect(item.inputSchema.additionalProperties).toBe(false);
    expect((await app.inject({ url: '/v1/actions', headers: await auth([]) })).json()).toEqual({ items: [] });
  } finally { await app.close(); }
});

test('action runtime denies unauthenticated and missing organization requests without writes', async () => {
  const { app, writes } = setup();
  try {
    expect((await app.inject({ url: '/v1/actions' })).statusCode).toBe(401);
    const noScope = await new SignJWT({ realm_access: { roles: ['records:write'] } })
      .setProtectedHeader({ alg: 'RS256', kid: 'actions' }).setSubject('alice')
      .setIssuer('https://identity.test').setAudience('dx-api').setExpirationTime('5m').sign(privateKey);
    expect((await app.inject({ method: 'POST', url: '/v1/actions/records.create/run', headers: { authorization: `Bearer ${noScope}` }, payload: { version: 1, input: { title: 'Hello' } } })).statusCode).toBe(403);
    expect(writes).toEqual([]);
  } finally { await app.close(); }
});

test('record action executes with signed scope and a normalized title', async () => {
  const { app, writes } = setup();
  try {
    const response = await app.inject({ method: 'POST', url: '/v1/actions/records.create/run', headers: await auth(['records:write'], 'org-b'), payload: { version: 1, input: { title: '  Hello  ' } } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ actionId: 'records.create', version: 1, status: 'succeeded', result: { title: 'Hello', ownerId: 'alice', organizationId: 'org-b' } });
    expect(writes).toHaveLength(1);
  } finally { await app.close(); }
});

test('task action uses the same durable task repository with signed creator/scope', async () => {
  const { app } = setup();
  try {
    const response = await app.inject({ method: 'POST', url: '/v1/actions/tasks.create/run', headers: await auth(['tasks:assign']), payload: { version: 1, input: { title: 'Review', assigneeId: 'bob' } } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ actionId: 'tasks.create', status: 'succeeded', result: { id: 'task-1', createdBy: 'alice', organizationId: 'org-a', assigneeId: 'bob', status: 'pending', version: 1 } });
  } finally { await app.close(); }
});

test('input length counts Unicode code points as advertised by JSON Schema', async () => {
  const { app, writes } = setup();
  try {
    const headers = await auth(['records:write']);
    expect((await app.inject({ method: 'POST', url: '/v1/actions/records.create/run', headers, payload: { version: 1, input: { title: '😀'.repeat(200) } } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/v1/actions/records.create/run', headers, payload: { version: 1, input: { title: '😀'.repeat(201) } } })).statusCode).toBe(400);
    expect(writes).toHaveLength(1);
  } finally { await app.close(); }
});

test('task assignee Unicode length agrees with catalog boundaries', async () => {
  const { app, writes } = setup();
  try {
    const headers = await auth(['tasks:assign']);
    expect((await app.inject({ method: 'POST', url: '/v1/actions/tasks.create/run', headers, payload: { version: 1, input: { title: 'Review', assigneeId: '😀'.repeat(100) } } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/v1/actions/tasks.create/run', headers, payload: { version: 1, input: { title: 'Review', assigneeId: '😀'.repeat(101) } } })).statusCode).toBe(400);
    expect(writes).toHaveLength(1);
  } finally { await app.close(); }
});

test.each([
  { version: 2, input: { title: 'Hello' } },
  { input: { title: 'Hello' } },
  { version: 1, input: { title: 'Hello', organizationId: 'org-b' } },
  { version: 1, input: { title: 'Hello', ownerId: 'bob' } },
  { version: 1, input: { title: ' ' } },
  { version: 1, input: { title: 'a'.repeat(201) } },
  { version: 1, input: [] },
  { version: 1, input: null },
  { version: 1, input: { title: 'Hello' }, actionId: 'tasks.create' },
])('rejects malformed record action input without writes: %j', async payload => {
  const { app, writes } = setup();
  try {
    expect((await app.inject({ method: 'POST', url: '/v1/actions/records.create/run', headers: await auth(['records:write']), payload })).statusCode).toBe(400);
    expect(writes).toEqual([]);
  } finally { await app.close(); }
});

test('rejects unknown actions and role bypass without writes', async () => {
  const { app, writes } = setup();
  try {
    const headers = await auth(['records:read']);
    expect((await app.inject({ method: 'POST', url: '/v1/actions/unknown/run', headers, payload: { version: 1, input: {} } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/v1/actions/records.create/run', headers, payload: { version: 1, input: { title: 'Hello' } } })).statusCode).toBe(403);
    expect(writes).toEqual([]);
  } finally { await app.close(); }
});

test('catalog omits unavailable actions and execution fails closed', async () => {
  const app = createApi({ workerUrl: 'http://localhost:1', identity: { key, issuer: 'https://identity.test', audience: 'dx-api' } });
  try {
    const headers = await auth(['records:write']);
    expect((await app.inject({ url: '/v1/actions', headers })).json()).toEqual({ items: [] });
    expect((await app.inject({ method: 'POST', url: '/v1/actions/records.create/run', headers, payload: { version: 1, input: { title: 'Hello' } } })).statusCode).toBe(503);
  } finally { await app.close(); }
});

test.each(['', ' ', 'a'.repeat(101)])('task action rejects invalid assignee %j', async assigneeId => {
  const { app, writes } = setup();
  try {
    expect((await app.inject({ method: 'POST', url: '/v1/actions/tasks.create/run', headers: await auth(['tasks:assign']), payload: { version: 1, input: { title: 'Review', assigneeId } } })).statusCode).toBe(400);
    expect(writes).toEqual([]);
  } finally { await app.close(); }
});
test('action keyed fixtures fail closed and malformed keys return400 after role authorization',async()=>{
 const {app,writes}=setup();try{
 for(const id of ['records.create','tasks.create']) {
 const input=id==='records.create'?{title:'Hello'}:{title:'Hello',assigneeId:'alice'};
 const headers=await auth(['records:write','tasks:assign']);
 expect((await app.inject({method:'POST',url:`/v1/actions/${id}/run`,headers:{...headers,'idempotency-key':'valid'},payload:{version:1,input}})).statusCode).toBe(503);
 expect((await app.inject({method:'POST',url:`/v1/actions/${id}/run`,headers:{...headers,'idempotency-key':'a,b'},payload:{version:1,input}})).statusCode).toBe(400);
 expect((await app.inject({method:'POST',url:`/v1/actions/${id}/run`,headers:{...await auth([]),'idempotency-key':'a,b'},payload:{version:1,input}})).statusCode).toBe(403);
 }
 expect(writes).toEqual([]);
 }finally{await app.close();}
});
