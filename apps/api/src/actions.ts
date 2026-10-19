// SPDX-License-Identifier: Apache-2.0
import { CreateCommandError,parseCreateKey,requireCreateCapability } from './create-command.js';
import type { FastifyInstance } from 'fastify';
import {
  parseActionRunRequest, parseRecordCreateInput, parseTaskCreateInput,
  recordCreateSchema, taskCreateSchema,
  type ActionDescriptor, type ActionRunResult,
} from '@dx/contracts';
import { verifyIdentity, type IdentityConfig } from './identity.js';
import type { RecordRepository } from './records.js';
import type { FoundationRepository, Scope } from './foundation.js';
import { resolveRecordLink, RecordLinkError } from './record-link.js';
import { requireAssignee, DirectoryError, type DirectoryOptions } from './directory.js';

interface Options extends DirectoryOptions { identity?: IdentityConfig; records?: RecordRepository; foundation?: FoundationRepository }
interface RegisteredAction {
  descriptor: ActionDescriptor;
  available: boolean;
  execute(input: unknown, scope: Scope,key?:string): Promise<unknown>;
}
class InvalidInput extends Error {}

export const actionDescriptors: readonly ActionDescriptor[] = [
  { id: 'records.create', version: 1, title: 'Tạo bản ghi', requiredRole: 'records:write', inputSchema: recordCreateSchema },
  { id: 'tasks.create', version: 1, title: 'Tạo nhiệm vụ', requiredRole: 'tasks:assign', inputSchema: taskCreateSchema },
];

export function registerActions(app: FastifyInstance, options: Options) {
  const actions: RegisteredAction[] = [
    {
      descriptor: actionDescriptors[0],
      available: !!options.records,
      async execute(value, scope,key) {
        const input = parseRecordCreateInput(value);
        if (!input) throw new InvalidInput();
        requireCreateCapability(key,options.records!);
        return options.records!.create(input.title, scope.subject, scope.organizationId,key);
      },
    },
    {
      descriptor: actionDescriptors[1],
      available: !!options.foundation,
      async execute(value, scope,key) {
        const input = parseTaskCreateInput(value);
        if (!input) throw new InvalidInput();
        requireCreateCapability(key,options.foundation!);
        await requireAssignee(input.assigneeId,scope,options.directory);
        const recordId = await resolveRecordLink(input.recordId, scope, options.records);
        if (recordId) input.recordId = recordId;
        return options.foundation!.createTask({ ...input, organizationId: scope.organizationId, createdBy: scope.subject },key);
      },
    },
  ];
  app.register(async routes => {
    const identities = new WeakMap<object, Scope & { roles: string[] }>();
    routes.addHook('preHandler', async (request, reply) => {
      if (!options.identity) return reply.code(503).send({ error: 'Action identity chưa được cấu hình.' });
      let identity;
      try { identity = await verifyIdentity(request.headers.authorization, options.identity); }
      catch { return reply.code(401).send({ error: 'Token không hợp lệ.' }); }
      if (!identity.organizationId) return reply.code(403).send({ error: 'Token thiếu phạm vi đơn vị.' });
      identities.set(request, { subject: identity.subject, organizationId: identity.organizationId, roles: identity.roles });
    });
    routes.get('/v1/actions', async request => {
      const identity = identities.get(request)!;
      return { items: actions.filter(action => action.available && identity.roles.includes(action.descriptor.requiredRole)).map(action => action.descriptor) };
    });
    routes.post<{ Params: { id: string }; Body: unknown }>('/v1/actions/:id/run', async (request, reply) => {
      const identity = identities.get(request)!;
      const action = actions.find(candidate => candidate.descriptor.id === request.params.id);
      if (!action) return reply.code(404).send({ error: 'Action không tồn tại.' });
      if (!identity.roles.includes(action.descriptor.requiredRole)) return reply.code(403).send({ error: 'Không có quyền thực hiện action.' });
      if (!action.available) return reply.code(503).send({ error: 'Dịch vụ của action chưa được cấu hình.' });
      const envelope = parseActionRunRequest(request.body);
      if (!envelope) return reply.code(400).send({ error: 'Phiên bản hoặc request action không hợp lệ.' });
      try {
        const key=parseCreateKey(request.headers['idempotency-key'],request.raw.rawHeaders);
        const result = await action.execute(envelope.input, identity,key);
        const response: ActionRunResult = { actionId: action.descriptor.id, version: action.descriptor.version, status: 'succeeded', result };
        return response;
      } catch (error) {
        if (error instanceof RecordLinkError || error instanceof DirectoryError || error instanceof CreateCommandError) return reply.code(error.statusCode).send({error: error.message});
        if (error instanceof InvalidInput) return reply.code(400).send({ error: 'Input không đúng cấu trúc action.' });
        throw error;
      }
    });
  });
}
