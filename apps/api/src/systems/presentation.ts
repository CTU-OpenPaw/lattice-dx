// SPDX-License-Identifier: Apache-2.0
import { bundleKeys, type WorkflowBundle } from "../workflows/bundles.js";
import { slug, title } from "../entities/policy.js";
import { WorkflowError } from "../workflows/policy.js";
export type SystemPage = {
  id: string;
  title: string;
  definitionId: string;
  blocks: string[];
  fieldLabels: Record<string, string>;
};
export type SystemPresentation = { schemaVersion: 1; pages: SystemPage[] };
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
): SystemPresentation {
  bundleKeys(value, ["schemaVersion", "pages"]);
  if (
    value.schemaVersion !== 1 ||
    !Array.isArray(value.pages) ||
    !value.pages.length ||
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
  if (new Set(pages.map((p) => p.id)).size !== pages.length)
    throw new WorkflowError(400, "Duplicate system page");
  return { schemaVersion: 1, pages };
}
