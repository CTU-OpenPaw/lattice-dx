/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { scanWithClamd } from './clamav.js';
import { createRustfsS3Client } from './s3-rustfs.js';
import { createFileScannerServer, createFilesystemBackend } from './server.js';

function parsePort(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === '') return fallback;
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid port configuration: ${name}`);
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid port configuration: ${name}`);
  }
  return parsed;
}

const secret = process.env.DX_NATIVE_FILES_SECRET;
const instance = process.env.DX_NATIVE_FILES_INSTANCE;
if (!secret || !instance) {
  throw new Error('DX_NATIVE_FILES_SECRET and DX_NATIVE_FILES_INSTANCE are required');
}

const clamdHost = process.env.CLAMD_HOST?.trim();
if (!clamdHost) {
  throw new Error('CLAMD_HOST is required');
}
const clamdPort = parsePort(process.env.CLAMD_PORT, 3310, 'CLAMD_PORT');

const provider = process.env.FILE_STORAGE_PROVIDER ?? (process.env.S3_ENDPOINT ? 's3' : 'filesystem');
if (provider !== 's3' && provider !== 'filesystem') {
  throw new Error('FILE_STORAGE_PROVIDER must be "s3" or "filesystem"');
}

const storage =
  provider === 's3'
    ? {
        kind: 's3' as const,
        client: createRustfsS3Client({
          endpoint: process.env.S3_ENDPOINT ?? '',
          accessKeyId: process.env.S3_ACCESS_KEY_ID ?? '',
          secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '',
          bucket: process.env.S3_BUCKET || undefined,
          region: process.env.S3_REGION || undefined,
        }),
      }
    : {
        kind: 'filesystem' as const,
        backend: await createFilesystemBackend(process.env.FILE_STORAGE_ROOT ?? '/var/lib/latticedx/objects'),
      };

const server = createFileScannerServer({
  secret,
  instance,
  storage,
  scan: (content) => scanWithClamd(content, clamdHost, clamdPort),
});

const host = process.env.FILE_SCANNER_HOST?.trim() || '0.0.0.0';
const port = parsePort(process.env.FILE_SCANNER_PORT ?? process.env.PORT, 4010, 'FILE_SCANNER_PORT');
await server.listen({ host, port });
console.log(`File scanner listening on ${host}:${port} (${provider})`);

let closing: Promise<void> | undefined;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    closing ??= server.close().then(
      () => {
        process.exitCode = 0;
      },
      () => {
        console.error('File scanner shutdown failed');
        process.exitCode = 1;
      },
    );
  });
}
