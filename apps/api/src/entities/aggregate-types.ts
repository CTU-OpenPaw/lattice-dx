/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import type {EntityQuery} from './types.js';
export type AggregateMetric = {name:string;operation:'count'} | {name:string;operation:'sum'|'min'|'max'|'avg';field:string};
export type AggregateQuery = {schemaId:string;schemaVersion:number;filters?:EntityQuery['filters'];groupBy?:string[];metrics:AggregateMetric[]};
export type AggregateResult = {schemaId:string;schemaVersion:number;groupBy:string[];groups:{keys:(string|boolean|null)[];metrics:Record<string,string|null>}[]};
export type ParsedAggregateQuery = AggregateQuery & {groupBy:string[];filters:NonNullable<EntityQuery['filters']>};
