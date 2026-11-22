/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import {registerAgents,type AgentOptions} from './agents/routes.js';
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
import { registerEntityDataTools, type EntityDataToolsOptions } from './entities/data-tools-routes.js';
import {registerReports,type ReportsOptions} from './entities/reports-routes.js';
import {registerBlocks} from './blocks/routes.js';
import {registerOrganization,type OrganizationOptions} from './organization/routes.js';
import {registerOperations,type OperationsOptions} from './operations/routes.js';
import {correlationId} from './operations/policy.js';
import {createTelemetry,type StatusClass} from './operations/telemetry.js';
import {registerWorkflowEvents,type EventOptions} from './events/routes.js';
import {registerModules,type ModuleOptions} from './modules/routes.js';
import {registerAutomations,type AutomationOptions} from './automations/routes.js';
import {registerStudio} from './studio/routes.js';
import {registerContextLinks,type ContextLinksOptions} from './context-links/routes.js';
import {registerNgsiLd} from './ngsi-ld/routes.js';
import type {NgsiLdOptions} from './ngsi-ld/types.js';
import {registerAssetHandover,type HandoverOptions} from './ngsi-ld/handover.js';
import {registerSystems,type SystemOptions} from './systems/routes.js';

const MAX_RATE_LIMIT_KEYS = 10_000;
const DEFAULT_RATE_LIMIT_MAX = 1000;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;

interface RateWindow {
  windowStart: number;
  current: number;
  previous: number;
}

export function createRateLimiter(maxRequests = DEFAULT_RATE_LIMIT_MAX, windowMs = DEFAULT_RATE_LIMIT_WINDOW_MS) {
  const windows = new Map<string, RateWindow>();
  return {
    get size(): number {
      return windows.size;
    },
    check(ip: string, now = Date.now()) {
      const windowStart = Math.floor(now / windowMs) * windowMs;
      let entry = windows.get(ip);
      if (entry) {
        windows.delete(ip);
        windows.set(ip, entry);
        if (entry.windowStart === windowStart - windowMs) {
          entry.previous = entry.current;
          entry.current = 0;
          entry.windowStart = windowStart;
        } else if (entry.windowStart !== windowStart) {
          entry.previous = 0;
          entry.current = 0;
          entry.windowStart = windowStart;
        }
      } else {
        if (windows.size >= MAX_RATE_LIMIT_KEYS) {
          for (const [key, item] of windows) {
            if (now - item.windowStart >= windowMs * 2) windows.delete(key);
          }
          while (windows.size >= MAX_RATE_LIMIT_KEYS) {
            const oldest = windows.keys().next().value;
            if (oldest === undefined) break;
            windows.delete(oldest);
          }
        }
        entry = { windowStart, current: 0, previous: 0 };
        windows.set(ip, entry);
      }

      const elapsed = Math.max(0, now - windowStart);
      const weight = (windowMs - elapsed) / windowMs;
      const effective = Math.floor(entry.previous * weight) + entry.current;
      const reset = Math.ceil((windowStart + windowMs) / 1000);
      if (effective >= maxRequests) {
        const retryAfter = Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000));
        return { allowed: false as const, limit: maxRequests, remaining: 0, reset, retryAfter };
      }
      entry.current += 1;
      const remaining = Math.max(0, maxRequests - (Math.floor(entry.previous * weight) + entry.current));
      return { allowed: true as const, limit: maxRequests, remaining, reset };
    },
  };
}

function resolvePositiveInt(explicit: number | undefined, envValue: string | undefined, fallback: number): number {
  if (typeof explicit === 'number' && Number.isSafeInteger(explicit) && explicit >= 1) return explicit;
  if (envValue !== undefined && /^[1-9]\d{0,8}$/.test(envValue.trim())) return Number(envValue.trim());
  return fallback;
}

