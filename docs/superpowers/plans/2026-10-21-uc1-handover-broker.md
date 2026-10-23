# UC1 handover to broker implementation plan

**Goal:** Close the actual procurement handover → n8n → Orion-LD gap without processing unrelated backlog or changing teammate branches.

**Architecture:** A credential-protected, opt-in API integration adapter accepts only an exact canonical copy of an existing procurement handover outbox event. PostgreSQL serializes delivery per Asset and retains successful event receipts. n8n forwards the envelope with its idempotency key to the adapter and acknowledges only the adapter's result. The adapter checks tenant-scoped Department/Location references, preserves unrelated Asset attributes and newer observations, writes the handover and reads it back before recording success.

**Constraints:** No README changes, new dependencies, arbitrary destination URLs from payloads, unrestricted outbox enablement, teammate branch edits or secrets in exported workflows. Use a separate adapter credential from the webhook credential. Automatic delivery must require event type + organization + created-after scope, preserving existing backlog. Broker and PostgreSQL are not a distributed transaction; retries recover from read-back of the same sourceEventId. All writers of these handover attributes must obey the ownership/ordering policy; independent broker writers are not atomically fenced.

## Steps
- [x] Write failing broker-mapping and route/database contract tests; implement the minimal adapter and durable receipts using existing pg/Fastify utilities.
- [x] Export an inactive n8n handover workflow with explicit response/error handling; test its routing and status normalization.
- [x] Add opt-in runtime configuration and an idempotent local setup path that preserves existing workflows/credentials and data.
- [x] Run a fresh procurement handover through the real backend, n8n, adapter and broker; verify duplicate/conflict/authorization behavior and restart persistence.
- [x] Run relevant/full checks, request independent review, fix findings and create PR #28. Record exact acceptance boundaries, including UI work that is not independently exercised.

## Alternatives considered
Doing all validation and state management in n8n would duplicate backend authority and complicate transactional replay handling. A new standalone integration service adds a deployment and duplicate database plumbing. The small opt-in adapter reuses existing API and SQL boundaries while leaving n8n's routing role visible.

## Verification

- `pnpm check`: 118 files / 646 tests, typecheck and production build passed.
- `pnpm test:uc1-database`: real SQL verifies concurrent duplicates, source identity, stale events, rollback/retry, reconnect, cancellation/replay and scoped worker selection.
- Fresh automatic acceptance: workflow `fbb8ee0d-48bc-42d4-9732-866daaf826a8`, event `cd3c501f-6fea-4f54-8b85-bcc9d90e825b`, one attempt. Both broker read-back and real notification/context projection passed. Existing backlog unchanged.
- Broker restarted with its existing volume; read-back, context and replay passed afterwards.
- UI SSO/read check showed that same workflow at handed_over/version 6 and its six history entries. This is a read check, not a full UI-driven scenario or broker-sync panel acceptance.
- Independent review caught receipt replay after cancellation; fixed, then SQL tests proved receipt replay and serialization with in-flight cancellation. Second review found no new scope issues.
- Keep UI changes with Hưng: sync status panel and stale disabled-event caption remain. No README, Notion task ticks or teammate branch changes.
