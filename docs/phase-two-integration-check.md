# Phase-two integration checkpoint — 14 October 2026

Branch: `feat/nocobase-workflow-integration`. This checkpoint incorporates main commit `f40f984c32a5429d6dbe778f10d4e0b847e8a5a0` into Hưng's branch, starting from `43978ca`. Main itself is not changed. Git reported no textual conflicts; the integration changes below align the plugin with the updated backend contract.

## Changes

- Foundation 0.9.1 uses Unicode code-point limits for record/task form fields.
- Record/task form controllers send a stable idempotency key through the authenticated action bridge. Uncertain writes lock new submissions; manual retry preserves the key and payload and rechecks action availability. New deliberate submissions receive new keys. No automatic POST/file retry is added.
- The workflow proxy allows fixed, session-bound `waits`, `executions`, `completeWait` and `retrySync` operations. Writes require a key; the API owns authorization and state validation.
- Workspace remains registry/manifest based. Business-specific views stay in application modules; no application-ID branches were added to the core.
- Root `output/` and `tmp/` are excluded from Git and Docker build context. Backups, screenshots and package archives stay local.

## Verification

- 220 Vitest tests passed across 31 files; 34 Node tests passed for Foundation and bridge extensions.
- Type checks passed for contracts, API, agent worker, web and Logistics contracts. API, worker, bridge, Foundation and Next.js production builds passed. The host pnpm wrapper attempted dependency reinstallation with a different pnpm version, so local verification invoked installed compiler/build entrypoints directly. The API Docker image built with its pinned pnpm 10.23.0 and frozen lockfile.
- Local API was recreated and the gateway restarted. Foundation 0.9.1 was installed using NocoBase's package manager, then the existing NocoBase container restarted. Identity and directory fixtures were synchronized without resetting database volumes or user passwords.
- Workspace browser smoke passed login, application navigation, PKCE return to the selected application, shared connection state, disconnect/logout and simulated authorization errors.
- Native Studio menu smoke passed on `/admin/annfbogrejf`: Lattice Form and Lattice Danh sách remain available; no page schema was inserted. A first attempt using a different page path timed out waiting for a table; rerunning on the established fixture page passed.
- Logistics browser smoke passed: order `48b73da5-c5fc-4bb0-915f-03a30132824d`, state `received`, version 3; uncertain-create replay, warehouse restrictions and shared evidence bytes verified; no page errors.
- Procurement browser smoke passed: run `b823408c-7326-4f6f-bd12-3bb49a4293c3`, state `handed_over`, version 6; role transitions, history and evidence download verified.
- Create-reliability smoke passed against PostgreSQL: REST/action replay, concurrency, actor/organization isolation, strict input validation, current permissions/references, rollback and fresh-pool persistence.

Before updating the local runtime, both databases and the previous Foundation package were backed up under ignored `output/backups/main-integration-20261014/`. Browser and smoke fixtures retain demo records as evidence. The separate original checkout and its uncommitted files were not modified.

## Remaining phase-two work

This is an integration checkpoint, not phase-two acceptance. Reusable Inbox, Approval, Attachment, Timeline and Context Entity blocks, the UC1 dashboard and a full UI configuration export/import package remain to be implemented. Workflow bundle APIs export workflow definitions, not complete UI applications. Actual n8n/broker delivery and Asset mapping still require team integration. The separate entity-sharing branch is not included in this checkpoint.
