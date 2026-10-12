// SPDX-License-Identifier: Apache-2.0
import { jwtVerify, type JWTVerifyGetKey } from 'jose';
export interface IdentityConfig { issuer: string; audience: string; key: JWTVerifyGetKey }
export async function verifyIdentity(header: string | undefined, config: IdentityConfig) {
  if (!header?.startsWith('Bearer ')) throw new Error('Missing bearer token');
  const { payload } = await jwtVerify(header.slice(7), config.key, {
    issuer: config.issuer, audience: config.audience, algorithms: ['RS256'], requiredClaims: ['sub', 'exp'],
  });
  if (!payload.sub) throw new Error('Missing subject');
  const access = payload.realm_access;
  const roles = access && typeof access === 'object' && 'roles' in access && Array.isArray(access.roles)
    ? access.roles.filter((role): role is string => typeof role === 'string') : [];
  const organizationId = typeof payload.organization_id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(payload.organization_id)
    ? payload.organization_id : undefined;
  return { subject: payload.sub, roles, organizationId };
}
