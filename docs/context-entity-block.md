# Context Entity block — Foundation 0.13.0

`context-entity` is a reusable, read-only workflow-to-business-entity view. Workspace and NocoBase Studio use the same component. There is no application-ID switch or Logistics-specific component in the runtime. The sample Work manifest maps `assetCode`, `location` and `status`; another manifest supplies its own fields and labels without changing the component.

## Data and permission contract

1. Resolve the selected workflow through the existing authorized workflow detail contract and optional `definitionId` constraint. No association means an empty state, without guessing from `recordId`, arbitrary workflow data or NocoBase collections.
2. Read `GET /v1/workflows/:id/entity-context` through the session-bound Action Bridge operation `entityContext`. The returned original association must match the selected workflow's pinned association.
3. Read `GET /v1/entities/:id` through the new `dxActions:entity` / `detail` operation. Both routes use the current business account token, kept on the server. No browser-supplied URL, organization, token or broker secret is accepted. Entity access remains independent of workflow access.
4. Validate identity, schema and version against the context read. A concurrent version change fails visibly and offers a fresh read, rather than silently mixing versions. Show current entity values and `updatedAt` separately from the original entity/schema version captured at workflow creation.

Only explicitly mapped primitive attributes are rendered as escaped React text. Location is an explicitly configured attribute in the local acceptance fixture; this version does not invent a location name from an unresolved relation ID. Missing mapped fields display `Chưa có dữ liệu`. Metadata is hidden immediately on account/selection changes; pending responses are discarded after disconnect. Failed reads clear displayed entity values. A 403/404 intentionally does not distinguish absent associations from inaccessible entities.

## Manifest configuration

```json
{
  "id": "request-context",
  "type": "context-entity",
  "title": "Dữ liệu liên kết",
  "collection": "workflow-runs",
  "permissions": ["data:read"],
  "entityFields": [
    {"name": "assetCode", "title": "Mã tài sản"},
    {"name": "location", "title": "Vị trí tài sản"},
    {"name": "status", "title": "Trạng thái tài sản"}
  ]
}
```

The collection must use the `workflows` API resource. Optional `runId` binds a UUID; optional `definitionId` constrains the workflow and `entitySchemaId` constrains the current entity schema. Up to 30 unique, safe field names are accepted; executable mappings and URLs are rejected. An Approval block links this view with `contextBlockId`; its collection and definition scope must match.

In Studio choose **Lattice Context Entity**, select the installed application/block and optionally set the workflow context ID. This binds a workflow ID, not an entity UUID or broker URN. Field mappings belong to the installed manifest; this increment does not provide an arbitrary schema/mapping editor in Studio. Existing Attachment/Timeline bindings continue to work.

## Broker boundary and remaining phase-two work

This increment shows **engine business data**, not live NGSI-LD context. `updatedAt` is an engine update timestamp, not broker `observedAt`; workflow states are not Asset states. At inspection, Nhi's `origin/feat/ngsi-ld-asset-subscription` at `0575cf9` exposes a status projection read-back protected by an integration secret and explicitly marked operational. It must not be called from the employee browser or exposed by forwarding that secret.

The remaining broker integration needs a user-authorized API/adapter that checks current entity access, resolves the verified entity UUID ↔ broker URN mapping, and returns context provenance, observation time and actual synchronization status. A retry control also needs an explicit server-authorized operation and its command/idempotency contract. No broker retry or fake pending/success state is shown before that exists. `Tải lại dữ liệu liên kết` repeats an authorized read only. This does not finish all Context Entity requirements or declare phase two complete.

## Verification — 15 October 2026

- Foundation/bridge Node suite: **58 passed**, including fixed proxy paths, session binding, denial propagation, association/schema/version mismatch, alternate field mappings, absent context, unsafe configuration, revocation and delayed-response isolation.
- Foundation build and API TypeScript check passed. Bridge/installer Vitest checks: **25 passed**. The installer fixture now reads source package versions instead of pinning the old Foundation 0.11.0 version; its deliberate installed-version mismatch test remains enabled. The backend integration smoke passed signed HTTP grant/revoke, cross-tenant denial, approval authority, replay and stale-version checks.
- `scripts/smoke-lattice-context.cjs` passed real NocoBase login → Keycloak PKCE → Gateway/API: warehouse initially reads the workflow but cannot read its entity; explicit sharing enables asset code/location/state; owner updates appear after refresh while the original pin stays unchanged; reload retains the association; revocation clears private values; disconnect removes the view. No browser page errors. The demo is left shared and pending for manual inspection.
- Studio exposed all seven team block models. `LATTICE_BUILDER_APP=context` with `scripts/smoke-lattice-builder-save.cjs` saved Context Entity and Timeline with a workflow binding, reloaded them successfully and verified the original expense page schema stayed identical. The isolated hidden test page is `/admin/ltc17465a027`.
- Current inspectable fixture: search **Context UI 466279fd** in Workspace, connected as the local `warehouse` fixture. Workflow ID `6a412513-92b8-4b93-ada4-55331e23f08c`; entity ID `a69ad910-9ad1-4f8f-8c7a-a4dd974fef77`. Runtime artifacts/screenshots stay in ignored `output/`.

The local API previously returned 404 for the newer module endpoint. Before upgrading it, a database-only core backup was saved at `output/backups/core-eb71b40ab35a422f98a2e4aa69adbc69.dump`. NocoBase/Keycloak database dumps and the installed Foundation copy were retained under `output/backups/context-entity-20261015`. No restore rehearsal was performed. The API was rebuilt from the current branch's unchanged backend (main `9e74bf7`); existing local realm fixtures and directory were synchronized using the repository scripts, and Foundation 0.13.0 was installed with the official package manager. Databases, volumes, passwords and existing page schemas were preserved. Integration workers remain opt-in; no broker or n8n deployment is claimed.
