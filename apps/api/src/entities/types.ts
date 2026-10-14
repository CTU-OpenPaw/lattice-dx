// SPDX-License-Identifier: Apache-2.0
import type { Page, PageQuery } from '../pagination.js';
export type Scope = { actorId: string; organizationId: string };
export type Field = { type: 'text'|'boolean'|'integer'|'decimal'|'date'|'enum'; required?: boolean; maxLength?: number; choices?: string[] };
export type SchemaDefinition = { id: string; title: string; fields: Record<string, Field>; relations: Record<string, {targetSchemaId:string}> };
export type SchemaDraft = SchemaDefinition & { revision: number; publishedVersion: number; createdAt: string; updatedAt: string };
export type SchemaPublication = SchemaDefinition & { version: number };
export type Attributes = Record<string, string|number|boolean>;
export type Entity = { id: string; schemaId: string; schemaVersion: number; title: string; attributes: Attributes; ownerId: string; organizationId: string; version: number; archivedAt: string|null; createdAt: string; updatedAt: string };
export type EntityCreate = {schemaId:string;title:string;attributes:Attributes};
export type EntityUpdate = {expectedVersion:number;title:string;attributes:Attributes};
export type RelationInput = {name:string;targetId:string;expectedVersion:number};
export type Relation = {name:string;targetId:string;createdAt:string};
export type EntityAudit = {id:string;entityId:string;actorId:string;operation:string;fromVersion:number;toVersion:number;occurredAt:string;input:unknown;result:Entity};
export interface EntityRepository {
  createSchema(scope:Scope, definition:SchemaDefinition):Promise<SchemaDraft>;
  listSchemas(scope:Scope, page:PageQuery):Promise<Page<SchemaDraft>>;
  getSchema(scope:Scope, id:string):Promise<SchemaDraft|undefined>;
  getPublishedSchema(scope:Scope, id:string, version:number):Promise<SchemaPublication|undefined>;
  saveSchema(scope:Scope, id:string, input:Omit<SchemaDefinition,'id'> & {expectedRevision:number}):Promise<SchemaDraft>;
  publishSchema(scope:Scope, id:string, expectedRevision:number):Promise<SchemaPublication>;
  create(scope:Scope,input:EntityCreate,key:string):Promise<Entity>;
  list(scope:Scope,page:PageQuery & {schemaId?:string}):Promise<Page<Entity>>;
  find(scope:Scope,id:string):Promise<Entity|undefined>;
  update(scope:Scope,id:string,input:EntityUpdate,key:string):Promise<Entity>;
  archive(scope:Scope,id:string,expectedVersion:number,key:string):Promise<Entity>;
  link(scope:Scope,id:string,input:RelationInput,key:string):Promise<Entity>;
  unlink(scope:Scope,id:string,input:RelationInput,key:string):Promise<Entity>;
  relations(scope:Scope,id:string,page:PageQuery):Promise<Page<Relation>>;
  history(scope:Scope,id:string,page:PageQuery):Promise<Page<EntityAudit>>;
}
