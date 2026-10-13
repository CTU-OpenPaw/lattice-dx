// SPDX-License-Identifier: Apache-2.0
import { test, expect } from 'vitest';
import { createDirectoryDatabase } from './directory-database';
test('directory SQL scopes active membership and filters before stable bounded pagination',async()=>{
  const queries:{sql:string;values?:unknown[]}[]=[];
  const pool={async query(sql:string,values?:unknown[]){queries.push({sql,values});return {rows:sql.startsWith('SELECT')?[{subject:'b',organizationId:'org-a',displayName:'Bob',roles:[]},{subject:'c',organizationId:'org-a',displayName:'Carol',roles:[]}]:[]}}};
  const directory=await createDirectoryDatabase(pool as any);
  expect(queries[0].sql).toContain('CREATE TABLE IF NOT EXISTS directory_people');
  const result=await directory.list('org-a',{limit:1,offset:4,role:'warehouse',department:'wh',q:'B%_'});
  expect(result.items).toHaveLength(1);expect(result.page).toEqual({limit:1,offset:4,hasMore:true,nextOffset:5});
  const query=queries.at(-1)!;expect(query.sql).toContain('enabled=true');expect(query.sql).toContain('organization_id=$1');expect(query.sql).toContain('ORDER BY display_name, subject');expect(query.sql).toContain('LIMIT $5 OFFSET $6');expect(query.values).toEqual(['org-a','warehouse','wh','%B\\%\\_%',2,4]);
  await directory.find('bob','org-a');expect(queries.at(-1)!.sql).toContain('subject=$1 AND organization_id=$2 AND enabled=true');
});

test('department SQL counts active role-filtered members before paging and uses display-name fallback',async()=>{
  const queries:{sql:string;values?:unknown[]}[]=[];
  const pool={async query(sql:string,values?:unknown[]){queries.push({sql,values});return {rows:sql.startsWith('SELECT')?[{id:'it',name:'IT',memberCount:2},{id:'ops',name:'ops',memberCount:1}]:[]};}};
  const directory=await createDirectoryDatabase(pool as any);
  const result=await directory.departments!('org-a',{limit:1,offset:4,role:'tasks:decide',q:'IT'});
  expect(result.items).toEqual([{id:'it',name:'IT',memberCount:2}]);
  expect(result.page).toMatchObject({hasMore:true,nextOffset:5});
  const query=queries.at(-1)!;
  expect(query.sql).toContain('enabled=true');expect(query.sql).toContain('COALESCE');expect(query.sql).toContain('roles ? $2');expect(query.sql).toContain('GROUP BY');expect(query.values).toEqual(['org-a','tasks:decide','IT',2,4]);
});
