// SPDX-License-Identifier: Apache-2.0
// Real PostgreSQL acceptance for systemAccessDatabase & Fastify HTTP runtime enforcement in isolated disposable database.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { generateKeyPair, SignJWT } from 'jose';
import type { WorkflowActor } from '@dx/contracts';
import { connectRecords } from '../apps/api/src/database.js';
import { createApi } from '../apps/api/src/app.js';

const control = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
});
control.on('error', () => {});

const databaseName = 'access_accept_' + randomUUID().replaceAll('-', '');
let database: Awaited<ReturnType<typeof connectRecords>> | undefined;
let pool: Pool | undefined;
let app: ReturnType<typeof createApi> | undefined;

async function main() {
  assert.match(databaseName, /^access_accept_[a-f0-9]{32}$/);
  await control.query('CREATE DATABASE ' + databaseName);
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = '/' + databaseName;

  database = await connectRecords(url.href);
  pool = new Pool({ connectionString: url.href });
  pool.on('error', () => {});

  const org = 'org-accept';
  const systemId = 'procure-flow';
  const version = '1.0.0';

  // 1. Seed published system fixture
  const publishedWorkflowDef = {
    id: 'req-flow',
    version: 1,
    title: 'Requests Flow',
    startRole: 'employee',
    initialState: 'draft',
    startFields: {},
    readerRoles: ['procurement:manager'],
    transitions: [
      { id: 'approve', from: 'draft', to: 'approved', role: 'procurement:manager', fields: {} },
      { id: 'system-sync', from: 'approved', to: 'synced', role: 'procurement:sync', execution: 'service', fields: {} },
    ],
  };

  const schemaA = {
    id: 'purchase-order',
    title: 'Purchase Orders',
    fields: { poNumber: { type: 'text', required: true } },
    relations: {},
  };

  await pool.query(
    'INSERT INTO enterprise_module_versions(organization_id, id, version, title, hash, manifest, enabled, created_by) VALUES($1, $2, $3, $4, $5, $6, true, $7)',
    [
      org,
      systemId,
      version,
      'Procurement Flow',
      'hash-1',
      JSON.stringify({
        id: systemId,
        version,
        title: 'Procurement Flow',
        schemas: [schemaA],
        presentation: { entityPages: [] },
      }),
      'admin-usr',
    ]
  );

  await pool.query(
    'INSERT INTO workflow_definition_versions(organization_id, id, version, revision, definition, published_by) VALUES($1, $2, $3, 1, $4, $5)',
    [org, 'req-flow', 1, JSON.stringify(publishedWorkflowDef), 'admin-usr']
  );

  await pool.query(
    'INSERT INTO enterprise_module_workflows(organization_id, module_id, module_version, definition_id, definition_version) VALUES($1, $2, $3, $4, $5)',
    [org, systemId, version, 'req-flow', 1]
  );

  // Seed schema publication for purchase-order
  await pool.query(
    `INSERT INTO enterprise_schemas(organization_id, id, definition, revision, published_version, published_revision)
     VALUES($1, $2, '{"id":"purchase-order","title":"Purchase Orders","fields":{"poNumber":{"type":"text","required":true}},"relations":{}}'::jsonb, 1, 1, 1)`,
    [org, 'purchase-order']
  );
  await pool.query(
    `INSERT INTO enterprise_schema_versions(organization_id, schema_id, version, definition)
     VALUES($1, $2, 1, '{"id":"purchase-order","title":"Purchase Orders","fields":{"poNumber":{"type":"text","required":true}},"relations":{}}'::jsonb)`,
    [org, 'purchase-order']
  );

  // Seed directory people & department
  await pool.query(
    'INSERT INTO organization_departments(organization_id, id, name, version) VALUES($1, $2, $3, 1)',
    [org, 'dept-purchasing', 'Purchasing']
  );

  await pool.query(
    `INSERT INTO directory_people(subject, organization_id, display_name, department_id, roles, enabled)
     VALUES
       ('emp-alice', $1, 'Alice', 'dept-purchasing', '["workflow:start","data:write","data:read"]'::jsonb, true),
       ('emp-bob', $1, 'Bob', NULL, '["workflow:start","data:write","data:read"]'::jsonb, true),
       ('emp-scoped-mgr', $1, 'Scoped Manager', 'dept-purchasing', '["workflow:start","data:write","data:read"]'::jsonb, true),
       ('emp-disabled', $1, 'Disabled Dan', 'dept-purchasing', '["workflow:start"]'::jsonb, false),
       ('emp-non-member', $1, 'Non Member', NULL, '["workflow:start","data:write","data:read"]'::jsonb, true),
       ('user%special_\\1', $1, 'Special Search', 'dept-purchasing', '["workflow:start"]'::jsonb, true),
       ('admin-usr', $1, 'Admin User', NULL, '["workflow:design","data:design","data:write","data:read","workflow:start"]'::jsonb, true)
    `,
    [org]
  );

  const adminActor: WorkflowActor = {
    subject: 'admin-usr',
    organizationId: org,
    roles: ['workflow:design', 'data:design'],
  };

  const repo = database.systemAccess;

  // 2. Entity-only membership (empty roles)
  const gEntityOnly = await repo.grant(
    systemId,
    version,
    { principalType: 'person', principalId: 'emp-bob', roles: [] },
    adminActor,
    'k-ent-only'
  );
  assert.equal(gEntityOnly.status, 'active');
  assert.equal(gEntityOnly.revision, 1);
  assert.deepEqual(gEntityOnly.roles, []);

  // 3. Roles validation: business roles declared by published workflow allowed; service/reserved roles rejected
  const gAlice = await repo.grant(
    systemId,
    version,
    { principalType: 'person', principalId: 'emp-alice', roles: ['employee'] },
    adminActor,
    'k-alice-grant'
  );
  assert.equal(gAlice.status, 'active');
  assert.deepEqual(gAlice.roles, ['employee']);

  // Service execution transition role 'procurement:sync' must be rejected
  await assert.rejects(
    repo.grant(
      systemId,
      version,
      { principalType: 'person', principalId: 'emp-alice', roles: ['procurement:sync'] },
      adminActor,
      'k-service-role'
    ),
    /Role 'procurement:sync' is not declared by this system version/
  );

  // Reserved platform role rejected
  await assert.rejects(
    repo.grant(
      systemId,
      version,
      { principalType: 'person', principalId: 'emp-alice', roles: ['workflow:design'] },
      adminActor,
      'k-reserved-role'
    ),
    /Cannot grant reserved platform role/
  );

  // 4. Department grant & person+dept union
  await repo.grant(
    systemId,
    version,
    { principalType: 'department', principalId: 'dept-purchasing', roles: ['procurement:manager'] },
    adminActor,
    'k-dept-grant'
  );

  const aliceActor: WorkflowActor = {
    subject: 'emp-alice',
    organizationId: org,
    roles: ['workflow:start'],
  };

  const effAlice = await repo.effectiveAccess(systemId, version, aliceActor);
  assert.equal(effAlice.hasAccess, true);
  assert.deepEqual(effAlice.effectiveRoles, ['employee', 'procurement:manager']);
  assert.equal(effAlice.sources.length, 2);
  assert.equal(effAlice.enforcementStatus, 'not_enforced');

  // Disabled user gets immediate denial
  const disabledActor: WorkflowActor = {
    subject: 'emp-disabled',
    organizationId: org,
    roles: ['workflow:start'],
  };
  const effDisabled = await repo.effectiveAccess(systemId, version, disabledActor);
  assert.equal(effDisabled.hasAccess, false);
  assert.deepEqual(effDisabled.effectiveRoles, []);

  // 5. Update / Revoke / Regrant ABA prevention with tombstone revision
  const updatedAlice = await repo.update(
    systemId,
    version,
    'person',
    'emp-alice',
    { expectedRevision: 1, roles: ['employee'] },
    adminActor,
    'k-alice-update'
  );
  assert.equal(updatedAlice.revision, 2);
  assert.deepEqual(updatedAlice.roles, ['employee']);

  // Stale update with revision 1 rejected with 409
  await assert.rejects(
    repo.update(
      systemId,
      version,
      'person',
      'emp-alice',
      { expectedRevision: 1, roles: ['employee'] },
      adminActor,
      'k-alice-stale'
    ),
    /Grant revision conflict/
  );

  // Revoke sets tombstone revision 3
  const revokedAlice = await repo.revoke(
    systemId,
    version,
    'person',
    'emp-alice',
    { expectedRevision: 2 },
    adminActor,
    'k-alice-revoke'
  );
  assert.equal(revokedAlice.revision, 3);
  assert.equal(revokedAlice.revoked, true);

  // Alice effective access now retains only department-derived role
  const effAliceAfterRevoke = await repo.effectiveAccess(systemId, version, aliceActor);
  assert.equal(effAliceAfterRevoke.hasAccess, true);
  assert.deepEqual(effAliceAfterRevoke.effectiveRoles, ['procurement:manager']);
  assert.equal(effAliceAfterRevoke.sources.length, 1);

  // Regrant increments revision from tombstone to 4 (no ABA reset to 1)
  const regrantAlice = await repo.grant(
    systemId,
    version,
    { principalType: 'person', principalId: 'emp-alice', roles: ['employee'] },
    adminActor,
    'k-alice-regrant'
  );
  assert.equal(regrantAlice.revision, 4);
  assert.equal(regrantAlice.status, 'active');

  // 6. Same-key replay and conflict across target/action
  const replayAlice = await repo.grant(
    systemId,
    version,
    { principalType: 'person', principalId: 'emp-alice', roles: ['employee'] },
    adminActor,
    'k-alice-regrant'
  );
  assert.equal(replayAlice.revision, 4);

  await assert.rejects(
    repo.grant(
      systemId,
      '2.0.0',
      { principalType: 'person', principalId: 'emp-alice', roles: ['employee'] },
      adminActor,
      'k-alice-regrant'
    ),
    /Idempotency-Key reuse conflict/
  );

  // 7. Unknown version validation (fails 404)
  await assert.rejects(
    repo.list('procure-flow', '9.9.9', adminActor, { limit: 10, offset: 0 }),
    /System version not found or not installed/
  );

  // 8. Disabled update validation
  await assert.rejects(
    repo.grant(
      systemId,
      version,
      { principalType: 'person', principalId: 'emp-disabled', roles: ['employee'] },
      adminActor,
      'k-grant-disabled'
    ),
    /Principal must be an active member of this organization/
  );

  // 9. Literal q search with %, _, and \ characters
  await repo.grant(
    systemId,
    version,
    { principalType: 'person', principalId: 'user%special_\\1', roles: ['employee'] },
    adminActor,
    'k-grant-special'
  );

  const searchPercent = await repo.list(systemId, version, adminActor, { limit: 10, offset: 0, q: '%' });
  assert.equal(searchPercent.items.length, 1);
  assert.equal(searchPercent.items[0].principalId, 'user%special_\\1');

  const searchUnderscore = await repo.list(systemId, version, adminActor, { limit: 10, offset: 0, q: '_' });
  assert.equal(searchUnderscore.items.length, 1);
  assert.equal(searchUnderscore.items[0].principalId, 'user%special_\\1');

  const searchBackslash = await repo.list(systemId, version, adminActor, { limit: 10, offset: 0, q: '\\' });
  assert.equal(searchBackslash.items.length, 1);
  assert.equal(searchBackslash.items[0].principalId, 'user%special_\\1');

  // 10. Multi-page stable history
  const page1 = await repo.history(systemId, version, adminActor, { limit: 2, offset: 0, q: '' });
  assert.equal(page1.items.length, 2);
  assert.equal(page1.page.hasMore, true);
  assert.equal(page1.page.nextOffset, 2);

  const page2 = await repo.history(systemId, version, adminActor, { limit: 2, offset: 2, q: '' });
  assert.equal(page2.items.length, 2);
  const p1Ids = new Set(page1.items.map(i => i.auditId));
  assert.ok(!page2.items.some(i => p1Ids.has(i.auditId)));

  // 11. Rollback on errors
  const beforeCount = (await pool.query('SELECT count(*)::int AS n FROM studio_system_grants')).rows[0].n;
  await assert.rejects(
    repo.grant(
      systemId,
      version,
      { principalType: 'person', principalId: 'non-existent-user', roles: ['employee'] },
      adminActor,
      'k-fail-rollback'
    )
  );
  const afterCount = (await pool.query('SELECT count(*)::int AS n FROM studio_system_grants')).rows[0].n;
  assert.equal(afterCount, beforeCount);

  // 12. Identical-key concurrency: multiple concurrent calls with same key resolve cleanly to single receipt
  const updateInput = { expectedRevision: 1, roles: ['employee'] };
  const concurrentCalls = await Promise.all([
    repo.update(systemId, version, 'person', 'user%special_\\1', updateInput, adminActor, 'k-concur-test'),
    repo.update(systemId, version, 'person', 'user%special_\\1', updateInput, adminActor, 'k-concur-test'),
    repo.update(systemId, version, 'person', 'user%special_\\1', updateInput, adminActor, 'k-concur-test'),
  ]);
  assert.equal(concurrentCalls[0].revision, 2);
  assert.equal(concurrentCalls[0].revision, concurrentCalls[1].revision);
  assert.equal(concurrentCalls[1].revision, concurrentCalls[2].revision);

  // 13. Policy status report & preflight checks
  const initialPolicy = await repo.getPolicy(systemId, version, adminActor);
  assert.equal(initialPolicy.status, 'legacy');
  assert.equal(initialPolicy.revision, 0);

  // Preflight: unpublished workflow blocks policy activation
  await pool.query(
    `INSERT INTO enterprise_module_workflows(organization_id, module_id, module_version, definition_id, definition_version)
     VALUES($1, $2, $3, 'wf-unpub', NULL)`,
    [org, systemId, version]
  );
  await assert.rejects(
    repo.activatePolicy(systemId, version, { expectedRevision: 0 }, adminActor, 'k-act-unpub'),
    (err: any) => err.statusCode === 409 && err.message.includes('not published')
  );
  await pool.query(
    'DELETE FROM enterprise_module_workflows WHERE organization_id = $1 AND module_id = $2 AND definition_id = $3',
    [org, systemId, 'wf-unpub']
  );

  // CAS mismatch check: expectedRevision 1 when current is 0 throws 409
  await assert.rejects(
    repo.activatePolicy(systemId, version, { expectedRevision: 1 }, adminActor, 'k-act-cas-fail'),
    (err: any) => err.statusCode === 409 && err.message.includes('Policy revision conflict')
  );

  // 14. Policy activation, idempotency, audit trail & enforcementStatus reflection
  const activated = await repo.activatePolicy(systemId, version, { expectedRevision: 0 }, adminActor, 'k-act-1');
  assert.equal(activated.status, 'enforced');
  assert.equal(activated.revision, 1);
  assert.equal(activated.activatedBy, adminActor.subject);

  // Idempotent replay with same key
  const actReplay = await repo.activatePolicy(systemId, version, { expectedRevision: 0 }, adminActor, 'k-act-1');
  assert.equal(actReplay.status, 'enforced');
  assert.equal(actReplay.revision, 1);

  // Second activation with matching expectedRevision=1 when already enforced is a no-op: does not increment revision or duplicate audit
  const reAct = await repo.activatePolicy(systemId, version, { expectedRevision: 1 }, adminActor, 'k-act-2');
  assert.equal(reAct.status, 'enforced');
  assert.equal(reAct.revision, 1);

  const auditCount = (
    await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM studio_system_policy_audit WHERE organization_id = $1 AND system_id = $2 AND system_version = $3',
      [org, systemId, version]
    )
  ).rows[0].n;
  assert.equal(auditCount, 1);

  const currentPolicy = await repo.getPolicy(systemId, version, adminActor);
  assert.equal(currentPolicy.status, 'enforced');
  assert.equal(currentPolicy.revision, 1);

  const postActiveAccess = await repo.effectiveAccess(systemId, version, { subject: 'emp-alice', organizationId: org, roles: ['workflow:start'] });
  assert.equal(postActiveAccess.enforcementStatus, 'enforced');

  // =========================================================================
  // FASTIFY SIGNED HTTP ACCEPTANCE (PHASE 1B RUNTIME ENFORCEMENT)
  // =========================================================================
  const keys = await generateKeyPair('RS256');
  const identity = {
    issuer: 'accept-issuer',
    audience: 'api',
    key: async () => keys.publicKey,
  };

  app = createApi({
    workerUrl: 'http://localhost',
    identity,
    records: database.repository,
    systems: database.systems,
    systemAccess: database.systemAccess,
    modules: database.modules,
    workflows: database.workflows,
    definitionRegistry: database.definitionRegistry,
    foundation: database.foundation,
    directory: database.directory,
    organization: database.organization,
    entities: database.entities,
  });

  const sign = async (subject: string, roles: string[], userOrg = org) =>
    'Bearer ' +
    (await new SignJWT({ organization_id: userOrg, realm_access: { roles } })
      .setSubject(subject)
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer('accept-issuer')
      .setAudience('api')
      .setExpirationTime('1h')
      .sign(keys.privateKey));

  const httpCall = async (
    path: string,
    method = 'GET',
    payload?: unknown,
    token = '',
    expected = 200,
    key = randomUUID()
  ) => {
    const res = await app!.inject({
      method: method as any,
      url: path,
      headers: {
        authorization: token,
        'idempotency-key': key,
      },
      payload: payload ? (payload as any) : undefined,
    });
    if (res.statusCode !== expected) {
      throw new Error(`${method} ${path} failed with ${res.statusCode} (expected ${expected}): ${res.body}`);
    }
    return res.headers['content-type']?.includes('application/json')
      ? JSON.parse(res.body)
      : res.body;
  };

  const adminToken = await sign('admin-usr', ['workflow:design', 'data:design', 'data:write', 'data:read', 'workflow:start', 'files:read', 'files:write']);
  const aliceToken = await sign('emp-alice', ['workflow:start', 'tasks:assign', 'workflow:sync', 'data:write', 'data:read', 'files:read']);
  const nonMemberToken = await sign('emp-non-member', ['workflow:start', 'data:write', 'data:read', 'files:read']);
  const scopedMgrToken = await sign('emp-scoped-mgr', ['workflow:start', 'data:write', 'data:read', 'files:read']);

  // 15. System discovery / detail HTTP
  const sysDetail = await httpCall(`/v1/system-apps/${systemId}/versions/${version}`, 'GET', undefined, aliceToken, 200);
  assert.equal(sysDetail.id, systemId);
  assert.equal(sysDetail.version, version);

  const aliceMyAccess = await httpCall(`/v1/system-apps/${systemId}/versions/${version}/access/me`, 'GET', undefined, aliceToken, 200);
  assert.equal(aliceMyAccess.hasAccess, true);
  assert.equal(aliceMyAccess.enforcementStatus, 'enforced');

  // 16. Workflow Create, Read, Transition & Revocation with Old JWT
  // Alice starts a workflow run (emp-alice is active member with 'employee' role)
  const createdRun = await httpCall(
    '/v1/workflows',
    'POST',
    { definitionId: 'req-flow', title: 'Alice PO Request', input: {} },
    aliceToken,
    201
  );
  assert.equal(createdRun.ownerId, 'emp-alice');
  assert.equal(createdRun.state, 'draft');

  // Alice can read her own run
  const readRun = await httpCall(`/v1/workflows/${createdRun.id}`, 'GET', undefined, aliceToken, 200);
  assert.equal(readRun.id, createdRun.id);

  // 17. Scoped Manager List & Inbox (Manager has NO global business roles, only scoped grant)
  // emp-scoped-mgr has department grant for dept-purchasing which grants 'procurement:manager'
  const mgrList = await httpCall('/v1/workflows', 'GET', undefined, scopedMgrToken, 200);
  assert.ok(mgrList.items.some((r: any) => r.id === createdRun.id));

  const mgrInbox = await httpCall('/v1/workflows?inbox=true', 'GET', undefined, scopedMgrToken, 200);
  assert.ok(mgrInbox.items.some((r: any) => r.id === createdRun.id));

  // Scoped manager approves the run
  const approvedRun = await httpCall(
    `/v1/workflows/${createdRun.id}/transitions`,
    'POST',
    { action: 'approve', expectedVersion: createdRun.version, input: {} },
    scopedMgrToken,
    200
  );
  assert.equal(approvedRun.state, 'approved');

  // Create a managed workflow attachment file (owned by emp-alice, linked to run)
  const fileId = crypto.randomUUID();
  await pool.query(
    'INSERT INTO foundation_files(id, filename, owner_id, organization_id, content, size, scan_status) VALUES($1, $2, $3, $4, $5, $6, $7)',
    [fileId, 'po-doc.pdf', 'emp-alice', org, Buffer.from('test-doc'), 8, 'clean']
  );
  await pool.query(
    'INSERT INTO workflow_files(run_id, file_id) VALUES($1, $2)',
    [createdRun.id, fileId]
  );

  // Alice can read her owned file while she has active membership
  const aliceFileBefore = await httpCall(`/v1/files/${fileId}`, 'GET', undefined, aliceToken, 200);
  assert.equal(aliceFileBefore.id, fileId);

  // 18. Revoke Alice's membership & verify OLD JWT is immediately denied
  // Revoke person grant for Alice
  const aliceGrantRow = (await pool.query<{ revision: number }>(
    'SELECT revision FROM studio_system_grants WHERE organization_id = $1 AND system_id = $2 AND principal_id = $3 AND status = \'active\'',
    [org, systemId, 'emp-alice']
  )).rows[0];
  await httpCall(
    `/v1/systems/${systemId}/versions/${version}/members/person/emp-alice`,
    'DELETE',
    { expectedRevision: aliceGrantRow.revision },
    adminToken,
    200
  );

  // Also remove Alice from department dept-purchasing so she loses department grant
  await pool.query('UPDATE directory_people SET department_id = NULL WHERE organization_id = $1 AND subject = $2', [org, 'emp-alice']);

  // Alice immediately denied access to her run with her OLD (still non-expired) JWT!
  await httpCall(`/v1/workflows/${createdRun.id}`, 'GET', undefined, aliceToken, 404);

  // Exact oldJWT-after-revoke regressions for entityContext, retryJobs, cancel, task-transfer, and workflow-linked file reads
  await httpCall(`/v1/workflows/${createdRun.id}/entity-context`, 'GET', undefined, aliceToken, 404);
  await httpCall(`/v1/workflows/${createdRun.id}/sync/retry`, 'POST', undefined, aliceToken, 404);
  await httpCall(`/v1/workflows/${createdRun.id}/cancel`, 'POST', { expectedVersion: approvedRun.version, reason: 'Deny' }, aliceToken, 404);
  await httpCall(`/v1/workflows/${createdRun.id}/task-transfer`, 'POST', { taskId: fileId, expectedVersion: approvedRun.version, assigneeId: 'emp-scoped-mgr', reason: 'Deny' }, aliceToken, 404);
  await httpCall(`/v1/files/${fileId}`, 'GET', undefined, aliceToken, 404);

  // Verify authorized scoped manager without global businessrole CAN access workflow & linked file
  const mgrRun = await httpCall(`/v1/workflows/${createdRun.id}`, 'GET', undefined, scopedMgrToken, 200);
  assert.equal(mgrRun.id, createdRun.id);
  const mgrFile = await httpCall(`/v1/files/${fileId}`, 'GET', undefined, scopedMgrToken, 200);
  assert.ok(mgrFile);

  // 19. Entity create/query/update/share with scoped membership
  // Non-member with platform data:write attempts to create managed entity -> 404
  await httpCall(
    '/v1/entities',
    'POST',
    { schemaId: 'purchase-order', title: 'PO-001', attributes: { poNumber: 'PO-1001' } },
    nonMemberToken,
    404
  );

  // Member emp-scoped-mgr creates managed entity -> 201
  const createdEntity = await httpCall(
    '/v1/entities',
    'POST',
    { schemaId: 'purchase-order', title: 'PO-001', attributes: { poNumber: 'PO-1001' } },
    scopedMgrToken,
    201
  );
  assert.equal(createdEntity.schemaId, 'purchase-order');
  assert.equal(createdEntity.attributes.poNumber, 'PO-1001');

  // Scoped manager can read detail
  const readEntity = await httpCall(`/v1/entities/${createdEntity.id}`, 'GET', undefined, scopedMgrToken, 200);
  assert.equal(readEntity.id, createdEntity.id);

  // Non-member cannot read detail -> 404
  await httpCall(`/v1/entities/${createdEntity.id}`, 'GET', undefined, nonMemberToken, 404);

  // Scoped manager can update entity
  const updatedEntity = await httpCall(
    `/v1/entities/${createdEntity.id}`,
    'PATCH',
    { expectedVersion: createdEntity.version, title: 'PO-001 Updated', attributes: { poNumber: 'PO-1002' } },
    scopedMgrToken,
    200
  );
  assert.equal(updatedEntity.version, 2);
  assert.equal(updatedEntity.title, 'PO-001 Updated');

  // 20. Same-role A/B isolation: SysA vs SysB
  // Register second system 'logistics-flow' with same role name 'procurement:manager'
  await pool.query(
    'INSERT INTO enterprise_module_versions(organization_id, id, version, title, hash, manifest, enabled, created_by) VALUES($1, $2, $3, $4, $5, $6, true, $7)',
    [
      org,
      'logistics-flow',
      '1.0.0',
      'Logistics',
      'hash-2',
      JSON.stringify({ id: 'logistics-flow', version: '1.0.0', title: 'Logistics', presentation: { entityPages: [] } }),
      'admin-usr',
    ]
  );
  await pool.query(
    'INSERT INTO workflow_definition_versions(organization_id, id, version, revision, definition, published_by) VALUES($1, $2, $3, 1, $4, $5)',
    [org, 'logistics-req', 1, JSON.stringify({ ...publishedWorkflowDef, id: 'logistics-req' }), 'admin-usr']
  );
  await pool.query(
    'INSERT INTO enterprise_module_workflows(organization_id, module_id, module_version, definition_id, definition_version) VALUES($1, $2, $3, $4, $5)',
    [org, 'logistics-flow', '1.0.0', 'logistics-req', 1]
  );
  // Grant emp-bob membership in logistics-flow ONLY
  await repo.grant('logistics-flow', '1.0.0', { principalType: 'person', principalId: 'emp-bob', roles: ['procurement:manager'] }, adminActor, 'k-bob-log');
  await repo.activatePolicy('logistics-flow', '1.0.0', { expectedRevision: 0 }, adminActor, 'k-act-log');

  const bobToken = await sign('emp-bob', ['workflow:start', 'data:write', 'data:read']);

  // Bob can see logistics-flow with manager role, but has NO business roles in SysA (procure-flow)
  const bobSysB = await httpCall('/v1/system-apps/logistics-flow/versions/1.0.0/access/me', 'GET', undefined, bobToken, 200);
  assert.equal(bobSysB.hasAccess, true);
  assert.deepEqual(bobSysB.effectiveRoles, ['procurement:manager']);

  const bobSysA = await httpCall('/v1/system-apps/procure-flow/versions/1.0.0/access/me', 'GET', undefined, bobToken, 200);
  assert.deepEqual(bobSysA.effectiveRoles, []);

  const nonMemberSysA = await httpCall('/v1/system-apps/procure-flow/versions/1.0.0/access/me', 'GET', undefined, nonMemberToken, 200);
  assert.equal(nonMemberSysA.hasAccess, false);
  assert.deepEqual(nonMemberSysA.effectiveRoles, []);

  // Bob cannot read Alice's SysA run -> 404
  await httpCall(`/v1/workflows/${createdRun.id}`, 'GET', undefined, bobToken, 404);

  // 21. Shared schema ambiguity fail-closed
  // Declare 'shared-conflict-schema' in BOTH procure-flow and logistics-flow
  await pool.query(
    `UPDATE enterprise_module_versions
     SET manifest = jsonb_set(manifest, '{schemas}', '[{"id":"shared-conflict-schema","title":"Conflict"}]'::jsonb)
     WHERE organization_id = $1 AND id = 'procure-flow' AND version = '1.0.0'`,
    [org]
  );
  await pool.query(
    `UPDATE enterprise_module_versions
     SET manifest = jsonb_set(manifest, '{schemas}', '[{"id":"shared-conflict-schema","title":"Conflict"}]'::jsonb)
     WHERE organization_id = $1 AND id = 'logistics-flow' AND version = '1.0.0'`,
    [org]
  );
  // Attempt to create entity for ambiguous schema -> fails closed (404)
  await httpCall(
    '/v1/entities',
    'POST',
    { schemaId: 'shared-conflict-schema', title: 'Ambiguous', attributes: {} },
    scopedMgrToken,
    404
  );

  // 22. Legacy unmanaged workflow fallback
  // Unmanaged workflow (not in enterprise_module_workflows) continues legacy behavior
  await pool.query(
    'INSERT INTO workflow_definition_versions(organization_id, id, version, revision, definition, published_by) VALUES($1, $2, $3, 1, $4, $5)',
    [
      org,
      'legacy-flow',
      1,
      JSON.stringify({
        id: 'legacy-flow',
        version: 1,
        title: 'Legacy Flow',
        startRole: 'employee',
        initialState: 'draft',
        startFields: {},
        readerRoles: [],
        transitions: [],
      }),
      'admin-usr',
    ]
  );
  const legacyBob = await sign('emp-bob', ['workflow:start', 'employee']);
  const legacyRun = await httpCall(
    '/v1/workflows',
    'POST',
    { definitionId: 'legacy-flow', title: 'Legacy Bob Run', input: {} },
    legacyBob,
    201
  );
  assert.equal(legacyRun.ownerId, 'emp-bob');
  const legacyRead = await httpCall(`/v1/workflows/${legacyRun.id}`, 'GET', undefined, legacyBob, 200);
  assert.equal(legacyRead.id, legacyRun.id);

  console.log(
    'System access PostgreSQL & Fastify HTTP acceptance passed: isolated database, real SQL & signed HTTP runtime enforcement, discovery/detail, scoped manager list/inbox without global business roles, workflow create/transition, old JWT immediate denial on revocation, entity create/query/update/share, same-role A/B isolation, shared schema ambiguity fail closed, person+department union, disabled user denial, platform prerequisites, idempotent CAS policy activation, and legacy fallback.'
  );
}

main()
  .catch(err => {
    console.error('System access PostgreSQL acceptance failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await app?.close();
    await database?.close();
    await pool?.end();
    await control.query('DROP DATABASE IF EXISTS ' + databaseName + ' WITH (FORCE)');
    await control.end();
  });
