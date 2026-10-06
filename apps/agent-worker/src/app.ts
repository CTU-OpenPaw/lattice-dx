// SPDX-License-Identifier: Apache-2.0
import Fastify from 'fastify';
import { parseDemoRequest, type DemoResult } from '@dx/contracts';
export function createWorker() {
  const app = Fastify({ bodyLimit: 16_384 });
  app.get('/health', async () => ({ status: 'ok', service: 'agent-worker', mode: 'demo' }));
  app.post('/run', async (request, reply) => {
    const input = parseDemoRequest(request.body);
    if (!input) return reply.code(400).send({ error: 'Nhập yêu cầu từ 1 đến 2000 ký tự.' });
    const result: DemoResult = { mode: 'demo', summary: `Đã nhận yêu cầu: ${input.message}` };
    return result;
  });
  return app;
}
