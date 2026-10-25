# Admin-to-Employee System Foundation Implementation Plan

> For agentic workers: use executing-plans task by task. Dad owns architecture, contracts, reviews and integration; Baby AGY is the implementation worker in the existing `baby agy` Antigravity chat. No subagents. Phase 0 is read-only and must return to Dad before implementation.

**Goal:** an administrator configures a new multi-department system, publishes it, grants access to existing verified users, and employees operate it through authorized data and workflow APIs.

**Architecture:** extend the existing PostgreSQL entity, directory, module and workflow repositories. Keycloak remains the identity provider. Distinguish global platform authority, system membership, workflow role and row-level data access; a system grant must never silently grant global identity roles or access to unrelated records.

**Tech stack:** existing TypeScript/Fastify/PostgreSQL, Keycloak OIDC, NocoBase action bridge, Vitest and Node tests. No new framework or dependency without Dad's review.

## Ownership and working rules

- Workspace: `E:/pmnm2026`; same checkout, one implementation writer, branch `feat/admin-system-foundation` from main `bcace53`.
- Hưng owns `plugins/nocobase/plugin-lattice-foundation/src/client/**` and corresponding UI tests. Do not edit these, `client.js`, `client-v2.js`, `apps/web/**`, UI manifests or application screens without a specific Dad-approved exception.
- Our scope: `apps/api/src/**`, server contracts, database migrations, backend acceptance scripts, backend tests, docs and `plugins/nocobase/action-bridge/**`. Bridge client shims are transport only; document any new operation for Hưng.
- Read existing code before adding equivalent features. Reuse directory, sharing, workflow memberships, module lifecycle, capabilities, idempotency and audit mechanisms.
- Do not edit/read `.env*`, credentials, CV.pdf, a.png or unrelated files. No model-provider calls in Phase 0. Later live model calls require the existing configuration and model `combo` only.
- No git reset, clean, rebase, force push, database reset, volume deletion or fixture-wide reseeding. No commit/push/merge by Baby; Dad integrates reviewed work.
- Do not modify Notion or mark a whole phase complete merely because code exists. Record exact passing commands and remaining gaps.
- Keep bridge artifacts local. Do not stage `.antigravity-bridge/`, output artifacts or secrets.

## Phase 0 — Inventory, threat boundaries and an implementation-ready contract

**Read first:** `apps/api/src/identity.ts`, `directory.ts`, `directory-routes.ts`, `directory-database.ts`, `entities/access.ts`, `entities/routes.ts`, `systems/{policy,presentation,routes,database}.ts`, `modules/{types,policy,routes,database}.ts`, `studio/{catalog,policy,routes}.ts`, relevant workflow role/member validation, capability and route wiring, `packages/contracts/src/index.ts`, and `plugins/nocobase/action-bridge/bridge.cjs`. Use targeted searches rather than dumping every file.

- [ ] Map each existing endpoint involved in draft/plan/install/publish/enable, directory, effective access, entity sharing, workflow membership and assigned work. Record exact request/response, role requirements and implementation path.
- [ ] Classify each requirement as implemented-and-tested, implemented-but-unverified, missing, or blocked. Inspect authorization predicates, not only exported route names.
- [ ] Resolve account subject versus Employee ID versus Department ID; name the authoritative mapping and enabled/disabled behavior. Do not fabricate Keycloak subjects for accounts that do not exist.
- [ ] Identify how arbitrary designer role strings are validated against real users and which system-level constraints can be enforced without widening global access.
- [ ] Propose one authority model for system membership, page/module access, workflow actions and entity records. Explain grant/revoke propagation, already-issued tokens, ownership, in-flight work, and direct API bypass.
- [ ] Propose concrete backend and bridge contracts for Hưng: operations, payloads, pagination, effective capabilities, errors, idempotency and revisions. Clearly label new contracts as proposed, existing contracts as verified. Do not promise imaginary endpoints.
- [ ] Produce exact file map, database changes and regression test names for Phases 1–5 after inspection. Prefer small modules following existing conventions.
- [ ] Write `output/office-02-backend-audit.md` (maximum 120 lines), `output/office-02-ui-contract.md` and a short summary. STOP and await Dad's review. No source edits in this phase.

