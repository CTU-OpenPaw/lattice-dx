# Local runtime hardening plan

**Goal:** Preserve integration configuration on startup and provide an honest, read-only readiness check without changing README or teammate-owned UI/adapters.

**Design:** Replace the shell-chain `local:up` with one small Node entry point. Reuse the existing safe command runner, select ignored `.env.integration` when present for every Compose operation, and opt in to integration services explicitly. Missing integration configuration fails before mutation. A separate doctor checks fixed loopback HTTP endpoints and reports service readiness only, not business acceptance.

## Deliverables
- [x] Add failing tests for env preservation, cold-checkout defaults, missing integration env, ordered startup and sanitized failures.
- [x] Implement `scripts/start-local.mjs`; preserve Docker workers and credentials as explicitly configured, without seeding accounts or processing queues.
- [x] Add tested bounded read-only doctor checks for core and optional integration endpoints; do not call the model or expose response bodies.
- [x] Verify the real stack, core authorization/workflow regressions and new command behavior from another working directory.
- [x] Independent code review found no actionable findings. Prepare the verified change for PR; UC1 remains explicitly incomplete.

## Verification — 21 October

- `pnpm check`: typecheck, 117 test files / 643 tests, production build passed before the two additional regression tests.
- Targeted rerun after adding oversized-response and late-preflight tests: 2 files / 9 tests passed.
- `pnpm local:up --integration`: successfully started core, NocoBase and integration using `.env.integration`.
- Doctor from `E:/` reported all six services ready. This proves HTTP readiness, not a complete fresh-install rehearsal or business acceptance.
- `pnpm test:workflows`: real procurement handover, persisted audit/outbox payload, isolated SQL retry worker and controlled receiver passed. Evidence: ignored `output/uc1-handoff/70f4f34f-b0b4-440e-8c1f-714de3c744db.json`.
- `pnpm test:team-integration`: signed HTTP ACL separation, explicit grant/revoke, tenant isolation, replay and stale revision passed.

## UC1 remaining acceptance

Remote UI branch `feat/nocobase-foundation-config` at `b7a2255` includes newer Case Board and Agent UI work. Remote integration branch `feat/uc1-n8n-handover` at `2104710` adds an n8n intake workflow and tests. The intake creates a draft procurement run; it does not implement the outbound handover receiver.

Still required for complete UC1: real handover event → authenticated n8n receiver → mapped Asset update in Orion-LD → read-back and visible synchronization status, including replay/error behavior. Do not enable the existing outbox backlog without reviewing the receiver and pending events. Teammate branches and README remain untouched.
