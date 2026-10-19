// SPDX-License-Identifier: Apache-2.0
export * from './actions';
export * from './workspace';
export interface DemoRequest { message: string }
export interface DemoResult { mode: 'demo'; summary: string }

export function parseDemoRequest(value: unknown): DemoRequest | undefined {
  if (!value || typeof value !== 'object' || !('message' in value) || typeof value.message !== 'string') return;
  const message = value.message.trim();
  if (!message || value.message.length > 2000) return;
  return { message };
}

export function isDemoResult(value: unknown): value is DemoResult {
  return !!value && typeof value === 'object' && 'mode' in value && value.mode === 'demo'
    && 'summary' in value && typeof value.summary === 'string';
}