## Phase 1 — System membership and effective access

**Likely integration points:** directory repositories, `systems/routes.ts`, `modules/database.ts`, `entities/access.ts`, workflow authorization, capability projection and app wiring. Create a cohesive system-access module only if no equivalent exists. Exact paths/signatures are finalized by the Phase 0 review.

- [ ] Write failing tests for an authorized administrator listing eligible existing people and departments, granting access, reading effective access and revoking access.
- [ ] Prove ordinary employees cannot grant themselves rights; a tenant administrator cannot affect another tenant; unknown/disabled accounts and invalid departments cannot be assigned.
- [ ] Add revisioned, audited, idempotent persistence for the approved model; reject concurrent stale edits and same-key/different-body commands.
- [ ] Enforce the approved policy in system discovery, direct system access, mutations and all applicable data/workflow APIs. Hiding navigation is not authorization.
- [ ] Test the same user across two systems and another organization. A grant must not expose unrelated entities, files or workflow runs; revocation must follow the documented semantics on the next applicable request.
- [ ] Document account provisioning as a separate concern. If creating Keycloak users is required, return a separate design to Dad; never embed administrative credentials in browser responses or overload employee CRUD as identity creation.
- [ ] Run targeted route/database tests and API typecheck; return diff and contract delta to Dad before Phase 2.

## Phase 2 — Coherent from-scratch system configuration

**Existing files:** `systems/policy.ts`, `systems/presentation.ts`, `systems/routes.ts`, `systems/database.ts`, `modules/policy.ts`, `modules/types.ts` and their tests.

- [ ] Verify a new recipe can define independent entity modules (for example suppliers, internal requests and assets), supported field types, relations and filtered/list/detail/action bindings, rather than requiring a hardcoded logistics schema.
- [ ] Reject duplicate resource IDs, broken relations, missing required form fields, unsupported block/action combinations and references to foreign/unpublished definitions.
- [ ] Validate configured workflow roles and assignment references using the Phase 1 authority model; distinguish designer authority from employee runtime authority.
- [ ] Preserve draft revisions, reopen behavior and import/export equivalence. Document current schema evolution restrictions rather than silently rewriting persisted schema versions.
- [ ] Return structured validation diagnostics usable by UI, retaining compatibility with established error envelopes where practical.
- [ ] Add regression cases for a fully independent second system and a configuration with no workflow. Run focused compile/presentation/route tests and return the contract delta.

## Phase 3 — Publication and runtime readiness

**Existing files:** `modules/database.ts`, `modules/routes.ts`, `systems/routes.ts`, Studio policy/catalog, operations runtime configuration and their tests.

- [ ] Derive a single useful readiness report from existing persisted state: schema availability, workflow publication, resource conflicts, required connector availability and access setup.
- [ ] Reject enablement when a required dependency is missing; distinguish optional integrations from required ones according to stored configuration.
- [ ] Test partial installation/publication failure and same-command retry. Report partial progress honestly; do not claim atomicity across external services.
- [ ] Preserve immutable published definitions, version/revision checks, audit history and existing disable semantics. A pause must not silently destroy in-flight work or records.
- [ ] Verify what employees can discover and start before/after enable/disable and access changes. Return actual effective actions for supported UI rendering, while keeping backend enforcement authoritative.
- [ ] Run focused lifecycle tests; Dad reviews before integrating the next phase.

## Phase 4 — Authorized transport and automation/agent connections

**Existing files:** `plugins/nocobase/action-bridge/bridge.cjs`, associated bridge server/client shims and tests; existing API automation, incident-agent, context-link and workflow modules discovered in Phase 0.

