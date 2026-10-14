# Enterprise typed data implementation

Implemented increment 1 backend storage and signed API modules under `apps/api/src/entities`. The engine owns typed enterprise entities; Studio/UI and capability groups 2–8 remain outside this change.

## Contracts and storage

`entityDatabase(pool)` returns the portable `EntityRepository` in `types.ts`. Scope always consists of signed actor ID and organization ID. Schemas are tenant scoped; entities, relations and history require current caller ownership and tenant. Schema drafts use revisions, publications are immutable, and each entity stores its original schema version. A `data:read` caller can fetch `/v1/entity-schemas/:id/versions/:version` to render that pinned version without reading designer drafts.

Field definitions support text, boolean, safe integer, precision-preserving decimal strings, calendar dates and bounded enums. Unknown attributes, prototype keys, authority metadata, unsupported field options and explicit null relation definitions reject. Decimal strings allow at most 38 total digits and 18 fractional digits. Text defaults to 4000 Unicode characters; explicit maxLength is 1–4000. Schema definitions and attributes also have a 16 KiB serialized UTF-8 storage boundary; HTTP retains the existing 16 KiB entire-body boundary.

All entity creates and mutations require a valid command key. Dedicated enterprise receipts preserve recursively sorted typed JSON fingerprints without changing legacy workflow/create normalization. Receipt lookup, stable UUID row locks, entity version update, audit insertion and receipt insertion use one PostgreSQL client transaction. Replays validate current owner/tenant first, then return the original accepted snapshot without applying stale version or archive checks a second time. New archive of an already archived source rejects. New link/unlink validates source expectedVersion even for existing/absent set membership; exact set membership repeats return current source without fabricated audit or version advancement, and persist that first receipt result.

New links require active source and target. Unlink permits an archived target under the approved lifecycle amendment, while retaining active source, current owner/tenant, declared relation and correct target schema checks. Relation listing filters targets by their current readable owner/tenant and archive status. There is no hard-delete endpoint.

## API and deployment wiring

Fastify exposes strict schema draft/publish/version and entity CRUD/archive/relation/history endpoints with `data:design`, `data:read` and `data:write` checks. Missing repository explicitly returns 503; malformed signed identity returns 401; absent role or tenant returns 403; hidden data returns 404; stale state or conflicting command returns 409. Typed policy errors remain 400. Query parsing clones Fastify's own query properties before strict validation; JSON body prototype validation stays strict.

`connectRecords` bootstraps the repository and `index.ts` injects it into the API. A separate APISIX route forwards GET/POST/PUT/PATCH/DELETE only for enterprise schema/entity paths with the existing OIDC/rate-limit/request-ID controls. The local public realm defines three data roles and assigns them only to Alice. Existing users, passwords, volumes and original routes are unchanged by these files.

## Validation evidence

- Initial policy behavioral RED: 3 failed assertions; then GREEN.
- Receipt behavior RED: replay executed a second mutation, conflicting input did not reject, and replay ignored current authority; then GREEN.
- Signed API RED: missing endpoints returned 404 instead of expected authentication/input/unavailable results; then GREEN.
- Regression RED/GREEN for non-string schema type, inherited optional attributes, archived-target unlink, explicit null relations, UTF-8 storage bounds and valid Fastify query pagination.
- Fresh `pnpm exec vitest run apps/api/src/entities`: 3 files, 17 tests passed (14 October 2026, 10:47 local).
- `pnpm --filter @dx/api typecheck`: passed after the pagination fix.
- `git diff --check`: passed.
- Impacted entity/create-command/records/foundation/workflow regression run: 17 files, 108 tests passed before the final added route coverage/pagination fix; the final entity rerun covers those changes.

The parent agent owns real private PostgreSQL acceptance, live signed gateway acceptance, full workspace checks, independent review and publication/PR handling. Those checks are not claimed by this implementation report. Command unit tests use a controlled query boundary to exercise transaction/replay control; SQL isolation, races, rollback and persistence require the parent's real-database smoke.

## Independent review correction — creation replay revocation

Read `enterprise-data-task-review.md` and confirmed its Important finding: a create receipt replay checked only schema publication existence, allowing the historical result to remain readable after current entity ownership or tenant changed. Added a focused `repository.create` regression; the RED run returned the accepted attributes instead of rejecting the moved-owner replay with 404.

The command helper now accepts an optional receipt-result validator. Only `entity.create` supplies the new validator: it locks and loads the receipt's entity ID with current actor and organization filtering on the same transaction client before returning the snapshot. Hidden entities return 404. Current same-owner archived entities still replay the original accepted version and attributes, including schema v1 after an incompatible v2 publication. Fingerprint conflicts retain their existing 409 behavior. No route, schema or generic workflow contracts changed.

Fresh verification after this correction (14 October 2026, 10:52 local):

- `pnpm exec vitest run apps/api/src/entities/database.test.ts` before the fix: 1 failed, 4 passed; failure explicitly reproduced disclosure after owner revocation.
- `pnpm exec vitest run apps/api/src/entities` after the fix: 3 files, 18 tests passed.
- `pnpm --filter @dx/api typecheck`: passed.
- `git diff --check`: passed.

The new repository regression checks current owner and tenant denial, same-owner archive replay, preserved schema v1/result after v2 publication, row locking and exactly one connection per command. Parent real PostgreSQL revocation acceptance and rebuilt live API acceptance remain separate required checks.
