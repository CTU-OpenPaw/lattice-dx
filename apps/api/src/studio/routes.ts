// SPDX-License-Identifier: Apache-2.0
import type { FastifyInstance } from 'fastify';
import type { WorkflowActor } from '@dx/contracts';
import { verifyIdentity } from '../identity.js';
import { EntityError, slug } from '../entities/policy.js';
import { requireModuleAdmin, requireModuleDesigner, semver } from '../modules/policy.js';
import type { ModuleVersion } from '../modules/types.js';
import { WorkflowError } from '../workflows/policy.js';
import { studioCatalog } from './catalog.js';
import { capabilities, requireDesigner, strictObject, StudioError, type StudioIssue, type StudioOptions } from './policy.js';

export type StudioDependencies = {
  version: 1;
  module: Pick<ModuleVersion, 'id' | 'version'>;
  schemas: ModuleVersion['schemas'];
  workflows: ModuleVersion['workflows'];
  blocks: ModuleVersion['blocks'];
  bindings: NonNullable<ModuleVersion['bindings']>;
  dependencies: ModuleVersion['dependencies'];
};

export function registerStudio(app: FastifyInstance, options: StudioOptions): void {
  app.register(async routes => {
    const actors = new WeakMap<object, WorkflowActor>();
    routes.setErrorHandler((error, _request, reply) => {
      let safe: StudioError;
      if (error instanceof StudioError) safe = error;
      else if (error instanceof EntityError || error instanceof WorkflowError) {
        safe = error.statusCode === 403 ? new StudioError(403, 'authority_denied', 'Required designer roles are missing.')
          : error.statusCode === 404 ? new StudioError(404, 'not_found', 'Module version not found.')
          : error.statusCode === 503 ? new StudioError(503, 'runtime_unavailable', 'Studio runtime unavailable.')
          : error.statusCode === 409 ? new StudioError(409, 'resource_conflict', 'Resource conflict.')
          : new StudioError(400, 'invalid_request', 'Invalid request.');
      } else {
        const framework = error as {code?:string;statusCode?:number};
        safe = framework.code?.startsWith('FST_ERR_CTP_') && [400,413,415].includes(framework.statusCode ?? 0)
          ? new StudioError(framework.statusCode!, 'invalid_request', 'Invalid request body.')
          : new StudioError(500, 'internal_error', 'Studio request failed.');
      }
      return reply.code(safe.statusCode).send({error:{code:safe.code,message:safe.message}});
    });
    routes.addHook('preHandler', async request => {
      if (!options.identity) throw new StudioError(503, 'identity_unavailable', 'Studio identity is not configured.');
      let identity;
      try { identity = await verifyIdentity(request.headers.authorization, options.identity); }
      catch { throw new StudioError(401, 'invalid_token', 'Invalid token.'); }
      if (!identity.organizationId) throw new StudioError(403, 'authority_denied', 'Organization scope required.');
      actors.set(request, {...identity,organizationId:identity.organizationId});
      strictObject(request.query, []);
      if (request.method === 'GET' && request.body !== undefined) throw new StudioError(400, 'invalid_request', 'Unexpected request body.');
    });
    routes.get('/v1/me/capabilities', async request => {
      const actor = actors.get(request)!;
      return {version:1,subject:actor.subject,organizationId:actor.organizationId,capabilities:capabilities(actor,options)};
    });
    routes.get('/v1/studio/catalog', async request => {
      const actor = actors.get(request)!;
      requireDesigner(actor);
      return studioCatalog(actor,options);
    });
    routes.post('/v1/studio/preflight', {bodyLimit:128*1024}, async request => {
      const actor = actors.get(request)!;
      requireModuleAdmin(actor);
      const body = strictObject(request.body, ['manifest']);
      if (!options.modules) throw new StudioError(503, 'runtime_unavailable', 'Module service is not configured.');
      try {
        const preview = await options.modules.preview(body.manifest,actor);
        const issues: StudioIssue[] = [
          ...preview.conflicts.map(message => ({code:'resource_conflict',path:'manifest',message})),
          ...preview.dependencyErrors.map(message => ({code:'dependency_error',path:'manifest.dependencies',message})),
        ];
        return {version:1,valid:issues.length === 0,issues,preview};
      } catch (error) {
        if ((error instanceof WorkflowError || error instanceof EntityError) && error.statusCode === 400)
          return {version:1,valid:false,issues:[{code:'invalid_manifest',path:'manifest',message:'Invalid module manifest.'}]};
        throw error;
      }
    });
    routes.get<{Params:{id:string;version:string}}>('/v1/studio/modules/:id/versions/:version/dependencies', async request => {
      const actor = actors.get(request)!;
      requireModuleDesigner(actor);
      const id = slug(request.params.id), version = semver(request.params.version);
      if (!options.modules) throw new StudioError(503, 'runtime_unavailable', 'Module service is not configured.');
      const module = await options.modules.get(id,version,actor);
      return {
        version:1, module:{id:module.id,version:module.version}, schemas:[...module.schemas],
        workflows:module.workflows.map(item => ({definitionId:item.definitionId,...(item.definitionVersion === undefined ? {} : {definitionVersion:item.definitionVersion})})),
        blocks:module.blocks.map(item => ({id:item.id,version:item.version})),
        bindings:(module.bindings ?? []).map(item => ({id:item.id,schemaId:item.schemaId,schemaVersion:item.schemaVersion,definitionId:item.definitionId,
          ...(item.definitionVersion === undefined ? {} : {definitionVersion:item.definitionVersion}),allowedTransitions:[...item.allowedTransitions]})),
        dependencies:module.dependencies.map(item => ({id:item.id,version:item.version})),
      } satisfies StudioDependencies;
    });
  });
}