- [ ] Extend only fixed, validated bridge operations needed by Hưng's new screens. Preserve user/browser binding, body/query separation, idempotency and safe error behavior; no arbitrary URL proxy.
- [ ] Supply Hưng with tested request/response examples for directory, membership, effective access, validation, publication and runtime discovery; include 401/403/404/409/503 outcomes and current pagination limits.
- [ ] Identify existing automation, broker and agent wiring usable from configured workflows. Connect supported capabilities rather than building a second engine or replacing Nhi's work.
- [ ] Keep agent analysis separate from authority: a completed proposal references its actual run/job/evidence, human approval executes through the existing workflow, and missing provider results fail explicitly.
- [ ] Do not invent a natural-language system-builder agent in this phase. First make Studio's configured actions and permissions reliable.
- [ ] Test bridge allowlists, cross-session isolation and denied operations; publish a compact transport contract delta.

## Phase 5 — Reproducible company acceptance and delivery

**Existing baseline:** `scripts/acceptance-system-studio.mjs`, `scripts/acceptance-incident-agent-postgres.mjs` and related repository tests. Extend existing disposable PostgreSQL acceptance or add a focused script if isolation requires it.

- [ ] Start from a unique empty system namespace. Create company data modules and a cross-department workflow through public authenticated API contracts; use admin, requester, reviewer, handler and unauthorized actors with realistic distinct scopes.
- [ ] Save/reopen draft, validate, install/publish/enable, grant access, create/link records, submit a request, approve/assign/complete it and verify persisted state and audit.
- [ ] Revoke a member and verify the documented access change; test foreign organization, unrelated system, direct API bypass, concurrent edits, duplicate command and missing dependency.
- [ ] Keep backend acceptance distinct from browser acceptance. Hưng's actual UI walkthrough is a separate required evidence item; do not call an API script a completed UI demonstration.
- [ ] Run `pnpm check`, Foundation/bridge Node suites and new isolated PostgreSQL acceptance. Record pass counts and whether broker/model were real or simulated.
- [ ] Dad reviews targeted diffs, runs independent checks, creates one focused PR or a small sequence by phase, waits for CI and merges verified work. No release/tag automatically.

## Every implementation checkpoint

Report at most 10 bullets: completed behavior, changed paths, exact red/green checks, contract changes, migration/backward-compatibility notes, remaining risks, next proposed task. Preserve original failure evidence. If a requirement is already satisfied, test and document it instead of duplicating it.

## Completion definition

An administrator can define a new system without source edits or manual database repair; membership and effective actions are explicit and enforced; published configurations are resumable/versioned; existing verified employees can operate their assigned cross-department process; unrelated systems/organizations remain inaccessible. User-defined new block types remain outside this plan. A full generic ERP, arbitrary UI layouts and automatic identity provisioning are not implied by this completion definition.

## Dad review checkpoint — Phase 1A and approved next batch

Phase 1A passed Dad's independent real PostgreSQL acceptance (`node scripts/acceptance-system-access.mjs`), 22 focused system tests and API typecheck. This validates membership storage and admin APIs; it does not establish runtime enforcement.

The following decisions override conflicting wording in worker artifacts:

- Enforcement is explicitly activated per installed system version, revisioned/idempotent/audited. Absent policy rows preserve legacy authorization; activation never happens merely because a grant exists. Report legacy/not-enforced versus enforced accurately.
- System membership is a necessary condition for every human operation on managed resources, including owners and assignees. Owner-only and assignee restrictions remain additional conditions, not membership bypasses. Platform prerequisites and row-level shares remain required.
- Derive resource ownership from persisted definitions/schema declarations and immutable existing workflow bindings. Preserve existing binding fields. Reject ambiguous governing ownership; grants on all referencing systems or a generic admin role are not a substitute for unambiguous ownership.
- Never mutate the request's global actor roles. Resolve business roles only inside the governing resource's policy context. Do not bypass service-token authority or change legacy owner deactivation rules globally.
- Enforce filtering before pagination and aggregate counts, including search, workflow inbox/history, entity lists, and applicable task/file access paths. Browser navigation alone is not enforcement.
- The next batch includes runtime enforcement, backend readiness diagnostics, fixed bridge operations and real PostgreSQL acceptance. No changes in Hưng's UI files. Any uncovered resource path must be reported, not silently declared protected.
