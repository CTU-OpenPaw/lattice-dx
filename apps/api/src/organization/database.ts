/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { pageResult } from '../pagination.js';
import { departmentId, mandatoryKey, OrganizationError, parseDepartmentCreate, parseDepartmentUpdate, parseSnapshot, requireManager } from './policy.js';
import type { Department, DepartmentInput, OrganizationActor, OrganizationRepository } from './types.js';
const columns='id,name,parent_id AS "parentId",manager_id AS "managerId",version,created_at AS "createdAt",updated_at AS "updatedAt"';
const serialize=(row:any):Department=>({
  ...row,createdAt:new Date(row.createdAt).toISOString(),updatedAt:new Date(row.updatedAt).toISOString()
});
export async function organizationDatabase(pool:Pool):Promise<OrganizationRepository>{
  await pool.query(`CREATE TABLE IF NOT EXISTS organization_departments(organization_id text NOT NULL,id text NOT NULL,name text NOT NULL,parent_id text,manager_id text,version integer NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(organization_id,id));
 CREATE TABLE IF NOT EXISTS organization_department_audit(organization_id text NOT NULL,id text NOT NULL,version integer NOT NULL,actor_id text NOT NULL,operation text NOT NULL,metadata jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(organization_id,id,version));
 CREATE TABLE IF NOT EXISTS organization_directory_state(organization_id text PRIMARY KEY,revision integer NOT NULL DEFAULT 0,updated_at timestamptz);
 CREATE TABLE IF NOT EXISTS organization_snapshot_audit(organization_id text NOT NULL,revision integer NOT NULL,actor_id text NOT NULL,change_count integer NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(organization_id,revision));
 CREATE TABLE IF NOT EXISTS organization_commands(organization_id text NOT NULL,actor_id text NOT NULL,operation text NOT NULL,key text NOT NULL,fingerprint text NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(organization_id,actor_id,operation,key));`);
  async function command<T>(actor:OrganizationActor,operation:string,key:string,input:unknown,write:(client:PoolClient)=>Promise<T>):Promise<T>{
    requireManager(actor);
    mandatoryKey(key);
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      const lock=createHash('sha256').update(JSON.stringify(['organization',actor.organizationId])).digest().readBigInt64BE(0).toString();
      await client.query('SELECT pg_advisory_xact_lock($1::bigint)',[lock]);
      const tuple=[actor.organizationId,actor.subject,operation,key];
      const fingerprint=createHash('sha256').update(JSON.stringify(input)).digest('hex');
      const receipt=(await client.query('SELECT fingerprint,result FROM organization_commands WHERE organization_id=$1 AND actor_id=$2 AND operation=$3 AND key=$4',tuple)).rows[0];
      if (receipt){
        if (receipt.fingerprint!==fingerprint)throw new OrganizationError(409,'Idempotency key conflict.');
        await client.query('COMMIT');
        return receipt.result;
      }
      const result=await write(client);
      await client.query('INSERT INTO organization_commands(organization_id,actor_id,operation,key,fingerprint,result) VALUES($1,$2,$3,$4,$5,$6::jsonb)',[...tuple,fingerprint,JSON.stringify(result)]);
      await client.query('COMMIT');
      return result;
    } catch (error){
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async function references(client:PoolClient,org:string,id:string,input:DepartmentInput){
    if (input.managerId){
      const manager=await client.query('SELECT subject FROM directory_people WHERE organization_id=$1 AND subject=$2 AND enabled=true FOR SHARE',[org,input.managerId]);
      if (!manager.rows.length)throw new OrganizationError(400,'Manager must be an active member of this organization.');
    }
    const rows=(await client.query('SELECT id,parent_id AS "parentId" FROM organization_departments WHERE organization_id=$1',[org])).rows;
    const graph=new Map<string,string|null>(rows.map(r=>[r.id,r.parentId]));
    if (input.parentId&&!graph.has(input.parentId)){
      const foreign=(await client.query('SELECT id FROM organization_departments WHERE organization_id<>$1 AND id=$2 LIMIT 1',[org,input.parentId])).rows.length;
      throw new OrganizationError(foreign?404:400,'Parent department does not exist.');
    }
    graph.set(id,input.parentId);
    for (const start of graph.keys()){
      let current:string|null=start,depth=0;
      const seen=new Set<string>();
      while (current!==null){
        if (seen.has(current))throw new OrganizationError(409,'Department cycle.');
        seen.add(current);
        if (++depth>20)throw new OrganizationError(409,'Department hierarchy exceeds depth 20.');
        current=graph.get(current)??null;
      }
    }
  }
  async function audit(client:PoolClient,actor:OrganizationActor,department:Department,operation:string){
    await client.query('INSERT INTO organization_department_audit(organization_id,id,version,actor_id,operation,metadata) VALUES($1,$2,$3,$4,$5,$6::jsonb)',[actor.organizationId,department.id,department.version,actor.subject,operation,JSON.stringify(department)]);
  }
  return {
    async createDepartment(actor,value,key){
      const input=parseDepartmentCreate(value);
      return command(actor,'department.create',key,input,async client=>{
        const existing=await client.query('SELECT id FROM organization_departments WHERE organization_id=$1 AND id=$2',[actor.organizationId,input.id]);
        if (existing.rows.length)throw new OrganizationError(409,'Department already exists.');
        await references(client,actor.organizationId,input.id,input);
        const department=serialize((await client.query(`INSERT INTO organization_departments(organization_id,id,name,parent_id,manager_id,version) VALUES($1,$2,$3,$4,$5,1) RETURNING ${columns}`,[actor.organizationId,input.id,input.name,input.parentId,input.managerId])).rows[0]);
        await audit(client,actor,department,'create');
        return department;
      });
    },
    async updateDepartment(actor,id,value,key){
      id=departmentId(id);
      const input=parseDepartmentUpdate(value);
      return command(actor,`department.update:${id}`,key,input,async client=>{
        const current=(await client.query('SELECT version FROM organization_departments WHERE organization_id=$1 AND id=$2',[actor.organizationId,id])).rows[0];
        if (!current)throw new OrganizationError(404,'Department not found.');
        if (current.version!==input.expectedVersion)throw new OrganizationError(409,'Department version conflict.');
        await references(client,actor.organizationId,id,input);
        const department=serialize((await client.query(`UPDATE organization_departments SET name=$3,parent_id=$4,manager_id=$5,version=version+1,updated_at=now() WHERE organization_id=$1 AND id=$2 RETURNING ${columns}`,[actor.organizationId,id,input.name,input.parentId,input.managerId])).rows[0]);
        await audit(client,actor,department,'update');
        return department;
      });
    },
    async listDepartments(org,query){
      return pageResult((await pool.query(`SELECT ${columns} FROM organization_departments WHERE organization_id=$1 AND ($2='' OR strpos(lower(name),lower($2))>0 OR strpos(id,$2)>0) ORDER BY name,id LIMIT $3 OFFSET $4`,[org,query.q,query.limit+1,query.offset])).rows.map(serialize),query);
    },
    async departmentHistory(org,id,query){
      departmentId(id);
      const target=await pool.query('SELECT id FROM organization_departments WHERE organization_id=$1 AND id=$2',[org,id]);
      if (!target.rows.length)throw new OrganizationError(404,'Department not found.');
      return pageResult((await pool.query('SELECT metadata,actor_id AS "actorId",operation FROM organization_department_audit WHERE organization_id=$1 AND id=$2 ORDER BY version DESC LIMIT $3 OFFSET $4',[org,id,query.limit+1,query.offset])).rows.map(r=>({
        ...r.metadata,actorId:r.actorId,operation:r.operation
      })),query);
    },
    async directoryState(org){
      const row=(await pool.query('SELECT revision,updated_at AS "updatedAt" FROM organization_directory_state WHERE organization_id=$1',[org])).rows[0];
      return row?{
        revision:row.revision,updatedAt:row.updatedAt?new Date(row.updatedAt).toISOString():null
      }:{
        revision:0,updatedAt:null
      };
    },
    async replaceSnapshot(actor,value,key){
      const input=parseSnapshot(value);
      return command(actor,'directory.replaceSnapshot',key,input,async client=>{
        // Acquire the directory gate before any person row. Existing transactions
        // may hold source/service and recipient rows in different orders.
        // Plain reads remain available; snapshots wait for locking consumers.
        await client.query('LOCK TABLE directory_people IN EXCLUSIVE MODE');
        await client.query('INSERT INTO organization_directory_state(organization_id) VALUES($1) ON CONFLICT DO NOTHING',[actor.organizationId]);
        const current=(await client.query('SELECT revision FROM organization_directory_state WHERE organization_id=$1 FOR UPDATE',[actor.organizationId])).rows[0];
        if (current.revision!==input.expectedRevision)throw new OrganizationError(409,'Directory revision conflict.');
        let changeCount=0;
        for (const p of input.people){
          const result=await client.query(`INSERT INTO directory_people(subject,organization_id,display_name,department_id,roles,enabled,synced_at) VALUES($1,$2,$3,$4,$5::jsonb,$6,now()) ON CONFLICT(subject,organization_id) DO UPDATE SET display_name=EXCLUDED.display_name,department_id=EXCLUDED.department_id,roles=EXCLUDED.roles,enabled=EXCLUDED.enabled,synced_at=now() WHERE (directory_people.display_name,directory_people.department_id,directory_people.roles,directory_people.enabled) IS DISTINCT FROM (EXCLUDED.display_name,EXCLUDED.department_id,EXCLUDED.roles,EXCLUDED.enabled)`,[p.subject,actor.organizationId,p.displayName,p.departmentId??null,JSON.stringify(p.roles),p.enabled]);
          changeCount+=result.rowCount??0;
        }
        changeCount+=(await client.query('UPDATE directory_people SET enabled=false,synced_at=now() WHERE organization_id=$1 AND enabled=true AND NOT(subject=ANY($2::text[]))',[actor.organizationId,input.people.map(p=>p.subject)])).rowCount??0;
        const row=(await client.query('UPDATE organization_directory_state SET revision=revision+1,updated_at=now() WHERE organization_id=$1 RETURNING revision,updated_at AS "updatedAt"',[actor.organizationId])).rows[0];
        await client.query('INSERT INTO organization_snapshot_audit(organization_id,revision,actor_id,change_count) VALUES($1,$2,$3,$4)',[actor.organizationId,row.revision,actor.subject,changeCount]);
        return {
          revision:row.revision,updatedAt:new Date(row.updatedAt).toISOString(),changeCount
        };
      });
    }
  };
}
