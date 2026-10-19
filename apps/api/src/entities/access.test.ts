// SPDX-License-Identifier: Apache-2.0
import { expect, test } from 'vitest';
import { accessPredicate, checkAccess } from './access.js';
import type { PoolClient } from 'pg';
const scope={actorId:'bob',organizationId:'org-a'};
const row={ownerId:'alice',organizationId:'org-a'};
test('SQL predicate keeps tenant and active directory membership in all shared reads',()=>{
 const sql=accessPredicate('e','$2','$1','read');
 expect(sql).toContain('e.organization_id=$1');expect(sql).toContain('p.enabled=true');expect(sql).toContain('p.department_id=g.principal_id');
 expect(accessPredicate('e','$2','$1','edit')).toContain("g.permission='edit'");
});
test('shared writes lock current active directory row and hide missing permissions',async()=>{
 const statements:string[]=[];
 let allowed=true;
 const db={query:async(sql:string)=>{statements.push(sql);return {rows:allowed?[{subject:'bob'}]:[]};}} as unknown as PoolClient;
 await checkAccess(db,scope,row,'edit');expect(statements[0]).toContain('FOR SHARE');expect(statements[0]).toContain("g.permission='edit'");
 allowed=false;await expect(checkAccess(db,scope,row,'edit')).rejects.toMatchObject({statusCode:404});
 await expect(checkAccess(db,scope,row,'owner')).rejects.toMatchObject({statusCode:404});
});
