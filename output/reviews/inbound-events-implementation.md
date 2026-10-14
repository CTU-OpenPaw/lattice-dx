# Inbound events implementation

Implemented the production ingress in `apps/api/src/events` with authenticated event receipt and subscription routes, strict bounded parsers, metadata-only durable receipts, subscription versions/audit/mutation receipts, and run provenance. Subscription IDs are portable lowercase slugs of at most 100 characters. Subscription POST requires an Idempotency-Key; PATCH requires the complete DTO, fixed ID, expectedRevision, and Idempotency-Key.

Event receive locks organization/source/event ID, checks the current active directory source, compares a SHA-256 canonical content fingerprint for replay, locks matching subscriptions in ID order, and uses the current JWT actor to start each pinned publication. Workflow createWithClient uses the supplied transaction client; REST create remains its transaction wrapper. Derived records, workflow runs/start receipts/audit/files, the event receipt, and provenance commit together. No network hooks execute in the transaction. A zero-match acceptance consumes the event ID without requiring workflow start roles.

Subscription mutations validate the exact published version, current source metadata roles, all declared required mappings, optional mapping names, literal types/references, and literal assigned-reader eligibility on the transaction client. A tenant advisory lock serializes match-group changes and enforces at most ten enabled matches. Receipts compare canonical mutation content; updates enforce expectedRevision and retain immutable version snapshots.

Verification performed by the implementer:

- RED event-policy module coverage before implementation; GREEN 4 parser/authority/canonical key tests.
- RED createWithClient assertion before extraction; GREEN pinned-client test and existing registry replay tests.
- RED signed route endpoints (404) before route registration/wiring; GREEN signed JWT route tests, strict mutation metadata, tenant/source forwarding, and 128 KiB event body limit.
- Targeted Vitest command: `pnpm exec vitest run apps/api/src/events apps/api/src/workflows/database-registry.test.ts apps/api/src/workflows/routes.test.ts` — 5 files, 28 tests passed.
- `pnpm --filter @dx/api typecheck` — passed.
- `git diff --check` — passed; existing Windows line-ending normalization warnings only.

The parent reported its live signed-JWT HTTP and private PostgreSQL acceptance smoke passed against the working implementation: duplicate/race single receipt, changed-content 409, two-subscription receipt failure rollback, disabled source replay denial, pinned version/source ownership, and pool-max-one restart/replay/new event checks. That acceptance script and full regression/independent review remain parent-owned.

Scope preserved: no dependencies, UI, upstream, adapters, Notion, credentials, or user files were changed. Parent operations changes in app/database/index were committed before event wiring, and are preserved.
