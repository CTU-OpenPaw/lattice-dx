// SPDX-License-Identifier: Apache-2.0
import { test, expect } from 'vitest';
// @ts-expect-error JavaScript-only local script module.
import { snapshotPerson, snapshotSql } from '../../../scripts/directory-snapshot.mjs';
test('snapshot uses actual subject/scope, actual roles, authoritative enabled and admin-only department',()=>{
  const user={id:'actual-sub',username:'warehouse',enabled:false,firstName:'Kho',lastName:'A',attributes:{organization_id:['org-a'],department_id:['user-injected']},credentials:[{value:'secret'}]};
  expect(snapshotPerson(user,['department:warehouse','logistics:warehouse'],false)).toEqual({subject:'actual-sub',organizationId:'org-a',displayName:'Kho A',departmentId:'warehouse',enabled:false,roles:['department:warehouse','logistics:warehouse']});
  expect(snapshotPerson(user,[],true).departmentId).toBe('user-injected');
  expect(snapshotPerson({...user,attributes:{}},[],false)).toBeUndefined();
});
test('snapshot transaction disables removed members and upserts escaped values without credentials',()=>{
  const sql=snapshotSql([{subject:'id',organizationId:'org-a',displayName:"O'Brien",roles:['role'],enabled:true}]);
  expect(sql).toContain('BEGIN;');expect(sql).toContain('pg_advisory_xact_lock');expect(sql).toContain('UPDATE directory_people SET enabled=false');expect(sql).toContain('ON CONFLICT(subject,organization_id) DO UPDATE');expect(sql).toContain("O''Brien");expect(sql).toContain('COMMIT;');expect(sql).not.toContain('secret');
  expect(snapshotSql([])).toContain('UPDATE directory_people SET enabled=false');
});
