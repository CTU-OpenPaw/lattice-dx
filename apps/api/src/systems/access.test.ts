/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it, vi } from 'vitest';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { createApi } from '../app.js';
import { systemAccessDatabase } from './access-database.js';
import { pageResult } from '../pagination.js';
import type { SystemAccessRepository } from './access-types.js';

const { privateKey, publicKey } = await generateKeyPair('RS256');
const identity = {
  issuer: 'http://fixture',
  audience: 'dx-api',
  key: createLocalJWKSet({
    keys: [{ ...(await exportJWK(publicKey)), kid: 'sys', alg: 'RS256' }],
  }),
};

const auth = async (roles: string[], subject = 'admin', org = 'org-a') => ({
  authorization:
    'Bearer ' +
    (await new SignJWT({ organization_id: org, realm_access: { roles } })
      .setSubject(subject)
      .setProtectedHeader({ alg: 'RS256', kid: 'sys' })
      .setIssuer(identity.issuer)
      .setAudience(identity.audience)
      .setExpirationTime('5m')
      .sign(privateKey)),
  'idempotency-key': 'test-key',
});

const declaredPublishedWorkflow = {
  id: 'ops-req',
  title: 'Requests',
  startRole: 'employee',
  initialState: 'draft',
  startFields: {},
  readerRoles: ['procurement:manager'],
  assignedReader: { field: 'handlerId', role: 'logistics:warehouse' },
  transitions: [
    { id: 'submit', from: 'draft', to: 'submitted', role: 'employee', fields: {} },
    { id: 'approve', from: 'submitted', to: 'approved', role: 'procurement:manager', fields: {} },
    { id: 'auto-notify', from: 'approved', to: 'notified', role: 'service:notifier', execution: 'service', fields: {} },
  ],
};

const declaredManifest = {
  format: 'latticedx.enterprise-module',
  formatVersion: 1,
  id: 'company-ops',
  version: '1.0.0',
  title: 'Company Operations',
  schemas: [],
  bundle: {
    format: 'latticedx.workflow-bundle',
    formatVersion: 1,
    definitions: [declaredPublishedWorkflow],
  },
  blocks: [],
  dependencies: [],
};

