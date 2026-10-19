# Incident agent worker implementation plan

**Goal:** Execute one authorized incident job using the real `combo` model and persist a proposal for human review.

**Architecture:** Reuse existing claim/context/result API and provider client. A one-job function and CLI run on demand; the existing demo server remains unchanged. Backend remains responsible for leases, current authority, and workflow transitions.

**Constraints:** Only `combo`; no new dependencies; no model tools, arbitrary URLs, direct entity writes, automatic approval, or edits to teammate branches. Never log credentials, leases, context, or raw provider errors.

## 1. One-job executor
- [x] Write failing checks for the successful flow, denied context, invalid output, lease expiry, provider failure, and uncertain result delivery.
- [x] Implement bounded HTTP requests, strict output parsing and scoped evidence references in `apps/agent-worker/src/incident.ts`.
- [x] Support bounded UTF-8 text attachments; reject unsupported formats explicitly.

## 2. Operator entry point
- [x] Add a CLI using ignored environment credentials and an explicit job UUID. Require `AGENT_MODEL=combo` before any network call.
- [x] Document worker token roles and exact limits; keep transport ownership with Nhi.

## 3. Verification
- [x] Run focused tests, typecheck, build and full regressions.
- [x] Exercise signed API + isolated PostgreSQL + real combo model; assert review_pending, unchanged asset, and forbidden agent approval.
- [x] Review the diff and report what is verified versus still awaiting transport/UI integration. Do not tick Notion.

Evidence: `pnpm check` passed 634 tests in 114 files, typecheck and build. The live fixture passed twice through `combo` (resolved member `deepseek-v4.1-flash-free`), including an opaque external event ID. Review corrections cover opaque notification IDs and uppercase UUID input. Only this local implementation checklist was updated; Notion was not changed.
