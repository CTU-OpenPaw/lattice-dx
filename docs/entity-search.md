# Authorized entity full text search

`POST /v1/entities/search` requires `data:read` and a verified organization. It searches the caller's currently readable, active business entities.

```json
{
  "q": "equipment repair",
  "schemaId": "assets",
  "schemaVersion": 1,
  "limit": 50,
  "offset": 0
}
```

The schema and publication are optional together. Text is trimmed and bounded to 200 Unicode codepoints and 800 UTF-8 bytes. The body is bounded to 4 KiB; limit is 1–100 and offset 0–10000. SQL, custom search operators, sorting and HTML options are rejected.

PostgreSQL's `simple` text configuration indexes titles and scalar attribute values. Attribute names, attachment bytes and private workflow projection values are excluded. Search input is passed to `plainto_tsquery`, so punctuation cannot become an executable SQL or tsquery expression. This is token search, not language-specific stemming or semantic search.

Current tenant, entity access, archival state and optional schema pin are applied before the page limit. Results use the ordinary entity shape and page metadata. Follow `hasMore` and `nextOffset`; results are ordered by creation time and ID, and pages are not frozen snapshots.

Generated vectors update as entity values change, including canonical imports and migrations. Revoking a grant, disabling shared membership or archiving an entity removes it from subsequent searches. A small result set may legitimately use a sequential plan; the acceptance fixture verifies a selective GIN plan on a populated database rather than forcing an index to claim performance.

Verification: `pnpm test:entity-search` checks signed API and isolated PostgreSQL pagination over hidden rows, current access changes, injection as plain text, scalar-value indexing, generated updates, actual selective GIN planning and poolmax1 restart.
