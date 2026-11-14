/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import type { PoolClient } from 'pg';
import type { WorkflowActor, WorkflowDefinition } from '@dx/contracts';
import { getDefinition, workflowDefinitions } from '../../../../solutions/workflows/definitions.js';
import type { Page, PageQuery } from '../pagination.js';
import { validateSteps } from './block-policy.js';
import { WorkflowError } from './policy.js';
import { validCondition } from './conditions.js';

export type DraftDefinition = Omit<WorkflowDefinition, 'version'>;
export type WorkflowDraft = {
  id: string;
  revision: number;
  definition: DraftDefinition;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
};

export interface DefinitionRegistry {
  get(organizationId: string, id: string, version?: number, client?: PoolClient): Promise<WorkflowDefinition | undefined>;
  list(organizationId: string, client?: PoolClient): Promise<WorkflowDefinition[]>;
  create(definition: unknown, actor: WorkflowActor): Promise<WorkflowDraft>;
  createMany(definitions: unknown[], actor: WorkflowActor): Promise<WorkflowDraft[]>;
  listDrafts(actor: WorkflowActor, page: PageQuery): Promise<Page<WorkflowDraft>>;
  getDraft(id: string, actor: WorkflowActor): Promise<WorkflowDraft>;
  updateDraft(id: string, revision: number, definition: unknown, actor: WorkflowActor): Promise<WorkflowDraft>;
  publish(id: string, revision: number, actor: WorkflowActor): Promise<WorkflowDefinition>;
}

export const sourceRegistry: Pick<DefinitionRegistry, 'get' | 'list'> = {
  async get(_org, id, version) {
    return getDefinition(id, version);
  },
  async list() {
    return workflowDefinitions;
  },
};

const unsafe = new Set(['__proto__', 'prototype', 'constructor']);
const authorityFields = new Set(['id','recordId','ownerId','actorId','organizationId','subject','roles','assigneeId','createdBy','state','version','definitionId','definitionVersion']);

function fail(): never {
  throw new WorkflowError(400, 'Cấu hình quy trình không hợp lệ.');
}

function name(value: unknown, role = false): value is string {
  const pattern = role ? /^[a-zA-Z][a-zA-Z0-9_.:-]*$/ : /^[a-zA-Z][a-zA-Z0-9_-]*$/;
  return typeof value === 'string' && value.length <= 80 && !unsafe.has(value) && pattern.test(value);
}

export function definitionId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 80
    && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value) && !unsafe.has(value);
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function keys(value: unknown, allowed: string[]): asserts value is Record<string, unknown> {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) {
    fail();
  }
}

export const workflowFieldTypes = Object.freeze(['text', 'subject', 'department', 'location', 'file', 'positiveInteger']);

function fields(value: unknown) {
  if (!object(value) || Object.keys(value).length > 50
    || Object.entries(value).some(([key, type]) => !name(key) || typeof type !== 'string' || !workflowFieldTypes.includes(type))) {
    fail();
  }
}

function names(value: unknown, role = false): value is string[] {
  return Array.isArray(value) && value.length <= 50
    && value.every(item => name(item, role)) && new Set(value).size === value.length;
}

