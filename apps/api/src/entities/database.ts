// SPDX-License-Identifier: Apache-2.0
import type { Pool, PoolClient } from 'pg';
import { accessPredicate, checkAccess, type AccessMode } from './access.js';
import {compileEntityQuery,parseEntityQuery} from './query.js';
import {aggregateEntitiesWithClient} from './aggregate-database.js';
import {searchEntities} from './search-client.js';
import { createDirectoryDatabase } from '../directory-database.js';
import {initializeEntityEvents,type EntityEvent} from './events.js';
import { parseCreateKey } from '../create-command.js';
import { pageResult, type PageQuery } from '../pagination.js';
import { bad, EntityError, parseSchema, parseShare, principalKind, principalId, title, uuid, version } from './policy.js';
import type { Entity, EntityAudit, EntityRepository, RelationInput, SchemaDraft, SchemaPublication, Scope, Share, ShareInput, RevokeShareInput } from './types.js';

import { withEntityTransaction as transaction, runEntityCommandInTransaction } from './commands.js';
import { entityColumns, entity, current, scopedEntity, publication, updateRow, missing, createEntityAtPublication, lockEntities, applyEntityUpdateWithClient, applyEntityArchiveWithClient, applyEntityRelationWithClient } from './client.js';
type Queryable = Pick<PoolClient,'query'>;
function draft(row:{definition:SchemaDraft;revision:number;publishedVersion:number;createdAt:string;updatedAt:string}):SchemaDraft {
  return {...row.definition,revision:row.revision,publishedVersion:row.publishedVersion,createdAt:new Date(row.createdAt).toISOString(),updatedAt:new Date(row.updatedAt).toISOString()};
}
const draftColumns=`definition, revision, published_version AS "publishedVersion", created_at AS "createdAt", updated_at AS "updatedAt"`;
export async function runEntityCommand<T>(pool:Pool,scope:Scope,operation:string,key:string,input:unknown,validate:(client:PoolClient)=>Promise<void>,execute:(client:PoolClient)=>Promise<T>,validateReplay?:(client:PoolClient,result:T)=>Promise<void>):Promise<T> {
  if(!parseCreateKey(key)) bad('Idempotency-Key is required.');
  return transaction(pool,client=>runEntityCommandInTransaction(client,scope,operation,key,input,validate,execute,validateReplay));
}

function validatePage(page:PageQuery) {
  if(!Number.isSafeInteger(page.limit)||page.limit<1||page.limit>100||!Number.isSafeInteger(page.offset)||page.offset<0||page.offset>Number.MAX_SAFE_INTEGER-101||typeof page.q!=='string'||Array.from(page.q).length>200) bad('Invalid pagination.');
}

