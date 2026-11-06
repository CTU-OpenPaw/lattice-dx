# Native ingress and proposal tools — 06/11/2026

**Goal:** Complete Duy's authenticated ingress and safe record/context/proposal API foundation for stage 5, reusing NocoBase auth, ACL, repositories and collection workflow events.

**Boundary:** Hưng owns pages/menus/client blocks; Nhi owns native workflows, AI Employees/model/tool binding and n8n. This change supplies backend contracts, not their configurations. No edits to their dirty files, no legacy engine rewrite, no secret/.env reads and no automatic merge.

## Design and acceptance

- Native sessions/API keys authenticate callers. A dedicated native connector role + active User–Employee mapping identifies source and organization. Payload cannot select organization, actor, role, status, arbitrary HTTP target or workflow action.
- Two host-managed collections: immutable integration inbox and agent proposals. Native repository create is the collection-event boundary for Nhi. No custom task engine, approval executor or AI runtime.
- Broker/n8n ingress accepts validated observation/order/request envelopes, derives scope, checks target access with native API, and deduplicates event ID per organization/source account. Same event with altered payload returns 409. Old observations are labelled late and never directly change asset state.
- Record tools call the host's existing collection API under the same caller session/role, keeping native field/data-scope ACL. Context comes only from a verified visible Asset and the server-configured broker. No model-supplied URLs or tenant.
- Proposal creation requires a current fingerprint of the visible native record; stores text + evidence reference only. API has no approve/execute/status-update action. Native workflow owns any future approval/execution. Current visible fingerprint is rechecked before returning proposal text.
- Generic collection APIs for journals are root-only; custom endpoints recheck membership/scope. Root/native workflow can query collections; no broad non-root global role can bypass journal guards.

## Tasks

- [x] Write failing tests for strict envelopes, bounded payloads, source-scoped dedupe, stale/future observations, evidence hashes, and immutable/protected fields.
- [x] Add inbox/proposal collections, minimal connector role and metadata migration; add exact HTTP contracts without UI/workflow changes.
- [x] Add a thin same-host native API reader that forwards only native authentication and verified role; allowlist collections/IDs and never bypass native ACL with direct DB record reads.
- [x] Add authenticated receive/record/context/propose/proposals endpoints; use native transaction/advisory lock/repository create and native collection events for atomic duplicate handling.
- [x] Verify real HTTP/PostgreSQL cases: replay/conflict/concurrency, revoked/wrong-org membership, field/data ACL, stale evidence, no agent approval, private journal access and durable queued event. Confirm existing native workflow remains functional.
- [x] Build/install after backup, independent targeted review, document Nhi/Hưng handoff and update Notion only for verified scope.

**Not completed by this change:** native logistics workflow across all departments; Nhi's real model/n8n bindings; UI agent chat; arbitrary agent execution; production broker authentication/global Keycloak logout. No stage-wide completion claim.

## Verified checkpoint — 06/11/2026

- Installed foundation 0.25.1 after backup; app healthy on host 2.2.38; audit lists 101 compatible plugin entries and 10 native managed collections.
- 19 real native HTTP/PostgreSQL/Orion/collection-event checks PASS; new integration unit tests 11 PASS; full current foundation suite253 PASS; installer6 PASS; native identity6 and workflow22 regressions PASS. No model/API-key/n8n-production/browser E2E claim.
- Targeted reviewer found event-ID coercion and stale membership attribution; fixed with strict types and transaction actor comparison. Final review found no remaining P1/P2; minor attribute coercion was also fixed with a red/green regression.
- Native snippet lattice.integrations.propose handles capability, preserving other role grants and excluding readonly/connector defaults. No custom approval/execution endpoint or parallel workflow engine.
- Handoff docs/native-integration-tools.md; no edits to teammate UI/worker/workflows. Notion updated with checkpoint, but broad stage5 checkboxes remain unticked until actual human-approval/logistics/live integration acceptance.
- Branch feat/native-integration-ingress; not committed/pushed/merged in this session.
