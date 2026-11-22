/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
/// <reference types="node" />
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { parseDemoRequest, type DemoResult } from '@dx/contracts';

const BODY_LIMIT = 16_384;

export interface WorkerInjectOptions {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  payload?: unknown;
}

export interface WorkerInjectResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  json: <T = unknown>() => T;
}

interface RouteResponse {
  statusCode: number;
  body: unknown;
}

function dispatch(method: string, url: string, rawBody: string): RouteResponse {
  const path = url.split('?')[0];
  if (method === 'GET' && path === '/health') {
    return { statusCode: 200, body: { status: 'ok', service: 'agent-worker', mode: 'demo' } };
  }
  if (method === 'POST' && path === '/run') {
    let parsed: unknown;
    try {
      parsed = rawBody ? JSON.parse(rawBody) : undefined;
    } catch {
      return { statusCode: 400, body: { error: 'Nhập yêu cầu từ 1 đến 2000 ký tự.' } };
    }
    const input = parseDemoRequest(parsed);
    if (!input) {
      return { statusCode: 400, body: { error: 'Nhập yêu cầu từ 1 đến 2000 ký tự.' } };
    }
    const result: DemoResult = { mode: 'demo', summary: `Đã nhận yêu cầu: ${input.message}` };
    return { statusCode: 200, body: result };
  }
  return { statusCode: 404, body: { error: 'Not Found' } };
}

const MAX_DRAIN_BYTES = 512 * 1024;
const DRAIN_TIMEOUT_MS = 1500;

class PayloadTooLargeError extends Error {
  constructor() {
    super('Payload Too Large');
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

async function readRawBody(req: IncomingMessage, limit: number): Promise<string> {
  const contentLength = req.headers['content-length'];
  if (typeof contentLength === 'string') {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > limit) {
      if (declared <= MAX_DRAIN_BYTES) {
        await drainOversizedRequest(req, 0, MAX_DRAIN_BYTES, DRAIN_TIMEOUT_MS);
      } else {
        req.resume();
      }
      throw new PayloadTooLargeError();
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
      if (total > limit) {
        settled = true;
        chunks.length = 0;
        cleanup();
        const finish = () => reject(new PayloadTooLargeError());
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

function writeJson(res: ServerResponse, statusCode: number, payload: unknown, extraHeaders: Record<string, string> = {}): void {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    ...extraHeaders,
  });
  res.end(body);
}

export function createWorker() {
  const server = createServer(async (req, res) => {
    try {
      const method = (req.method ?? 'GET').toUpperCase();
      const url = req.url ?? '/';
      const rawBody = method === 'GET' || method === 'HEAD' ? '' : await readRawBody(req, BODY_LIMIT);
      const outcome = dispatch(method, url, rawBody);
      writeJson(res, outcome.statusCode, outcome.body);
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        writeJson(res, 413, { error: 'Payload Too Large' }, { connection: 'close' });
        return;
      }
      if (!res.headersSent) {
        writeJson(res, 500, { error: 'Internal Server Error' });
      }
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;

  return {
    listen(options: { host?: string; port: number }): Promise<string> {
      if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
        return Promise.reject(new Error('Invalid worker port'));
      }
      const host = options.host ?? '127.0.0.1';
      return new Promise((resolve, reject) => {
        const onError = (error: Error) => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.off('error', onError);
          const address = server.address();
          if (!address || typeof address === 'string') {
            resolve(`http://${host}:${options.port}`);
            return;
          }
          const formattedHost = address.family === 'IPv6' ? `[${address.address}]` : address.address;
          resolve(`http://${formattedHost}:${address.port}`);
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(options.port, host);
      });
    },
    close(): Promise<void> {
      if (!server.listening) return Promise.resolve();
      return new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeIdleConnections?.();
      });
    },
    async inject(options: WorkerInjectOptions): Promise<WorkerInjectResponse> {
      const method = (options.method ?? 'GET').toUpperCase();
      const rawBody = options.payload === undefined
        ? ''
        : typeof options.payload === 'string'
          ? options.payload
          : Buffer.isBuffer(options.payload)
            ? options.payload.toString('utf8')
            : JSON.stringify(options.payload);
      const outcome = Buffer.byteLength(rawBody, 'utf8') > BODY_LIMIT
        ? { statusCode: 413, body: { error: 'Payload Too Large' } }
        : dispatch(method, options.url, rawBody);
      const body = JSON.stringify(outcome.body);
      return {
        statusCode: outcome.statusCode,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'content-length': String(Buffer.byteLength(body)),
        },
        body,
        json: <T = unknown>() => JSON.parse(body) as T,
      };
    },
  };
}