export function validateDefinition(value: unknown): DraftDefinition {
  keys(value, ['id', 'title', 'startRole', 'initialState', 'startFields', 'optionalStartFields', 'readerRoles', 'transitions', 'assignedReader']);
  if (!definitionId(value.id) || workflowDefinitions.some(definition => definition.id === value.id)
    || typeof value.title !== 'string' || !value.title.trim() || value.title.length > 200
    || !name(value.startRole, true) || !name(value.initialState) || !names(value.readerRoles, true)) {
    fail();
  }

  fields(value.startFields);
  if (value.optionalStartFields !== undefined) {
    fields(value.optionalStartFields);
  }
  const required = value.startFields as Record<string, string>;
  const optional = (value.optionalStartFields ?? {}) as Record<string, string>;
  if (Object.keys(optional).some(key => Object.hasOwn(required, key))) {
    fail();
  }
  if (!Array.isArray(value.transitions) || !value.transitions.length || value.transitions.length > 100) {
    fail();
  }

  const ids = new Set<string>();
  const states = new Set<string>([value.initialState]);
  const subjects = new Set(Object.entries(required).filter(([, type]) => type === 'subject').map(([key]) => key));
  for (const transition of value.transitions) {
    keys(transition, ['id', 'from', 'to', 'role', 'ownerOnly', 'fields', 'eventType', 'assigneeField', 'steps', 'condition', 'wait', 'execution', 'task']);
    if (!name(transition.id) || ids.has(transition.id) || !name(transition.from) || !name(transition.to)
      || !name(transition.role, true)
      || (transition.execution !== undefined && !['interactive','service'].includes(transition.execution as string))
      || (transition.ownerOnly !== undefined && typeof transition.ownerOnly !== 'boolean')
      || (transition.eventType !== undefined && !name(transition.eventType, true))) {
      fail();
    }
    fields(transition.fields);
    if (transition.task !== undefined && (!['assign','complete'].includes(transition.task as string)
      || !object(value.assignedReader) || transition.wait !== undefined
      || (transition.task === 'complete' && transition.assigneeField !== value.assignedReader.field))) fail();
    ids.add(transition.id);
    states.add(transition.from);
    states.add(transition.to);
    if (transition.assigneeField !== undefined
      && (!name(transition.assigneeField) || !subjects.has(transition.assigneeField))) {
      fail();
    }
  }

  // All transition structures have been validated before reading cross-transition fields.
  const dataFields = new Set([...Object.keys(required), ...Object.keys(optional), ...value.transitions.flatMap(t => Object.keys(t.fields))]);
  const inputFields = new Set(dataFields);
  if (value.assignedReader && object(value.assignedReader) && typeof value.assignedReader.field === 'string') inputFields.add(value.assignedReader.field);
  for (const transition of value.transitions) {
    if (transition.wait !== undefined) {
      keys(transition.wait, ['stepId','successState','failureState','resultFields','timeoutSeconds']);
      const wait = transition.wait;
      fields(wait.resultFields);
      if (!name(wait.stepId) || !name(wait.successState) || !name(wait.failureState)
        || !Number.isSafeInteger(wait.timeoutSeconds) || Number(wait.timeoutSeconds) < 1 || Number(wait.timeoutSeconds) > 604800
        || Object.entries(wait.resultFields as Record<string,string>).some(([key,kind]) => inputFields.has(key) || authorityFields.has(key) || !['text','positiveInteger'].includes(kind))) fail();
      states.add(wait.successState); states.add(wait.failureState);
      for (const key of Object.keys(wait.resultFields)) dataFields.add(key);
    }
  }
  for (const transition of value.transitions) {
    if (transition.steps !== undefined) {
      validateSteps(transition.steps, dataFields, new Set(Object.keys(transition.fields)));
    }
    for (const step of (transition.steps ?? [])) if (step.action === 'timers.schedule') {
      const target=value.transitions.find(t=>t.id===step.input.transitionId);
      if (transition.wait || transition.task || !target || target.from!==transition.to || target.execution!=='service' || target.ownerOnly || target.assigneeField || Object.keys(target.fields).sort().join(',')!==Object.keys(step.input.input).sort().join(',')) fail();
    }
    if (transition.wait) {
      const final = Array.isArray(transition.steps) ? transition.steps.at(-1) : undefined;
      if (!final || final.id !== transition.wait.stepId || !['tasks.create','connectors.dispatch'].includes(final.action)) fail();
    }
    if (transition.condition !== undefined) {
      if(!validCondition(transition.condition,dataFields)) fail();
    }
  }

  const reached = new Set([value.initialState]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const transition of value.transitions) {
      if (reached.has(transition.from) && !reached.has(transition.to)) {
        reached.add(transition.to);
        changed = true;
      }
      if (reached.has(transition.to) && transition.wait) for (const target of [transition.wait.successState,transition.wait.failureState]) {
        if (!reached.has(target)) { reached.add(target); changed = true; }
      }
    }
  }
  if (value.transitions.some(transition => !reached.has(transition.from))) {
    fail();
  }

  if (value.assignedReader !== undefined) {
    keys(value.assignedReader, ['field', 'role', 'states']);
    const assigned = value.assignedReader;
    if (!name(assigned.field) || !subjects.has(assigned.field) || !name(assigned.role, true)
      || !names(assigned.states) || !assigned.states.length || assigned.states.some(state => !states.has(state))) {
      fail();
    }
  }
  return JSON.parse(JSON.stringify(value)) as DraftDefinition;
}
