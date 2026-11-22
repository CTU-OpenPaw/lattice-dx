/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { createWorker } from './app.js';
const app = createWorker();
const host = process.env.WORKER_HOST ?? '127.0.0.1';
const port = Number(process.env.WORKER_PORT ?? 4001);
await app.listen({ host, port });
console.log(`Agent worker listening on ${host}:${port} (demo mode)`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void app.close().then(() => process.exit(0)); });
}
