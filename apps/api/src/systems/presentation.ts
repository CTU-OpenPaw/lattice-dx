/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { bundleKeys, type WorkflowBundle } from "../workflows/bundles.js";
import type {SchemaDefinition, EntityQuery} from "../entities/types.js";
import {parseEntityQuery,compileEntityQuery} from "../entities/query.js";
import { slug, title, exact } from "../entities/policy.js";
import { WorkflowError } from "../workflows/policy.js";
export type SystemPage = {
  id: string;
  title: string;
  definitionId: string;
  blocks: string[];
  fieldLabels: Record<string, string>;
};
export type EntityPage = {
  id: string;
  title: string;
  schemaId: string;
  schemaVersion: 1;
  blocks: string[];
  fields: string[];
  actions: string[];
  query?: Pick<EntityQuery, 'filters' | 'sort'>;
};
export type SystemPresentation = {
  schemaVersion: 1;
  pages: SystemPage[];
  entityPages?: EntityPage[];
};
export const entityPageBlocks = ['create', 'list', 'detail', 'relations', 'history'];
export const entityPageActions = ['create', 'update', 'archive', 'link', 'unlink'];

export function parseEntityPages(value: unknown, schemas: SchemaDefinition[]): EntityPage[] {
  if (!Array.isArray(value) || value.length > 10)
    throw new WorkflowError(400, 'Invalid entity pages');
  function list(value: unknown, allowed: string[], empty = false): value is string[] {
    return Array.isArray(value) && (empty || value.length > 0) && value.length <= 50
      && new Set(value).size === value.length
      && value.every(item => typeof item === 'string' && allowed.includes(item));
  }
  return value.map(raw => {
    bundleKeys(raw, [
      'id', 'title', 'schemaId', 'schemaVersion', 'blocks', 'fields', 'actions',
      ...(raw && typeof raw === 'object' && Object.hasOwn(raw, 'query') ? ['query'] : []),
    ]);
    const schema = schemas.find(item => item.id === raw.schemaId);
    if (!schema || raw.schemaVersion !== 1
      || !list(raw.blocks, entityPageBlocks)
      || !list(raw.fields, Object.keys(schema.fields), true)
      || !list(raw.actions, entityPageActions, true))
      throw new WorkflowError(400, 'Invalid entity page binding');
    const pageBlocks = raw.blocks, pageFields = raw.fields, pageActions = raw.actions;
    const missingCreateFields = pageBlocks.includes('create')
      && Object.entries(schema.fields).some(([key, field]) => field.required && !pageFields.includes(key));
    const missingDetail = pageActions.some(action => ['update', 'archive'].includes(action))
      && !pageBlocks.includes('detail');
    const missingRelations = pageActions.some(action => ['link', 'unlink'].includes(action))
      && (!pageBlocks.includes('relations') || !Object.keys(schema.relations).length);
    if (pageBlocks.includes('create') !== pageActions.includes('create')
      || missingCreateFields || missingDetail || missingRelations)
      throw new WorkflowError(400, 'Incoherent entity page actions');
    let query: EntityPage['query'];
    if (Object.hasOwn(raw, 'query')) {
      const config = exact(raw.query, ['filters', 'sort']);
      if (!pageBlocks.includes('list')) throw new WorkflowError(400, 'Query requires list block');
      const parsed = parseEntityQuery({...config, schemaId: schema.id, schemaVersion: 1});
      compileEntityQuery(parsed, {...schema, version: 1});
      query = {
        ...(Object.hasOwn(config, 'filters') ? {filters: parsed.filters} : {}),
        ...(parsed.sort ? {sort: parsed.sort} : {}),
      };
    }
    return {
      id: slug(raw.id), title: title(raw.title), schemaId: schema.id, schemaVersion: 1,
      blocks: pageBlocks, fields: pageFields, actions: pageActions,
      ...(query ? {query} : {}),
    };
  });
}
const blocks = new Set([
  "create",
  "list",
  "inbox",
  "detail",
  "history",
  "sync",
]);
export function parsePresentation(
  value: unknown,
  bundle: WorkflowBundle,
  schemas: SchemaDefinition[] = [],
): SystemPresentation {
  bundleKeys(value, ["schemaVersion", "pages",...(value&&typeof value==='object'&&Object.hasOwn(value,'entityPages')?['entityPages']:[])]);
  const entityPages=Object.hasOwn(value,'entityPages')?parseEntityPages(value.entityPages,schemas):undefined;
  if (
    value.schemaVersion !== 1 ||
    !Array.isArray(value.pages) ||
    (!value.pages.length && !entityPages?.length) ||
    value.pages.length > 10
  )
    throw new WorkflowError(400, "Invalid system presentation");
  const pages = value.pages.map((raw) => {
    bundleKeys(raw, ["id", "title", "definitionId", "blocks", "fieldLabels"]);
    const def = bundle.definitions.find((d) => d.id === raw.definitionId);
    if (
      !def ||
      !Array.isArray(raw.blocks) ||
      !raw.blocks.length ||
      new Set(raw.blocks).size !== raw.blocks.length ||
      raw.blocks.some((b) => typeof b !== "string" || !blocks.has(b))
    )
      throw new WorkflowError(
        400,
        "Presentation requires owned workflow and known blocks",
      );
    if (
      !raw.fieldLabels ||
      typeof raw.fieldLabels !== "object" ||
      Array.isArray(raw.fieldLabels)
    )
      throw new WorkflowError(400, "Invalid field labels");
    const fields = new Set([
      ...Object.keys(def.startFields),
      ...Object.keys(def.optionalStartFields ?? {}),
      ...def.transitions.flatMap((t) => Object.keys(t.fields)),
    ]);
    const fieldLabels: Record<string, string> = {};
    for (const [key, label] of Object.entries(raw.fieldLabels)) {
      if (
        !fields.has(key) ||
        ["__proto__", "constructor", "prototype"].includes(key)
      )
        throw new WorkflowError(400, "Unknown presentation field");
      fieldLabels[key] = title(label);
    }
    return {
      id: slug(raw.id),
      title: title(raw.title),
      definitionId: def.id,
      blocks: raw.blocks as string[],
      fieldLabels,
    };
  });
  if (new Set([...pages,...(entityPages??[])].map((p) => p.id)).size !== pages.length+(entityPages?.length??0))
    throw new WorkflowError(400, "Duplicate system page");
  return { schemaVersion: 1, pages, ...(entityPages?{entityPages}:{}) };
}
