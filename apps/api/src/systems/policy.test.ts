/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { expect, test } from "vitest";
import { compileSystem, parseRecipe, parsePresentation } from "./policy.js";
import { parseManifest } from "../modules/policy.js";
import type { WorkflowDefinition, WorkflowRun } from "@dx/contracts";
import { canReadRun, availableTransitions, planTransition } from "../workflows/policy.js";
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

test("recipe supports ordered blocks and validated custom approval transitions", () => {
  const workflow = {
    initialState: "draft",
    assignedStates: ["approved", "completed"],
    transitions: [
      { id: "submit", from: "draft", to: "review", role: "employee", ownerOnly: true, fields: {} },
      { id: "review", from: "review", to: "approved", role: "procurement:manager", fields: { reviewNote: "text" }, condition: { field: "purpose", operator: "eq", value: "equipment" }, task: "assign" },
      { id: "complete", from: "approved", to: "completed", role: "logistics:warehouse", fields: {}, assigneeField: "handlerId", task: "complete" },
    ],
  };
  const custom = { ...recipe, pages: [{ ...recipe.pages[0], blocks: ["history", "create", "detail"], workflow }] };
  const manifest = compileSystem(custom);
  expect(parseRecipe(custom).pages[0]).toMatchObject({ blocks: custom.pages[0]!.blocks, workflow });
  expect(manifest.bundle.definitions[0]).toMatchObject({ initialState: "draft", transitions: workflow.transitions });
  expect(manifest.presentation!.pages[0]!.blocks).toEqual(["history", "create", "detail"]);
  expect(manifest.presentation!.pages[0]!.fieldLabels).toEqual({ purpose: "Mục đích", handlerId: "Nhân viên thực hiện", reviewNote: "reviewNote" });
  expect(parseManifest(manifest)).toEqual(manifest);
  for (const changes of [
    { blocks: [] }, { blocks: ["create", "create"] }, { blocks: ["script"] },
    { workflow: { ...workflow, assignedStates: ["missing"] } },
    { workflow: { ...workflow, initialState: null } },
    { workflow: { ...workflow, transitions: null } },
    { workflow: { ...workflow, assignedStates: null } },
    { workflow: { ...workflow, initialState: "unreachable" } },
    { workflow: { ...workflow, url: "https://bad" } },
    { workflow: { ...workflow, transitions: [{ ...workflow.transitions[0], condition: { field: "roles", operator: "eq", value: "admin" } }] } },
    { workflow: { ...workflow, transitions: [{ ...workflow.transitions[0], fields: JSON.parse('{"__proto__":"text"}') }] } },
    { workflow: { ...workflow, transitions: [{ ...workflow.transitions[0], steps: [{ id: "hack", action: "javascript", input: {} }] }] } },
  ]) expect(() => parseRecipe({ ...recipe, pages: [{ ...recipe.pages[0], ...changes }] })).toThrow();
});

test("legacy recipe retains byte-identical compiled manifest", () => {
  const manifest = compileSystem(recipe);
  expect(JSON.stringify(manifest)).toBe(legacyManifest);
});

