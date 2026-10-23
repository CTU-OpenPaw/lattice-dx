# UC1 backend handoff implementation plan

**Goal:** Verify Duy's UC1 producer boundary and hand over a reproducible event fixture.

**Architecture:** Reuse the authenticated procurement acceptance and production outbox
code. Read its newly created event in a read-only database transaction, compare it to
the API state/audit, and export after the entire acceptance succeeds. No receiver or
mapping implementation is added.

## Constraints

- Work on one `feat/` branch; preserve unrelated files and teammate branches.
- Preserve all public backlog; controlled delivery runs only in an isolated schema.
- Keep secrets outside Git; no automatic Notion ticks, model integration or release.

## Tasks

- [x] Start Docker and existing core/NocoBase services with integration configuration.
- [x] Run existing procurement acceptance before changes.
- [x] Extend `scripts/smoke-workflows.mjs` with producer-payload assertions, a canonical
  demo Asset URN and an ignored, exclusively created fixture export.
- [x] Run the modified acceptance; verify artifact contains the actual persisted event
  and no token/authorization configuration.
- [x] Document the exact receiver contract and remaining integration responsibilities
  in `docs/uc1-backend-handoff.md`; correct the outbox enablement command in the runbook.
- [x] Run broker subscription and shared integration acceptance separately; record scope.
- [x] Check diff, relevant syntax/tests and full project checks; independent review
  approved without findings. Commit and PR publication are the final delivery steps.
