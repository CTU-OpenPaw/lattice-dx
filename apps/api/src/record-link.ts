/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { isRecordId } from '@dx/contracts';
import type { RecordRepository } from './records.js';
import type { Scope } from './foundation.js';
export class RecordLinkError extends Error {
  constructor(public readonly statusCode: 400 | 404 | 503, message: string) { super(message); }
}
export async function resolveRecordLink(value: unknown, scope: Scope, records?: RecordRepository): Promise<string | undefined> {
  if (value === undefined) return;
  if (!isRecordId(value)) throw new RecordLinkError(400, 'recordId phải là UUID.');
  if (!records?.find) throw new RecordLinkError(503, 'Tra cứu bản ghi chưa được cấu hình.');
  let record;
  try { record = await records.find(value.toLowerCase(), scope.subject, scope.organizationId); }
  catch { throw new RecordLinkError(503, 'Tra cứu bản ghi tạm thời không khả dụng.'); }
  if (!record) throw new RecordLinkError(404, 'Không tìm thấy bản ghi trong phạm vi được phép.');
  return record.id;
}
