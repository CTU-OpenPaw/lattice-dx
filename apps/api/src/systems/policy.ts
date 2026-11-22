/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import type { WorkflowTransition } from "@dx/contracts";
import { bundleKeys } from "../workflows/bundles.js";
import {parseEntityPages,type EntityPage} from "./presentation.js";
import type {SchemaDefinition} from "../entities/types.js";
import { name, slug, title,parseSchema } from "../entities/policy.js";
import { semver } from "../modules/policy.js";
import type { ModuleManifest } from "../modules/types.js";
import { validateDefinition } from "../workflows/registry.js";
import { WorkflowError } from "../workflows/policy.js";
export { parsePresentation } from "./presentation.js";
type RecipeField = {
  name: string;
  label: string;
  type: "text" | "positiveInteger";
  required: boolean;
};
type RecipePage = {
  id: string;
  title: string;
  requesterRole: string;
  reviewerRole: string;
  handlerRole: string;
  fields: RecipeField[];
  blocks?: string[];
  workflow?: {
    initialState: string;
    assignedStates: string[];
    transitions: WorkflowTransition[];
  };
};
export type SystemRecipe = {
  format: "latticedx.system-recipe";
  formatVersion: 1;
  id: string;
  version: string;
  title: string;
  pages: RecipePage[];
  schemas?:SchemaDefinition[];
  entityPages?:EntityPage[];
};
const role = (value: unknown) => {
  if (typeof value !== "string" || !/^[a-z][a-z0-9:_-]{0,79}$/.test(value))
    throw new WorkflowError(400, "Invalid role reference");
  return value;
};
export function parseRecipe(value: unknown): SystemRecipe {
  bundleKeys(value, [
    "format",
    "formatVersion",
    "id",
    "version",
    "title",
    "pages",
    ...(value&&typeof value==='object'&&Object.hasOwn(value,'schemas')?['schemas']:[]),
    ...(value&&typeof value==='object'&&Object.hasOwn(value,'entityPages')?['entityPages']:[]),
  ]);
  if (
    value.format !== "latticedx.system-recipe" ||
    value.formatVersion !== 1 ||
    Buffer.byteLength(JSON.stringify(value)) > 32768 ||
    !Array.isArray(value.pages) ||
    (!value.pages.length && !(Array.isArray(value.entityPages)&&value.entityPages.length)) ||
    value.pages.length > 5
  )
    throw new WorkflowError(400, "Invalid system recipe");
  const schemas=Object.hasOwn(value,'schemas')? (()=>{if(!Array.isArray(value.schemas)||value.schemas.length>10)throw new WorkflowError(400,'Invalid schemas');return value.schemas.map(parseSchema);})():undefined;
  if(schemas&&new Set(schemas.map(s=>s.id)).size!==schemas.length)throw new WorkflowError(400,'Duplicate schemas');
  const entityPages=Object.hasOwn(value,'entityPages')?parseEntityPages(value.entityPages,schemas??[]):undefined;
  const id = slug(value.id);
  if (id.length > 24)
    throw new WorkflowError(400, "System ID maximum 24 characters");
  const pages = value.pages.map((raw) => {
    bundleKeys(raw, [
      "id",
      "title",
      "requesterRole",
      "reviewerRole",
      "handlerRole",
      "fields",
      ...(raw && typeof raw === "object" && Object.hasOwn(raw, "blocks")
        ? ["blocks"]
        : []),
      ...(raw && typeof raw === "object" && Object.hasOwn(raw, "workflow")
        ? ["workflow"]
        : []),
    ]);
    const pageId = slug(raw.id);
    if (
      pageId.length > 16 ||
      !Array.isArray(raw.fields) ||
      !raw.fields.length ||
      raw.fields.length > 12
    )
      throw new WorkflowError(400, "Invalid module page or fields");
    const fields = raw.fields.map((field) => {
      bundleKeys(field, ["name", "label", "type", "required"]);
      const fieldName = name(field.name);
      if (
        ["handlerId", "reason", "receiptNote"].includes(fieldName) ||
        !["text", "positiveInteger"].includes(String(field.type)) ||
        typeof field.required !== "boolean"
      )
        throw new WorkflowError(400, "Reserved or invalid business field");
      return {
        name: fieldName,
        label: title(field.label),
        type: field.type as RecipeField["type"],
        required: field.required,
      };
    });
    if (new Set(fields.map((f) => f.name)).size !== fields.length)
      throw new WorkflowError(400, "Duplicate business field");
    if (Object.hasOwn(raw, "blocks")) {
      if (
        !Array.isArray(raw.blocks) ||
        !raw.blocks.length ||
        new Set(raw.blocks).size !== raw.blocks.length ||
        raw.blocks.some(block => typeof block !== "string" ||
          !["create", "list", "inbox", "detail", "history", "sync"].includes(block))
      )
        throw new WorkflowError(400, "Invalid page blocks");
    }
    if (Object.hasOwn(raw, "workflow"))
      bundleKeys(raw.workflow, ["initialState", "assignedStates", "transitions"]);
    const page: RecipePage = {
      id: pageId,
      title: title(raw.title),
      requesterRole: role(raw.requesterRole),
      reviewerRole: role(raw.reviewerRole),
      handlerRole: role(raw.handlerRole),
      fields,
      ...(Object.hasOwn(raw, "blocks") ? { blocks: raw.blocks as string[] } : {}),
      ...(Object.hasOwn(raw, "workflow")
        ? { workflow: raw.workflow as RecipePage["workflow"] }
        : {}),
    };
    if (Object.hasOwn(raw, "workflow")) definitionFor(page, id, semver(value.version));
    return page;
  });
  if (new Set([...pages,...(entityPages??[])].map((p) => p.id)).size !== pages.length+(entityPages?.length??0))
    throw new WorkflowError(400, "Duplicate module page");
  return {
    format: "latticedx.system-recipe",
    formatVersion: 1,
    id,
    version: semver(value.version),
    title: title(value.title),
    pages,
    ...(schemas?{schemas}:{}),
    ...(entityPages?{entityPages}:{}),
  };
}
export function compileSystem(value: unknown): ModuleManifest {
  const recipe = parseRecipe(value);
  const definitions = recipe.pages.map((page) =>
    definitionFor(page, recipe.id, recipe.version),
  );
  return {
    format: "latticedx.enterprise-module",
    formatVersion: 1,
    id: recipe.id,
    version: recipe.version,
    title: recipe.title,
    schemas: recipe.schemas??[],
    bundle: {
      format: "latticedx.workflow-bundle",
      formatVersion: 1,
      definitions,
    },
    blocks: [...new Set((recipe.entityPages??[]).flatMap(page=>[
      'entities.read',
      ...(page.blocks.includes('list')?['entities.query']:[]),
      ...page.actions.map(action=>`entities.${action}`),
    ]))].sort().map(id=>({id,version:1 as const})),
    dependencies: [],
    presentation: {
      schemaVersion: 1,
      ...(recipe.entityPages?{entityPages:recipe.entityPages}:{}),
      pages: recipe.pages.map((page, index) => ({
        id: page.id,
        title: page.title,
        definitionId: definitions[index]!.id,
        blocks: page.blocks ?? ["create", "list", "inbox", "detail", "history", "sync"],
        fieldLabels: fieldLabelsFor(page, definitions[index]!),
      })),
    },
  };
}

