// SPDX-License-Identifier: Apache-2.0
import { createWorker } from './app.js';
const app = createWorker();
await app.listen({ host: '127.0.0.1', port: Number(process.env.WORKER_PORT ?? 4001) });
console.log(`Agent worker listening on port ${process.env.WORKER_PORT ?? 4001} (demo mode)`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void app.close().then(() => process.exit(0)); });
}
