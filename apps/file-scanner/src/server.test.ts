/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { createHmac, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { createRequire } from 'node:module';
import { mkdtemp, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { scanWithClamd } from './clamav.js';
import { createRustfsS3Client, signAwsSigV4 } from './s3-rustfs.js';
import { createFileScannerServer, createFilesystemBackend, NonceReplayCache } from './server.js';

const require = createRequire(import.meta.url);
const { createNativeSharedFiles } = require('../../../plugins/nocobase/plugin-lattice-foundation/src/server/native-shared-files.js') as {
  createNativeSharedFiles: (opts: { url: string; secret: string; instance: string }) => (
    ctx: { throw: (status: number, msg: string) => never },
    operation: 'list' | 'download' | 'upload',
    req: { id: string; actor: { organizationId: string; userId: string } },
    values: Record<string, unknown>,
  ) => Promise<{ status?: number; data?: unknown; disposition?: string | null; content?: Buffer }>;
};

const SECRET = 'b'.repeat(64);
const INSTANCE = 'test-native';
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) {
    await fn();
  }
});

function signBody(body: string, secret = SECRET): string {
  return createHmac('sha256', Buffer.from(secret, 'hex')).update(body).digest('hex');
}

function makeEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    at: Date.now(),
    nonce: randomUUID(),
    instance: INSTANCE,
    operation: 'list',
    organizationId: 'org-a',
    requestId: '101',
    userId: '7',
    limit: 20,
    offset: 0,
    ...overrides,
  };
}

function createMockS3Server() {
  const buckets = new Set<string>();
  const objects = new Map<string, { body: Buffer; contentType: string }>();
  const seenAuths: string[] = [];

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const auth = req.headers.authorization;
    if (typeof auth === 'string') seenAuths.push(auth);
    if (!auth || !auth.startsWith('AWS4-HMAC-SHA256 ')) {
      res.writeHead(403);
      res.end('<Error><Code>AccessDenied</Code></Error>');
      return;
    }

    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
    const body = Buffer.concat(chunks);

    const parsed = new URL(req.url ?? '/', 'http://127.0.0.1');
    const parts = parsed.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const bucket = parts[0];
    const key = parts.slice(1).join('/');

    if (!bucket) {
      res.writeHead(400);
      res.end();
      return;
    }

    if (!key) {
      if (req.method === 'HEAD') {
        res.writeHead(buckets.has(bucket) ? 200 : 404);
        res.end();
        return;
      }
      if (req.method === 'PUT') {
        buckets.add(bucket);
        res.writeHead(200);
        res.end();
        return;
      }
      if (req.method === 'GET' && parsed.searchParams.get('list-type') === '2') {
        if (!buckets.has(bucket)) {
          res.writeHead(404);
          res.end('<Error><Code>NoSuchBucket</Code></Error>');
          return;
        }
        const prefix = parsed.searchParams.get('prefix') ?? '';
        const token = parsed.searchParams.get('continuation-token');
        const matchingKeys = [...objects.keys()]
          .filter((k) => k.startsWith(`${bucket}/`))
          .map((k) => k.slice(bucket.length + 1))
          .filter((k) => k.startsWith(prefix))
          .sort();
        const start = token ? Number(token) : 0;
        const pageSize = 2;
        const pageKeys = matchingKeys.slice(start, start + pageSize);
        const hasMore = start + pageSize < matchingKeys.length;
        const escapeXml = (s: string) =>
          s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const contentsXml = pageKeys.map((k) => `<Contents><Key>${escapeXml(k)}</Key></Contents>`).join('');
        const nextXml = hasMore ? `<NextContinuationToken>${start + pageSize}</NextContinuationToken>` : '';
        const xml = `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${escapeXml(bucket)}</Name><IsTruncated>${hasMore}</IsTruncated>${nextXml}${contentsXml}</ListBucketResult>`;
        res.writeHead(200, { 'content-type': 'application/xml' });
        res.end(xml);
        return;
      }
    }

    if (!buckets.has(bucket)) {
      res.writeHead(404);
      res.end('<Error><Code>NoSuchBucket</Code></Error>');
      return;
    }

    const fullKey = `${bucket}/${key}`;
    if (req.method === 'PUT') {
      if (req.headers['if-none-match'] === '*' && objects.has(fullKey)) {
        res.writeHead(412);
        res.end('<Error><Code>PreconditionFailed</Code></Error>');
        return;
      }
      objects.set(fullKey, {
        body,
        contentType: String(req.headers['content-type'] ?? 'application/octet-stream'),
      });
      res.writeHead(200);
      res.end();
      return;
    }
    if (req.method === 'GET') {
      const item = objects.get(fullKey);
      if (!item) {
        res.writeHead(404);
        res.end('<Error><Code>NoSuchKey</Code></Error>');
        return;
      }
      res.writeHead(200, { 'content-type': item.contentType });
      res.end(item.body);
      return;
    }
    res.writeHead(405);
    res.end();
  });

  return {
    buckets,
    objects,
    seenAuths,
    async start() {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const addr = server.address() as { port: number };
      cleanups.push(
        () => new Promise<void>((resolve, reject) => {
          server.closeIdleConnections?.();
          server.close((err) => (err ? reject(err) : resolve()));
        }),
      );
      return `http://127.0.0.1:${addr.port}`;
    },
  };
}

