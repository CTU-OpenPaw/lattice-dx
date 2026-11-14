/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import type {AggregateQuery,AggregateResult} from './aggregate-types.js';
import type {Scope} from './types.js';
import type {Page,PageQuery} from '../pagination.js';
export type ReportInput={title:string;query:AggregateQuery};
export type ReportMetadata={id:string;title:string;version:number;createdAt:string};
export type ReportSnapshot=ReportMetadata & {query:AggregateQuery;result:AggregateResult;asOf:string};
export interface ReportsRepository {
 create(scope:Scope,input:ReportInput,key:string):Promise<ReportSnapshot>;
 get(scope:Scope,id:string):Promise<ReportSnapshot>;
 list(scope:Scope,page:PageQuery):Promise<Page<ReportMetadata>>;
}
