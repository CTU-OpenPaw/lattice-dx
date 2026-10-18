// SPDX-License-Identifier: Apache-2.0
import type { WorkflowActor, WorkflowRun, CreateWorkflow } from "@dx/contracts";
import type { SchemaDefinition } from "../entities/types.js";
import type { WorkflowBundle } from "../workflows/bundles.js";
import type { Page, PageQuery } from "../pagination.js";
export type BusinessBinding = { id: string; schemaId: string; schemaVersion: number; definitionId: string; allowedTransitions: string[] };
export type ModuleManifest = {
  bindings?: BusinessBinding[];
  format: "latticedx.enterprise-module";
  formatVersion: 1;
  id: string;
  version: string;
  title: string;
  schemas: SchemaDefinition[];
  bundle: WorkflowBundle;
  blocks: { id: string; version: 1 }[];
  dependencies: { id: string; version: string }[];
};
export type ModuleVersion = {
  bindings?: (BusinessBinding & {definitionVersion?: number})[];
  id: string;
  version: string;
  title: string;
  hash: string;
  revision: number;
  enabled: boolean;
  schemas: string[];
  workflows: { definitionId: string; definitionVersion?: number }[];
  blocks: ModuleManifest["blocks"];
  dependencies: ModuleManifest["dependencies"];
};
export type ModulePreview = {
  bindings?: BusinessBinding[];
  hash: string;
  resources: { schemas: string[]; workflows: string[]; blocks: string[] };
  requiredRoles: string[];
  connectors: string[];
  conflicts: string[];
  dependencyErrors: string[];
};
export interface ModuleRepository {
  preview(value: unknown, actor: WorkflowActor): Promise<ModulePreview>;
  install(
    value: unknown,
    actor: WorkflowActor,
    key: string,
  ): Promise<ModuleVersion>;
  list(actor: WorkflowActor, page: PageQuery): Promise<Page<ModuleVersion>>;
  get(
    id: string,
    version: string,
    actor: WorkflowActor,
  ): Promise<ModuleVersion>;
  audit(
    id: string,
    version: string,
    actor: WorkflowActor,
    page: PageQuery,
  ): Promise<Page<Record<string, unknown>>>;
  setEnabled(
    id: string,
    version: string,
    input: { expectedRevision: number; enabled: boolean },
    actor: WorkflowActor,
    key: string,
  ): Promise<ModuleVersion>;
  startBinding(id: string, version: string, bindingId: string, input: {entityId: string; title: string; input: Record<string,string>}, actor: WorkflowActor, key: string): Promise<WorkflowRun>;
  start(
    id: string,
    version: string,
    input: CreateWorkflow,
    actor: WorkflowActor,
    key: string,
  ): Promise<WorkflowRun>;
}
