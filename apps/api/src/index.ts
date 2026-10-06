// SPDX-License-Identifier: Apache-2.0
import { createApi } from './app.js';
import { createRemoteJWKSet } from 'jose';
import { connectRecords } from './database.js';
const database = process.env.DATABASE_URL ? await connectRecords(process.env.DATABASE_URL) : undefined;
const identity = process.env.OIDC_ISSUER && process.env.OIDC_JWKS_URL ? {
  issuer: process.env.OIDC_ISSUER,
  audience: process.env.OIDC_AUDIENCE ?? 'dx-api',
  key: createRemoteJWKSet(new URL(process.env.OIDC_JWKS_URL)),
} : undefined;
const app = createApi({ workerUrl: process.env.WORKER_URL ?? 'http://127.0.0.1:4001', identity, records: database?.repository });
if (database) app.addHook('onClose', () => database.close());
await app.listen({ host: process.env.API_HOST ?? '127.0.0.1', port: Number(process.env.API_PORT ?? 4000) });
console.log(`API listening on port ${process.env.API_PORT ?? 4000}`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void app.close().then(() => process.exit(0)); });
}