describe('ClamAV zINSTREAM client', () => {
  test.each([
    ['stream: OK\0', 'clean'],
    ['stream: Eicar-Test-Signature FOUND\0', 'rejected'],
    ['stream: INSTREAM size limit exceeded. ERROR\0', 'error'],
    ['stream: OK', 'error'],
  ] as const)('parses clamd response %j and enforces streaming framing', async (reply, expected) => {
    let received = Buffer.alloc(0);
    const clamd = createNetServer((socket) => {
      socket.on('data', (chunk) => {
        received = Buffer.concat([received, typeof chunk === 'string' ? Buffer.from(chunk) : chunk]);
        if (received.length === 22) {
          socket.write(reply.slice(0, 4));
          socket.end(reply.slice(4));
        }
      });
    });
    await new Promise<void>((resolve) => clamd.listen(0, '127.0.0.1', resolve));
    cleanups.push(
      () => new Promise<void>((resolve, reject) => clamd.close((err) => (err ? reject(err) : resolve()))),
    );
    const addr = clamd.address() as { port: number };
    const promise = scanWithClamd(Buffer.from('test'), '127.0.0.1', addr.port);
    if (expected === 'error') {
      await expect(promise).rejects.toThrow();
    } else {
      await expect(promise).resolves.toBe(expected);
    }
    expect(received.subarray(0, 10).toString()).toBe('zINSTREAM\0');
    expect(received.readUInt32BE(10)).toBe(4);
    expect(received.subarray(14, 18).toString()).toBe('test');
    expect(received.readUInt32BE(18)).toBe(0);
  });
});

describe('AWS SigV4 & RustFS S3 client', () => {
  test('matches official AWS SigV4 GetObject reference signature', () => {
    const signed = signAwsSigV4({
      method: 'GET',
      host: 'examplebucket.s3.amazonaws.com',
      canonicalUri: '/test.txt',
      query: {},
      extraHeaders: { range: 'bytes=0-9' },
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      region: 'us-east-1',
      date: new Date('2013-05-24T00:00:00Z'),
    });
    expect(signed.headers['x-amz-date']).toBe('20130524T000000Z');
    expect(signed.headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );

    // Code-point sorting puts uppercase 'B' before lowercase 'a' regardless of locale
    const querySigned = signAwsSigV4({
      method: 'GET',
      host: 'rustfs:9000',
      canonicalUri: '/bucket',
      query: { a: '1', B: '2', a_b: '3' },
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      accessKeyId: 'rustfs-key',
      secretAccessKey: 'rustfs-secret',
      region: 'us-east-1',
      date: new Date('2026-01-01T00:00:00Z'),
    });
    expect(querySigned.queryString).toBe('B=2&a=1&a_b=3');
  });

  test('uploads, downloads, and lists objects against RustFS S3 mock with automatic bucket creation', async () => {
    const s3Mock = createMockS3Server();
    const endpoint = await s3Mock.start();
    const client = createRustfsS3Client({
      endpoint,
      accessKeyId: 'rustfs-key',
      secretAccessKey: 'rustfs-secret',
      bucket: 'dx-native-test',
    });

    await client.putObject('blobs/org-a/1/a.bin', Buffer.from('hello s3'));
    await client.putObject('blobs/org-a/1/b.bin', Buffer.from('second'));
    await client.putObject('blobs/org-a/1/c.bin', Buffer.from('third'));
    const got = await client.getObject('blobs/org-a/1/a.bin');
    expect(got?.toString('utf8')).toBe('hello s3');
    expect(await client.getObject('blobs/org-a/1/missing.bin')).toBeUndefined();
    expect(await client.listKeys('blobs/org-a/1/')).toEqual([
      'blobs/org-a/1/a.bin',
      'blobs/org-a/1/b.bin',
      'blobs/org-a/1/c.bin',
    ]);
    expect(s3Mock.seenAuths.length).toBeGreaterThanOrEqual(4);
  });
});