const legacyManifest = "{\"format\":\"latticedx.enterprise-module\",\"formatVersion\":1,\"id\":\"company-demo\",\"version\":\"1.0.0\",\"title\":\"Công ty thử nghiệm\",\"schemas\":[],\"bundle\":{\"format\":\"latticedx.workflow-bundle\",\"formatVersion\":1,\"definitions\":[{\"id\":\"company-demo-1-0-0-requests\",\"title\":\"Đề xuất nội bộ\",\"startRole\":\"employee\",\"initialState\":\"draft\",\"startFields\":{\"purpose\":\"text\",\"handlerId\":\"subject\"},\"optionalStartFields\":{},\"readerRoles\":[\"procurement:manager\"],\"assignedReader\":{\"field\":\"handlerId\",\"role\":\"logistics:warehouse\",\"states\":[\"approved\",\"completed\"]},\"transitions\":[{\"id\":\"submit\",\"from\":\"draft\",\"to\":\"submitted\",\"role\":\"employee\",\"ownerOnly\":true,\"fields\":{}},{\"id\":\"approve\",\"from\":\"submitted\",\"to\":\"approved\",\"role\":\"procurement:manager\",\"fields\":{},\"task\":\"assign\"},{\"id\":\"reject\",\"from\":\"submitted\",\"to\":\"rejected\",\"role\":\"procurement:manager\",\"fields\":{\"reason\":\"text\"}},{\"id\":\"complete\",\"from\":\"approved\",\"to\":\"completed\",\"role\":\"logistics:warehouse\",\"assigneeField\":\"handlerId\",\"fields\":{\"receiptNote\":\"text\"},\"task\":\"complete\"}]}]},\"blocks\":[],\"dependencies\":[],\"presentation\":{\"schemaVersion\":1,\"pages\":[{\"id\":\"requests\",\"title\":\"Đề xuất nội bộ\",\"definitionId\":\"company-demo-1-0-0-requests\",\"blocks\":[\"create\",\"list\",\"inbox\",\"detail\",\"history\",\"sync\"],\"fieldLabels\":{\"purpose\":\"Mục đích\",\"handlerId\":\"Nhân viên thực hiện\",\"reason\":\"Lý do từ chối\",\"receiptNote\":\"Kết quả thực hiện\"}}]}}";


test("custom human reviewers can read and act without widening owner or assignee access", () => {
  const manifest = compileSystem({ ...recipe, pages: [{ ...recipe.pages[0], workflow: {
    initialState: "draft",
    assignedStates: ["approved", "completed"],
    transitions: [
      { id: "submit", from: "draft", to: "finance", role: "employee", ownerOnly: true, fields: {} },
      { id: "finance", from: "finance", to: "approved", role: "finance:manager", fields: { financeNote: "text" }, task: "assign" },
      { id: "complete", from: "approved", to: "completed", role: "logistics:warehouse", assigneeField: "handlerId", fields: {}, task: "complete" },
      { id: "archive", from: "completed", to: "archived", role: "automation:worker", execution: "service", fields: {} },
    ],
  } }] });
  const definition: WorkflowDefinition = { ...manifest.bundle.definitions[0]!, version: 1 };
  const run: WorkflowRun = {
    id: "run", recordId: "record", definitionId: definition.id, definitionVersion: 1,
    title: "Equipment", ownerId: "alice", organizationId: "company", state: "finance",
    version: 1, data: { purpose: "equipment", handlerId: "handler-one" },
    createdAt: "2026-10-21T00:00:00Z", updatedAt: "2026-10-21T00:00:00Z",
  };
  const reviewer = { subject: "frank", organizationId: "company", roles: ["finance:manager"] };
  expect(canReadRun(definition, run, reviewer)).toBe(true);
  expect(definition.readerRoles).toEqual(["procurement:manager", "finance:manager"]);
  expect(availableTransitions(definition, run, reviewer).map(t => t.id)).toEqual(["finance"]);
  expect(planTransition(definition, run, reviewer, { action: "finance", expectedVersion: 1, input: { financeNote: " Approved " } }).input).toEqual({ financeNote: "Approved" });
  expect(() => planTransition(definition, run, reviewer, { action: "finance", expectedVersion: 1, input: {} })).toThrow();
  expect(manifest.presentation!.pages[0]!.fieldLabels.financeNote).toBe("financeNote");
  expect(parseManifest(manifest)).toEqual(manifest);
  for (const actor of [
    { subject: "other-handler", organizationId: "company", roles: ["logistics:warehouse"] },
    { subject: "other-requester", organizationId: "company", roles: ["employee"] },
    { subject: "worker", organizationId: "company", roles: ["automation:worker"] },
    { ...reviewer, organizationId: "other-company" },
  ]) expect(canReadRun(definition, { ...run, state: "approved" }, actor)).toBe(false);
  const handler = { subject: "handler-one", organizationId: "company", roles: ["logistics:warehouse"] };
  expect(canReadRun(definition, { ...run, state: "approved" }, handler)).toBe(true);
  expect(availableTransitions(definition, { ...run, state: "approved" }, { ...handler, subject: "other-handler" })).toEqual([]);
});
