// SPDX-License-Identifier: Apache-2.0
// Real PostgreSQL acceptance for systemAccessDatabase in isolated schema.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { WorkflowActor } from '@dx/contracts';
import { systemAccessDatabase } from '../apps/api/src/systems/access-database.js';

const admin = new Pool({ connectionString: process.env.DATABASE_URL });
const schema = 'sys_accept_' + randomUUID().replaceAll('-', '');
let pool: Pool | undefined;

async function main() {
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    options: `-c search_path=${schema}`,
    max: 5,
  });

  // Minimum required table dependencies for systemAccessDatabase under test schema
  await pool.query(`
    CREATE TABLE IF NOT EXISTS directory_people (
      subject text PRIMARY KEY,
      organization_id text NOT NULL,
      display_name text NOT NULL,
      department_id text,
      roles jsonb NOT NULL DEFAULT '[]'::jsonb,
      enabled boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS organization_departments (
      id text PRIMARY KEY,
      organization_id text NOT NULL,
      name text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS workflow_references (
      organization_id text NOT NULL,
      kind text NOT NULL,
      id text NOT NULL,
      display_name text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (organization_id, kind, id)
    );
    CREATE TABLE IF NOT EXISTS enterprise_module_versions (
      organization_id text NOT NULL,
      id text NOT NULL,
      version text NOT NULL,
      manifest jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (organization_id, id, version)
    );
    CREATE TABLE IF NOT EXISTS enterprise_module_workflows (
      organization_id text NOT NULL,
      module_id text NOT NULL,
      module_version text NOT NULL,
      workflow_name text NOT NULL,
      definition_id text NOT NULL,
      definition_version integer,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (organization_id, module_id, module_version, workflow_name)
    );
    CREATE TABLE IF NOT EXISTS workflow_definition_versions (
      organization_id text NOT NULL,
      id text NOT NULL,
      version integer NOT NULL,
      definition jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (organization_id, id, version)
    );
  `);

  // 1. Seed published system fixture
  const org = 'org-accept';
  const systemId = 'procure-flow';
  const version = '1.0.0';

  await pool.query(
    'INSERT INTO enterprise_module_versions(organization_id, id, version, manifest) VALUES($1, $2, $3, $4)',
    [
      org,
      systemId,
      version,
      JSON.stringify({
        id: systemId,
        version,
        title: 'Procurement Flow',
      }),
    ]
  );

  const publishedWorkflowDef = {
    id: 'req-flow',
    startRole: 'employee',
    readerRoles: ['procurement:auditor'],
    transitions: [
      { action: 'approve', role: 'procurement:manager' },
      { action: 'system-sync', role: 'procurement:sync', execution: 'service' },
    ],
  };

  await pool.query(
    'INSERT INTO workflow_definition_versions(organization_id, id, version, definition) VALUES($1, $2, $3, $4)',
    [org, 'req-flow', 1, JSON.stringify(publishedWorkflowDef)]
  );

  await pool.query(
    'INSERT INTO enterprise_module_workflows(organization_id, module_id, module_version, workflow_name, definition_id, definition_version) VALUES($1, $2, $3, $4, $5, $6)',
    [org, systemId, version, 'requests', 'req-flow', 1]
  );

  // Seed directory people & department
  await pool.query(
    'INSERT INTO organization_departments(id, organization_id, name) VALUES($1, $2, $3)',
    ['dept-purchasing', org, 'Purchasing']
  );

  await pool.query(
    `INSERT INTO directory_people(subject, organization_id, display_name, department_id, roles, enabled)
     VALUES
       ('emp-alice', $1, 'Alice', 'dept-purchasing', '["workflow:start"]'::jsonb, true),
       ('emp-bob', $1, 'Bob', NULL, '["workflow:start"]'::jsonb, true),
       ('emp-disabled', $1, 'Disabled Dan', 'dept-purchasing', '["workflow:start"]'::jsonb, false),
       ('user%special_\\1', $1, 'Special Search', 'dept-purchasing', '["workflow:start"]'::jsonb, true)
    `,
    [org]
  );

  const adminActor: WorkflowActor = {
    subject: 'admin-usr',
    organizationId: org,
    roles: ['workflow:design', 'data:design'],
  };

  const repo = await systemAccessDatabase(pool);

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
    { principalType: 'person', principalId: 'emp-alice', roles: ['employee', 'procurement:auditor'] },
    adminActor,
    'k-alice-grant'
  );
  assert.equal(gAlice.status, 'active');
  assert.deepEqual(gAlice.roles, ['employee', 'procurement:auditor']);

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
  assert.deepEqual(effAlice.effectiveRoles, ['employee', 'procurement:auditor', 'procurement:manager']);
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
  // Same key replay returns exact cached receipt
  const replayAlice = await repo.grant(
    systemId,
    version,
    { principalType: 'person', principalId: 'emp-alice', roles: ['employee'] },
    adminActor,
    'k-alice-regrant'
  );
  assert.equal(replayAlice.revision, 4);

  // Same key across different action or version throws 409
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
  // Guarantee stable deterministic order without overlap
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
  const updateInput = { expectedRevision: 1, roles: ['procurement:auditor'] };
  const concurrentCalls = await Promise.all([
    repo.update(systemId, version, 'person', 'user%special_\\1', updateInput, adminActor, 'k-concur-test'),
    repo.update(systemId, version, 'person', 'user%special_\\1', updateInput, adminActor, 'k-concur-test'),
    repo.update(systemId, version, 'person', 'user%special_\\1', updateInput, adminActor, 'k-concur-test'),
  ]);
  assert.equal(concurrentCalls[0].revision, 2);
  assert.equal(concurrentCalls[0].revision, concurrentCalls[1].revision);
  assert.equal(concurrentCalls[1].revision, concurrentCalls[2].revision);

  console.log(
    'System access PostgreSQL acceptance passed: isolated schema, published fixture, entity-only membership, business roles whitelisted/services excluded, person+dept union, tombstone ABA protection, idempotent replay/conflict, unknown version 404, disabled rejection, literal %/_/\\ matching, stable paginated history, transaction rollback, and concurrent advisory locking.'
  );
}

main()
  .catch(err => {
    console.error('System access PostgreSQL acceptance failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool?.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });
