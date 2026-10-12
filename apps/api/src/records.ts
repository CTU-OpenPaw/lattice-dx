// SPDX-License-Identifier: Apache-2.0
export interface RecordItem { id: string; title: string; ownerId: string; organizationId: string; createdAt: string }
export interface RecordRepository {
  find?(id: string, ownerId: string, organizationId: string): Promise<RecordItem | undefined>;
  create(title: string, ownerId: string, organizationId: string): Promise<RecordItem>;
  list(ownerId: string, organizationId: string): Promise<RecordItem[]>;
}
