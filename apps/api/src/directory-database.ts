// SPDX-License-Identifier: Apache-2.0
import type { Pool } from 'pg';
import type { DirectoryRepository } from './directory.js';
export async function createDirectoryDatabase(pool:Pool):Promise<DirectoryRepository>{
  await pool.query(`CREATE TABLE IF NOT EXISTS directory_people (
    subject text NOT NULL, organization_id text NOT NULL, display_name text NOT NULL,
    department_id text, roles jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(roles)='array'),
    enabled boolean NOT NULL DEFAULT false, synced_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(subject, organization_id)
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS directory_people_active_idx ON directory_people(organization_id, display_name, subject) WHERE enabled=true');
  const columns='subject, organization_id AS "organizationId", display_name AS "displayName", department_id AS "departmentId", roles';
  const serialize=(row:any)=>({subject:row.subject,organizationId:row.organizationId,displayName:row.displayName,...(row.departmentId?{departmentId:row.departmentId}:{}),roles:row.roles});
  return {
    async find(subject,organizationId){const result=await pool.query(`SELECT ${columns} FROM directory_people WHERE subject=$1 AND organization_id=$2 AND enabled=true`,[subject,organizationId]);return result.rows[0]?serialize(result.rows[0]):undefined;},
    async list(organizationId,query){
      const values:unknown[]=[organizationId];const where=['organization_id=$1','enabled=true'];
      if(query.role){values.push(query.role);where.push(`roles ? $${values.length}`);}
      if(query.department){values.push(query.department);where.push(`department_id=$${values.length}`);}
      if(query.q){values.push(`%${query.q.replace(/[\\%_]/g,'\\$&')}%`);where.push(`display_name ILIKE $${values.length} ESCAPE '\\'`);}
      values.push(query.limit+1,query.offset);
      const result=await pool.query(`SELECT ${columns} FROM directory_people WHERE ${where.join(' AND ')} ORDER BY display_name, subject LIMIT $${values.length-1} OFFSET $${values.length}`,values);
      const hasMore=result.rows.length>query.limit;
      return {items:result.rows.slice(0,query.limit).map(serialize),page:{limit:query.limit,offset:query.offset,hasMore,nextOffset:hasMore?query.offset+query.limit:null}};
    }
  };
}
