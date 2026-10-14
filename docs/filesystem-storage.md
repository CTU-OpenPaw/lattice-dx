# Optional filesystem object storage

This storage integration is implemented and locally accepted. Check the [execution ledger](superpowers/plans/2026-10-14-enterprise-composition.md) for the evidence and remaining delivery gates.

PostgreSQL remains the default byte provider. Upload limits, virus scan policy and file permissions stay the same. Optional offload moves only clean files to verified immutable objects, then switches database metadata in the caller's transaction. Failure before commit retains the original PostgreSQL bytes; an unreferenced object may remain for manual inspection.

After the switch commits, an unavailable or corrupt object fails closed. Database bytes have been cleared, so there is no fallback copy in the row. File metadata remains readable under its ordinary policy without loading bytes; pending or rejected content cannot be downloaded.

Deployment configures an isolated absolute `FILE_STORAGE_ROOT` and `FILE_STORAGE_PROVIDER=filesystem`. `FILE_STORAGE_WORKER=true` opts into migration. Generated UUID keys are server controlled. Never expose root paths, object keys or provider choices in public request bodies. Disabling the worker stops future switches; existing filesystem rows still need the configured root for reads.

The Compose object volume is mounted at `/var/lib/latticedx/objects`. The image creates that root owned by the runtime user (UID1000) with mode0700 before switching to that user. On Linux the root must belong to the process user and forbid group/other writes; ancestors and objects cannot be symlinks. On Windows isolate the directory with operating-system ACLs. An existing incorrectly owned volume requires an operator to inspect its exact mount and ownership; do not reset or recursively rewrite user volumes. Startup rejects filesystem rows without a configured reader, even if offload is disabled or the selected write provider is PostgreSQL.

The same storage provider must cover owner downloads, non-workflow task attachments, workflow-shared files and entity-context attachments. Each path first checks current resource authority and clean scan state. Storage itself grants no access.

## Recovery

`backup:core` and its rehearsal cover the database only. Their report explicitly does not establish full recoverability for external objects.

The paired backup implementation restores a dump into a generated fixture first and reads its exact object inventory. It copies and verifies those immutable objects, then writes a bounded final manifest. Inventory is derived from the dump snapshot, rather than from a separately queried changing live database.

A complete rehearsal restores both database and object root, verifies every referenced size/checksum, and exercises an authorized download through the application loader. Actual paired recovery passed with scanned, offloaded files; missing bytes, changed checksums and omitted manifest references failed. A report with `downloadVerified:false` remains an intermediate copy-verification checkpoint. Artifact directories and unreferenced objects are retained; there is no automatic deletion. See [commands and manual recovery](recovery.md).

This provides local filesystem storage and local rehearsal. Distributed object storage, high availability and offsite recovery require separate implementation and acceptance.
