/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Page,PageQuery } from './pagination.js';
export interface RecordItem { id: string; title: string; ownerId: string; organizationId: string; createdAt: string }
export interface RecordRepository {
  supportsCreateCommands?:boolean;
  find?(id: string, ownerId: string, organizationId: string): Promise<RecordItem | undefined>;
  create(title: string, ownerId: string, organizationId: string,key?:string): Promise<RecordItem>;
  list(ownerId: string, organizationId: string): Promise<RecordItem[]>;
  listPage?(subject:string,organizationId:string,query:PageQuery):Promise<Page<RecordItem>>;
  findReadable?(id:string,subject:string,organizationId:string):Promise<RecordItem|undefined>;
}
