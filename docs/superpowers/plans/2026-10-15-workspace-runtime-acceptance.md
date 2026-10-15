# Workspace runtime acceptance

User authorized updating the merged UI runtime and completing internal acceptance on15October; Nhi's broker/n8n/agent branch must remain untouched.

## Scope and constraints

Use merged Foundation0.11.0 and Action Bridge0.1.0 on the existing pinned NocoBase2.2.20 container. Build original team sources, snapshot the NocoBase database before enabling additive plugin tables, recreate only the NocoBase service to apply its mount, then use the official plugin manager. Preserve existing accounts, credentials, pages and all volumes. Do not modify PR14, deploy integration services, change upstream source or reset data. Work on one branch codex/workspace-runtime-acceptance. Runtime verification uses the supported browser computer-use tool; scripts/APIs may prepare isolated local test records.

## Steps

- [ ] Capture pre-install plugin status and database backup under ignored output/backups; build current team plugin packages.
- [ ] Recreate NocoBase with existing volumes/mounts; enable Foundation with official package manager, verify package/version/enabled state and service health. Capture errors before proposing fixes.
- [ ] In the browser sign into local NocoBase and connect existing Keycloak demo accounts using the normal PKCE flow. Verify Workspace/home/app navigation and visible error states.
- [ ] Prepare uniquely named procurement/onboarding and asset-review fixtures. Verify approve/reject, required reason, reload persistence and account lacking approval. Verify metadata through backend separately; do not conflate generic tasks, waits and workflow transitions.
- [ ] Verify app directory/Logistics entry, supported form/list controls and no invented completed-work counts. Preserve native page schemas and other users' records. Keep broker/agent placeholders accurately labeled.
- [ ] Run relevant regression checks. Add a small repeatable runtime command/runbook if installation revealed a reproducibility gap; any behavior change requires focused failing/passing tests and review.
- [ ] Record actual runtime/browser evidence and remaining teammate-owned gaps, retain a screenshot and a usable pending fixture, create a reviewed PR for source/docs changes and verify CI. No automatic merge/release/Notion ticks.

## Ledger

Initial state: main0d97071; core/Keycloak/NocoBase running; Foundation source merged but package unavailable in current container. No source defect assumed before deployment.
