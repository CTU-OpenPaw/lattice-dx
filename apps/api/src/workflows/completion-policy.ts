// SPDX-License-Identifier: Apache-2.0
import type { WorkflowCompletion, WorkflowCondition, WorkflowWaitConfig } from '@dx/contracts';
import { validateInput } from './policy.js';
export {numericPattern,strictNumber,conditionMatches} from './conditions.js';
export function parseCompletion(body: unknown): WorkflowCompletion | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return;
  const value = body as Record<string,unknown>;
  if (Object.keys(value).some(key => !['status','result','reason'].includes(key)) || typeof value.status !== 'string' || !['succeeded','failed'].includes(value.status)) return;
  if (!value.result || typeof value.result !== 'object' || Array.isArray(value.result) || Object.values(value.result).some(item => typeof item !== 'string' || item.length > 2000)) return;
  if (value.reason !== undefined && (typeof value.reason !== 'string' || !value.reason.trim() || value.reason.length > 500)) return;
  if (value.status === 'failed' && (Object.keys(value.result).length || value.reason === undefined) || value.status === 'succeeded' && value.reason !== undefined) return;
  return {status:value.status as WorkflowCompletion['status'],result:value.result as Record<string,string>,...(value.reason === undefined ? {} : {reason:value.reason as string})};
}
export function completionResult(config: WorkflowWaitConfig, value: WorkflowCompletion) {
  return value.status === 'succeeded' ? validateInput(config.resultFields,value.result) : {};
}
