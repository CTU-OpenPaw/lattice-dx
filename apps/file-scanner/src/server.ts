/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, unlink } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { RustfsS3Client } from './s3-rustfs.js';

export const MAX_BODY_BYTES = 1_450_000;
export const MAX_FILE_BYTES = 1_048_576;
export const MAX_NONCES = 10_000;
export const NONCE_WINDOW_MS = 15_000;

const UUID_RE = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const NAME_RE = /^[A-Za-z0-9_-]{1,80}$/;
const DECIMAL_RE = /^[1-9]\d{0,18}$/;
const HEX64_RE = /^[a-f0-9]{64}$/;

export interface NativeScope {
  instance: string;
  organizationId: string;
  requestId: string;
  userId: string;
}

export interface NativeFileItem {
  fileId: string;
  filename: string;
  size: number;
  scanStatus: 'clean';
}

interface FileMetaRecord extends NativeFileItem {
  digest: string;
  uploaderId: string;
  uploadKey: string;
  createdAt: number;
}

interface IdempotencyRecord extends NativeFileItem {
  digest: string;
}

export interface NativeStorageBackend {
  findUploaded(scope: NativeScope, idempotencyKey: string): Promise<IdempotencyRecord | undefined>;
  saveCleanFile(
    scope: NativeScope,
    idempotencyKey: string,
    filename: string,
    content: Buffer,
    digest: string,
  ): Promise<{ status: 200 | 201; file: NativeFileItem } | { conflict: true }>;
  listFiles(scope: NativeScope, limit: number, offset: number): Promise<NativeFileItem[]>;
  downloadFile(
    scope: NativeScope,
    fileId: string,
  ): Promise<{ kind: 'ok'; filename: string; content: Buffer } | { kind: 'missing' } | { kind: 'rejected' } | { kind: 'corrupt' }>;
}

export class NonceReplayCache {
  private readonly entries = new Map<string, number>();

  constructor(
    private readonly maxSize = MAX_NONCES,
    private readonly windowMs = NONCE_WINDOW_MS,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  accept(nonce: string, at: number, now = Date.now()): boolean {
    const key = nonce.toLowerCase();
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      if (existing >= now) {
        return false;
      }
      this.entries.delete(key);
    }

    if (this.entries.size >= this.maxSize) {
      for (const [k, exp] of this.entries) {
        if (exp < now) this.entries.delete(k);
      }
      while (this.entries.size >= this.maxSize) {
        const oldest = this.entries.keys().next().value;
        if (oldest === undefined) break;
        this.entries.delete(oldest);
      }
    }

    this.entries.set(key, at + this.windowMs);
    return true;
  }
}

