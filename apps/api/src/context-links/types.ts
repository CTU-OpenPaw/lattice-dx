/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import type {Scope} from '../entities/types.js';
import type {PageQuery,Page} from '../pagination.js';
export type ContextMapping={provider:'ngsi-ld';entityId:string;externalId:string|null;revision:number;updatedAt:string};
export type MappingMutation={externalId:string;expectedRevision:number};
export type MappingRemoval={expectedRevision:number};
export type Observation={provider:'ngsi-ld';externalId:string;status:'ready'|'in_use'|'repair'|'retired';observedAt:string;receivedAt:string};
export type ObservationState={status:'source_unavailable'|'no_observation'|'fresh'|'stale';observation:Observation|null};
export type EntityContext={version:1;entityId:string;mapping:ContextMapping|null;status:'not_linked'|ObservationState['status'];freshnessThresholdSeconds:300;observation:Observation|null};
export type MappingEvent={entityId:string;provider:'ngsi-ld';actorId:string;operation:'link'|'remove';fromRevision:number;toRevision:number;externalId:string|null;occurredAt:string};
export interface ContextLinksRepository {
 get(scope:Scope,id:string):Promise<ContextMapping|null>;
 put(scope:Scope,id:string,input:MappingMutation,key:string):Promise<ContextMapping>;
 remove(scope:Scope,id:string,input:MappingRemoval,key:string):Promise<ContextMapping>;
 history(scope:Scope,id:string,page:PageQuery):Promise<Page<MappingEvent>>;
 context(scope:Scope,id:string):Promise<EntityContext>;
}
