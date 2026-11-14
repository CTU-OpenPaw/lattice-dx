/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import type { FastifyInstance } from 'fastify';
import type { WorkflowActor } from '@dx/contracts';
import { verifyIdentity, type IdentityConfig } from '../identity.js';
import { WorkflowError } from './policy.js';
import { definitionId, type DefinitionRegistry } from './registry.js';
import { bundleKeys, bundlePreview, parseBundle } from './bundles.js';
import { workflowDefinitions } from '../../../../solutions/workflows/definitions.js';
export function registerWorkflowBundles(app: FastifyInstance, options: { identity?: IdentityConfig; definitionRegistry?: DefinitionRegistry }) {
  app.register(async routes => {
    const actors = new WeakMap<object, WorkflowActor>();
    routes.setErrorHandler((error, _req, reply) => error instanceof WorkflowError ? reply.code(error.statusCode).send({ error: error.message }) : reply.send(error));
    routes.addHook('preHandler', async (req, reply) => {
      if (!options.identity) return reply.code(503).send({error:'Workflow identity chưa cấu hình.'});
      let identity;
      try { identity = await verifyIdentity(req.headers.authorization, options.identity); }
      catch { return reply.code(401).send({error:'Token không hợp lệ.'}); }
      if (!identity.organizationId || !identity.roles.includes('workflow:design')) return reply.code(403).send({error:'Không có quyền thiết kế quy trình.'});
      if (!options.definitionRegistry) return reply.code(503).send({error:'Definition registry chưa cấu hình.'});
      actors.set(req, {...identity, organizationId:identity.organizationId});
    });
    routes.post('/v1/workflow-bundles/validate', {bodyLimit:131072}, async req => {
      bundleKeys(req.body, ['bundle']);
      return bundlePreview(parseBundle(req.body.bundle));
    });
    routes.post('/v1/workflow-bundles/import', {bodyLimit:131072}, async (req, reply) => {
      bundleKeys(req.body, ['bundle']);
      const bundle = parseBundle(req.body.bundle);
      return reply.code(201).send({items:await options.definitionRegistry!.createMany(bundle.definitions, actors.get(req)!)});
    });
    routes.post('/v1/workflow-bundles/export', {bodyLimit:131072}, async req => {
      bundleKeys(req.body, ['definitions']);
      if (!Array.isArray(req.body.definitions) || req.body.definitions.length < 1 || req.body.definitions.length > 10) throw new WorkflowError(400, 'Export không hợp lệ.');
      const requests = req.body.definitions.map(value => {
        bundleKeys(value, ['id','version']);
        if (!definitionId(value.id) || workflowDefinitions.some(d => d.id === value.id) || !Number.isSafeInteger(value.version) || (Number(value.version) < 1 || Number(value.version) > 2147483647)) throw new WorkflowError(400, 'Export không hợp lệ.');
        return {id:value.id,version:Number(value.version)};
      });
      if (new Set(requests.map(d => d.id)).size !== requests.length) throw new WorkflowError(400, 'Workflow ID trùng lặp.');
      const definitions = [];
      for (const request of requests) {
        const published = await options.definitionRegistry!.get(actors.get(req)!.organizationId,request.id,request.version);
        if (!published) throw new WorkflowError(404, 'Không tìm thấy workflow version.');
        const {version: _version, ...definition} = published;
        definitions.push(definition);
      }
      return parseBundle({format:'latticedx.workflow-bundle',formatVersion:1,definitions});
    });
  });
}
