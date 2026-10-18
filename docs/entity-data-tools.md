# Entity documents, import/export and explicit migration

These contracts belong to the engine data service. NocoBase and integration adapters call the same authorized APIs; they do not gain database authority through a connector.

All mutations require `Idempotency-Key`. Entity mutations also require the current `expectedVersion`. Identity and organization come from verified JWTs. Error responses use `{error: string}`: invalid body 400, missing identity 401, missing route role 403, invisible resource 404, stale version/digest or incompatible operation 409.

| Capability | Endpoint | Required roles |
| --- | --- | --- |
| Link clean uploaded file | `POST /v1/entities/:id/attachments` | `data:write`, current entity edit |
| Unlink file | `DELETE /v1/entities/:id/attachments/:fileId` | `data:write`, current entity edit |
| List contextual files | `GET /v1/entities/:id/attachments?limit=20&offset=0` | `data:read`, current entity read |
| Download contextual content | `GET /v1/entities/:id/attachments/:fileId/content` | `data:read`, `files:read`, current entity read |
| Validate import | `POST /v1/entity-imports/dry-run` | `data:write` |
| Commit import | `POST /v1/entity-imports/commit` | `data:write` |
| Export one bounded page | `POST /v1/entities/export` | `data:read` |
| Validate/commit migration | `POST /v1/entities/:id/migration/dry-run` or `/commit` | `data:write`, exact owner |

Attachment creation accepts `{fileId, expectedVersion}`. The uploaded file must be caller-owned, in the same organization, clean, and without a legacy record link. Detach accepts `{expectedVersion}`. Entity sharing provides contextual download access only; it does not open the independent `/v1/files` endpoint. Revocation and scan state are checked again when downloading. Metadata uses normal pagination. Shared archived entities remain inaccessible.

Import accepts `{schemaId, schemaVersion, format: "json" | "csv", content}`. JSON content is an array of `{title, attributes}`; CSV starts with the unique `title` header and declared schema fields. Quoted commas, embedded newlines, and doubled quotes are supported. Limits are 256 KiB of decoded UTF-8 content and 100 rows. Dry-run writes nothing and returns row errors, row count, validity, and a digest for a valid normalized batch. Commit sends the same input plus `expectedDigest`; it returns `{schemaId, schemaVersion, entityIds}`. All entities, audit entries, and the batch receipt commit together. A published newer schema does not change an explicitly pinned import. This is create-only import, without upsert, relations or grant import.

Export accepts `{query, format}` using the existing typed entity query. Access filtering happens before the page limit. Its response is `{format, content, page}`; at most 100 rows and 2 MiB are returned. CSV text beginning with spreadsheet formula characters receives a leading apostrophe; this protective marker can appear when reimporting CSV. Numeric negative values retain their numeric representation. Export excludes ownership and authorization metadata.

Migration accepts `{expectedVersion, targetSchemaVersion, attributes}` with the complete new attributes, and commit additionally requires the dry-run `expectedDigest`. It preserves ID, owner and title, advances to an existing higher publication of the same schema, and records the old/new pin in audit. Existing relation names and target schemas must remain compatible; unlink incompatible relations explicitly first. Publishing a schema never silently migrates existing entities.

Run `pnpm test:entity-data-tools` against the local core stack to check signed HTTP and isolated PostgreSQL behavior. Verification results are recorded separately in `docs/verification.md`; this contract is not proof that every acceptance check has passed.
