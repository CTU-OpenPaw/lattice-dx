/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { timingSafeEqual, createHash } from 'node:crypto';
import { NotificationError, type Notification, type AssetContext, type AssetObservation } from './types.js';
const component = /^[A-Za-z0-9_-]{1,128}$/;
const statuses = new Set(['ready', 'in_use', 'repair', 'retired']);
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const bad = (message: string): never => { throw new NotificationError(400, message); };
const ns = 'https://latticedx.example/ns/';
function attribute(entity: Record<string, unknown>, name: string): unknown {
  if (Object.hasOwn(entity, name) && Object.hasOwn(entity, ns + name)) return bad(`Ambiguous attribute: ${name}.`);
  return entity[name] ?? entity[ns + name];
}
export function validateConfig(token: string, tenant: string, subscriptionId: string) {
  if (!/^[A-Za-z0-9._~-]{32,256}$/.test(token) || !component.test(tenant) || !/^urn:ngsi-ld:Subscription:[A-Za-z0-9._:-]{1,200}$/.test(subscriptionId)) {
    throw new Error('Invalid NGSI-LD notification token, tenant or subscription ID configuration.');
  }
}
export function authorized(actual: unknown, expected: string) {
  return typeof actual === 'string' && timingSafeEqual(createHash('sha256').update(actual).digest(), createHash('sha256').update(expected).digest());
}
export function assetId(id: unknown, tenant: string): id is string {
  const prefix = `urn:ngsi-ld:Asset:${tenant}:`;
  return typeof id === 'string' && id.startsWith(prefix) && component.test(id.slice(prefix.length));
}
// v1 deliberately accepts UTC with millisecond precision at most. No lossy ordering of sub-ms events.
function timestamp(value: unknown, now: number): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return bad('status.observedAt: UTC ISO 8601 timestamp required (maximum millisecond precision).');
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return bad('status.observedAt: invalid timestamp.');
  const canonical = value.includes('.') ? value.replace(/\.(\d+)Z$/, (_, digits: string) => `.${digits.padEnd(3, '0')}Z`) : value.replace('Z', '.000Z');
  if (new Date(ms).toISOString() !== canonical || ms > now + 300_000) return bad('status.observedAt: invalid date or more than five minutes in the future.');
  return canonical;
}
export function parseNotification(value: unknown, tenant: string, subscriptionId: string, now = Date.now()): Notification {
  if (!object(value) || value.type !== 'Notification' || typeof value.id !== 'string' || !value.id.length || value.id.length > 512) return bad('NGSI-LD Notification with bounded id required.');
  if (value.subscriptionId !== subscriptionId) throw new NotificationError(403, 'Subscription is not allowed.');
  if (!Array.isArray(value.data) || !value.data.length || value.data.length > 100) return bad('data: array of 1 to 100 Assets required.');
  const seen = new Set<string>();
  const observations = value.data.map((entity: unknown): AssetObservation => {
    if (!object(entity) || !assetId(entity.id, tenant) || !['Asset', ns + 'Asset'].includes(entity.type as string)) return bad('Entity must be an Asset in the configured tenant.');
    if (seen.has(entity.id)) return bad('Duplicate entity in notification batch.');
    seen.add(entity.id);
    const organization = attribute(entity, 'organizationId'), business = attribute(entity, 'businessId'), status = attribute(entity, 'status');
    if (!object(organization) || organization.type !== 'Property' || organization.value !== tenant) return bad('organizationId must match the configured tenant.');
    if (!object(business) || business.type !== 'Property' || typeof business.value !== 'string' || entity.id !== `urn:ngsi-ld:Asset:${tenant}:${business.value}`) return bad('businessId must match entity ID.');
    if (!object(status) || status.type !== 'Property' || typeof status.value !== 'string' || !statuses.has(status.value) || status.datasetId !== undefined) return bad('status: single default Property with a valid Asset status required.');
    return { entityId: entity.id, businessId: business.value, status: status.value, observedAt: timestamp(status.observedAt, now) };
  });
  return { id: value.id, subscriptionId, observations };
}
export function shouldApply(current: AssetContext | undefined, incoming: AssetObservation): boolean {
  if (!current) return true;
  if (incoming.observedAt < current.observedAt) return false;
  if (incoming.observedAt === current.observedAt) {
    if (incoming.status !== current.status) throw new NotificationError(409, 'Conflicting status at the same observedAt.');
    return false;
  }
  return true;
}