describe('Production Wiring & Endpoint Routing', () => {
  it('proves createApi receives and registers systemAccess correctly', async () => {
    const effectiveAccess = vi.fn(async () => ({
      systemId: 'company-ops',
      version: '1.0.0',
      hasAccess: true,
      effectiveRoles: ['employee'],
      sources: [{ source: 'person' as const, principalId: 'emp-1', roles: ['employee'] }],
      enforcementStatus: 'not_enforced' as const,
    }));
    const list = vi.fn(async () => pageResult([], { limit: 20, offset: 0, q: '' }));

    const systemAccess: Partial<SystemAccessRepository> = {
      list: list as any,
      effectiveAccess: effectiveAccess as any,
    };

    const systems = {
      save: vi.fn(),
      list: vi.fn(async () => pageResult([], { limit: 20, offset: 0, q: '' })),
      get: vi.fn(),
      runtime: vi.fn(async () => pageResult([], { limit: 20, offset: 0, q: '' })),
    };

    const app = createApi({
      workerUrl: 'http://worker',
      identity,
      systems: systems as any,
      systemAccess: systemAccess as any,
    });

    try {
      // 1. Unauthenticated request -> 401
      const unauth = await app.inject({
        method: 'GET',
        url: '/v1/systems/company-ops/versions/1.0.0/members',
      });
      expect(unauth.statusCode).toBe(401);

      // 2. Ordinary employee on admin members list -> 403
      const empHeaders = await auth(['employee'], 'emp-1');
      const empDenied = await app.inject({
        method: 'GET',
        url: '/v1/systems/company-ops/versions/1.0.0/members',
        headers: empHeaders,
      });
      expect(empDenied.statusCode).toBe(403);

      // 3. Module admin on admin members list -> 200
      const adminHeaders = await auth(['workflow:design', 'data:design'], 'admin-1');
      const adminAllowed = await app.inject({
        method: 'GET',
        url: '/v1/systems/company-ops/versions/1.0.0/members',
        headers: adminHeaders,
      });
      expect(adminAllowed.statusCode).toBe(200);

      // 4. Ordinary employee on /access/me -> 200 with enforcementStatus=not_enforced
      const myAccess = await app.inject({
        method: 'GET',
        url: '/v1/system-apps/company-ops/versions/1.0.0/access/me',
        headers: empHeaders,
      });
      expect(myAccess.statusCode).toBe(200);
      expect(myAccess.json()).toEqual({
        systemId: 'company-ops',
        version: '1.0.0',
        hasAccess: true,
        effectiveRoles: ['employee'],
        sources: [{ source: 'person', principalId: 'emp-1', roles: ['employee'] }],
        enforcementStatus: 'not_enforced',
      });

      // 5. Query validation: unexpected query on /access/me -> 400
      const invalidQueryAccessMe = await app.inject({
        method: 'GET',
        url: '/v1/system-apps/company-ops/versions/1.0.0/access/me?unexpected=true',
        headers: empHeaders,
      });
      expect(invalidQueryAccessMe.statusCode).toBe(400);

      // 6. Query validation: general system routes do not allow principalType -> 400
      const invalidQueryDrafts = await app.inject({
        method: 'GET',
        url: '/v1/system-drafts?principalType=person',
        headers: adminHeaders,
      });
      expect(invalidQueryDrafts.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('proves dedicated module-admin system discovery/detail allows admin inspection without business role/membership while employee app returns 404', async () => {
    const adminList = vi.fn(async () => pageResult([
      {
        id: 'company-ops',
        version: '1.0.0',
        title: 'Điều hành công ty',
        enabled: false,
        policyStatus: 'enforced',
        policyRevision: 1,
        publishedWorkflowsCount: 1,
        totalWorkflowsCount: 1,
        schemasCount: 2,
      },
      {
        id: 'draft-sys',
        version: '1.0.0',
        title: 'Draft System',
        enabled: false,
        policyStatus: 'legacy',
        policyRevision: 0,
        publishedWorkflowsCount: 0,
        totalWorkflowsCount: 1,
        schemasCount: 0,
      },
    ], { limit: 20, offset: 0, q: '' }));

    const adminGet = vi.fn(async (id: string, version: string) => ({
      id,
      version,
      title: 'Điều hành công ty',
      enabled: false,
      policyStatus: 'enforced',
      policyRevision: 1,
      presentation: { schemaVersion: 1, pages: [] },
      schemas: [],
      definitions: [
        {
          id: 'cross-requests',
          title: 'Yêu cầu liên phòng ban',
          published: true,
          definitionVersion: 1,
          startRole: 'employee',
          readerRoles: ['manager'],
          assignedReader: { field: 'handlerId', role: 'operator', states: ['approved'] },
        },
        {
          id: 'draft-flow',
          title: 'Quy trình thử nghiệm',
          published: false,
        }
      ],
      permittedBusinessRoles: ['employee', 'manager', 'operator'],
    }));

    const runtime = vi.fn(async () => pageResult([], { limit: 20, offset: 0, q: '' }));

    const systems = {
      save: vi.fn(),
      list: vi.fn(async () => pageResult([], { limit: 20, offset: 0, q: '' })),
      get: vi.fn(),
      runtime: runtime as any,
      adminList: adminList as any,
      adminGet: adminGet as any,
    };

    const app = createApi({
      workerUrl: 'http://worker',
      identity,
      systems: systems as any,
    });

    try {
      // 1. Employee without module-admin roles cannot access admin discovery -> 403
      const empHeaders = await auth(['employee'], 'emp-1');
      const empList = await app.inject({
        method: 'GET',
        url: '/v1/systems',
        headers: empHeaders,
      });
      expect(empList.statusCode).toBe(403);

      const empDetail = await app.inject({
        method: 'GET',
        url: '/v1/systems/company-ops/versions/1.0.0',
        headers: empHeaders,
      });
      expect(empDetail.statusCode).toBe(403);

      // 2. Pure module admin (workflow:design + data:design) with NO business roles or membership:
      // Can discover installed systems via GET /v1/systems -> 200
      const adminHeaders = await auth(['workflow:design', 'data:design'], 'admin-pure');
      const adminListRes = await app.inject({
        method: 'GET',
        url: '/v1/systems',
        headers: adminHeaders,
      });
      expect(adminListRes.statusCode).toBe(200);
      expect(adminListRes.json().items).toHaveLength(2);
      expect(adminListRes.json().items[0].id).toBe('company-ops');
      expect(adminListRes.json().items[1]).toMatchObject({
        id: 'draft-sys',
        publishedWorkflowsCount: 0,
        totalWorkflowsCount: 1,
      });

      // Can get system detail via GET /v1/systems/:id/versions/:version -> 200
      const adminGetRes = await app.inject({
        method: 'GET',
        url: '/v1/systems/company-ops/versions/1.0.0',
        headers: adminHeaders,
      });
      expect(adminGetRes.statusCode).toBe(200);
      const detail = adminGetRes.json();
      expect(detail.id).toBe('company-ops');
      expect(detail.version).toBe('1.0.0');
      expect(detail.permittedBusinessRoles).toEqual(['employee', 'manager', 'operator']);
      expect(detail.definitions).toHaveLength(2);
      expect(detail.definitions[0].published).toBe(true);
      expect(detail.definitions[1].published).toBe(false);

      // 3. But on employee runtime route (/v1/system-apps/:id/versions/:version), pure admin gets 404 because they have no business membership
      const empRuntimeRes = await app.inject({
        method: 'GET',
        url: '/v1/system-apps/company-ops/versions/1.0.0',
        headers: adminHeaders,
      });
      expect(empRuntimeRes.statusCode).toBe(404);
      expect(empRuntimeRes.json().error).toMatch(/Published system unavailable|not_found/);
    } finally {
      await app.close();
    }
  });

  it('rejects missing Idempotency-Key on mutating grant/update/revoke commands', async () => {
    const systemAccess: Partial<SystemAccessRepository> = {
      grant: vi.fn(),
      update: vi.fn(),
      revoke: vi.fn(),
    };
    const systems = {
      save: vi.fn(),
      list: vi.fn(async () => pageResult([], { limit: 20, offset: 0, q: '' })),
      get: vi.fn(),
      runtime: vi.fn(async () => pageResult([], { limit: 20, offset: 0, q: '' })),
    };
    const app = createApi({
      workerUrl: 'http://worker',
      identity,
      systems: systems as any,
      systemAccess: systemAccess as any,
    });

    try {
      const adminHeadersNoKey = {
        authorization: (await auth(['workflow:design', 'data:design'])).authorization,
      };
      const res = await app.inject({
        method: 'POST',
        url: '/v1/systems/company-ops/versions/1.0.0/members',
        headers: adminHeadersNoKey,
        payload: { principalType: 'person', principalId: 'emp-1', roles: ['employee'] },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('Idempotency-Key');
    } finally {
      await app.close();
    }
  });
});

describe('Database Repository Logic & Invariants', () => {
  function createMockDb() {
    const grants = new Map<string, any>();
    const audit: any[] = [];
    const commands = new Map<string, any>();
    const people = new Map<string, any>([
      ['org-a:active-emp', { subject: 'active-emp', enabled: true, departmentId: 'dept-1' }],
      ['org-a:disabled-emp', { subject: 'disabled-emp', enabled: false, departmentId: 'dept-1' }],
      ['org-a:special%_\\emp', { subject: 'special%_\\emp', enabled: true, departmentId: 'dept-1' }],
      ['org-b:active-emp', { subject: 'active-emp', enabled: true, departmentId: 'dept-b' }],
    ]);
    const depts = new Map<string, any>([
      ['org-a:dept-1', { id: 'dept-1', name: 'Dept 1' }],
      ['org-b:dept-b', { id: 'dept-b', name: 'Dept B' }],
    ]);
    const modules = new Map<string, any>([
      ['org-a:company-ops:1.0.0', { id: 'company-ops', version: '1.0.0', manifest: declaredManifest }],
      ['org-a:company-ops:2.0.0', { id: 'company-ops', version: '2.0.0', manifest: declaredManifest }],
    ]);
    const moduleWorkflows = new Map<string, any>([
      ['org-a:company-ops:1.0.0', [{ definitionId: 'ops-req', definitionVersion: 1, definition: declaredPublishedWorkflow }]],
      ['org-a:company-ops:2.0.0', [{ definitionId: 'ops-req', definitionVersion: 1, definition: declaredPublishedWorkflow }]],
    ]);
    const policies = new Map<string, any>();
    const policyAudit: any[] = [];

    const client = {
      query: vi.fn(async (sql: string, params: any[] = []) => {
        if (sql.startsWith('BEGIN') || sql.startsWith('COMMIT') || sql.startsWith('ROLLBACK')) {
          return { rows: [] };
        }
        if (sql.includes('pg_advisory_xact_lock')) {
          return { rows: [] };
        }
        if (sql.includes('count(*)::text AS count FROM studio_system_grants')) {
          const org = params[0];
          const sysId = params[1];
          const ver = params[2];
          let cnt = 0;
          for (const [k, v] of grants.entries()) {
            if (k.startsWith(`${org}:${sysId}:${ver}:`) && v.status === 'active') cnt++;
          }
          return { rows: [{ count: cnt.toString() }] };
        }
        if (sql.includes('FROM studio_system_policies')) {
          const key = `${params[0]}:${params[1]}:${params[2]}`;
          const pol = policies.get(key);
          return { rows: pol ? [pol] : [] };
        }
        if (sql.includes('INSERT INTO studio_system_policies')) {
          const key = `${params[0]}:${params[1]}:${params[2]}`;
          const row = {
            system_id: params[1],
            system_version: params[2],
            status: 'enforced',
            revision: 1,
            activated_by: params[3],
            activated_at: new Date(),
          };
          policies.set(key, row);
          return { rows: [row] };
        }
        if (sql.includes('UPDATE studio_system_policies SET')) {
          const key = `${params[2]}:${params[3]}:${params[4]}`;
          const existing = policies.get(key);
          if (existing) {
            existing.status = 'enforced';
            existing.revision = params[0];
            existing.activated_by = params[1];
            existing.activated_at = new Date();
          }
          return { rows: existing ? [existing] : [] };
        }
        if (sql.includes('INSERT INTO studio_system_policy_audit')) {
          policyAudit.push({
            audit_id: params[0],
            organization_id: params[1],
            system_id: params[2],
            system_version: params[3],
            status: params[4],
            revision: params[5],
            actor_id: params[6],
            occurred_at: new Date(),
          });
          return { rows: [] };
        }
        if (sql.includes('SELECT 1 FROM enterprise_module_versions')) {
          const key = `${params[0]}:${params[1]}:${params[2]}`;
          return { rows: modules.has(key) ? [{ 1: 1 }] : [] };
        }
        if (sql.includes('FROM enterprise_module_workflows')) {
          const key = `${params[0]}:${params[1]}:${params[2]}`;
          const flows = moduleWorkflows.get(key) ?? [];
          return { rows: flows };
        }
        if (sql.includes('SELECT subject FROM directory_people')) {
          const key = `${params[0]}:${params[1]}`;
          const found = people.get(key);
          if (sql.includes('enabled=true')) {
            return { rows: found && found.enabled ? [found] : [] };
          }
          return { rows: found ? [found] : [] };
        }
        if (sql.includes('SELECT id FROM organization_departments')) {
          const key = `${params[0]}:${params[1]}`;
          const found = depts.get(key);
          return { rows: found ? [found] : [] };
        }
        if (sql.includes('FROM studio_system_grant_commands WHERE')) {
          const key = `${params[0]}:${params[1]}:${params[2]}`;
          const found = commands.get(key);
          return { rows: found ? [found] : [] };
        }
        if (sql.includes('INSERT INTO studio_system_grant_commands')) {
          const key = `${params[0]}:${params[1]}:${params[2]}`;
          commands.set(key, { fingerprint: params[3], result: JSON.parse(params[4]) });
          return { rows: [] };
        }
        if (sql.includes('FROM studio_system_grants') && sql.includes('FOR UPDATE')) {
          const key = `${params[0]}:${params[1]}:${params[2]}:${params[3]}:${params[4]}`;
          const found = grants.get(key);
          return { rows: found ? [found] : [] };
        }
        if (sql.includes('INSERT INTO studio_system_grants')) {
          const key = `${params[0]}:${params[1]}:${params[2]}:${params[3]}:${params[4]}`;
          const row = {
            systemId: params[1],
            systemVersion: params[2],
            principalType: params[3],
            principalId: params[4],
            roles: JSON.parse(params[5]),
            status: 'active',
            revision: 1,
            createdBy: params[6],
            createdAt: new Date(),
            updatedBy: params[6],
            updatedAt: new Date(),
          };
          grants.set(key, row);
          return { rows: [row] };
        }
        if (sql.includes('UPDATE studio_system_grants SET')) {
          if (sql.includes("status='revoked'")) {
            const key = `${params[2]}:${params[3]}:${params[4]}:${params[5]}:${params[6]}`;
            const existing = grants.get(key);
            if (existing) {
              existing.status = 'revoked';
              existing.revision = params[0];
            }
            return { rows: [existing] };
          } else {
            const key = `${params[3]}:${params[4]}:${params[5]}:${params[6]}:${params[7]}`;
            const existing = grants.get(key);
            if (existing) {
              existing.status = 'active';
              existing.roles = JSON.parse(params[0]);
              existing.revision = params[1];
            }
            return { rows: [existing] };
          }
        }
        if (sql.includes('INSERT INTO studio_system_grant_audit')) {
          audit.push({
            auditId: params[0],
            systemId: params[2],
            systemVersion: params[3],
            principalType: params[4],
            principalId: params[5],
            revision: params[6],
            actorId: params[7],
            operation: params[8],
            roles: JSON.parse(params[9]),
            status: params[10],
            occurredAt: new Date(),
          });
          return { rows: [] };
        }
        if (sql.includes('WITH caller AS')) {
          // Effective access single-query snapshot
          const org = params[0];
          const sub = params[1];
          const sysId = params[2];
          const ver = params[3];
          const person = people.get(`${org}:${sub}`);
          if (!person || !person.enabled) {
            return { rows: person ? [{ enabled: false, departmentId: person.departmentId, grants: [] }] : [] };
          }
          const activeGrants: any[] = [];
          const personGrant = grants.get(`${org}:${sysId}:${ver}:person:${sub}`);
          if (personGrant && personGrant.status === 'active') {
            activeGrants.push({ source: 'person', principalId: sub, roles: personGrant.roles });
          }
          if (person.departmentId) {
            const deptGrant = grants.get(`${org}:${sysId}:${ver}:department:${person.departmentId}`);
            if (deptGrant && deptGrant.status === 'active') {
              activeGrants.push({ source: 'department', principalId: person.departmentId, roles: deptGrant.roles });
            }
          }
          return {
            rows: [
              {
                enabled: true,
                departmentId: person.departmentId,
                grants: activeGrants,
              },
            ],
          };
        }
        if (sql.includes('SELECT') && sql.includes('FROM studio_system_grants')) {
          // List query
          const org = params[0];
          const sysId = params[1];
          const ver = params[2];
          const listRows: any[] = [];
          for (const [k, v] of grants.entries()) {
            if (k.startsWith(`${org}:${sysId}:${ver}:`) && v.status === 'active') {
              if (params.length > 5 && typeof params[3] === 'string' && ['person', 'department'].includes(params[3])) {
                if (v.principalType !== params[3]) continue;
              }
              const qParam = params.find(p => typeof p === 'string' && !['person', 'department', org, sysId, ver].includes(p));
              if (qParam && !v.principalId.toLowerCase().includes(qParam.toLowerCase())) {
                continue;
              }
              listRows.push(v);
            }
          }
          return { rows: listRows };
        }
        if (sql.includes('FROM studio_system_grant_audit')) {
          // History query
          const org = params[0];
          const sysId = params[1];
          const ver = params[2];
          const historyRows: any[] = [];
          for (const a of audit) {
            historyRows.push(a);
          }
          return { rows: historyRows };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };

    const pool = {
      query: client.query,
      connect: vi.fn(async () => client),
    };

    return { pool, client, grants, audit, commands, people, depts, modules, moduleWorkflows, policies, policyAudit };
  }

  const actor = {
    subject: 'admin',
    organizationId: 'org-a',
    roles: ['workflow:design', 'data:design'],
  };

  it('validates installed module version on list and history (fails 404 on unknown module)', async () => {
    const { pool } = createMockDb();
    const repo = await systemAccessDatabase(pool as any);

    await expect(
      repo.list('unknown-system', '1.0.0', actor, { limit: 10, offset: 0, q: '' })
    ).rejects.toThrow('System version not found or not installed.');

    await expect(
      repo.history('unknown-system', '1.0.0', actor, { limit: 10, offset: 0, q: '' })
    ).rejects.toThrow('System version not found or not installed.');
  });

  it('fails closed when module workflows are declared but unpublished, excluding service roles', async () => {
    const { pool, moduleWorkflows } = createMockDb();
    const repo = await systemAccessDatabase(pool as any);

    // 1. Unpublished definition -> 409
    moduleWorkflows.set('org-a:company-ops:1.0.0', [
      { definitionId: 'ops-req', definitionVersion: null, definition: null },
    ]);

    await expect(
      repo.grant(
        'company-ops',
        '1.0.0',
        { principalType: 'person', principalId: 'active-emp', roles: ['employee'] },
        actor,
        'k-unpub'
      )
    ).rejects.toThrow('Module workflow definitions are not published yet.');

    // 2. Empty roles (entity-only) is permitted even if workflows are unpublished
    const emptyGrant = await repo.grant(
      'company-ops',
      '1.0.0',
      { principalType: 'person', principalId: 'active-emp', roles: [] },
      actor,
      'k-empty-unpub'
    );
    expect(emptyGrant.roles).toEqual([]);

    // 3. Service execution role ('service:notifier') cannot be granted as a business role
    moduleWorkflows.set('org-a:company-ops:1.0.0', [
      { definitionId: 'ops-req', definitionVersion: 1, definition: declaredPublishedWorkflow },
    ]);
    await expect(
      repo.grant(
        'company-ops',
        '1.0.0',
        { principalType: 'person', principalId: 'active-emp', roles: ['service:notifier'] },
        actor,
        'k-svc'
      )
    ).rejects.toThrow("Role 'service:notifier' is not declared by this system version.");
  });

  it('handles safe literal search for percent, underscore, and backslash characters', async () => {
    const { pool, grants } = createMockDb();
    const repo = await systemAccessDatabase(pool as any);

    grants.set('org-a:company-ops:1.0.0:person:special%_\\emp', {
      systemId: 'company-ops',
      systemVersion: '1.0.0',
      principalType: 'person',
      principalId: 'special%_\\emp',
      roles: ['employee'],
      status: 'active',
      revision: 1,
      createdBy: 'admin',
      createdAt: new Date(),
      updatedBy: 'admin',
      updatedAt: new Date(),
    });

    const res = await repo.list('company-ops', '1.0.0', actor, {
      limit: 10,
      offset: 0,
      q: '%_\\',
    });
    expect(res.items).toHaveLength(1);
    expect(res.items[0].principalId).toBe('special%_\\emp');
  });

  it('revalidates principal active status on update and prevents updating deactivated users', async () => {
    const { pool, people } = createMockDb();
    const repo = await systemAccessDatabase(pool as any);

    // Grant active user
    await repo.grant(
      'company-ops',
      '1.0.0',
      { principalType: 'person', principalId: 'active-emp', roles: ['employee'] },
      actor,
      'k-up-deact-1'
    );

    // Deactivate user in directory
    people.set('org-a:active-emp', { subject: 'active-emp', enabled: false, departmentId: 'dept-1' });

    // Update must fail with 400
    await expect(
      repo.update(
        'company-ops',
        '1.0.0',
        'person',
        'active-emp',
        { expectedRevision: 1, roles: ['employee', 'procurement:manager'] },
        actor,
        'k-up-deact-2'
      )
    ).rejects.toThrow('Principal must be an active member of this organization.');
  });

  it('enforces cross-tenant and cross-version isolation', async () => {
    const { pool, grants } = createMockDb();
    const repo = await systemAccessDatabase(pool as any);

    // Grant in org-a version 1.0.0
    await repo.grant(
      'company-ops',
      '1.0.0',
      { principalType: 'person', principalId: 'active-emp', roles: ['employee'] },
      actor,
      'k-iso-1'
    );

    // Cross-version check: version 2.0.0 has 0 grants
    const v2List = await repo.list('company-ops', '2.0.0', actor, { limit: 10, offset: 0, q: '' });
    expect(v2List.items).toHaveLength(0);

    // Cross-tenant check: org-b admin cannot see org-a grants
    const orgBActor = { subject: 'admin', organizationId: 'org-b', roles: ['workflow:design', 'data:design'] };
    await expect(
      repo.list('company-ops', '1.0.0', orgBActor, { limit: 10, offset: 0, q: '' })
    ).rejects.toThrow('System version not found or not installed.');
  });

  it('preserves tombstone revisions on revoke and prevents ABA overwrite', async () => {
    const { pool } = createMockDb();
    const repo = await systemAccessDatabase(pool as any);

    const g1 = await repo.grant(
      'company-ops',
      '1.0.0',
      { principalType: 'person', principalId: 'active-emp', roles: ['employee'] },
      actor,
      'k-g1'
    );
    expect(g1.revision).toBe(1);

    // Revoke with wrong expectedRevision fails 409
    await expect(
      repo.revoke(
        'company-ops',
        '1.0.0',
        'person',
        'active-emp',
        { expectedRevision: 99 },
        actor,
        'k-rev-stale'
      )
    ).rejects.toThrow('Grant revision conflict; reload before revoking.');

    // Correct revoke increments to revision 2
    const rev = await repo.revoke(
      'company-ops',
      '1.0.0',
      'person',
      'active-emp',
      { expectedRevision: 1 },
      actor,
      'k-rev1'
    );
    expect(rev.revoked).toBe(true);
    expect(rev.revision).toBe(2);

    // Stale update with revision 1 fails 404/409
    await expect(
      repo.update(
        'company-ops',
        '1.0.0',
        'person',
        'active-emp',
        { expectedRevision: 1, roles: ['employee'] },
        actor,
        'k-stale-up'
      )
    ).rejects.toThrow();

    // Regrant increments revision from tombstone to 3
    const regrant = await repo.grant(
      'company-ops',
      '1.0.0',
      { principalType: 'person', principalId: 'active-emp', roles: ['employee'] },
      actor,
      'k-regrant'
    );
    expect(regrant.revision).toBe(3);
    expect(regrant.status).toBe('active');
  });

  it('detects key reuse conflict across different actions and targets', async () => {
    const { pool } = createMockDb();
    const repo = await systemAccessDatabase(pool as any);

    const input = { principalType: 'person' as const, principalId: 'active-emp', roles: ['employee'] };
    await repo.grant('company-ops', '1.0.0', input, actor, 'shared-key');

    // Replay same key against different target version -> 409
    await expect(
      repo.grant('company-ops', '2.0.0', input, actor, 'shared-key')
    ).rejects.toThrow('Idempotency-Key reuse conflict.');

    // Replay same key for update action -> 409
    await expect(
      repo.update('company-ops', '1.0.0', 'person', 'active-emp', { expectedRevision: 1, roles: ['employee'] }, actor, 'shared-key')
    ).rejects.toThrow('Idempotency-Key reuse conflict.');
  });

  it('single-query effectiveAccess returns union and handles deactivation atomically', async () => {
    const { pool, grants, people } = createMockDb();
    const repo = await systemAccessDatabase(pool as any);

    grants.set('org-a:company-ops:1.0.0:person:active-emp', {
      systemId: 'company-ops',
      systemVersion: '1.0.0',
      principalType: 'person',
      principalId: 'active-emp',
      roles: ['employee'],
      status: 'active',
      revision: 1,
    });
    grants.set('org-a:company-ops:1.0.0:department:dept-1', {
      systemId: 'company-ops',
      systemVersion: '1.0.0',
      principalType: 'department',
      principalId: 'dept-1',
      roles: ['procurement:manager'],
      status: 'active',
      revision: 1,
    });

    const empActor = { subject: 'active-emp', organizationId: 'org-a', roles: ['workflow:start'] };

    // Atomic union
    const access = await repo.effectiveAccess('company-ops', '1.0.0', empActor);
    expect(access).toBeDefined();
    expect(access.hasAccess).toBe(true);
    expect(access.effectiveRoles).toEqual(['employee', 'procurement:manager']);
    expect(access.sources).toHaveLength(2);
    expect(access.enforcementStatus).toBe('not_enforced');

    // Deactivation denies all immediately
    people.set('org-a:active-emp', { subject: 'active-emp', enabled: false, departmentId: 'dept-1' });
    const disabledAccess = await repo.effectiveAccess('company-ops', '1.0.0', empActor);
    expect(disabledAccess.hasAccess).toBe(false);
    expect(disabledAccess.effectiveRoles).toEqual([]);
    expect(disabledAccess.sources).toEqual([]);
  });

  describe('Phase 1B: Policy Activation, Role Isolation & Immediate Denial', () => {
    it('manages policy lifecycle with preflight verification and idempotency', async () => {
      const { pool, grants } = createMockDb();
      const repo = await systemAccessDatabase(pool as any);

      // 1. Initial state is legacy
      const initialPolicy = await repo.getPolicy('company-ops', '1.0.0', actor);
      expect(initialPolicy.status).toBe('legacy');
      expect(initialPolicy.revision).toBe(0);

      // 2. Preflight: fails if no active grants exist
      await expect(
        repo.activatePolicy('company-ops', '1.0.0', { expectedRevision: 0 }, actor, 'act-key-1')
      ).rejects.toThrow('Cannot activate policy: at least one active member grant is required.');

      // Seed an active grant
      await repo.grant(
        'company-ops',
        '1.0.0',
        { principalType: 'person', principalId: 'active-emp', roles: ['employee'] },
        actor,
        'grant-for-act'
      );

      // 3. Activation succeeds
      const activated = await repo.activatePolicy('company-ops', '1.0.0', { expectedRevision: 0 }, actor, 'act-key-1');
      expect(activated.status).toBe('enforced');
      expect(activated.revision).toBe(1);
      expect(activated.activatedBy).toBe('admin');

      // 4. Idempotent replay with same key
      const replay = await repo.activatePolicy('company-ops', '1.0.0', { expectedRevision: 0 }, actor, 'act-key-1');
      expect(replay.status).toBe('enforced');
      expect(replay.revision).toBe(1);

      // 5. Subsequent read returns enforced policy
      const pol = await repo.getPolicy('company-ops', '1.0.0', actor);
      expect(pol.status).toBe('enforced');
      expect(pol.revision).toBe(1);

      // 6. Effective access now reports enforced status
      const access = await repo.effectiveAccess('company-ops', '1.0.0', {
        subject: 'active-emp',
        organizationId: 'org-a',
        roles: ['workflow:start'],
      });
      expect(access.enforcementStatus).toBe('enforced');
    });

    it('isolates role scopes between systems A and B with identical role names', async () => {
      const { pool, modules, moduleWorkflows } = createMockDb();
      const repo = await systemAccessDatabase(pool as any);

      // Register system B in same organization
      modules.set('org-a:system-b:1.0.0', { id: 'system-b', version: '1.0.0', manifest: declaredManifest });
      moduleWorkflows.set('org-a:system-b:1.0.0', [
        { definitionId: 'b-req', definitionVersion: 1, definition: declaredPublishedWorkflow },
      ]);

      // Grant 'employee' in company-ops (System A) ONLY
      await repo.grant(
        'company-ops',
        '1.0.0',
        { principalType: 'person', principalId: 'active-emp', roles: ['employee'] },
        actor,
        'grant-sys-a'
      );

      const empActor = { subject: 'active-emp', organizationId: 'org-a', roles: ['workflow:start'] };

      // System A access has role 'employee'
      const accessA = await repo.effectiveAccess('company-ops', '1.0.0', empActor);
      expect(accessA.hasAccess).toBe(true);
      expect(accessA.effectiveRoles).toEqual(['employee']);

      // System B access has ZERO roles and hasAccess = false (no cross-system leakage!)
      const accessB = await repo.effectiveAccess('system-b', '1.0.0', empActor);
      expect(accessB.hasAccess).toBe(false);
      expect(accessB.effectiveRoles).toEqual([]);
    });

    it('immediately denies access on revocation without waiting for JWT expiration', async () => {
      const { pool } = createMockDb();
      const repo = await systemAccessDatabase(pool as any);

      // Grant role
      await repo.grant(
        'company-ops',
        '1.0.0',
        { principalType: 'person', principalId: 'active-emp', roles: ['employee'] },
        actor,
        'grant-rev-test'
      );

      const empActor = { subject: 'active-emp', organizationId: 'org-a', roles: ['workflow:start'] };
      const before = await repo.effectiveAccess('company-ops', '1.0.0', empActor);
      expect(before.hasAccess).toBe(true);
      expect(before.effectiveRoles).toEqual(['employee']);

      // Revoke grant
      await repo.revoke('company-ops', '1.0.0', 'person', 'active-emp', { expectedRevision: 1 }, actor, 'revoke-test-key');

      // Immediate denial even with the same JWT claims
      const after = await repo.effectiveAccess('company-ops', '1.0.0', empActor);
      expect(after.hasAccess).toBe(false);
      expect(after.effectiveRoles).toEqual([]);
      expect(after.sources).toEqual([]);
    });

    it('supports entity-only membership with empty roles', async () => {
      const { pool } = createMockDb();
      const repo = await systemAccessDatabase(pool as any);

      // Grant entity-only membership (roles: [])
      await repo.grant(
        'company-ops',
        '1.0.0',
        { principalType: 'person', principalId: 'active-emp', roles: [] },
        actor,
        'grant-entity-only'
      );

      const empActor = { subject: 'active-emp', organizationId: 'org-a', roles: ['data:read'] };
      const access = await repo.effectiveAccess('company-ops', '1.0.0', empActor);

      // Has active membership for entity access, but zero workflow business roles
      expect(access.hasAccess).toBe(true);
      expect(access.effectiveRoles).toEqual([]);
      expect(access.sources).toHaveLength(1);
      expect(access.sources[0].roles).toEqual([]);
    });
  });
});
