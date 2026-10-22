// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "vitest";
import { compileSystem, parseRecipe, parsePresentation } from "./policy.js";
import { parseManifest } from "../modules/policy.js";
export const recipe = {
  format: "latticedx.system-recipe",
  formatVersion: 1,
  id: "company-demo",
  version: "1.0.0",
  title: "Công ty thử nghiệm",
  pages: [
    {
      id: "requests",
      title: "Đề xuất nội bộ",
      requesterRole: "employee",
      reviewerRole: "procurement:manager",
      handlerRole: "logistics:warehouse",
      fields: [
        { name: "purpose", label: "Mục đích", type: "text", required: true },
      ],
    },
  ],
};
test("recipe compiles a portable module and presentation referencing its exact workflow", () => {
  const manifest = compileSystem(recipe);
  expect(parseManifest(manifest)).toEqual(manifest);
  const def = manifest.bundle.definitions[0]!;
  expect(def.startFields).toEqual({ purpose: "text", handlerId: "subject" });
  expect(def.assignedReader).toMatchObject({
    field: "handlerId",
    role: "logistics:warehouse",
  });
  expect(def.transitions.find((t) => t.id === "approve")?.task).toBe("assign");
  expect(manifest.presentation?.pages[0]?.definitionId).toBe(def.id);
  expect(
    compileSystem({ ...recipe, id: "another" }).bundle.definitions[0]!.id,
  ).not.toBe(def.id);
  expect(
    compileSystem({ ...recipe, version: "1.1.0" }).bundle.definitions[0]!.id,
  ).not.toBe(def.id);
});
test("recipe rejects authority fields, duplicate pages, unknown code/URL and invalid versions", () => {
  for (const value of [
    { ...recipe, url: "https://bad" },
    { ...recipe, version: "latest" },
    { ...recipe, pages: [recipe.pages[0], recipe.pages[0]] },
    {
      ...recipe,
      pages: [
        {
          ...recipe.pages[0],
          fields: [
            { name: "handlerId", label: "Spoof", type: "text", required: true },
          ],
        },
      ],
    },
    {
      ...recipe,
      pages: [
        {
          ...recipe.pages[0],
          fields: [
            { name: "__proto__", label: "Spoof", type: "text", required: true },
          ],
        },
      ],
    },
  ])
    expect(() => parseRecipe(value)).toThrow();
});
test("presentation accepts only owned definitions, known renderers and known field labels", () => {
  const manifest = compileSystem(recipe),
    presentation = structuredClone(manifest.presentation!);
  presentation.pages[0]!.definitionId = "someone-elses-flow";
  expect(() => parsePresentation(presentation, manifest.bundle)).toThrow();
  const bad = structuredClone(manifest.presentation!);
  (bad.pages[0]!.blocks as string[]).push("javascript");
  expect(() => parsePresentation(bad, manifest.bundle)).toThrow();
});
