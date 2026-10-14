// SPDX-License-Identifier: Apache-2.0
import { CreateCommandError,parseCreateKey,requireCreateCapability } from './create-command.js';
import Fastify from 'fastify';
import {registerTaskLifecycle,type TaskLifecycleOptions} from './tasks/routes.js';
import { isDemoResult, parseDemoRequest } from '@dx/contracts';
import { verifyIdentity, type IdentityConfig } from './identity.js';
import type { RecordRepository } from './records.js';
import { registerFoundation, type FoundationOptions } from './foundation.js';
import { registerActions } from './actions.js';
import { registerDirectory } from './directory-routes.js';
import { registerWorkflows, type WorkflowOptions } from './workflows/routes.js';
import { registerWorkflowBundles } from './workflows/bundle-routes.js';
import { registerWorkflowDrafts } from './workflows/registry-routes.js';
import { registerLogistics } from './logistics.js';
import { isRecordId,parseRecordCreateInput } from '@dx/contracts';
import { parsePage } from './pagination.js';
import { registerEntities, type EntityOptions } from './entities/routes.js';
import {registerBlocks} from './blocks/routes.js';
import {registerOrganization,type OrganizationOptions} from './organization/routes.js';
import {registerOperations,type OperationsOptions} from './operations/routes.js';
import {correlationId} from './operations/policy.js';
import {registerWorkflowEvents,type EventOptions} from './events/routes.js';
export function createApi(options: { workerUrl: string; timeoutMs?: number; identity?: IdentityConfig; records?: RecordRepository } & FoundationOptions & WorkflowOptions & EntityOptions & TaskLifecycleOptions & OrganizationOptions & OperationsOptions & EventOptions) {
  const app = Fastify({ bodyLimit: 16_384,genReqId:request=>correlationId(request.headers['x-request-id']) });
  app.addHook('onSend',async(request,reply)=>{reply.header('X-Request-Id',request.id);});
  app.get('/health', async () => ({ status: 'ok', service: 'api' }));
  registerOperations(app,{...options,coreConfigured:!!(options.records&&options.foundation&&options.entities&&options.workflows),coreCapabilities:{records:!!options.records,foundation:!!options.foundation,entities:!!options.entities,workflows:!!options.workflows}});
  registerFoundation(app,options);
  registerTaskLifecycle(app,options);
  registerActions(app,options);
  registerDirectory(app,options);
  registerOrganization(app,options);
  registerWorkflows(app,options);
  registerWorkflowDrafts(app,options);
  registerWorkflowBundles(app,options);
  registerWorkflowEvents(app,options);
  registerLogistics(app,options);
  registerEntities(app,options);
  registerBlocks(app,options);
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
      const input=parseRecordCreateInput(request.body);
      if(!input)return reply.code(400).send({error:'Input bản ghi không hợp lệ.'});
      try {
        const key=parseCreateKey(request.headers['idempotency-key'],request.raw.rawHeaders);
        requireCreateCapability(key,options.records);
        return reply.code(201).send(await options.records.create(input.title,identity.subject,identity.organizationId,key));
      } catch(error) {
        if(error instanceof CreateCommandError)return reply.code(error.statusCode).send({error:error.message});
        throw error;
      }
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
