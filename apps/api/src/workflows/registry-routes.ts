/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import type { FastifyInstance } from 'fastify';
import type { WorkflowActor } from '@dx/contracts';
import { verifyIdentity, type IdentityConfig } from '../identity.js';
import { PageError, parsePage } from '../pagination.js';
import { WorkflowError } from './policy.js';
import type { DefinitionRegistry } from './registry.js';

export function registerWorkflowDrafts(
  app: FastifyInstance,
  options: { identity?: IdentityConfig; definitionRegistry?: DefinitionRegistry },
) {
  app.register(async routes => {
    const actors = new WeakMap<object, WorkflowActor>();
    routes.setErrorHandler((error, _req, reply) => {
      if (error instanceof WorkflowError || error instanceof PageError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      return reply.send(error);
    });

    routes.addHook('preHandler', async (req, reply) => {
      if (!options.identity) {
        return reply.code(503).send({ error: 'Workflow identity chưa cấu hình.' });
      }
      let identity;
      try {
        identity = await verifyIdentity(req.headers.authorization, options.identity);
      } catch {
        return reply.code(401).send({ error: 'Token không hợp lệ.' });
      }
      if (!identity.organizationId || !identity.roles.includes('workflow:design')) {
        return reply.code(403).send({ error: 'Không có quyền thiết kế quy trình.' });
      }
      if (!options.definitionRegistry) {
        return reply.code(503).send({ error: 'Definition registry chưa cấu hình.' });
      }
      actors.set(req, { ...identity, organizationId: identity.organizationId });
    });

    function body(
      value: unknown,
      update = false,
      publish = false,
    ): { definition?: unknown; expectedRevision?: number } {
      const allowed = publish ? ['expectedRevision']
        : update ? ['definition', 'expectedRevision'] : ['definition'];
      if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).some(key => !allowed.includes(key))) {
        throw new WorkflowError(400, 'Payload bản nháp không hợp lệ.');
      }
      const payload = value as { definition?: unknown; expectedRevision?: number };
      if ((!publish && !Object.hasOwn(payload, 'definition'))
        || ((update || publish) && (!Number.isSafeInteger(payload.expectedRevision) || Number(payload.expectedRevision) < 1))) {
        throw new WorkflowError(400, 'Payload bản nháp không hợp lệ.');
      }
      return payload;
    }

    const registry = options.definitionRegistry!;
    routes.post('/v1/workflow-drafts', async (req, reply) => {
      const draft = await registry.create(body(req.body).definition, actors.get(req)!);
      return reply.code(201).send(draft);
    });
    routes.get<{ Querystring: Record<string, unknown> }>('/v1/workflow-drafts', async req => {
      return registry.listDrafts(actors.get(req)!, parsePage(req.query));
    });
    routes.get<{ Params: { id: string } }>('/v1/workflow-drafts/:id', async req => {
      return registry.getDraft(req.params.id, actors.get(req)!);
    });
    routes.put<{ Params: { id: string } }>('/v1/workflow-drafts/:id', async req => {
      const payload = body(req.body, true);
      return registry.updateDraft(req.params.id, payload.expectedRevision!, payload.definition, actors.get(req)!);
    });
    routes.post<{ Params: { id: string } }>('/v1/workflow-drafts/:id/publish', async req => {
      const payload = body(req.body, false, true);
      return registry.publish(req.params.id, payload.expectedRevision!, actors.get(req)!);
    });
  });
}