function sha256Hex(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function scopePrefix(scope: NativeScope): string {
  return `${scope.instance}/${scope.organizationId}/${scope.requestId}`;
}

function metaKey(scope: NativeScope, fileId: string): string {
  return `meta/${scopePrefix(scope)}/${fileId.toLowerCase()}.json`;
}

function blobKey(scope: NativeScope, fileId: string): string {
  return `blobs/${scopePrefix(scope)}/${fileId.toLowerCase()}`;
}

function idemKey(scope: NativeScope, idempotencyKey: string): string {
  return `idem/${scopePrefix(scope)}/${scope.userId}/${idempotencyKey.toLowerCase()}.json`;
}

function toFileItem(record: NativeFileItem): NativeFileItem {
  return {
    fileId: record.fileId,
    filename: record.filename,
    size: record.size,
    scanStatus: record.scanStatus,
  };
}

function parseJsonSafe<T>(raw: Buffer): T | undefined {
  try {
    return JSON.parse(raw.toString('utf8')) as T;
  } catch {
    return undefined;
  }
}

function isValidMetaRecord(meta: unknown): meta is FileMetaRecord {
  if (!meta || typeof meta !== 'object') return false;
  const record = meta as Partial<FileMetaRecord>;
  return (
    typeof record.filename === 'string' &&
    record.filename.length > 0 &&
    typeof record.size === 'number' &&
    Number.isInteger(record.size) &&
    record.size >= 0 &&
    record.size <= MAX_FILE_BYTES &&
    typeof record.digest === 'string' &&
    HEX64_RE.test(record.digest)
  );
}

export function createS3Backend(client: RustfsS3Client): NativeStorageBackend {
  async function findUploaded(scope: NativeScope, idempotencyKey: string): Promise<IdempotencyRecord | undefined> {
    const raw = await client.getObject(idemKey(scope, idempotencyKey));
    if (!raw) return undefined;
    return parseJsonSafe<IdempotencyRecord>(raw);
  }
  return {
    findUploaded,
    async saveCleanFile(scope, idempotencyKey, filename, content, digest) {
      const fileId = randomUUID();
      await client.putObject(blobKey(scope, fileId), content, 'application/octet-stream');
      const idemRecord: IdempotencyRecord = {
        fileId,
        filename,
        size: content.length,
        scanStatus: 'clean',
        digest,
      };
      const putIdem = await client.putObject(
        idemKey(scope, idempotencyKey),
        JSON.stringify(idemRecord),
        'application/json',
        { ifNoneMatch: '*' },
      );
      if (putIdem === 'precondition_failed') {
        const existing = await findUploaded(scope, idempotencyKey);
        if (!existing || existing.filename !== filename || existing.digest !== digest) {
          return { conflict: true };
        }
        return { status: 200, file: toFileItem(existing) };
      }
      const metaRecord: FileMetaRecord = {
        ...idemRecord,
        uploaderId: scope.userId,
        uploadKey: idempotencyKey.toLowerCase(),
        createdAt: Date.now(),
      };
      await client.putObject(metaKey(scope, fileId), JSON.stringify(metaRecord), 'application/json');
      return { status: 201, file: toFileItem(metaRecord) };
    },
    async listFiles(scope, limit, offset) {
      const keys = await client.listKeys(`meta/${scopePrefix(scope)}/`);
      const records: FileMetaRecord[] = [];
      for (const key of keys) {
        if (!key.endsWith('.json')) continue;
        const raw = await client.getObject(key);
        if (!raw) continue;
        const parsed = parseJsonSafe<FileMetaRecord>(raw);
        if (parsed && UUID_RE.test(parsed.fileId)) {
          records.push(parsed);
        }
      }
      records.sort((a, b) => (a.createdAt - b.createdAt) || a.fileId.localeCompare(b.fileId));
      return records.slice(offset, offset + limit).map(toFileItem);
    },
    async downloadFile(scope, fileId) {
      const rawMeta = await client.getObject(metaKey(scope, fileId));
      if (!rawMeta) return { kind: 'missing' };
      const meta = parseJsonSafe<unknown>(rawMeta);
      if (!isValidMetaRecord(meta)) return { kind: 'corrupt' };
      if (meta.scanStatus !== 'clean') return { kind: 'rejected' };

      const content = await client.getObject(blobKey(scope, fileId));
      if (
        !content ||
        content.length !== meta.size ||
        content.length > MAX_FILE_BYTES ||
        sha256Hex(content) !== meta.digest
      ) {
        return { kind: 'corrupt' };
      }
      return { kind: 'ok', filename: meta.filename, content };
    },
  };
}

const normalizePath = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);

function sameStat(a: Stats, b: Stats): void {
  if (a.dev !== b.dev || a.ino !== b.ino || !b.isFile() || b.isSymbolicLink()) {
    throw new Error('Object identity changed');
  }
}

async function readVerifiedFile(fullPath: string): Promise<Buffer | undefined> {
  let handle;
  try {
    handle = await open(fullPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
    throw error;
  }

  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.isSymbolicLink() || opened.size > MAX_FILE_BYTES) {
      throw new Error('Unsafe object');
    }
    if (normalizePath(await realpath(fullPath)) !== normalizePath(fullPath)) {
      throw new Error('Unsafe object resolution');
    }
    const content = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < opened.size) {
      const { bytesRead } = await handle.read(content, offset, opened.size - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== opened.size) {
      throw new Error('Truncated object read');
    }
    sameStat(opened, await handle.stat());
    sameStat(opened, await lstat(fullPath));
    return content;
  } finally {
    await handle.close();
  }
}

