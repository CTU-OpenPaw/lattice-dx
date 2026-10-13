// SPDX-License-Identifier: Apache-2.0
import { WorkflowError } from './policy.js';
import { validateDefinition, type DraftDefinition } from './registry.js';
export type WorkflowBundle = { format: 'latticedx.workflow-bundle'; formatVersion: 1; definitions: DraftDefinition[] };
export function bundleKeys(value: unknown, allowed: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.keys(value).some(key => !allowed.includes(key))
    || allowed.some(key => !Object.hasOwn(value, key))) throw new WorkflowError(400, 'Workflow bundle không hợp lệ.');
}
export function parseBundle(value: unknown): WorkflowBundle {
  bundleKeys(value, ['format', 'formatVersion', 'definitions']);
  if (value.format !== 'latticedx.workflow-bundle' || value.formatVersion !== 1
    || !Array.isArray(value.definitions) || value.definitions.length < 1 || value.definitions.length > 10) throw new WorkflowError(400, 'Workflow bundle không hợp lệ.');
  const definitions = value.definitions.map(item => {
    if (Buffer.byteLength(JSON.stringify(item) ?? '', 'utf8') > 12288) throw new WorkflowError(400, 'Workflow definition quá lớn.');
    const definition = validateDefinition(item);
    for (const transition of definition.transitions) for (const step of transition.steps ?? []) {
      if (step.action !== 'tasks.create') continue;
      if ([step.input.assigneeId, step.input.recordId, step.assignment?.department, step.assignment?.assigneeId].some(binding => binding?.source === 'literal')) throw new WorkflowError(400, 'Bundle chứa liên kết tài nguyên nguồn.');
    }
    return definition;
  });
  if (new Set(definitions.map(item => item.id)).size !== definitions.length) throw new WorkflowError(400, 'Workflow ID trùng lặp.');
  return { format: 'latticedx.workflow-bundle', formatVersion: 1, definitions };
}
export function bundlePreview(bundle: WorkflowBundle) {
  return { workflowCount: bundle.definitions.length, definitions: bundle.definitions.map(definition => {
    const roles = new Set(['workflow:start', definition.startRole, ...definition.readerRoles]);
    const connectors = new Set<string>();
    if (definition.assignedReader) roles.add(definition.assignedReader.role);
    for (const transition of definition.transitions) {
      roles.add(transition.role);
      for (const step of transition.steps ?? []) {
        roles.add({ 'records.create': 'records:write', 'tasks.create': 'tasks:assign', 'connectors.dispatch': 'workflow:integrate' }[step.action]);
        if (step.action === 'tasks.create' && step.assignment) roles.add(step.assignment.role);
        if (step.action === 'tasks.create' && transition.wait?.stepId === step.id) roles.add('tasks:decide');
        if (step.action === 'connectors.dispatch' && step.input.connectorId.source === 'literal') {
          connectors.add(step.input.connectorId.value);
          if (transition.wait?.stepId === step.id) { roles.add('workflow:callback'); roles.add('connector:' + step.input.connectorId.value); }
        }
      }
    }
    return { id: definition.id, title: definition.title, requiredRoles: [...roles].sort(), connectors: [...connectors].sort(),
      inputFields: { start: definition.startFields, optionalStart: definition.optionalStartFields ?? {},
        transitions: Object.fromEntries(definition.transitions.map(t => [t.id, t.fields])) } };
  }) };
}