export function createApi(options: { workerUrl: string; timeoutMs?: number; rateLimitMax?: number; rateLimitWindowMs?: number; identity?: IdentityConfig; records?: RecordRepository } & FoundationOptions & WorkflowOptions & EntityOptions & TaskLifecycleOptions & OrganizationOptions & OperationsOptions & EventOptions & ModuleOptions & EntityDataToolsOptions & ReportsOptions & AutomationOptions & ContextLinksOptions & AgentOptions & NgsiLdOptions & HandoverOptions & SystemOptions) {
  const telemetry=options.telemetry??createTelemetry();
  const rateLimitMax = resolvePositiveInt(options.rateLimitMax, process.env.API_RATE_LIMIT_MAX, DEFAULT_RATE_LIMIT_MAX);
  const rateLimitWindowMs = resolvePositiveInt(options.rateLimitWindowMs, undefined, DEFAULT_RATE_LIMIT_WINDOW_MS);
  const rateLimiter = createRateLimiter(rateLimitMax, rateLimitWindowMs);
  const app = Fastify({ bodyLimit: 16_384,genReqId:()=>correlationId() });
  const templates=new Set(['/v1/operations/metrics','/v1/operations/queues','/v1/operations/diagnostics']);
  for(const route of templates)telemetry.registerRoute(route);
  app.addHook('onRoute',route=>{if(!templates.has(route.url)&&templates.size<128){templates.add(route.url);telemetry.registerRoute(route.url);}});
  const starts=new WeakMap<object,number>();
  app.addHook('onRequest',async (request, reply)=>{
    starts.set(request,performance.now());
    const verdict = rateLimiter.check(request.ip || 'unknown');
    reply.header('X-RateLimit-Limit', String(verdict.limit));
    reply.header('X-RateLimit-Remaining', String(verdict.remaining));
    reply.header('X-RateLimit-Reset', String(verdict.reset));
    if (!verdict.allowed) {
      reply.header('Retry-After', String(verdict.retryAfter));
      return reply.code(429).send({ error: 'Quá nhiều yêu cầu. Vui lòng thử lại sau.' });
    }
  });
  app.addHook('onResponse',async(request,reply)=>{
   const started=starts.get(request);if(started===undefined)return;starts.delete(request);
   telemetry.recordHttp(request.routeOptions.url??'unmatched',request.method,`${Math.min(5,Math.max(1,Math.floor(reply.statusCode/100)))}xx` as StatusClass,Math.max(0,performance.now()-started));
  });
  app.addHook('onSend', async (request, reply) => {
    reply.header('X-Request-Id', request.id);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  });
  app.setErrorHandler((error, _request, reply) => {
    const status = typeof error === 'object' && error && 'statusCode' in error && typeof error.statusCode === 'number'
      ? error.statusCode
      : 500;
    if (status >= 400 && status < 500) {
      const msg = error instanceof Error ? error.message : 'Yêu cầu không hợp lệ.';
      return reply.code(status).send({ error: msg });
    }
    return reply.code(500).send({ error: 'Lỗi hệ thống nội bộ.' });
  });
  app.get('/health', async () => ({ status: 'ok', service: 'api' }));
  registerOperations(app,{...options,telemetry,coreConfigured:!!(options.records&&options.foundation&&options.entities&&options.workflows),coreCapabilities:{records:!!options.records,foundation:!!options.foundation,entities:!!options.entities,workflows:!!options.workflows}});
  registerFoundation(app,options);
  registerTaskLifecycle(app,options);
  registerActions(app,options);
  registerDirectory(app,options);
  registerOrganization(app,options);
  registerWorkflows(app,options);
  registerAgents(app,options);
  registerWorkflowDrafts(app,options);
  registerWorkflowBundles(app,options);
  registerWorkflowEvents(app,options);
  registerAutomations(app,options);
  registerModules(app,options);
  registerStudio(app,options);
  registerContextLinks(app,options);
  registerNgsiLd(app,options);
  registerAssetHandover(app,options);
  registerSystems(app,options);
  registerLogistics(app,options);
  registerEntities(app,options);
  registerEntityDataTools(app,options);
  registerReports(app,options);
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
    if (!options.identity) return reply.code(503).send({ error: 'Identity service chưa được cấu hình.' });
    let identity: Awaited<ReturnType<typeof verifyIdentity>>;
    try { identity = await verifyIdentity(request.headers.authorization, options.identity); }
    catch { return reply.code(401).send({ error: 'Token không hợp lệ.' }); }
    if (!identity.organizationId) return reply.code(403).send({ error: 'Token thiếu phạm vi đơn vị.' });
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