async function writeExclusiveFile(fullPath: string, data: Buffer): Promise<'created' | 'exists'> {
  await mkdir(dirname(fullPath), { recursive: true });
  let handle;
  try {
    handle = await open(
      fullPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') return 'exists';
    throw error;
  }

  try {
    let offset = 0;
    while (offset < data.length) {
      const { bytesWritten } = await handle.write(data, offset, data.length - offset);
      offset += bytesWritten;
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  return 'created';
}

export async function createFilesystemBackend(root: string): Promise<NativeStorageBackend> {
  if (!isAbsolute(root) || resolve(root) !== root) {
    throw new Error('FILE_STORAGE_ROOT must be absolute and canonical');
  }
  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('FILE_STORAGE_ROOT must be a non-symlink directory');
  }
  if (normalizePath(await realpath(root)) !== normalizePath(root)) {
    throw new Error('FILE_STORAGE_ROOT resolution changed');
  }

  const resolveKey = (rel: string) => join(root, ...rel.split('/'));

  async function findUploaded(scope: NativeScope, idempotencyKey: string): Promise<IdempotencyRecord | undefined> {
    const raw = await readVerifiedFile(resolveKey(idemKey(scope, idempotencyKey)));
    if (!raw) return undefined;
    return parseJsonSafe<IdempotencyRecord>(raw);
  }

  return {
    findUploaded,
    async saveCleanFile(scope, idempotencyKey, filename, content, digest) {
      const fileId = randomUUID();
      const blobPath = resolveKey(blobKey(scope, fileId));
      const blobStatus = await writeExclusiveFile(blobPath, content);
      if (blobStatus === 'exists') {
        throw new Error('Generated fileId collision');
      }

      const idemRecord: IdempotencyRecord = {
        fileId,
        filename,
        size: content.length,
        scanStatus: 'clean',
        digest,
      };
      const idemStatus = await writeExclusiveFile(
        resolveKey(idemKey(scope, idempotencyKey)),
        Buffer.from(JSON.stringify(idemRecord), 'utf8'),
      );
      if (idemStatus === 'exists') {
        await unlink(blobPath).catch(() => undefined);
        const existing = await findUploaded(scope, idempotencyKey);
        if (!existing || existing.filename !== filename || existing.digest !== digest) {
          return { conflict: true };
        }
        return { status: 200, file: toFileItem(existing) };
      }

      const metaRecord: FileMetaRecord = {
        ...idemRecord,
        uploaderId: scope.userId,
        uploadKey: idempotencyKey.toLowerCase(),
        createdAt: Date.now(),
      };
      await writeExclusiveFile(
        resolveKey(metaKey(scope, fileId)),
        Buffer.from(JSON.stringify(metaRecord), 'utf8'),
      );
      return { status: 201, file: toFileItem(metaRecord) };
    },
    async listFiles(scope, limit, offset) {
      const metaDir = resolveKey(`meta/${scopePrefix(scope)}`);
      let entries: string[];
      try {
        entries = await readdir(metaDir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
        throw error;
      }

      const records: FileMetaRecord[] = [];
      for (const entry of entries) {
        if (!entry.endsWith('.json')) continue;
        const raw = await readVerifiedFile(join(metaDir, entry));
        if (!raw) continue;
        const parsed = parseJsonSafe<FileMetaRecord>(raw);
        if (parsed && UUID_RE.test(parsed.fileId)) {
          records.push(parsed);
        }
      }
      records.sort((a, b) => (a.createdAt - b.createdAt) || a.fileId.localeCompare(b.fileId));
      return records.slice(offset, offset + limit).map(toFileItem);
    },
    async downloadFile(scope, fileId) {
      const rawMeta = await readVerifiedFile(resolveKey(metaKey(scope, fileId)));
      if (!rawMeta) return { kind: 'missing' };
      const meta = parseJsonSafe<unknown>(rawMeta);
      if (!isValidMetaRecord(meta)) return { kind: 'corrupt' };
      if (meta.scanStatus !== 'clean') return { kind: 'rejected' };

      let content: Buffer | undefined;
      try {
        content = await readVerifiedFile(resolveKey(blobKey(scope, fileId)));
      } catch {
        return { kind: 'corrupt' };
      }
      if (
        !content ||
        content.length !== meta.size ||
        content.length > MAX_FILE_BYTES ||
        sha256Hex(content) !== meta.digest
      ) {
        return { kind: 'corrupt' };
      }
      return { kind: 'ok', filename: meta.filename, content };
    },
  };
}

export interface FileScannerServerOptions {
  secret: string;
  instance: string;
  storage:
    | { kind: 's3'; client: RustfsS3Client }
    | { kind: 'filesystem'; backend: NativeStorageBackend };
  scan: (content: Buffer) => Promise<'clean' | 'rejected'>;
  now?: () => number;
  otelEndpoint?: string;
}

const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;
const ZERO_TRACE_ID = '0'.repeat(32);
const ZERO_SPAN_ID = '0'.repeat(16);

function parseTraceparentHeader(raw: string | string[] | undefined): { traceId: string; parentSpanId: string; traceFlags: string } | null {
  const val = Array.isArray(raw) ? raw[0] : raw;
  if (typeof val !== 'string') return null;
  const match = val.trim().match(TRACEPARENT_RE);
  if (!match) return null;
  const version = match[1].toLowerCase();
  const traceId = match[2].toLowerCase();
  const parentSpanId = match[3].toLowerCase();
  const traceFlags = match[4].toLowerCase();
  if (version === 'ff' || traceId === ZERO_TRACE_ID || parentSpanId === ZERO_SPAN_ID) return null;
  return { traceId, parentSpanId, traceFlags };
}

function resolveOtlpTracesUrl(raw?: string): string {
  const trimmed = String(raw ?? '').trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  try {
    const u = new URL(trimmed);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
  } catch {
    return '';
  }
  return trimmed.endsWith('/v1/traces') ? trimmed : `${trimmed}/v1/traces`;
}

function pushFileScannerSpan(tracesUrl: string, span: {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  method: string;
  path: string;
  statusCode: number;
  startUnixNano: bigint;
  endUnixNano: bigint;
}) {
  if (!tracesUrl || typeof globalThis.fetch !== 'function') return;
  const payload = {
    resourceSpans: [
      {
        resource: {
          attributes: [{ key: 'service.name', value: { stringValue: 'latticedx-file-scanner' } }],
        },
        scopeSpans: [
          {
            scope: { name: '@dx/file-scanner', version: '1.0.0' },
            spans: [
              {
                traceId: span.traceId,
                spanId: span.spanId,
                ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
                name: `HTTP ${span.method} ${span.path}`,
                kind: 2,
                startTimeUnixNano: span.startUnixNano.toString(),
                endTimeUnixNano: span.endUnixNano.toString(),
                attributes: [
                  { key: 'http.request.method', value: { stringValue: span.method } },
                  { key: 'url.path', value: { stringValue: span.path } },
                  { key: 'http.response.status_code', value: { intValue: String(span.statusCode) } },
                ],
                status: { code: span.statusCode >= 500 ? 2 : 1 },
              },
            ],
          },
        ],
      },
    ],
  };
  void globalThis.fetch(tracesUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(2000),
  }).catch(() => {});
}

const MAX_DRAIN_BYTES = 8 * 1024 * 1024;
const DRAIN_TIMEOUT_MS = 2000;

class BodyLimitError extends Error {
  constructor() {
    super('Body exceeds limit');
  }
}

function drainOversizedRequest(
  req: IncomingMessage,
  alreadyRead: number,
  maxDrainBytes: number,
  timeoutMs: number,
): Promise<void> {
  if (req.complete) return Promise.resolve();
  return new Promise((resolve) => {
    let drained = alreadyRead;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      req.off('data', onData);
      req.off('end', done);
      req.off('close', done);
      req.off('error', done);
    };

    const done = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };

    const onData = (chunk: Buffer | string) => {
      drained += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;
      if (drained > maxDrainBytes) {
        done();
      }
    };

    timer = setTimeout(done, timeoutMs);
    timer.unref?.();

    req.on('data', onData);
    req.on('end', done);
    req.on('close', done);
    req.on('error', done);
    req.resume();
  });
}

