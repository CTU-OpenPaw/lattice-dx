// SPDX-License-Identifier: Apache-2.0
import type {EntityQuery} from './types.js';
export type AggregateMetric = {name:string;operation:'count'} | {name:string;operation:'sum'|'min'|'max'|'avg';field:string};
export type AggregateQuery = {schemaId:string;schemaVersion:number;filters?:EntityQuery['filters'];groupBy?:string[];metrics:AggregateMetric[]};
export type AggregateResult = {schemaId:string;schemaVersion:number;groupBy:string[];groups:{keys:(string|boolean|null)[];metrics:Record<string,string|null>}[]};
export type ParsedAggregateQuery = AggregateQuery & {groupBy:string[];filters:NonNullable<EntityQuery['filters']>};
