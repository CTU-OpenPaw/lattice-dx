// SPDX-License-Identifier: Apache-2.0
export interface RecordItem { id: string; title: string; ownerId: string; createdAt: string }
export interface RecordRepository {
  create(title: string, ownerId: string): Promise<RecordItem>;
  list(ownerId: string): Promise<RecordItem[]>;
}