async function readRequestBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  const contentLength = req.headers['content-length'];
  if (typeof contentLength === 'string') {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > maxBytes) {
      if (declared <= MAX_DRAIN_BYTES) {
        await drainOversizedRequest(req, 0, MAX_DRAIN_BYTES, DRAIN_TIMEOUT_MS);
      } else {
        req.resume();
      }
      throw new BodyLimitError();
    }
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
    };

    const onData = (chunk: Buffer | string) => {
      if (settled) return;
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      total += buf.byteLength;
      if (total > maxBytes) {
        settled = true;
        chunks.length = 0;
        cleanup();
        const finish = () => reject(new BodyLimitError());
        if (req.complete) {
          finish();
        } else {
          void drainOversizedRequest(req, total, MAX_DRAIN_BYTES, DRAIN_TIMEOUT_MS).then(finish);
        }
        return;
      }
      chunks.push(buf);
    };

    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks).toString('utf8'));
    };

    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

function sendJson(
  res: ServerResponse,
  statusCode: number,
  payload: unknown,
  headers: Record<string, string> = {},
): void {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    ...headers,
  });
  res.end(body);
}

export function createFileScannerServer(options: FileScannerServerOptions) {
  if (!HEX64_RE.test(options.secret.toLowerCase()) || !NAME_RE.test(options.instance)) {
    throw new Error('Invalid native file service configuration');
  }
  const secretKey = Buffer.from(options.secret, 'hex');
  const backend: NativeStorageBackend =
    options.storage.kind === 's3' ? createS3Backend(options.storage.client) : options.storage.backend;
  const nonces = new NonceReplayCache(MAX_NONCES, NONCE_WINDOW_MS);
  const now = options.now ?? Date.now;
  const keyLocks = new Map<string, Promise<unknown>>();
  const otlpTracesUrl = resolveOtlpTracesUrl(options.otelEndpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT);

  async function withUploadLock<T>(lockKey: string, work: () => Promise<T>): Promise<T> {
    const previous = keyLocks.get(lockKey);
    const current = (previous ?? Promise.resolve()).catch(() => undefined).then(work);
    const tracked = current
      .finally(() => {
        if (keyLocks.get(lockKey) === tracked) {
          keyLocks.delete(lockKey);
        }
      })
      .catch(() => undefined);
    keyLocks.set(lockKey, tracked);
    return current;
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = (req.method ?? 'GET').toUpperCase();
    const path = (req.url ?? '/').split('?')[0];
    const incomingTrace = parseTraceparentHeader(req.headers.traceparent);
    const traceId = incomingTrace ? incomingTrace.traceId : randomBytes(16).toString('hex');
    const spanId = randomBytes(8).toString('hex');
    const traceFlags = incomingTrace ? incomingTrace.traceFlags : '01';
    const traceparent = `00-${traceId}-${spanId}-${traceFlags}`;
    res.setHeader('traceparent', traceparent);

    if (otlpTracesUrl) {
      const startUnixNano = BigInt(Date.now()) * 1_000_000n;
      const startHr = process.hrtime.bigint();
      res.once('finish', () => {
        const elapsedNs = process.hrtime.bigint() - startHr;
        pushFileScannerSpan(otlpTracesUrl, {
          traceId,
          spanId,
          parentSpanId: incomingTrace?.parentSpanId,
          method,
          path,
          statusCode: res.statusCode,
          startUnixNano,
          endUnixNano: startUnixNano + (elapsedNs >= 0n ? elapsedNs : 0n),
        });
      });
    }

    if (method === 'GET' && path === '/health') {
      sendJson(res, 200, { status: 'ok', service: 'file-scanner' });
      return;
    }

    if (method !== 'POST' || path !== '/internal/native-request-files') {
      sendJson(res, 404, { error: 'Not Found' });
      return;
    }

    let raw: string;
    try {
      raw = await readRequestBody(req, MAX_BODY_BYTES);
    } catch (error) {
      if (error instanceof BodyLimitError) {
        sendJson(res, 413, { error: 'Giới hạn tệp 1 MiB.' }, { connection: 'close' });
        return;
      }
      throw error;
    }

    const signature = req.headers['x-dx-native-signature'];
    if (
      typeof signature !== 'string' ||
      !HEX64_RE.test(signature) ||
      !timingSafeEqual(Buffer.from(signature, 'hex'), createHmac('sha256', secretKey).update(raw).digest())
    ) {
      sendJson(res, 401, { error: 'Yêu cầu nội bộ không hợp lệ.' });
      return;
    }

    let input: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        sendJson(res, 400, { error: 'Yêu cầu nội bộ không hợp lệ.' });
        return;
      }
      input = parsed as Record<string, unknown>;
    } catch {
      sendJson(res, 400, { error: 'Yêu cầu nội bộ không hợp lệ.' });
      return;
    }

    const currentTime = now();
    if (
      typeof input.at !== 'number' ||
      !Number.isSafeInteger(input.at) ||
      Math.abs(currentTime - input.at) > NONCE_WINDOW_MS ||
      typeof input.nonce !== 'string' ||
      !UUID_RE.test(input.nonce)
    ) {
      sendJson(res, 401, { error: 'Yêu cầu nội bộ đã hết hạn.' });
      return;
    }

    const { operation, organizationId, requestId, userId } = input;
    if (
      input.instance !== options.instance ||
      typeof organizationId !== 'string' ||
      !NAME_RE.test(organizationId) ||
      typeof requestId !== 'string' ||
      !DECIMAL_RE.test(requestId) ||
      typeof userId !== 'string' ||
      !DECIMAL_RE.test(userId)
    ) {
      sendJson(res, 400, { error: 'Phạm vi tệp không hợp lệ.' });
      return;
    }

    if (!nonces.accept(input.nonce, input.at, currentTime)) {
      sendJson(res, 401, { error: 'Yêu cầu nội bộ đã được sử dụng.' });
      return;
    }

    const scope: NativeScope = {
      instance: options.instance,
      organizationId,
      requestId,
      userId,
    };
    const cacheHeaders = { 'cache-control': 'private, no-store' };

    if (operation === 'list') {
      const { limit, offset } = input;
      if (
        typeof limit !== 'number' ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 50 ||
        typeof offset !== 'number' ||
        !Number.isInteger(offset) ||
        offset < 0 ||
        offset > 999_999
      ) {
        sendJson(res, 400, { error: 'Phân trang không hợp lệ.' }, cacheHeaders);
        return;
      }
      try {
        const files = await backend.listFiles(scope, limit, offset);
        sendJson(res, 200, files, cacheHeaders);
      } catch {
        sendJson(res, 503, { error: 'Dịch vụ tệp chưa sẵn sàng.' }, cacheHeaders);
      }
      return;
    }

    if (operation === 'download') {
      if (typeof input.fileId !== 'string' || !UUID_RE.test(input.fileId)) {
        sendJson(res, 400, { error: 'Mã tệp không hợp lệ.' }, cacheHeaders);
        return;
      }
      let result: Awaited<ReturnType<NativeStorageBackend['downloadFile']>>;
      try {
        result = await backend.downloadFile(scope, input.fileId);
      } catch {
        sendJson(res, 503, { error: 'file_storage_unavailable' }, cacheHeaders);
        return;
      }
      if (result.kind === 'missing') {
        sendJson(res, 404, { error: 'Không tìm thấy tệp.' }, cacheHeaders);
        return;
      }
      if (result.kind === 'rejected') {
        sendJson(res, 409, { error: 'Tệp chưa được phép sử dụng.' }, cacheHeaders);
        return;
      }
      if (result.kind === 'corrupt') {
        sendJson(res, 503, { error: 'file_storage_unavailable' }, cacheHeaders);
        return;
      }
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}`,
        'content-length': String(result.content.length),
        'x-content-type-options': 'nosniff',
        'cache-control': 'private, no-store',
      });
      res.end(result.content);
      return;
    }

    if (operation !== 'upload') {
      sendJson(res, 400, { error: 'Thao tác không hợp lệ.' }, cacheHeaders);
      return;
    }

    const { key, filename, contentBase64 } = input;
    if (
      typeof key !== 'string' ||
      !UUID_RE.test(key) ||
      typeof filename !== 'string' ||
      !filename.trim() ||
      filename.length > 200 ||
      /[\x00-\x1f\x7f/\\]/.test(filename) ||
      typeof contentBase64 !== 'string'
    ) {
      sendJson(res, 400, { error: 'Tệp hoặc khóa gửi lại không hợp lệ.' }, cacheHeaders);
      return;
    }

    try {
      encodeURIComponent(filename);
    } catch {
      sendJson(res, 400, { error: 'Tên tệp chứa Unicode không hợp lệ.' }, cacheHeaders);
      return;
    }

    const content = Buffer.from(contentBase64, 'base64');
    if (content.length > MAX_FILE_BYTES) {
      sendJson(res, 413, { error: 'Giới hạn tệp 1 MiB.' }, cacheHeaders);
      return;
    }
    if (!content.length || content.toString('base64') !== contentBase64) {
      sendJson(res, 400, { error: 'Base64 không hợp lệ.' }, cacheHeaders);
      return;
    }

    const normalizedName = filename.trim();
    const normalizedKey = key.toLowerCase();
    const digest = sha256Hex(content);
    const lockKey = `${scope.instance}\0${scope.organizationId}\0${scope.requestId}\0${scope.userId}\0${normalizedKey}`;

    const outcome = await withUploadLock(lockKey, async () => {
      try {
        const previous = await backend.findUploaded(scope, normalizedKey);
        if (previous) {
          if (previous.filename !== normalizedName || previous.digest !== digest) {
            return { statusCode: 409 as const, body: { error: 'Khóa gửi lại đã dùng cho tệp khác.' } };
          }
          return { statusCode: 200 as const, body: toFileItem(previous) };
        }
      } catch {
        return { statusCode: 503 as const, body: { error: 'Dịch vụ tệp chưa sẵn sàng.' } };
      }

      let scanOutcome: 'clean' | 'rejected';
      try {
        scanOutcome = await options.scan(content);
      } catch {
        return { statusCode: 503 as const, body: { error: 'Bộ quét tệp chưa sẵn sàng.' } };
      }
      if (scanOutcome !== 'clean') {
        return { statusCode: 409 as const, body: { error: 'Tệp bị bộ quét từ chối.' } };
      }

      try {
        const stored = await backend.saveCleanFile(scope, normalizedKey, normalizedName, content, digest);
        if ('conflict' in stored) {
          return { statusCode: 409 as const, body: { error: 'Khóa gửi lại đã dùng cho tệp khác.' } };
        }
        return { statusCode: stored.status, body: stored.file };
      } catch {
        return { statusCode: 503 as const, body: { error: 'Tệp chưa sẵn sàng. Vui lòng gửi lại.' } };
      }
    });

    sendJson(res, outcome.statusCode, outcome.body, cacheHeaders);
  }

  const server = createServer((req, res) => {
    void handleRequest(req, res).catch(() => {
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'Lỗi hệ thống nội bộ.' });
      }
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;

  return {
    listen(listenOptions: { host?: string; port: number }): Promise<string> {
      if (!Number.isInteger(listenOptions.port) || listenOptions.port < 0 || listenOptions.port > 65535) {
        return Promise.reject(new Error('Invalid file scanner port'));
      }
      const host = listenOptions.host ?? '0.0.0.0';
      return new Promise((resolvePromise, reject) => {
        const onError = (error: Error) => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.off('error', onError);
          const address = server.address();
          if (!address || typeof address === 'string') {
            resolvePromise(`http://${host}:${listenOptions.port}`);
            return;
          }
          const formatted = address.family === 'IPv6' ? `[${address.address}]` : address.address;
          resolvePromise(`http://${formatted}:${address.port}`);
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(listenOptions.port, host);
      });
    },
    close(): Promise<void> {
      if (!server.listening) return Promise.resolve();
      return new Promise((resolvePromise, reject) => {
        server.close((error) => (error ? reject(error) : resolvePromise()));
        server.closeIdleConnections?.();
      });
    },
  };
}
