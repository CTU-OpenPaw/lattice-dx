// SPDX-License-Identifier: Apache-2.0
import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {Scope} from './types.js';
export const entityEventOperations=['entity.create','entity.update','entity.archive','entity.link','entity.unlink','entity.schema.migrate'] as const;
export type EntityEventOperation=typeof entityEventOperations[number];
export type EntityEvent={id:string;entityId:string;schemaId:string;schemaVersion:number;fromVersion:number;toVersion:number;operation:EntityEventOperation;actorSubject:string;occurredAt:string};
export function isEntityEventOperation(operation:string):operation is EntityEventOperation {
 return (entityEventOperations as readonly string[]).includes(operation);
}
export async function initializeEntityEvents(client:Pick<PoolClient,'query'>):Promise<void> {
 await client.query(`CREATE TABLE IF NOT EXISTS enterprise_entity_events (
  id uuid PRIMARY KEY, organization_id text NOT NULL, entity_id uuid NOT NULL REFERENCES enterprise_entities(id),
  schema_id text NOT NULL, schema_version integer NOT NULL, from_version integer NOT NULL, to_version integer NOT NULL,
  operation text NOT NULL CHECK(operation IN ('entity.create','entity.update','entity.archive','entity.link','entity.unlink','entity.schema.migrate')),
  actor_subject text NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now(), UNIQUE(entity_id,to_version,operation)
 );
 CREATE INDEX IF NOT EXISTS enterprise_entity_events_scope_idx ON enterprise_entity_events(organization_id,entity_id,occurred_at,id)`);
}
/** Append metadata only, using the transaction that owns the resource mutation. */
export async function appendEntityEventWithClient(client:Pick<PoolClient,'query'>,scope:Scope,change:{operation:EntityEventOperation;entityId:string;schemaId:string;schemaVersion:number;fromVersion:number;toVersion:number}):Promise<void> {
 await client.query(`INSERT INTO enterprise_entity_events(id,organization_id,entity_id,schema_id,schema_version,from_version,to_version,operation,actor_subject)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[randomUUID(),scope.organizationId,change.entityId,change.schemaId,change.schemaVersion,change.fromVersion,change.toVersion,change.operation,scope.actorId]);
}
