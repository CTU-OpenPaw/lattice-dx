# Duy — Native database recovery, 07/11/2026

## Goal and boundary

Implement stage 6's native database recovery slice using PostgreSQL tooling and existing recovery guards. Preserve NocoBase collections, page metadata, ACL, workflows and integration journals; do not create another application/schema/workflow engine. The source database is read-only. Restore only into a generated, isolated fixture database, with cleanup on success or failure.

This is database-only recovery. Database-backed native attachment bytes are included; local uploads, S3/MinIO, encryption keys, Keycloak, broker, n8n, plugins and live application health are not covered. Do not tick the whole Notion backup/files/integration-store task.

## Plan

1. Check GitHub PRs, review comments, mentions and current Notion ownership. Review new integration branch without changing Nhi's worker or Hưng's UI.
2. Write failing recovery tests: wrong database/scope, corrupt dump, incomplete store inventory, metadata/attachment mismatch, isolated target and cleanup failures.
3. Add `scripts/native-database-recovery.mjs`, reusing `scripts/lib/backup-policy.mjs`. Use binary custom-format dump; store exclusive, private local artifacts. Compare restored table counts and canonical data fingerprints against the backup's restored snapshot. Never compare a live changing source with an old snapshot.
4. Add focused operator documentation and package commands. Verify against a real PostgreSQL restore using existing local native data and disposable sentinel metadata/content, without restarting the main app or modifying teammate flows.
5. Run affected tests and repository checks, independent review, commit and open a `feat/` PR. Update Notion with evidence and remaining scope; keep broad unfinished boxes unticked.

## Acceptance

- Source database is never a restore/drop target; corrupt, mismatched or incomplete artifacts fail before a target is created.
- Native stores and page/permission/workflow metadata survive; table inventory and fingerprints match the snapshot. Native attachment bytes are covered by the table fingerprint.
- Failure cleanup cannot erase the source; reports contain counts/digests rather than record contents or credentials.
- No claims of UI E2E, full-system recovery, external-file verification or migration cutover.

## Verified checkpoint — 07/11

- No open PRs/issues or new GitHub issue/review comments or mentions found at session start. Nhi's integration branch has a new queue/retry implementation; read-only review found no confirmed blocker, while native rule/transport wiring remains separate and no PR was opened for that branch.
- Native database snapshot and repeat restore passed for 116 existing public tables. Isolated-source acceptance passed for 117 tables including a binary fixture, same-size byte mutation, source changes after snapshot, corrupted artifacts denied before database commands and cleanup. No `dx_restore_*` database remained.
- `pnpm check`: typecheck, 812 tests across 132 files and workspace builds passed. Focused recovery suites: 13 tests passed. Independent review found no confirmed P1/P2 issue in the scoped implementation.
- Keep the full stage 6 backup/files/integration-store checkbox open: external objects, other databases, keys and application boot/browser verification remain outside this database rehearsal.
