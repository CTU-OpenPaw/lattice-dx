// SPDX-License-Identifier: Apache-2.0
import { bundleKeys } from "../workflows/bundles.js";
import { name, slug, title } from "../entities/policy.js";
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
};
export type SystemRecipe = {
  format: "latticedx.system-recipe";
  formatVersion: 1;
  id: string;
  version: string;
  title: string;
  pages: RecipePage[];
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
  ]);
  if (
    value.format !== "latticedx.system-recipe" ||
    value.formatVersion !== 1 ||
    Buffer.byteLength(JSON.stringify(value)) > 32768 ||
    !Array.isArray(value.pages) ||
    !value.pages.length ||
    value.pages.length > 5
  )
    throw new WorkflowError(400, "Invalid system recipe");
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
    return {
      id: pageId,
      title: title(raw.title),
      requesterRole: role(raw.requesterRole),
      reviewerRole: role(raw.reviewerRole),
      handlerRole: role(raw.handlerRole),
      fields,
    };
  });
  if (new Set(pages.map((p) => p.id)).size !== pages.length)
    throw new WorkflowError(400, "Duplicate module page");
  return {
    format: "latticedx.system-recipe",
    formatVersion: 1,
    id,
    version: semver(value.version),
    title: title(value.title),
    pages,
  };
}
export function compileSystem(value: unknown): ModuleManifest {
  const recipe = parseRecipe(value);
  const definitions = recipe.pages.map((page) =>
    validateDefinition({
      id: slug(
        `${recipe.id}-${recipe.version.replaceAll(".", "-")}-${page.id}`,
      ),
      title: page.title,
      startRole: page.requesterRole,
      initialState: "draft",
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
        states: ["approved", "completed"],
      },
      transitions: [
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
    }),
  );
  return {
    format: "latticedx.enterprise-module",
    formatVersion: 1,
    id: recipe.id,
    version: recipe.version,
    title: recipe.title,
    schemas: [],
    bundle: {
      format: "latticedx.workflow-bundle",
      formatVersion: 1,
      definitions,
    },
    blocks: [],
    dependencies: [],
    presentation: {
      schemaVersion: 1,
      pages: recipe.pages.map((page, index) => ({
        id: page.id,
        title: page.title,
        definitionId: definitions[index]!.id,
        blocks: ["create", "list", "inbox", "detail", "history", "sync"],
        fieldLabels: {
          ...Object.fromEntries(page.fields.map((f) => [f.name, f.label])),
          handlerId: "Nhân viên thực hiện",
          reason: "Lý do từ chối",
          receiptNote: "Kết quả thực hiện",
        },
      })),
    },
  };
}
