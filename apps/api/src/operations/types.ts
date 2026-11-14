/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
export interface RetentionPreview {before:string;dryRun:true;warning:'review_only';items:{store:string;count:string}[]}
export interface OperationsRepository {
 ready():Promise<boolean>;
 retentionPreview(organizationId:string,before:string):Promise<RetentionPreview>;
 queues?(organizationId:string):Promise<import('./queues.js').QueueItem[]>;
}
