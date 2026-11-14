/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
export function snapshotPerson(user,roles,adminDepartment=false){
  const organizationId=user.attributes?.organization_id?.[0];
  if(typeof user.id!=='string'||!user.id||typeof organizationId!=='string'||! /^[a-zA-Z0-9_-]{1,80}$/.test(organizationId))return undefined;
  const managedDepartment=adminDepartment?user.attributes?.department_id?.[0]:undefined;
  const knownDepartments=['warehouse','hr','it','administration'];
  const departments=knownDepartments.filter(name=>roles.includes(`department:${name}`));
  const departmentId=typeof managedDepartment==='string'&& /^[a-zA-Z0-9_-]{1,80}$/.test(managedDepartment)?managedDepartment:departments.length===1?departments[0]:undefined;
  return {subject:user.id,organizationId,displayName:[user.firstName,user.lastName].filter(value=>typeof value==='string'&&value.trim()).join(' ').trim()||user.username||user.id,...(departmentId?{departmentId}:{}),roles:[...new Set(roles.filter(role=>typeof role==='string'))].sort(),enabled:user.enabled===true};
}
export function snapshotSql(people){
  const literal=value=>"'"+String(value).replace(/'/g,"''")+"'";
  const inserts=people.map(person=>`INSERT INTO directory_people(subject,organization_id,display_name,department_id,roles,enabled,synced_at) VALUES (${literal(person.subject)},${literal(person.organizationId)},${literal(person.displayName)},${person.departmentId?literal(person.departmentId):'NULL'},${literal(JSON.stringify(person.roles))}::jsonb,${person.enabled?'true':'false'},now()) ON CONFLICT(subject,organization_id) DO UPDATE SET display_name=EXCLUDED.display_name,department_id=EXCLUDED.department_id,roles=EXCLUDED.roles,enabled=EXCLUDED.enabled,synced_at=EXCLUDED.synced_at;`);
  return `BEGIN;\nSET LOCAL standard_conforming_strings=on;\nSELECT pg_advisory_xact_lock(78134026);\nUPDATE directory_people SET enabled=false,synced_at=now();\n${inserts.join('\n')}\nCOMMIT;\n`;
}
