<!--
  @file LatticeDX — Open Digital Enterprise Platform
  @author CTU-OpenPaw
  @copyright (C) 2026 CTU-OpenPaw
  @license Apache-2.0
  @see https://github.com/CTU-OpenPaw/lattice-dx
  SPDX-License-Identifier: Apache-2.0
-->

# LatticeDX Disaster Recovery & Point-in-Time Recovery (PITR) Runbook

## 1. Recovery Objectives
- **RPO (Full-Stack Scheduled Snapshot):** <= 24 hours (daily encrypted bundle via `stack-recovery.mjs`).
- **RPO (Production WAL PITR):** <= 5 minutes (`archive_timeout = 300` in [`pitr.conf`](../infra/config/postgres/pitr.conf) archiving to encrypted RustFS S3).
- **RTO (Full Stack Restore):** <= 30 minutes via verified bundle restore and automated ephemeral verification.

## 2. Full-Stack 7-Component Snapshot (`scripts/stack-recovery.mjs`)
All 7 stateful stores are backed up in `output/backups/stack/stack-<uuid>/`:
1. `nocobase-db` (`nocobase/*.dump`): NocoBase metadata, roles, workflows, business collections, attachment rows.
2. `uploads` (`uploads.tar.gz`): `/app/nocobase/storage/uploads`.
3. `keycloak` (`keycloak.dump` + `keycloak-realm.json`): OIDC realm, clients, sessions/user mappings.
4. `orion-mongo` (`orion-mongo.archive.gz`): NGSI-LD IT/OT entities & subscriptions (authenticated when `ORION_MONGO_USER`/`ORION_MONGO_PASSWORD` are set).
5. `n8n` (`n8n-workflows.json` + `n8n-credentials.json`): n8n workflows and encrypted credentials.
6. `lattice-db` (`lattice.dump`): Companion `/v1` API PostgreSQL database.
7. `engine-objects` (`engine-objects.tar.gz`): Sidecar filesystem object store (`/var/lib/latticedx/objects`).

Binary artifacts stream directly between Docker and disk (`maxStreamingBackupBytes = 10 GiB`, overridable via `LATTICE_MAX_BACKUP_BYTES`) with SHA-256 verification and strict `tar -tvzf` filtering rejecting symlinks, hardlinks, device nodes, and path traversal.

## 3. Ephemeral Container Rehearsal (Non-Destructive)
Never run live restore tests on production databases. Use `--ephemeral` to boot an isolated PostgreSQL container (`ldx-dr-ephemeral-*`), restore all SQL dumps into throwaway databases, verify `requiredNativeTables` + `@latticedx/` migrations + attachment tables, inspect tar archives, and destroy the temporary container automatically:

```bash
pnpm backup:stack
node scripts/stack-recovery.mjs rehearse output/backups/stack/stack-<id> --ephemeral
```

`fullRecoverability: true` is reported ONLY when all 7 components pass checksums, `--ephemeral` PostgreSQL restore succeeds, object/upload tars extract safely, and application schema/migration health checks pass.

## 4. Guarded Production Restore
`restore` fails closed unless SHA-256 verification passes on every requested artifact AND `--confirm-restore=<stack-id>` matches the exact bundle directory name:

```bash
# Dry-run first
node scripts/stack-recovery.mjs restore output/backups/stack/stack-<id> --confirm-restore=stack-<id> --dry-run

# Apply restore
node scripts/stack-recovery.mjs restore output/backups/stack/stack-<id> --confirm-restore=stack-<id>
```

## 5. Continuous WAL PITR (`scripts/pitr-backup.mjs` + RustFS S3)
Production Compose (`infra/compose/prod.yml`) enables `wal_level=replica`, `archive_mode=on`, `archive_timeout=300` and provides S3-compatible Apache-2.0 `rustfs` (`http://rustfs:9000`).

Configure WAL-G (with mandatory client-side encryption via `WALG_LIBSODIUM_KEY_PATH` or `WALG_PGP_KEY_PATH`) or pgBackRest (`PGBACKREST_REPO1_CIPHER_PASS`) and verify readiness without printing secrets:

```bash
WALG_S3_PREFIX=s3://lattice-dr/nocobase \
WALG_LIBSODIUM_KEY_PATH=/etc/latticedx/walg.key \
AWS_ENDPOINT=http://rustfs:9000 \
node scripts/pitr-backup.mjs check-config --backend=wal-g

node scripts/pitr-backup.mjs restore-plan --backend=wal-g --target-time=2026-11-22T06:00:00Z
```
