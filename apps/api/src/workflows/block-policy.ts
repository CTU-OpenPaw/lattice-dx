// SPDX-License-Identifier: Apache-2.0
import type { WorkflowActor, WorkflowBinding, WorkflowRun, WorkflowStep } from '@dx/contracts';
import { WorkflowError } from './policy.js';
const unsafe = new Set(['__proto__', 'prototype', 'constructor']);
export function safeBlockName(value: unknown, role = false): value is string {
  return typeof value === 'string' && value.length <= 80 && !unsafe.has(value)
    && (role ? /^[a-zA-Z][a-zA-Z0-9_.:-]*$/ : /^[a-zA-Z][a-zA-Z0-9_-]*$/).test(value);
}
function fail(): never {
  throw new WorkflowError(400, 'Cấu hình block không hợp lệ.');
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function keys(value: unknown, allowed: string[]): asserts value is Record<string, unknown> {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) fail();
}
export function boundedString(value: unknown, max = 4000): value is string {
  return typeof value === 'string' && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
}
export function validateSteps(value: unknown, dataFields: Set<string>, inputFields: Set<string>): asserts value is WorkflowStep[] {
  if (!Array.isArray(value) || value.length > 10) fail();
  const earlier = new Map<string, string>();
  function binding(value: unknown) {
    if (!object(value)) fail();
    switch (value.source) {
      case 'literal':
        keys(value, ['source', 'value']);
        if (!boundedString(value.value)) fail();
        break;
      case 'data': case 'input':
        keys(value, ['source', 'field']);
        if (!safeBlockName(value.field) || !(value.source === 'data' ? dataFields : inputFields).has(value.field)) fail();
        break;
      case 'context':
        keys(value, ['source', 'field']);
        if (!['recordId', 'title', 'ownerId', 'actorId'].includes(value.field as string)) fail();
        break;
      case 'result':
        keys(value, ['source', 'stepId', 'field']);
        if (value.field !== 'id' || !['records.create', 'tasks.create'].includes(earlier.get(value.stepId as string) ?? '')) fail();
        break;
      default: fail();
    }
  }
  for (const step of value) {
    keys(step, ['id', 'action', 'input', 'assignment']);
    if (!safeBlockName(step.id) || earlier.has(step.id)) fail();
    if (step.action === 'records.create') {
      if (step.assignment !== undefined) fail();
      keys(step.input, ['title']);
      binding(step.input.title);
    } else if (step.action === 'tasks.create') {
      keys(step.input, ['title', 'assigneeId', 'recordId']);
      binding(step.input.title);
      if (step.input.recordId !== undefined) binding(step.input.recordId);
      if (step.assignment !== undefined) {
        if (step.input.assigneeId !== undefined) fail();
        keys(step.assignment, ['kind', 'department', 'role', 'assigneeId']);
        if (step.assignment.kind !== 'department' || !safeBlockName(step.assignment.role, true)) fail();
        binding(step.assignment.department);
        if (step.assignment.assigneeId !== undefined) binding(step.assignment.assigneeId);
      } else binding(step.input.assigneeId);
    } else if (step.action === 'connectors.dispatch') {
      if (step.assignment !== undefined) fail();
      keys(step.input, ['connectorId', 'operation', 'payload']);
      binding(step.input.connectorId);
      binding(step.input.operation);
      const connector = step.input.connectorId as Record<string, unknown>;
      const operation = step.input.operation as Record<string, unknown>;
      if (connector.source !== 'literal' || !['n8n', 'ngsi-ld', 'agent'].includes(connector.value as string)
        || operation.source !== 'literal' || !safeBlockName(operation.value, true)) fail();
      if (step.input.payload !== undefined) {
        if (!object(step.input.payload) || Object.keys(step.input.payload).length > 50) fail();
        for (const [name, value] of Object.entries(step.input.payload)) {
          if (!safeBlockName(name)) fail();
          binding(value);
        }
      }
    } else if (step.action === 'timers.schedule') {
      if (step.assignment !== undefined || step !== value.at(-1)) fail();
      keys(step.input, ['afterSeconds','serviceId','transitionId','input']);
      if (!Number.isSafeInteger(step.input.afterSeconds) || Number(step.input.afterSeconds)<1 || Number(step.input.afterSeconds)>604800 || typeof step.input.serviceId !== 'string' || step.input.serviceId.length>64 || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(step.input.serviceId) || !safeBlockName(step.input.transitionId)) fail();
      if (!object(step.input.input) || Object.keys(step.input.input).length>50) fail();
      for (const [name,value] of Object.entries(step.input.input)) {if (!safeBlockName(name)) fail();binding(value);}
    } else fail();
    earlier.set(step.id, step.action);
  }
}
export function authorizeBlock(step: WorkflowStep, actor: WorkflowActor) {
  const role = { 'records.create': 'records:write', 'tasks.create': 'tasks:assign', 'connectors.dispatch': 'workflow:integrate', 'timers.schedule':'workflow:schedule' }[step.action];
  if (!actor.roles.includes(role)) throw new WorkflowError(403, 'Không có quyền thực hiện block.');
}
export function resolveBinding(binding: WorkflowBinding, run: WorkflowRun, input: Record<string, string>, actor: WorkflowActor, results: Map<string, { id?: string }>): string {
  let value: unknown;
  switch (binding.source) {
    case 'literal': value = binding.value; break;
    case 'data': value = Object.hasOwn(run.data, binding.field) ? run.data[binding.field] : undefined; break;
    case 'input': value = Object.hasOwn(input, binding.field) ? input[binding.field] : undefined; break;
    case 'context': value = binding.field === 'actorId' ? actor.subject : run[binding.field]; break;
    case 'result': value = results.get(binding.stepId)?.id; break;
  }
  if (!boundedString(value)) throw new WorkflowError(400, 'Giá trị binding không khả dụng.');
  return value;
}
