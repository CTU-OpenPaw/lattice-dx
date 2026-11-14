/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { assetId, authorized, parseNotification, validateConfig } from './policy.js';
import { NotificationError, type NgsiLdOptions } from './types.js';
export function registerNgsiLd(app: FastifyInstance, options: NgsiLdOptions) {
  const config = options.ngsiLd;
  if (config) validateConfig(config.token, config.tenant, config.subscriptionId);
  app.register(async routes => {
    const failures = new WeakMap<object, string>();
    // Bounded metadata only: never log headers, tokens, raw payloads or parser error text.
    function diagnostic(request: FastifyRequest, statusCode: number) {
      const body = request.body && typeof request.body === 'object' && !Array.isArray(request.body)
        ? request.body as Record<string, unknown> : undefined;
      const first = Array.isArray(body?.data) ? body.data[0] : undefined;
      const property = first && typeof first === 'object'
        ? first.status ?? first['https://latticedx.example/ns/status'] : undefined;
      const observedAt = property?.observedAt;
      console.info('NGSI-LD receiver', JSON.stringify({
        statusCode, reason: failures.get(request), configured: !!config,
        tokenMatches: !!config && authorized(request.headers['x-lattice-broker-token'], config.token),
        tenantMatches: !!config && request.headers['ngsild-tenant'] === config.tenant,
        tenantValueCount: typeof request.headers['ngsild-tenant'] === 'string' ? request.headers['ngsild-tenant'].split(',').length : 0,
        notificationIdPresent: typeof body?.id === 'string',
        notificationTypeMatches: body?.type === 'Notification',
        subscriptionMatches: !!config && body?.subscriptionId === config.subscriptionId,
        dataCount: Array.isArray(body?.data) ? body.data.length : null,
        statusPresent: property !== undefined,
        observedAtType: typeof observedAt,
        fractionalDigits: typeof observedAt === 'string' ? (observedAt.match(/\.(\d+)/)?.[1].length ?? 0) : null,
      }));
    }
    routes.addHook('onResponse', async (request, reply) => {
      if (request.method === 'POST') diagnostic(request, reply.statusCode);
    });
    routes.addContentTypeParser('application/ld+json', { parseAs: 'string' }, routes.getDefaultJsonParser('error', 'error'));
    routes.setErrorHandler((error, request, reply) => {
      if (error instanceof NotificationError) {
        failures.set(request, error.message);
        return reply.code(error.statusCode).send({ error: error.message });
      }
      failures.set(request, 'Parser, storage or internal error');
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
