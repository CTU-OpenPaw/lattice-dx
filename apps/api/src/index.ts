// SPDX-License-Identifier: Apache-2.0
import { createApi } from './app.js';
import { createRemoteJWKSet } from 'jose';
import { connectRecords } from './database.js';
import { scanWithClamd } from './scanner.js';
import { sendHttpEvent, startOutboxWorker } from './workflows/outbox.js';
const database = process.env.DATABASE_URL ? await connectRecords(process.env.DATABASE_URL) : undefined;
const identity = process.env.OIDC_ISSUER && process.env.OIDC_JWKS_URL ? {
  issuer: process.env.OIDC_ISSUER,
  audience: process.env.OIDC_AUDIENCE ?? 'dx-api',
  key: createRemoteJWKSet(new URL(process.env.OIDC_JWKS_URL)),
} : undefined;
const app = createApi({ workerUrl: process.env.WORKER_URL ?? 'http://127.0.0.1:4001', identity, records: database?.repository,foundation:database?.foundation,
  directory:database?.directory,workflows:database?.workflows,readSharedFile:database?.workflows.readSharedFile,
  scan:process.env.CLAMD_HOST ? content=>scanWithClamd(content,process.env.CLAMD_HOST!,Number(process.env.CLAMD_PORT??3310)):undefined });
const eventUrl=process.env.WORKFLOW_EVENT_URL,eventToken=process.env.WORKFLOW_EVENT_TOKEN;
if(eventUrl&&(!eventToken||!['http:','https:'].includes(new URL(eventUrl).protocol)))throw new Error('Workflow connector URL/token configuration invalid.');
const outbox=database&&eventUrl&&eventToken?startOutboxWorker(database.jobs,job=>sendHttpEvent(job,eventUrl,eventToken)):undefined;
if (database) app.addHook('onClose', async () => {await outbox?.stop();await database.close();});
await app.listen({ host: process.env.API_HOST ?? '127.0.0.1', port: Number(process.env.API_PORT ?? 4000) });
console.log(`API listening on port ${process.env.API_PORT ?? 4000}`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void app.close().then(() => process.exit(0)); });
}
