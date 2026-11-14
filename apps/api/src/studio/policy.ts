/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import type { WorkflowActor } from '@dx/contracts';
import type { FoundationOptions } from '../foundation.js';
import type { EntityOptions } from '../entities/routes.js';
import type { ModuleOptions } from '../modules/routes.js';
import type { WorkflowOptions } from '../workflows/routes.js';
import type { ContextLinksOptions } from '../context-links/routes.js';
import type {OrganizationOptions} from '../organization/routes.js';
import type {OperationsOptions} from '../operations/routes.js';

export type StudioOptions = FoundationOptions & EntityOptions & ModuleOptions & WorkflowOptions & ContextLinksOptions & OrganizationOptions & OperationsOptions;
export type Availability = { authorized: boolean; configured: boolean; available: boolean };
export type StudioIssue = { code: string; path: string; message: string };
export type StudioErrorCode = 'identity_unavailable' | 'invalid_token' | 'authority_denied' | 'invalid_request' | 'runtime_unavailable' | 'not_found' | 'resource_conflict' | 'internal_error';
export class StudioError extends Error {
  constructor(public readonly statusCode: number, public readonly code: StudioErrorCode, message: string) { super(message); }
}
export function availability(actor: WorkflowActor, requiredRoles: readonly string[], configured: boolean): Availability {
  const authorized = requiredRoles.every(role => actor.roles.includes(role));
  return { authorized, configured, available: authorized && configured };
}
export function requireDesigner(actor: WorkflowActor): void {
  if (!actor.roles.some(role => role === 'data:design' || role === 'workflow:design'))
    throw new StudioError(403, 'authority_denied', 'Designer role required.');
}
export function capabilities(actor: WorkflowActor, options: StudioOptions) {
  return {
    'organization.read':availability(actor,['directory:read'],!!options.organization),
    'organization.manage':availability(actor,['directory:manage'],!!options.organization),
    'operations.read':availability(actor,['platform:operate'],!!options.operations),
    'context.read': availability(actor, ['data:read'], !!(options.entities && options.contextLinks)),
    'context.links.manage': availability(actor, ['data:read','data:design'], !!(options.entities && options.contextLinks)),
    'entities.read': availability(actor, ['data:read'], !!options.entities),
    'entities.write': availability(actor, ['data:write'], !!options.entities),
    'entities.share':availability(actor,['data:share'],!!options.entities),
    'entities.design': availability(actor, ['data:design'], !!options.entities),
    'entities.query': availability(actor, ['data:read'], !!options.entities?.query),
    'workflow.start': availability(actor, ['workflow:start'], !!options.workflows),
    'logistics.create': availability(actor, ['logistics:sales','workflow:start'], !!(options.workflows && options.directory)),
    'workflow.design': availability(actor, ['workflow:design'], !!options.definitionRegistry),
    'modules.preflight': availability(actor, ['workflow:design', 'data:design'], !!options.modules),
    'modules.dependencies': availability(actor, ['workflow:design'], !!options.modules),
    'records.create': availability(actor, ['records:write'], !!options.records),
    'tasks.create': availability(actor, ['tasks:assign'], !!(options.foundation && options.directory)),
  };
}
export function strictObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key)))
    throw new StudioError(400, 'invalid_request', 'Unexpected request fields.');
  return value as Record<string, unknown>;
}
