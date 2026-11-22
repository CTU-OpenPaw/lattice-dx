/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
export interface ActionInputSchema {
  type: 'object';
  additionalProperties: false;
  required: string[];
  properties: Record<string, { type: 'string'; minLength: number; maxLength: number; pattern: string }>;
}
export interface ActionDescriptor {
  id: string;
  version: 1;
  title: string;
  requiredRole: string;
  inputSchema: ActionInputSchema;
}
export interface ActionRunRequest<T = unknown> { version: 1; input: T }
export interface ActionRunResult<T = unknown> { actionId: string; version: 1; status: 'succeeded'; result: T }
export interface RecordCreateInput { title: string }
export interface TaskCreateInput extends RecordCreateInput { assigneeId: string; recordId?: string }
export const recordIdPattern = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
export function isRecordId(value: unknown): value is string { return typeof value === 'string' && new RegExp(recordIdPattern).test(value); }

function objectWithKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => keys.includes(key));
}
function title(value: unknown): value is string {
  return typeof value === 'string' && Array.from(value).length <= 200 && !!value.trim();
}
export function parseActionRunRequest(value: unknown): ActionRunRequest | undefined {
  if (!objectWithKeys(value, ['version', 'input']) || value.version !== 1 || !('input' in value)) return;
  return { version: 1, input: value.input };
}
export function parseRecordCreateInput(value: unknown): RecordCreateInput | undefined {
  if (!objectWithKeys(value, ['title']) || !title(value.title)) return;
  return { title: value.title.trim() };
}
export function parseTaskCreateInput(value: unknown): TaskCreateInput | undefined {
  if (!objectWithKeys(value, ['title', 'assigneeId', 'recordId']) || !title(value.title)
    || typeof value.assigneeId !== 'string' || !value.assigneeId.trim() || Array.from(value.assigneeId).length > 100) return;
  // Preserve the identity value: it is an opaque subject, not a display name.
  if ('recordId' in value && !isRecordId(value.recordId)) return;
  return { title: value.title.trim(), assigneeId: value.assigneeId, ...('recordId' in value ? {recordId: value.recordId as string} : {}) };
}
export const recordCreateSchema: ActionInputSchema = {
  type: 'object', additionalProperties: false, required: ['title'],
  properties: { title: { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' } },
};
export const taskCreateSchema: ActionInputSchema = {
  type: 'object', additionalProperties: false, required: ['title', 'assigneeId'],
  properties: { ...recordCreateSchema.properties, assigneeId: { type: 'string', minLength: 1, maxLength: 100, pattern: '\\S' }, recordId: {type: 'string', minLength: 36, maxLength: 36, pattern: recordIdPattern} },
};
