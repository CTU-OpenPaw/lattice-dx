# Studio and context foundation

Approved scope: the twelve backend improvements proposed in the conversation and accepted by Duy on 15 October 2026. Implementation uses four reviewable increments on one branch, preserving Hưng's UI and Nhi's receiver branch.

## Constraints

- Engine PostgreSQL remains authoritative for business data. NocoBase remains Studio/UI. No upstream/plugin source, teammate branch, credential, native page, existing volume or Notion tick changes.
- Additive endpoints/contracts; legacy action, workflow and history callers retain their behavior. Do not globally replace existing error envelopes.
- Current JWT tenant and resource authorization are checked at every read/write. Catalogs are guidance, never authority. No user-supplied SQL, arbitrary URLs, executable configuration or actor/tenant override.
- Idempotent mapping mutations require an Idempotency-Key and mapping revision. Versioned writes and audit must commit atomically. No secret or arbitrary workflow input in public audit.
- No automatic receiver deployment or simulated broker-success data. Broker observations remain distinct from business entity and workflow states.
- Original code Apache-2.0; no new runtime dependencies unless a demonstrated need cannot be met locally. Preserve CV.pdf, a.png and ignored artifacts.
- Prefer focused modules and existing validators/repositories. Source implementation is sequential, with focused TDD and independent review at each gate.

## Increment 1: serve Studio using existing capabilities (items 1–4, 7)

GET /v1/me/capabilities authenticates the caller and returns the current subject/organization and named capabilities with separate authorized/configured/available states. It never claims record-level access or grants privileges. GET /v1/studio/catalog requires designer authority and returns versioned, JSON-only schemas/descriptors from existing registries; expose supported entity fields/operators, workflow fields/entity steps, blocks, actions and connector/service IDs without credentials/URLs. Descriptor availability must reflect required role and configured repository where applicable.

POST /v1/studio/preflight accepts only {manifest}, reuses module preview/validation without writes, and returns structured valid/issues results (code, path, message). Malformed envelopes produce 400; configuration issues produce an explicit valid:false result. Conflict/dependency failures are included and never bypass installation checks. GET /v1/studio/modules/:id/versions/:version/dependencies returns the authorized installed module's exact schema/workflow/block/dependency references using modules.get, not an unrestricted tenant inventory. This is a direct dependency description, not an automatic upgrade engine. New APIs use stable error codes with human message and optional bounded issue details.

## Increment 2: trustworthy workflow history (items 5–6)

Keep GET /v1/workflows/:id/history without query returning the legacy first 100 items. With explicit limit/offset, return existing Page shape, deterministic version/id order, <=100 per page and hasMore/nextOffset, with the same get/read authorization. Add an optional repository historyPage method rather than loading all audit rows into memory. Reject unsupported query keys rather than silently dropping filters.

At a committed transition, copy only a validated configured text field named reason into immutable audit metadata.reason (maximum 2000 Unicode code points, existing input validation still governs). Keep entity/binding metadata untouched. Do not reconstruct missing historical reasons or copy entire input/data. Failed transitions leave no reason/audit/version effects. Contracts accept optional metadata.reason additively.

## Increment 3: user-authorized external context (items 8–10)

Introduce a focused context-links repository and original tables for mappings, mapping history and receipts; do not modify or depend on Nhi's receiver implementation files. One active ngsi-ld mapping per organization/entity, and unique active organization/provider/external ID. Mapping identity is a bounded urn:ngsi-ld:Asset:<organizationId>:<businessId> compatible with the receiver's constrained Asset.status projection. Entity must belong to the organization and be currently readable; mutation additionally requires data:design. Mapping reads require data:read and live entity readability. Missing/foreign/unreadable entities do not leak mappings or observations.

GET/PUT/DELETE /v1/entities/:id/context-links/ngsi-ld and GET /v1/entities/:id/context-links/ngsi-ld/history manage/read mappings; PUT {externalId,expectedRevision}, DELETE {expectedRevision}. Creation expectedRevision=0; replacement/removal requires current positive revision. Keep monotonic revision across removal/recreation and preserve history. No hard-delete audit. Replay reauthorizes and rejects key reuse with different body. Mutations use receipts and resource locks in one transaction, including mapping uniqueness enforcement.

GET /v1/entities/:id/context returns a versioned DTO separating mapping and observation. Explicit states distinguish not_linked, source_unavailable, no_observation, fresh and stale; classify freshness by observation time under a documented fixed five-minute threshold, never call this broker delivery success. Return observation observedAt and receivedAt and provenance/provider, not credentials or notification payload. Date validation and allowed status validation fail closed. No observation from an unrelated tenant/URN can be returned.

The observation adapter is read-only and opt-in using NGSI_LD_CONTEXT_READ=true (strict boolean; default false). It may read the known ngsi_ld_asset_context relation from Nhi's documented contract when present, but it must not create/write it. Missing relation/disabled source gives source_unavailable; database failures are controlled 503 errors, not invented no_observation. Receiver remains independently deployable. No HTTP endpoint/secret delegation to the employee browser.

## Increment 4: publish and verify the contract (items 11–12)

Provide a static valid OpenAPI 3.1 document for the new APIs and history paging, role/error/body/version constraints and examples. Add authenticated allowlisted Gateway routes for new families while preserving existing route protection. Provide signed HTTP smoke fixtures (current demo accounts only) for catalog/preflight, history paging and mapping/context isolation. Smoke fixtures are uniquely named, retained and never reset realm/directory/volumes. Add package commands, concise handoff/runbook and a read-only contract sanity check to prevent docs/route drift. Test negative authentication, role, tenant, stale revision, retry, missing source and denied entity access.

## Acceptance

Focused red/green tests per increment, whole pnpm check, actual PostgreSQL mapping/history rollback/concurrency/uniqueness tests and signed Gateway acceptance on a reviewed rebuilt local API. Back up the existing core database before runtime replacement; do not deploy receiver, broker, n8n or UI packages. If Docker is unavailable, keep source progress and identify live acceptance pending. New PR is reviewed with latest-head CI; no automatic merge/release beyond separate user authorization. Keep durable execution evidence in the implementation ledger.
