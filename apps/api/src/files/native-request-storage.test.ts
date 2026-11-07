// SPDX-License-Identifier: Apache-2.0
import Fastify from 'fastify';
import {createHmac, randomUUID} from 'node:crypto';
import {afterEach, expect, it, vi} from 'vitest';
import {registerNativeRequestStorage, type nativeRequestStorage} from './native-request-storage.js';

const secret = 'a'.repeat(64);
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });

function fixture() {
  const seen = new Set<string>();
  const repository = {
    acceptNonce: vi.fn(async (nonce: string) => {
      if (seen.has(nonce)) return false;
      seen.add(nonce);
      return true;
    }),
    list: vi.fn(async () => []),
    uploaded: vi.fn<ReturnType<typeof nativeRequestStorage>['uploaded']>(async () => undefined),
    store: vi.fn(async () => undefined),
    download: vi.fn(async () => undefined),
  };
  const scan = vi.fn<(content: Buffer) => Promise<'clean' | 'rejected'>>(async () => 'clean');
  const app = Fastify();
  apps.push(app);
  registerNativeRequestStorage(app, {secret, instance: 'test-native', repository, scan});
  const payload = {at: Date.now(), nonce: randomUUID(), instance: 'test-native', operation: 'list', organizationId: 'org-a', requestId: '1', userId: '2', limit: 20, offset: 0};
  const sign = (body: string) => createHmac('sha256', Buffer.from(secret, 'hex')).update(body).digest('hex');
  const send = (body: string, signature = sign(body)) => app.inject({
    method: 'POST', url: '/internal/native-request-files',
    headers: {'content-type': 'text/plain', 'x-dx-native-signature': signature}, payload: body,
  });
  return {app, repository, scan, payload, send, sign};
}

it('rejects changed, expired and replayed requests before reading storage', async () => {
  const {repository, payload, send, sign} = fixture();
  const body = JSON.stringify(payload);
  expect((await send(JSON.stringify({...payload, organizationId: 'org-b'}), sign(body))).statusCode).toBe(401);
  expect((await send(JSON.stringify({...payload, at: Date.now() - 30000}))).statusCode).toBe(401);
  expect(repository.list).not.toHaveBeenCalled();
  expect((await send(body)).statusCode).toBe(200);
  expect((await send(body)).statusCode).toBe(401);
  expect(repository.list).toHaveBeenCalledOnce();
  expect(repository.list).toHaveBeenCalledWith({instance:'test-native',organizationId:'org-a',requestId:'1',userId:'2'},20,0);
});

it('binds downloads to the signed instance, organization and request', async () => {
  const {repository, payload, send} = fixture();
  const fileId = randomUUID();
  expect((await send(JSON.stringify({...payload, operation: 'download', fileId}))).statusCode).toBe(404);
  expect(repository.download).toHaveBeenCalledWith({instance:'test-native',organizationId:'org-a',requestId:'1',userId:'2'},fileId);
  expect((await send(JSON.stringify({...payload, nonce:randomUUID(),instance:'other-native'}))).statusCode).toBe(400);
  expect(repository.download).toHaveBeenCalledOnce();
});

it('keeps rejected or unavailable scans out of the shared repository', async () => {
  const {repository, scan, payload, send} = fixture();
  const upload = {...payload, operation:'upload',key:randomUUID(),filename:'proof.txt',contentBase64:Buffer.from('proof').toString('base64')};
  scan.mockResolvedValueOnce('rejected');
  expect((await send(JSON.stringify(upload))).statusCode).toBe(409);
  scan.mockRejectedValueOnce(new Error('Scanner unavailable'));
  expect((await send(JSON.stringify({...upload,nonce:randomUUID()}))).statusCode).toBe(503);
  expect(repository.store).not.toHaveBeenCalled();
});

it('rejects reuse of an upload key with different bytes without scanning again', async () => {
  const {repository, scan, payload, send} = fixture();
  repository.uploaded.mockResolvedValueOnce({filename:'proof.txt',digest:'0'.repeat(64)});
  const response = await send(JSON.stringify({...payload,operation:'upload',key:randomUUID(),filename:'proof.txt',contentBase64:Buffer.from('changed').toString('base64')}));
  expect(response.statusCode).toBe(409);
  expect(scan).not.toHaveBeenCalled();
  expect(repository.store).not.toHaveBeenCalled();
});
