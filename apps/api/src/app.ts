// SPDX-License-Identifier: Apache-2.0
import Fastify from 'fastify';
import { isDemoResult, parseDemoRequest } from '@dx/contracts';
import { verifyIdentity, type IdentityConfig } from './identity.js';
import type { RecordRepository } from './records.js';
import { registerFoundation, type FoundationOptions } from './foundation.js';
import { registerActions } from './actions.js';
import { registerDirectory } from './directory-routes.js';
import { registerWorkflows, type WorkflowOptions } from './workflows/routes.js';
import { registerLogistics } from './logistics.js';
import { isRecordId } from '@dx/contracts';
import { parsePage } from './pagination.js';
export function createApi(options: { workerUrl: string; timeoutMs?: number; identity?: IdentityConfig; records?: RecordRepository } & FoundationOptions & WorkflowOptions) {
  const app = Fastify({ bodyLimit: 16_384 });
  app.get('/health', async () => ({ status: 'ok', service: 'api' }));
  registerFoundation(app,options);
  registerActions(app,options);
  registerDirectory(app,options);
  registerWorkflows(app,options);
  registerLogistics(app,options);
  app.route({
    method: ['GET', 'POST'], url: '/v1/records',
    handler: async (request, reply) => {
      if (!options.identity || !options.records) return reply.code(503).send({ error: 'Records service chưa được cấu hình.' });
      let identity: Awaited<ReturnType<typeof verifyIdentity>>;
      try { identity = await verifyIdentity(request.headers.authorization, options.identity); }
      catch { return reply.code(401).send({ error: 'Token không hợp lệ.' }); }
      if (!identity.organizationId) return reply.code(403).send({ error: 'Token thiếu phạm vi đơn vị.' });
      const role = request.method === 'POST' ? 'records:write' : 'records:read';
      if (!identity.roles.includes(role)) return reply.code(403).send({ error: 'Không có quyền thực hiện tác vụ.' });
      if (request.method === 'GET') {
        const query=parsePage(request.query as Record<string,unknown>);
        if(options.records.listPage)return options.records.listPage(identity.subject,identity.organizationId,query);
        return { items: await options.records.list(identity.subject, identity.organizationId) };
      }
      const body: unknown = request.body;
      if (!body || typeof body !== 'object' || !('title' in body) || typeof body.title !== 'string' || !body.title.trim() || body.title.length > 200) {
        return reply.code(400).send({ error: 'Tiêu đề phải có từ 1 đến 200 ký tự.' });
      }
      return reply.code(201).send(await options.records.create(body.title.trim(), identity.subject, identity.organizationId));
    },
  });
  app.get<{Params:{id:string}}>('/v1/records/:id',async(request,reply)=>{
    if(!options.identity||!options.records)return reply.code(503).send({error:'Records service chưa cấu hình.'});
    let actor;try{actor=await verifyIdentity(request.headers.authorization,options.identity);}catch{return reply.code(401).send({error:'Token không hợp lệ.'});}
    if(!actor.organizationId||!actor.roles.includes('records:read'))return reply.code(403).send({error:'Không có quyền đọc.'});
    if(!isRecordId(request.params.id))return reply.code(400).send({error:'Record ID phải là UUID.'});
    const record=options.records.findReadable?await options.records.findReadable(request.params.id,actor.subject,actor.organizationId):await options.records.find?.(request.params.id,actor.subject,actor.organizationId);
    return record??reply.code(404).send({error:'Không tìm thấy bản ghi.'});
  });
  app.post('/v1/agent/demo', async (request, reply) => {
    const input = parseDemoRequest(request.body);
    if (!input) return reply.code(400).send({ error: 'Nhập yêu cầu từ 1 đến 2000 ký tự.' });
    try {
      const response = await fetch(new URL('/run', options.workerUrl), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input), signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
      });
      if (!response.ok) throw new Error('Worker request failed');
      const result: unknown = await response.json();
      if (!isDemoResult(result)) throw new Error('Invalid worker response');
      return result;
    } catch {
      return reply.code(503).send({ error: 'Agent worker chưa sẵn sàng. Vui lòng thử lại.' });
    }
  });
  return app;
}