describe('NonceReplayCache', () => {
  test('blocks replay within 15s window and caps size at 10,000 entries', () => {
    const cache = new NonceReplayCache(10_000, 15_000);
    const now = 1_700_000_000_000;
    const id = randomUUID();
    expect(cache.accept(id, now, now)).toBe(true);
    expect(cache.accept(id.toUpperCase(), now, now + 1000)).toBe(false);

    for (let i = 0; i < 10_050; i++) {
      expect(cache.accept(randomUUID(), now + 1, now + 1)).toBe(true);
    }
    expect(cache.size).toBeLessThanOrEqual(10_000);
  });
});

describe('file-scanner HTTP server', () => {
  async function setupS3Scanner(scanFn?: (content: Buffer) => Promise<'clean' | 'rejected'>) {
    const s3Mock = createMockS3Server();
    const endpoint = await s3Mock.start();
    const s3Client = createRustfsS3Client({
      endpoint,
      accessKeyId: 'rustfs-key',
      secretAccessKey: 'rustfs-secret',
      bucket: 'dx-files',
    });
    const scan = vi.fn(scanFn ?? (async (): Promise<'clean' | 'rejected'> => 'clean'));
    const app = createFileScannerServer({
      secret: SECRET,
      instance: INSTANCE,
      storage: { kind: 's3', client: s3Client },
      scan,
    });
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    cleanups.push(() => app.close());

    const sendRaw = async (body: string, signature = signBody(body)) =>
      fetch(new URL('/internal/native-request-files', url), {
        method: 'POST',
        headers: { 'content-type': 'text/plain', 'x-dx-native-signature': signature },
        body,
      });

    return { app, url, s3Mock, scan, sendRaw };
  }

  test('GET /health returns 200 ok', async () => {
    const { url } = await setupS3Scanner();
    const res = await fetch(new URL('/health', url));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', service: 'file-scanner' });
  });

  test('rejects tampered signature, expired timestamp, replayed nonce, and invalid scope before storage access', async () => {
    const { sendRaw, s3Mock } = await setupS3Scanner();
    const valid = makeEnvelope();
    const validBody = JSON.stringify(valid);

    const tampered = await sendRaw(JSON.stringify({ ...valid, organizationId: 'org-b' }), signBody(validBody));
    expect(tampered.status).toBe(401);

    const expired = await sendRaw(JSON.stringify({ ...valid, at: Date.now() - 20_000 }));
    expect(expired.status).toBe(401);

    const wrongInstance = await sendRaw(JSON.stringify(makeEnvelope({ instance: 'other-instance' })));
    expect(wrongInstance.status).toBe(400);

    const first = await sendRaw(validBody);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual([]);

    const replay = await sendRaw(validBody);
    expect(replay.status).toBe(401);
    expect(s3Mock.objects.size).toBe(0);
  });

  test('rejects malware with 409 and scanner outage with 503 writing zero bytes to S3', async () => {
    const { sendRaw, scan, s3Mock } = await setupS3Scanner();
    const upload = makeEnvelope({
      operation: 'upload',
      key: randomUUID(),
      filename: 'evil.txt',
      contentBase64: Buffer.from('EICAR').toString('base64'),
    });

    scan.mockResolvedValueOnce('rejected');
    const malwareRes = await sendRaw(JSON.stringify(upload));
    expect(malwareRes.status).toBe(409);
    expect(await malwareRes.json()).toEqual({ error: 'Tệp bị bộ quét từ chối.' });
    expect(s3Mock.objects.size).toBe(0);

    scan.mockRejectedValueOnce(new Error('clamd down'));
    const outageRes = await sendRaw(JSON.stringify({ ...upload, nonce: randomUUID() }));
    expect(outageRes.status).toBe(503);
    expect(s3Mock.objects.size).toBe(0);
  });

  test('supports clean upload, idempotent replay, mismatch 409, concurrent upload, list, and UTF-8 download via native-shared-files', async () => {
    const { url, scan } = await setupS3Scanner();
    const sharedFiles = createNativeSharedFiles({ url, secret: SECRET, instance: INSTANCE });
    const ctx = {
      throw(status: number, message: string): never {
        const err = new Error(message) as Error & { status: number };
        err.status = status;
        throw err;
      },
    };

    const key = randomUUID();
    const content = Buffer.from('Nội dung tệp sạch 100%');
    const actor = { organizationId: 'org-a', userId: '10' };
    const reviewer = { organizationId: 'org-a', userId: '99' };

    const [up1, up2] = await Promise.all([
      sharedFiles(ctx, 'upload', { id: '42', actor }, {
        key, filename: 'báo-cáo.txt', contentBase64: content.toString('base64'),
      }),
      sharedFiles(ctx, 'upload', { id: '42', actor }, {
        key, filename: 'báo-cáo.txt', contentBase64: content.toString('base64'),
      }),
    ]);
    expect([up1.status, up2.status].sort()).toEqual([200, 201]);
    const fileId = (up1.data as { fileId: string }).fileId;
    expect(up1.data).toEqual({ fileId, filename: 'báo-cáo.txt', size: content.length, scanStatus: 'clean' });
    expect(up2.data).toEqual(up1.data);
    expect(scan).toHaveBeenCalledTimes(1);

    // Mismatched replay rejects 409 without re-scanning
    await expect(
      sharedFiles(ctx, 'upload', { id: '42', actor }, {
        key, filename: 'khác.txt', contentBase64: content.toString('base64'),
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(scan).toHaveBeenCalledTimes(1);

    // List and download by reviewer in same organization/request
    const listed = await sharedFiles(ctx, 'list', { id: '42', actor: reviewer }, { limit: 20, offset: 0 });
    expect(listed.data).toEqual([{ fileId, filename: 'báo-cáo.txt', size: content.length, scanStatus: 'clean' }]);

    const downloaded = await sharedFiles(ctx, 'download', { id: '42', actor: reviewer }, { fileId });
    expect(downloaded.content).toEqual(content);
    expect(downloaded.disposition).toBe(`attachment; filename*=UTF-8''${encodeURIComponent('báo-cáo.txt')}`);

    // Cross-request or cross-org download returns 404
    await expect(
      sharedFiles(ctx, 'download', { id: '43', actor: reviewer }, { fileId }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      sharedFiles(ctx, 'download', { id: '42', actor: { organizationId: 'org-b', userId: '99' } }, { fileId }),
    ).rejects.toMatchObject({ status: 404 });
  });

  test('enforces > 1 MiB file limit (413) and > 1,450,000 byte body limit (413)', async () => {
    const { sendRaw } = await setupS3Scanner();
    const bigFile = makeEnvelope({
      operation: 'upload',
      key: randomUUID(),
      filename: 'big.bin',
      contentBase64: Buffer.alloc(1_048_577, 1).toString('base64'),
    });
    const res413 = await sendRaw(JSON.stringify(bigFile));
    expect(res413.status).toBe(413);

    const hugeBody = 'x'.repeat(1_450_001);
    const body413 = await sendRaw(hugeBody);
    expect(body413.status).toBe(413);
  });

  test('filesystem fallback stores atomically with O_CREAT|O_EXCL and verifies integrity on download', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'dx-scanner-fs-')));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));

    await expect(createFilesystemBackend('.')).rejects.toThrow();
    const linkPath = join(dir, 'link-root');
    await symlink(dir, linkPath, 'junction');
    await expect(createFilesystemBackend(linkPath)).rejects.toThrow();
    await unlink(linkPath);

    const backend = await createFilesystemBackend(dir);
    const app = createFileScannerServer({
      secret: SECRET,
      instance: INSTANCE,
      storage: { kind: 'filesystem', backend },
      scan: async () => 'clean',
    });
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    cleanups.push(() => app.close());

    const sharedFiles = createNativeSharedFiles({ url, secret: SECRET, instance: INSTANCE });
    const ctx = {
      throw(status: number, message: string): never {
        const err = new Error(message) as Error & { status: number };
        err.status = status;
        throw err;
      },
    };
    const key = randomUUID();
    const payload = Buffer.from('filesystem payload');
    const uploaded = await sharedFiles(ctx, 'upload', { id: '9', actor: { organizationId: 'org-fs', userId: '5' } }, {
      key, filename: 'fs.txt', contentBase64: payload.toString('base64'),
    });
    const fileId = (uploaded.data as { fileId: string }).fileId;
    const downloaded = await sharedFiles(ctx, 'download', { id: '9', actor: { organizationId: 'org-fs', userId: '5' } }, { fileId });
    expect(downloaded.content).toEqual(payload);

    // Tampering blob on disk fails closed with 503
    await writeFile(join(dir, 'blobs', INSTANCE, 'org-fs', '9', fileId), 'tampered');
    await expect(
      sharedFiles(ctx, 'download', { id: '9', actor: { organizationId: 'org-fs', userId: '5' } }, { fileId }),
    ).rejects.toMatchObject({ status: 503 });

    // Corrupt metadata shape (non-string filename / non-integer size) fails closed with 503
    await writeFile(
      join(dir, 'meta', INSTANCE, 'org-fs', '9', `${fileId}.json`),
      JSON.stringify({ fileId, filename: 123, size: 1.5, digest: 'a'.repeat(64), scanStatus: 'clean' }),
    );
    await expect(
      sharedFiles(ctx, 'download', { id: '9', actor: { organizationId: 'org-fs', userId: '5' } }, { fileId }),
    ).rejects.toMatchObject({ status: 503 });
  });

  test('rejects invalid listen port and validates filenames, keys, base64, pagination, and unknown operations with 400', async () => {
    const { app, sendRaw } = await setupS3Scanner();
    for (const badPort of [-1, 65536, 1.5, Number.NaN]) {
      await expect(app.listen({ host: '127.0.0.1', port: badPort })).rejects.toThrow('Invalid file scanner port');
    }
    for (const invalid of [
      makeEnvelope({ operation: 'delete' }),
      makeEnvelope({ operation: 'list', limit: 0, offset: 0 }),
      makeEnvelope({ operation: 'list', limit: 51, offset: 0 }),
      makeEnvelope({ operation: 'list', limit: 10, offset: -1 }),
      makeEnvelope({ operation: 'download', fileId: 'not-a-uuid' }),
      makeEnvelope({ operation: 'upload', key: 'bad', filename: 'ok.txt', contentBase64: 'YQ==' }),
      makeEnvelope({ operation: 'upload', key: randomUUID(), filename: '../escape.txt', contentBase64: 'YQ==' }),
      makeEnvelope({ operation: 'upload', key: randomUUID(), filename: 'bad\\name.txt', contentBase64: 'YQ==' }),
      makeEnvelope({ operation: 'upload', key: randomUUID(), filename: '   ', contentBase64: 'YQ==' }),
      makeEnvelope({ operation: 'upload', key: randomUUID(), filename: 'ok.txt', contentBase64: 'not*base64!' }),
    ]) {
      const res = await sendRaw(JSON.stringify(invalid));
      expect(res.status).toBe(400);
    }
  });
});
