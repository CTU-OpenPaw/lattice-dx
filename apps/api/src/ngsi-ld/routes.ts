// SPDX-License-Identifier: Apache-2.0
import type { FastifyInstance } from 'fastify';
import { assetId, authorized, parseNotification, validateConfig } from './policy.js';
import { NotificationError, type NgsiLdOptions } from './types.js';
export function registerNgsiLd(app: FastifyInstance, options: NgsiLdOptions) {
  const config = options.ngsiLd;
  if (config) validateConfig(config.token, config.tenant, config.subscriptionId);
  app.register(async routes => {
    routes.addContentTypeParser('application/ld+json', { parseAs: 'string' }, routes.getDefaultJsonParser('error', 'error'));
    routes.setErrorHandler((error, _request, reply) => {
      if (error instanceof NotificationError) return reply.code(error.statusCode).send({ error: error.message });
      return reply.send(error);
    });
    routes.addHook('onRequest', async (request, reply) => {
      if (!config) return reply.code(503).send({ error: 'NGSI-LD receiver is not configured.' });
      if (!authorized(request.headers['x-lattice-broker-token'], config.token)) return reply.code(403).send({ error: 'Invalid broker credential.' });
      if (request.headers['ngsild-tenant'] !== config.tenant) return reply.code(403).send({ error: 'Broker tenant is not allowed.' });
      if (!config.repository) return reply.code(503).send({ error: 'NGSI-LD context storage is not configured.' });
    });
    routes.post('/v1/integrations/ngsi-ld/notifications', { bodyLimit: 65_536 }, async request => {
      const notification = parseNotification(request.body, config!.tenant, config!.subscriptionId);
      return { status: 'processed', ...await config!.repository!.apply(config!.tenant, notification) };
    });
    // Operational read-back, protected by the same scoped integration credential. Not an end-user API.
    routes.get<{ Querystring: { entityId?: string } }>('/v1/integrations/ngsi-ld/context', async (request, reply) => {
      if (!assetId(request.query.entityId, config!.tenant)) throw new NotificationError(400, 'Valid Asset entityId required.');
      const context = await config!.repository!.find(config!.tenant, request.query.entityId);
      return context ?? reply.code(404).send({ error: 'Asset context not found.' });
    });
  });
}
