// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import type { WorkflowActor } from "@dx/contracts";
import { canonicalJson, parseSchema, slug, title } from "../entities/policy.js";
import { bundleKeys, parseBundle } from "../workflows/bundles.js";
import { findBlock } from "../blocks/registry.js";
import { WorkflowError } from "../workflows/policy.js";
import type { ModuleManifest } from "./types.js";
export function semver(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value) ||
    value.split(".").some((n) => Number(n) > 2147483647)
  )
    throw new WorkflowError(400, "Exact bounded semantic version required.");
  return value;
}
export function requireModuleAdmin(actor: WorkflowActor): void {
  if (
    !actor.organizationId ||
    !["workflow:design", "data:design"].every((role) =>
      actor.roles.includes(role),
    )
  )
    throw new WorkflowError(
      403,
      "Module administration requires workflow:design and data:design.",
    );
}
export function requireModuleDesigner(actor: WorkflowActor): void {
  if (!actor.organizationId || !actor.roles.includes("workflow:design"))
    throw new WorkflowError(403, "Module catalog requires workflow:design.");
}
export function manifestHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
export function parseManifest(value: unknown): ModuleManifest {
  bundleKeys(value, [
    "format",
    "formatVersion",
    "id",
    "version",
    "title",
    "schemas",
    "bundle",
    "blocks",
    "dependencies",
  ]);
  if (
    Buffer.byteLength(canonicalJson(value)) > 128 * 1024 ||
    value.format !== "latticedx.enterprise-module" ||
    value.formatVersion !== 1
  )
    throw new WorkflowError(400, "Invalid enterprise module manifest.");
  const id = slug(value.id);
  for (const [key, max] of [
    ["schemas", 10],
    ["blocks", 20],
    ["dependencies", 10],
  ] as const)
    if (!Array.isArray(value[key]) || (value[key] as unknown[]).length > max)
      throw new WorkflowError(400, "Manifest resource bounds exceeded.");
  const schemas = (value.schemas as unknown[]).map(parseSchema);
  const blocks = (value.blocks as unknown[]).map((block) => {
    bundleKeys(block, ["id", "version"]);
    if (
      typeof block.id !== "string" ||
      block.version !== 1 ||
      !findBlock(block.id)
    )
      throw new WorkflowError(400, "Unknown builtin block/version.");
    return { id: block.id, version: 1 as const };
  });
  const dependencies = (value.dependencies as unknown[]).map((dep) => {
    bundleKeys(dep, ["id", "version"]);
    return { id: slug(dep.id), version: semver(dep.version) };
  });
  if (
    new Set(schemas.map((s) => s.id)).size !== schemas.length ||
    new Set(blocks.map((b) => b.id)).size !== blocks.length ||
    new Set(dependencies.map((d) => d.id)).size !== dependencies.length ||
    dependencies.some((d) => d.id === id)
  )
    throw new WorkflowError(400, "Duplicate resource or self dependency.");
  return {
    format: "latticedx.enterprise-module",
    formatVersion: 1,
    id,
    version: semver(value.version),
    title: title(value.title),
    schemas,
    bundle: parseBundle(value.bundle),
    blocks,
    dependencies,
  };
}
