/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import type { WorkflowActor } from '@dx/contracts';
import type { Page, PageQuery } from '../pagination.js';

export type PrincipalType = 'person' | 'department';
export type SystemGrantStatus = 'active' | 'revoked';

export interface SystemGrant {
  systemId: string;
  systemVersion: string;
  principalType: PrincipalType;
  principalId: string;
  roles: string[];
  status: SystemGrantStatus;
  revision: number;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
}

export interface SystemGrantInput {
  principalType: PrincipalType;
  principalId: string;
  roles: string[];
}

export interface SystemGrantUpdateInput {
  expectedRevision: number;
  roles: string[];
}

export interface SystemGrantRevokeInput {
  expectedRevision: number;
}

export interface SystemGrantAuditEntry {
  auditId: string;
  systemId: string;
  systemVersion: string;
  principalType: PrincipalType;
  principalId: string;
  revision: number;
  actorId: string;
  operation: 'grant' | 'update' | 'revoke';
  roles: string[];
  status: SystemGrantStatus;
  occurredAt: string;
}

export type SystemPolicyStatus = 'legacy' | 'enforced';

export interface SystemPolicy {
  systemId: string;
  systemVersion: string;
  status: SystemPolicyStatus;
  revision: number;
  activatedAt?: string;
  activatedBy?: string;
}

export interface SystemPolicyActivateInput {
  expectedRevision: number;
}

export interface EffectiveSystemAccess {
  systemId: string;
  version: string;
  hasAccess: boolean;
  effectiveRoles: string[];
  sources: Array<{
    source: PrincipalType;
    principalId: string;
    roles: string[];
  }>;
  enforcementStatus: 'legacy' | 'not_enforced' | 'enforced';
}

export interface SystemAccessRepository {
  activatePolicy(
    systemId: string,
    version: string,
    input: SystemPolicyActivateInput,
    actor: WorkflowActor,
    key: string
  ): Promise<SystemPolicy>;

  getPolicy(
    systemId: string,
    version: string,
    actor: WorkflowActor
  ): Promise<SystemPolicy>;

  grant(
    systemId: string,
    version: string,
    input: SystemGrantInput,
    actor: WorkflowActor,
    key: string
  ): Promise<SystemGrant>;

  update(
    systemId: string,
    version: string,
    principalType: PrincipalType,
    principalId: string,
    input: SystemGrantUpdateInput,
    actor: WorkflowActor,
    key: string
  ): Promise<SystemGrant>;

  revoke(
    systemId: string,
    version: string,
    principalType: PrincipalType,
    principalId: string,
    input: SystemGrantRevokeInput,
    actor: WorkflowActor,
    key: string
  ): Promise<{
    revoked: boolean;
    systemId: string;
    version: string;
    principalType: PrincipalType;
    principalId: string;
    revision: number;
  }>;

  list(
    systemId: string,
    version: string,
    actor: WorkflowActor,
    page: PageQuery,
    principalType?: PrincipalType
  ): Promise<Page<SystemGrant>>;

  history(
    systemId: string,
    version: string,
    actor: WorkflowActor,
    page: PageQuery,
    principalType?: PrincipalType,
    principalId?: string
  ): Promise<Page<SystemGrantAuditEntry>>;

  effectiveAccess(
    systemId: string,
    version: string,
    actor: WorkflowActor
  ): Promise<EffectiveSystemAccess>;
}
