// SPDX-License-Identifier: Apache-2.0
import type { Page,PageQuery } from './pagination.js';
export interface RecordItem { id: string; title: string; ownerId: string; organizationId: string; createdAt: string }
export interface RecordRepository {
  find?(id: string, ownerId: string, organizationId: string): Promise<RecordItem | undefined>;
  create(title: string, ownerId: string, organizationId: string): Promise<RecordItem>;
  list(ownerId: string, organizationId: string): Promise<RecordItem[]>;
  listPage?(subject:string,organizationId:string,query:PageQuery):Promise<Page<RecordItem>>;
  findReadable?(id:string,subject:string,organizationId:string):Promise<RecordItem|undefined>;
}