function definitionFor(page: RecipePage, systemId: string, systemVersion: string) {
  const definition = validateDefinition({
    id: slug(
      `${systemId}-${systemVersion.replaceAll(".", "-")}-${page.id}`,
    ),
    title: page.title,
    startRole: page.requesterRole,
    initialState: page.workflow ? page.workflow.initialState : "draft",
    startFields: Object.fromEntries([
      ...page.fields.filter((f) => f.required).map((f) => [f.name, f.type]),
      ["handlerId", "subject"],
    ]),
    optionalStartFields: Object.fromEntries(
      page.fields.filter((f) => !f.required).map((f) => [f.name, f.type]),
    ),
    readerRoles: [page.reviewerRole],
    assignedReader: {
      field: "handlerId",
      role: page.handlerRole,
      states: page.workflow ? page.workflow.assignedStates : ["approved", "completed"],
    },
    transitions: page.workflow ? page.workflow.transitions : [
      {
        id: "submit",
        from: "draft",
        to: "submitted",
        role: page.requesterRole,
        ownerOnly: true,
        fields: {},
      },
      {
        id: "approve",
        from: "submitted",
        to: "approved",
        role: page.reviewerRole,
        fields: {},
        task: "assign",
      },
      {
        id: "reject",
        from: "submitted",
        to: "rejected",
        role: page.reviewerRole,
        fields: { reason: "text" },
      },
      {
        id: "complete",
        from: "approved",
        to: "completed",
        role: page.handlerRole,
        assigneeField: "handlerId",
        fields: { receiptNote: "text" },
        task: "complete",
      },
    ],
  });
  if (!page.workflow) return definition;
  return validateDefinition({
    ...definition,
    readerRoles: [...new Set([
      page.reviewerRole,
      ...definition.transitions
        .filter(t => !t.ownerOnly && !t.assigneeField && t.execution !== "service")
        .map(t => t.role),
    ])],
  });
}

function fieldLabelsFor(
  page: RecipePage,
  definition: ReturnType<typeof validateDefinition>,
) {
  const fields = new Set([
    ...Object.keys(definition.startFields),
    ...Object.keys(definition.optionalStartFields ?? {}),
    ...definition.transitions.flatMap(t => Object.keys(t.fields)),
  ]);
  const labels: Record<string, string> = {
    ...Object.fromEntries(page.fields.map(f => [f.name, f.label])),
    handlerId: "Nhân viên thực hiện",
    reason: "Lý do từ chối",
    receiptNote: "Kết quả thực hiện",
  };
  return Object.fromEntries([
    ...Object.entries(labels).filter(([field]) => fields.has(field)),
    ...[...fields].filter(field => !Object.hasOwn(labels, field))
      .map(field => [field, field]),
  ]);
}
