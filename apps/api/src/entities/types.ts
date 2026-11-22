/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Page, PageQuery } from '../pagination.js';
export type Scope = { actorId: string; organizationId: string };
export type EntitySearch = {q:string;schemaId?:string;schemaVersion?:number;limit:number;offset:number};
export type Field = { type: 'text'|'boolean'|'integer'|'decimal'|'date'|'enum'; required?: boolean; maxLength?: number; choices?: string[] };
export type SchemaDefinition = { id: string; title: string; fields: Record<string, Field>; relations: Record<string, {targetSchemaId:string}> };
export type SchemaDraft = SchemaDefinition & { revision: number; publishedVersion: number; createdAt: string; updatedAt: string };
export type SchemaPublication = SchemaDefinition & { version: number };
export type Attributes = Record<string, string|number|boolean>;
export type Entity = { id: string; schemaId: string; schemaVersion: number; title: string; attributes: Attributes; ownerId: string; organizationId: string; version: number; archivedAt: string|null; createdAt: string; updatedAt: string };
export type EntityCreate = {schemaId:string;schemaVersion?:number;title:string;attributes:Attributes};
export type EntityUpdate = {expectedVersion:number;title:string;attributes:Attributes};
export type RelationInput = {name:string;targetId:string;expectedVersion:number};
export type Relation = {name:string;targetId:string;createdAt:string};
export type EntityAudit = {id:string;entityId:string;actorId:string;operation:string;fromVersion:number;toVersion:number;occurredAt:string;input?:unknown;result?:Entity};
export type Principal = {kind:'person'|'department';id:string};
export type Share = {principal:Principal;permission:'read'|'edit';createdAt:string;updatedAt:string};
export type ShareInput = {expectedVersion:number;principal:Principal;permission:'read'|'edit'};
export type RevokeShareInput = {expectedVersion:number;kind:Principal['kind'];principalId:string};
export type QueryOperator = 'eq'|'ne'|'gt'|'gte'|'lt'|'lte'|'contains'|'exists';
export type EntityQuery = {schemaId:string;schemaVersion:number;filters?:{field:string;operator:QueryOperator;value?:string|number|boolean}[];sort?:{field:string;direction:'asc'|'desc'};limit?:number;offset?:number};
export interface EntityRepository {
  search?(scope:Scope,input:EntitySearch):Promise<Page<Entity>>;
  aggregate?(scope:Scope,input:import('./aggregate-types.js').AggregateQuery):Promise<import('./aggregate-types.js').AggregateResult>;
  events?(scope:Scope,id:string,page:PageQuery):Promise<Page<import('./events.js').EntityEvent>>;
  query?(scope:Scope,input:EntityQuery):Promise<Page<Entity>>;
  share?(scope:Scope,id:string,input:ShareInput,key:string):Promise<Entity>;
  revokeShare?(scope:Scope,id:string,input:RevokeShareInput,key:string):Promise<Entity>;
  shares?(scope:Scope,id:string,page:PageQuery):Promise<Page<Share>>;
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
