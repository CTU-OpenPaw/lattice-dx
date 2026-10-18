# Duy Phase 2–3 Completion Plan

> **For agentic workers:** Use superpowers:subagent-driven-development task by task, with one source implementer and independent review.

**Goal:** Complete the Duy backend checklist with executable incident/agent contracts and truthful Notion evidence.

**Architecture:** Reuse workflow runs, connector waits, entity permissions, signed events and transactional outbox. Add a bounded durable agent job adapter and incident reference configuration.

**Tech Stack:** TypeScript, Fastify, PostgreSQL, Vitest, current JWT identity, existing engine contracts.

## Global Constraints

- Preserve existing APIs, data, users and teammate source. Never reset volumes or alter credentials.
- Worker identity is not a human approver. Every tool is bound to a specific job, tenant and current requester ACL.
- Agent results are proposals only; no automatic business close or arbitrary entity writes.
- Reuse the current transaction/ACL/lease primitives; keep files focused and avoid new runtime dependencies.
- Only mark actually verified Duy tasks; real Nhi/Hung integration remains explicitly pending.

## Task 1: Procurement acceptance repair

- [x] Reproduce the isolated smoke fixture failure.
- [x] Copy the required workflow run/wait dependencies into its disposable schema; retain the production queue before/after guard.
- [x] Run `pnpm test:workflows`; record all six phase-2 acceptance outcomes (4ed4947, independent review clean).

## Task 2: Durable agent execution adapter

Files: new `apps/api/src/agents/{types,policy,database,routes}.ts` and focused tests; wire `app.ts`, `database.ts`, `index.ts` and authenticated gateway route.

- [x] Read the design and existing wait/ACL/outbox contracts. Pin a job to one live connector:agent wait and persisted requester. Persist queued/running/failed/completed, attempt count, expiry, lease and proposal evidence.
- [x] Write failing tests for strict input, permission boundaries, claim races, timeout/retry, replay and stale lease. Add repository methods for create/list/get/claim/complete/fail/retry with bounded execution.
- [x] Expose job scoped context tools for case, Asset and attached files. Reload requester identity from current directory rather than trusting worker-supplied claims. Reuse resource checks and clean-file readers.
- [x] Completion atomically persists proposal and settles only an approved incident definition's human-review wait. No generic callback can bypass proposal storage. Deny agent principals at human transitions.
- [x] Verify focused tests and types; report exact interfaces for the incident fixture (4b81804/adaddb0, independent review clean after three P2 corrections).

## Task 3: Incident reference integration and handoff

Files: `solutions/incidents/` versioned workflow/schema/rule fixtures; `docs/incident-agent-runtime.md`; signed HTTP/live PostgreSQL acceptance scripts and package commands.

- [x] Configure incident assignment and explicit acceptance, signed event provenance, agent wait, human approval/rejection and close.
- [x] Define rule entity schema (Asset, attribute, comparison, threshold, data age, cooldown and enabled/revision), using current entity CRUD as the contract.
- [x] Close emits Asset synchronization event and applies authorized state change transactionally; preserve notification/case/job/workflow trace.
- [x] Run PostgreSQL and authenticated API acceptance with simulated worker, exercising invalid privilege/tenant, duplicate delivery, stale lease, retry, human gate and close rollback.
- [x] Independently review changes, fix findings, run full `pnpm check`, document handoff and PR (f25b0c5/ce33d40; final review clean).

## Task 4: Notion evidence

- [x] Re-fetch current page to avoid overwriting team updates.
- [x] Tick only fully evidenced Duy phase-2/3 checkboxes; keep teammate boxes and phase acceptance unchanged.
- [x] Add concise PR/command/evidence note in the corresponding Duy sections and read back both sections (6/6 phase 2, 7/7 phase 3; teammate sections unchanged).
