/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { readFile } from 'node:fs/promises';
export async function loadBrokerContext() {
  const configured = JSON.parse((await readFile(new URL('../../infra/config/ngsi-ld/context.jsonld', import.meta.url), 'utf8')).replace(/^\uFEFF/, ''))['@context'];
  // NGSI-LD already supplies its core context; keep the local mapping explicit.
  if (!Array.isArray(configured) || configured.length !== 2 || configured[0] !== 'https://uri.etsi.org/ngsi-ld/v1/ngsi-ld-core-context.jsonld' || !configured[1] || typeof configured[1] !== 'object' || Array.isArray(configured[1])) throw new Error('Expected NGSI-LD core context plus one local mapping object.');
  return configured[1];
}
export async function subscriptionConfig() {
  const token = process.env.NGSI_LD_NOTIFICATION_TOKEN;
  const tenant = process.env.NGSI_LD_TENANT || 'org-a';
  const id = process.env.NGSI_LD_SUBSCRIPTION_ID || `urn:ngsi-ld:Subscription:latticedx:${tenant}:asset-context-v1`;
  if (!token || !/^[A-Za-z0-9._~-]{32,256}$/.test(token) || !/^[A-Za-z0-9_-]{1,128}$/.test(tenant) || !/^urn:ngsi-ld:Subscription:[A-Za-z0-9._:-]{1,200}$/.test(id)) throw new Error('Valid notification token, tenant and subscription ID required. Run with --env-file=.env.integration.');
  const context = await loadBrokerContext();
  const baseUrl = (process.env.NGSI_LD_URL || 'http://localhost:1026').replace(/\/+$/, '');
  const receiverUrl = process.env.NGSI_LD_NOTIFICATION_URL || 'http://gateway:9080/v1/integrations/ngsi-ld/notifications';
  if (![baseUrl, receiverUrl].every(url => ['http:', 'https:'].includes(new URL(url).protocol))) throw new Error('HTTP(S) URLs required.');
  return { token, tenant, id, context, baseUrl, receiverUrl };
}
export async function brokerRequest(config, method, path, body, expected) {
  const response = await fetch(`${config.baseUrl}/ngsi-ld/v1${path}`, {
    method, redirect: 'error', signal: AbortSignal.timeout(10_000),
    headers: { Accept: 'application/ld+json', 'NGSILD-Tenant': config.tenant, ...(body ? { 'Content-Type': 'application/ld+json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  // Do not print broker bodies: subscription responses can contain the receiver credential.
  if (!expected.includes(response.status)) throw new Error(`Broker ${method} ${path.split('?')[0]} returned HTTP ${response.status}.`);
  return response;
}
export async function registerSubscription(config, { recreate = false } = {}) {
  const definition = {
    id: config.id, type: 'Subscription',
    entities: [{ type: 'Asset', idPattern: `^urn:ngsi-ld:Asset:${config.tenant}:[A-Za-z0-9_-]{1,128}$` }],
    watchedAttributes: ['status'],
    notification: { attributes: ['businessId', 'organizationId', 'status'], format: 'normalized', endpoint: {
      uri: config.receiverUrl, accept: 'application/json',
      // Orion-LD forwards the source tenant automatically. Adding it again here can
      // produce duplicate headers ("org-a, org-a") rejected by the strict receiver.
      receiverInfo: [{ key: 'X-Lattice-Broker-Token', value: config.token }],
    } },
    isActive: true, '@context': config.context,
  };
  const path = `/subscriptions/${encodeURIComponent(config.id)}`;
  const existing = await brokerRequest(config, 'GET', path, undefined, [200, 404]);
  if (recreate && existing.status === 200) {
    // Explicit local repair: PATCH may retain old receiverInfo entries in broker storage/cache.
    // Delete only this exact tenant-scoped subscription, never entities or other subscriptions.
    await brokerRequest(config, 'DELETE', path, undefined, [204]);
    console.log('Removed configured demo subscription; its notification counters will reset.');
  }
  if (existing.status === 200 && !recreate) {
    // Update our explicit configured subscription only; preserve unrelated subscriptions.
    // Orion-LD 1.10.0 PATCH with inline @context persists url:null and crashes
    // on restart. Native hosted contexts retain the same mapping and a real URL.
    const hosted=await brokerRequest(config,'POST','/jsonldContexts',{'@context':config.context},[201]);
    const location=hosted.headers.get('location');
    if(!location||!/^https?:\/\//.test(location))throw new Error('Broker returned no hosted context URL.');
    const { id, type, ...patch } = definition;
    patch['@context']=location;
    await brokerRequest(config, 'PATCH', path, patch, [204]);
    console.log('PASS subscription updated: HTTP 204');
  } else {
    await brokerRequest(config, 'POST', '/subscriptions', definition, [201]);
    console.log('PASS subscription created: HTTP 201');
  }
  console.log(`Subscription: ${config.id}`);
}
