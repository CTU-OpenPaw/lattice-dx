# Portable workflow bundles

Scope approved by Duy: extend the reusable engine with configuration export/import, before expanding department authorization or automatic action chaining. This increment transports workflow definitions only; UI layouts, users, roles, files, runs, secrets and external service installations are outside scope.

## Contract

A bundle is `{format:"latticedx.workflow-bundle",formatVersion:1,definitions:[DraftDefinition]}`. It contains 1–10 unique custom workflow definitions, each at most 12,288 UTF-8 JSON bytes. The existing declarative validator is authoritative. Unknown keys, unsupported format versions, built-in/reserved IDs and executable content are rejected with 400. HTTP bodies are bounded to 131,072 bytes.

POST `/v1/workflow-bundles/export` takes `{definitions:[{id,version}]}` with explicit positive published versions. It looks up each definition in the signed tenant and exports only the configuration minus the server version. Missing/foreign versions return 404; no runtime data or draft actor metadata is exported.

POST `/v1/workflow-bundles/validate` takes `{bundle}` and returns a preview of IDs, titles, required roles, connector IDs, and typed input fields. It writes nothing. POST `/v1/workflow-bundles/import` takes the same body and creates all definitions as revision-1 drafts in a single PostgreSQL transaction. Existing IDs cause 409 and roll back the whole import. Imported configurations are never automatically published. The signed caller supplies the destination tenant and audit actor; clients cannot override them.

All routes require signed `workflow:design`, same as existing Studio drafts. Import/export do not grant or create roles. Runtime action authorization and directory checks remain authoritative. To avoid carrying concrete source entity IDs, bundles reject literal task assignees, literal task record links, literal department routing and literal department assignee selectors; those bindings must come from data/input/context/prior results as already supported by the engine. Other literals such as task titles and connector payload constants are intentionally preserved: designers must review configuration for confidential text before sharing it. Connector IDs are names only, never credentials or URLs.

## Implementation boundaries

`bundles.ts` owns strict package parsing, portability checks and preview. `bundle-routes.ts` owns signed designer endpoints. `DefinitionRegistry.createMany` and its database implementation own atomic batch insertion, reusing one insertion routine with single-draft create. Existing schemas, version-pinning, waits, permissions, run data and source built-ins stay unchanged. Gateway explicitly forwards these POST routes.

## Acceptance

Export explicit published v1 after v2 exists; import two workflow definitions into another tenant as drafts; runtime rejects start until explicit publish; publish and run through normal APIs. Reject wrong role, missing token, foreign export, duplicate IDs, authority keys, invalid graph, oversized packages, and concrete resource bindings. Concurrent imports of identical IDs accept exactly one complete bundle; a late conflict leaves no earlier inserted draft. Retest existing workflow Studio and completion flows.