export async function entityDatabase(pool:Pool):Promise<EntityRepository> {
  await createDirectoryDatabase(pool);
  await pool.query(`CREATE TABLE IF NOT EXISTS enterprise_schemas (
    organization_id text NOT NULL, id text NOT NULL, definition jsonb NOT NULL, revision integer NOT NULL DEFAULT 1,
    published_version integer NOT NULL DEFAULT 0, published_revision integer,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(organization_id,id)
  );
  CREATE TABLE IF NOT EXISTS enterprise_schema_versions (
    organization_id text NOT NULL, schema_id text NOT NULL, version integer NOT NULL, definition jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(organization_id,schema_id,version),
    FOREIGN KEY(organization_id,schema_id) REFERENCES enterprise_schemas(organization_id,id)
  );
  CREATE TABLE IF NOT EXISTS enterprise_entities (
    id uuid PRIMARY KEY, organization_id text NOT NULL, owner_id text NOT NULL, schema_id text NOT NULL, schema_version integer NOT NULL,
    title text NOT NULL, attributes jsonb NOT NULL, version integer NOT NULL DEFAULT 1, archived_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY(organization_id,schema_id,schema_version) REFERENCES enterprise_schema_versions(organization_id,schema_id,version)
  );
  CREATE INDEX IF NOT EXISTS enterprise_entities_scope_idx ON enterprise_entities(organization_id,owner_id,created_at,id);
  CREATE INDEX IF NOT EXISTS enterprise_entities_schema_scope_idx ON enterprise_entities(organization_id,schema_id,schema_version,created_at,id) WHERE archived_at IS NULL;
  CREATE TABLE IF NOT EXISTS enterprise_entity_shares (
    entity_id uuid NOT NULL REFERENCES enterprise_entities(id), organization_id text NOT NULL,
    kind text NOT NULL CHECK(kind IN ('person','department')), principal_id text NOT NULL,
    permission text NOT NULL CHECK(permission IN ('read','edit')),
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(entity_id,kind,principal_id)
  );
  CREATE INDEX IF NOT EXISTS enterprise_entity_shares_scope_idx ON enterprise_entity_shares(organization_id,kind,principal_id,entity_id);
  CREATE TABLE IF NOT EXISTS enterprise_relations (
    source_id uuid NOT NULL REFERENCES enterprise_entities(id), name text NOT NULL,
    target_id uuid NOT NULL REFERENCES enterprise_entities(id), created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(source_id,name,target_id)
  );
  CREATE TABLE IF NOT EXISTS enterprise_audit (
    id uuid PRIMARY KEY, organization_id text NOT NULL, owner_id text NOT NULL, entity_id uuid NOT NULL REFERENCES enterprise_entities(id),
    actor_id text NOT NULL, operation text NOT NULL, from_version integer NOT NULL, to_version integer NOT NULL,
    occurred_at timestamptz NOT NULL DEFAULT now(), input jsonb NOT NULL, result jsonb NOT NULL
  );
  CREATE INDEX IF NOT EXISTS enterprise_audit_scope_idx ON enterprise_audit(organization_id,owner_id,entity_id,occurred_at,id);
  CREATE TABLE IF NOT EXISTS enterprise_commands (
    organization_id text NOT NULL, actor_id text NOT NULL, operation text NOT NULL, key text NOT NULL,
    fingerprint text NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(organization_id,actor_id,operation,key)
  )`);
  await initializeEntityEvents(pool);
  await pool.query(`ALTER TABLE enterprise_entities ADD COLUMN IF NOT EXISTS search_vector tsvector
    GENERATED ALWAYS AS (
      to_tsvector('simple'::regconfig,coalesce(title,'')) ||
      jsonb_to_tsvector('simple'::regconfig,attributes,'["string","numeric","boolean"]'::jsonb)
    ) STORED;
    CREATE INDEX IF NOT EXISTS enterprise_entities_search_idx ON enterprise_entities USING gin(search_vector)`);

  async function getDraft(db:Queryable,scope:Scope,id:string,lock=false):Promise<SchemaDraft|undefined> {
    const row=(await db.query(`SELECT ${draftColumns} FROM enterprise_schemas WHERE organization_id=$1 AND id=$2${lock?' FOR UPDATE':''}`,[scope.organizationId,id])).rows[0];
    return row?draft(row):undefined;
  }
  async function mutate(scope:Scope,id:string,expectedVersion:number,key:string,operation:string,input:unknown,apply:(client:PoolClient,before:Entity)=>Promise<Entity>,mode:AccessMode='edit'):Promise<Entity> {
    id=uuid(id); version(expectedVersion);
    let before:Entity;
    return runEntityCommand(pool,scope,operation,key,{id,...input as object},async client=>{
      const row=await scopedEntity(client,scope,id,true,mode);
      if(!row) throw missing();
      before=row;
    },async client=>{
      current(before,expectedVersion);
      return apply(client,before);
    });
  }
  async function relationCommand(scope:Scope,id:string,input:RelationInput,key:string,remove:boolean):Promise<Entity> {
    id=uuid(id);
    input={...input,targetId:uuid(input.targetId),expectedVersion:version(input.expectedVersion)};
    let source:Entity,target:Entity;
    const operation=remove?'entity.unlink':'entity.link';
    return runEntityCommand(pool,scope,operation,key,{id,...input},async client=>{
      const locked=await lockEntities(client,scope,[id,input.targetId]);
      source=locked.get(id)!; target=locked.get(input.targetId)!;
      await checkAccess(client,scope,source,'edit');
      await checkAccess(client,scope,target,'read');
    },async client=>{
      return applyEntityRelationWithClient(client,scope,source,target,input,remove);
    });
  }

  async function changeShare(scope:Scope,id:string,input:ShareInput|RevokeShareInput,key:string,remove:boolean):Promise<Entity> {
    const operation=remove?'entity.share.revoke':'entity.share';
    const kind='principal' in input?input.principal.kind:input.kind;
    const recipient='principal' in input?input.principal.id:input.principalId;
    return mutate(scope,id,input.expectedVersion,key,operation,input,async(client,before)=>{
      if(!remove) {
        const directory=await client.query(`SELECT subject FROM directory_people WHERE organization_id=$1 AND ${kind==='person'?'subject':'department_id'}=$2 AND enabled=true FOR SHARE`,[scope.organizationId,recipient]);
        if(!directory.rows.length) bad('Principal is not active in this organization.');
      }
      const changed=remove
        ?await client.query('DELETE FROM enterprise_entity_shares WHERE entity_id=$1 AND organization_id=$2 AND kind=$3 AND principal_id=$4 RETURNING entity_id',[id,scope.organizationId,kind,recipient])
        :await client.query(`INSERT INTO enterprise_entity_shares(entity_id,organization_id,kind,principal_id,permission) VALUES($1,$2,$3,$4,$5)
          ON CONFLICT(entity_id,kind,principal_id) DO UPDATE SET permission=EXCLUDED.permission,updated_at=now()
          WHERE enterprise_entity_shares.permission<>EXCLUDED.permission RETURNING entity_id`,[id,scope.organizationId,kind,recipient,(input as ShareInput).permission]);
      return changed.rows.length?updateRow(client,scope,before,operation,input):before;
    },'owner');
  }
  return {
    search(scope,query) {return searchEntities(pool,scope,query);},
    async aggregate(scope,input) {
      return transaction(pool,client=>aggregateEntitiesWithClient(client,scope,input));
    },
    async events(scope,id,page) {
      validatePage(page);id=uuid(id);
      const visible=await scopedEntity(pool,scope,id);
      if(!visible||(visible.archivedAt&&visible.ownerId!==scope.actorId)) throw missing();
      const result=await pool.query(`SELECT a.id,a.entity_id AS "entityId",a.schema_id AS "schemaId",a.schema_version AS "schemaVersion",
        a.from_version AS "fromVersion",a.to_version AS "toVersion",a.operation,a.actor_subject AS "actorSubject",a.occurred_at AS "occurredAt"
        FROM enterprise_entity_events a JOIN enterprise_entities e ON e.id=a.entity_id
        WHERE a.entity_id=$1 AND a.organization_id=$2 AND ${accessPredicate('e','$3','$2','read')}
        AND (e.archived_at IS NULL OR e.owner_id=$3)
        AND ($4='' OR strpos(lower(a.operation),lower($4))>0) ORDER BY a.occurred_at DESC,a.id DESC LIMIT $5 OFFSET $6`,[id,scope.organizationId,scope.actorId,page.q,page.limit+1,page.offset]);
      return pageResult(result.rows.map((row:EntityEvent)=>({...row,occurredAt:new Date(row.occurredAt).toISOString()})),page);
    },
    share(scope,id,input,key) { return changeShare(scope,uuid(id),parseShare(input),key,false); },
    revokeShare(scope,id,input,key) {
      input={expectedVersion:version(input.expectedVersion),kind:principalKind(input.kind),principalId:principalId(input.principalId)};
      return changeShare(scope,uuid(id),input,key,true);
    },
    async shares(scope,id,page) {
      validatePage(page); id=uuid(id);
      if(!await scopedEntity(pool,scope,id,false,'owner')) throw missing();
      const result=await pool.query(`SELECT g.kind,g.principal_id AS "principalId",g.permission,g.created_at AS "createdAt",g.updated_at AS "updatedAt"
        FROM enterprise_entity_shares g JOIN enterprise_entities e ON e.id=g.entity_id
        WHERE g.entity_id=$1 AND g.organization_id=$2 AND ${accessPredicate('e','$3','$2','owner')}
        AND ($4='' OR strpos(lower(g.principal_id),lower($4))>0) ORDER BY g.created_at DESC,g.kind,g.principal_id LIMIT $5 OFFSET $6`,[id,scope.organizationId,scope.actorId,page.q,page.limit+1,page.offset]);
      return pageResult(result.rows.map((row:{kind:Share['principal']['kind'];principalId:string;permission:Share['permission'];createdAt:string;updatedAt:string})=>({principal:{kind:row.kind,id:row.principalId},permission:row.permission,createdAt:new Date(row.createdAt).toISOString(),updatedAt:new Date(row.updatedAt).toISOString()})),page);
    },
    async createSchema(scope,definition) {
      definition=parseSchema(definition);
      const result=await pool.query(`INSERT INTO enterprise_schemas(organization_id,id,definition) VALUES($1,$2,$3::jsonb) ON CONFLICT DO NOTHING RETURNING ${draftColumns}`,[scope.organizationId,definition.id,JSON.stringify(definition)]);
      if(!result.rows[0]) throw new EntityError(409,'Schema already exists.');
      return draft(result.rows[0]);
    },
    async listSchemas(scope,page) {
      validatePage(page);
      const result=await pool.query(`SELECT ${draftColumns} FROM enterprise_schemas WHERE organization_id=$1 AND ($2='' OR strpos(lower(definition->>'title'),lower($2))>0) ORDER BY created_at DESC,id DESC LIMIT $3 OFFSET $4`,[scope.organizationId,page.q,page.limit+1,page.offset]);
      return pageResult(result.rows.map(draft),page);
    },
    getSchema(scope,id) { return getDraft(pool,scope,id); },
    async getPublishedSchema(scope,id,pinned) {
      version(pinned);
      if(pinned>2147483647) bad('Invalid schema version.');
      try { return await publication(pool,scope,id,pinned); }
      catch(error) {
        if(error instanceof EntityError&&error.statusCode===404) return undefined;
        throw error;
      }
    },
    async saveSchema(scope,id,input) {
      version(input.expectedRevision);
      const definition=parseSchema({id,title:input.title,fields:input.fields,relations:input.relations});
      return transaction(pool,async client=>{
        const existing=await getDraft(client,scope,id,true);
        if(!existing) throw missing();
        if(existing.revision!==input.expectedRevision) throw new EntityError(409,'Schema revision conflict.');
        const result=await client.query(`UPDATE enterprise_schemas SET definition=$3::jsonb,revision=revision+1,updated_at=now() WHERE organization_id=$1 AND id=$2 RETURNING ${draftColumns}`,[scope.organizationId,id,JSON.stringify(definition)]);
        return draft(result.rows[0]);
      });
    },
    async publishSchema(scope,id,expectedRevision) {
      version(expectedRevision);
      return transaction(pool,async client=>{
        const existing=await getDraft(client,scope,id,true);
        if(!existing) throw missing();
        if(existing.revision!==expectedRevision) throw new EntityError(409,'Schema revision conflict.');
        const state=(await client.query('SELECT published_revision FROM enterprise_schemas WHERE organization_id=$1 AND id=$2',[scope.organizationId,id])).rows[0];
        if(state.published_revision===expectedRevision) return publication(client,scope,id,existing.publishedVersion);
        for(const relation of Object.values(existing.relations)) {
          if(relation.targetSchemaId!==id) await publication(client,scope,relation.targetSchemaId);
        }
        const publishedVersion=existing.publishedVersion+1;
        const definition={id:existing.id,title:existing.title,fields:existing.fields,relations:existing.relations};
        await client.query('INSERT INTO enterprise_schema_versions(organization_id,schema_id,version,definition) VALUES($1,$2,$3,$4::jsonb)',[scope.organizationId,id,publishedVersion,JSON.stringify(definition)]);
        await client.query('UPDATE enterprise_schemas SET published_version=$3,published_revision=$4,updated_at=now() WHERE organization_id=$1 AND id=$2',[scope.organizationId,id,publishedVersion,expectedRevision]);
        return {...definition,version:publishedVersion};
      });
    },
    async create(scope,input,key) {
      input={...input,title:title(input.title)};
      let schema:SchemaPublication;
      return runEntityCommand(pool,scope,'entity.create',key,input,async client=>{
        schema=await publication(client,scope,input.schemaId,input.schemaVersion);
      },async client=>{
        return createEntityAtPublication(client,scope,{...input,schemaVersion:schema.version});
      },async(client,accepted)=>{
        if(!await scopedEntity(client,scope,accepted.id,true)) throw missing();
      });
    },
    async query(scope,input) {
      const query=parseEntityQuery(input);
      const schema=await publication(pool,scope,query.schemaId,query.schemaVersion);
      const compiled=compileEntityQuery(query,schema,5);
      const values=[scope.organizationId,scope.actorId,query.schemaId,query.schemaVersion,...compiled.values,query.limit+1,query.offset];
      const result=await pool.query(`SELECT ${entityColumns} FROM enterprise_entities WHERE ${accessPredicate('enterprise_entities','$2','$1','read')} AND archived_at IS NULL AND schema_id=$3 AND schema_version=$4 AND ${compiled.predicate} ORDER BY ${compiled.order} LIMIT $${values.length-1} OFFSET $${values.length}`,values);
      return pageResult(result.rows.map(entity),{limit:query.limit,offset:query.offset,q:''});
    },
    async list(scope,page) {
      validatePage(page);
      const result=await pool.query(`SELECT ${entityColumns} FROM enterprise_entities WHERE ${accessPredicate('enterprise_entities','$2','$1','read')} AND archived_at IS NULL
        AND ($3='' OR strpos(lower(title),lower($3))>0) AND ($4::text IS NULL OR schema_id=$4) ORDER BY created_at DESC,id DESC LIMIT $5 OFFSET $6`,
        [scope.organizationId,scope.actorId,page.q,page.schemaId??null,page.limit+1,page.offset]);
      return pageResult(result.rows.map(entity),page);
    },
    find(scope,id) { return scopedEntity(pool,scope,uuid(id)); },
    update(scope,id,input,key) {
      input={...input,title:title(input.title)};
      return mutate(scope,id,input.expectedVersion,key,'entity.update',input,(client,before)=>applyEntityUpdateWithClient(client,scope,before,input));
    },
    archive(scope,id,expectedVersion,key) {
      return mutate(scope,id,expectedVersion,key,'entity.archive',{expectedVersion},(client,before)=>applyEntityArchiveWithClient(client,scope,before,expectedVersion),'owner');
    },
    link(scope,id,input,key) { return relationCommand(scope,id,input,key,false); },
    unlink(scope,id,input,key) { return relationCommand(scope,id,input,key,true); },
    async relations(scope,id,page) {
      validatePage(page); id=uuid(id);
      if(!await scopedEntity(pool,scope,id)) throw missing();
      const result=await pool.query(`SELECT r.name,r.target_id AS "targetId",r.created_at AS "createdAt" FROM enterprise_relations r
        JOIN enterprise_entities t ON t.id=r.target_id JOIN enterprise_entities s ON s.id=r.source_id
        WHERE r.source_id=$1 AND ${accessPredicate('s','$3','$2','read')} AND ${accessPredicate('t','$3','$2','read')} AND t.archived_at IS NULL
        AND ($4='' OR strpos(lower(r.name),lower($4))>0) ORDER BY r.created_at DESC,r.name DESC,r.target_id DESC LIMIT $5 OFFSET $6`,[id,scope.organizationId,scope.actorId,page.q,page.limit+1,page.offset]);
      return pageResult(result.rows.map(row=>({...row,createdAt:new Date(row.createdAt).toISOString()})),page);
    },
    async history(scope,id,page) {
      validatePage(page); id=uuid(id);
      const visible=await scopedEntity(pool,scope,id);
      if(!visible) throw missing();
      const result=await pool.query(`SELECT a.id,a.entity_id AS "entityId",a.actor_id AS "actorId",a.operation,a.from_version AS "fromVersion",a.to_version AS "toVersion",a.occurred_at AS "occurredAt"${visible.ownerId===scope.actorId?",a.input,a.result":""}
        FROM enterprise_audit a JOIN enterprise_entities e ON e.id=a.entity_id
        WHERE a.entity_id=$1 AND a.organization_id=$2 AND a.owner_id=e.owner_id AND ${accessPredicate('e','$3','$2','read')}
        AND ($4='' OR strpos(lower(a.operation),lower($4))>0) ORDER BY a.occurred_at DESC,a.id DESC LIMIT $5 OFFSET $6`,[id,scope.organizationId,scope.actorId,page.q,page.limit+1,page.offset]);
      return pageResult(result.rows.map((row:EntityAudit)=>(() => {const {input,result,...metadata}=row;return {...metadata,...(visible.ownerId===scope.actorId?{input,result}:{}),occurredAt:new Date(row.occurredAt).toISOString()};})()),page);
    },
  };
}
