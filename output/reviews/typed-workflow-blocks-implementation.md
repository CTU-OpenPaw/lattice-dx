# Typed workflow blocks implementation

Status: source implementation and unit verification complete; real PostgreSQL acceptance belongs to the parent task.

## Scope

- Preserved and finished prior implementer's uncommitted contracts, executor, validators, entity client query helper, catalog, bundle preview/portability, and tests.
- Seven actions execute on the supplied workflow transaction client: entities.create/read/query/update/archive/link/unlink.
- Creation resolves an immutable schema publication pin and owns the entity under the actual workflow actor. Existing entity mutations use their current schema pin and current shared ACL helpers.
- Typed literal/data/input values support text, canonical safe integers, decimal strings, exact boolean strings, date strings and enum strings. Final entity schema validation enforces publication-specific constraints.
- Result IDs and versions refer only to earlier allowed steps; attributes cannot bind arbitrary result attributes. Entity evidence stores IDs/versions/schema versions and bounded query page metadata, never titles or attribute snapshots.
- Existing IDs from non-result bindings are normalized and locked in sorted UUID order before execution. Valid prior entity result aliases ultimately refer to those locked IDs or a new ID created in this transaction. A regression exercises both cases.
- Bundle imports reject source entity ID literals and advertise required data capabilities. The block catalog describes input and output schemas for all seven actions and filters by actor capability.

## Repairs and RED/GREEN evidence

Initial targeted run: 33 passing, one failing. Missing prelocked entities raised EntityError rather than the WorkflowError handled by workflow routes.

Added invalid entity configuration cases for schema ID, zero publication pin, reserved attribute name, and zero expected version. Targeted run observed four new failures, all because entity policy errors escaped as EntityError. Wrapped the validator's shared entity policy failures and prelock/UUID failures as controlled WorkflowError while retaining their HTTP status. All five cases then passed.

Corrected an inherited mock entity map inferred with archivedAt restricted to null; its explicit Entity type now supports archive transitions and passes API typecheck.

The preserved implementation/tests predate this worker; no claim is made that this worker observed their original RED runs. New alias/creation regression confirms existing behavior without adding production code.

## Verification

- `pnpm exec vitest run apps/api/src/workflows apps/api/src/entities packages/contracts`: 26 files passed, 153 tests passed.
- `pnpm --filter @dx/api typecheck`: passed.
- `pnpm --filter @dx/contracts typecheck`: passed.
- `git diff --check`: passed (Git emitted only existing CRLF normalization notices).

Self-review checked actual-actor scope, current read/edit/owner ACL calls, pinned publication resolution, sorted locks including result aliases, metadata-only workflow evidence, bounded ACL-before-limit query SQL, no caller-executor nested pool acquisition/transaction boundaries, and portable bundle resource policy. No additional actionable source finding remained.

## Review boundaries

Real PostgreSQL acceptance must establish workflow receipt replay, forced late-failure rollback of entity/run/audit/action results, concurrent commands, and max-one-connection behavior. Unit mocks establish executor routing and failure/ACL behavior but cannot establish PostgreSQL rollback or race semantics. Parent owns scripts, package metadata, docs, gateway, and independent whole-change review.
