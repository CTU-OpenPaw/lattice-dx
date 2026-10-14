# Optional filesystem object storage

This is the planned storage integration contract. Check the [execution ledger](superpowers/plans/2026-10-14-enterprise-composition.md) for implementation and acceptance status.

PostgreSQL remains the default byte provider. Upload limits, virus scan policy and file permissions stay the same. Optional offload moves only clean files to verified immutable objects, then switches database metadata in the caller's transaction. Failure before commit retains the original PostgreSQL bytes; an unreferenced object may remain for manual inspection.

After the switch commits, an unavailable or corrupt object fails closed. Database bytes have been cleared, so there is no fallback copy in the row. File metadata remains readable under its ordinary policy without loading bytes; pending or rejected content cannot be downloaded.

Deployment configures an isolated absolute `FILE_STORAGE_ROOT` and `FILE_STORAGE_PROVIDER=filesystem`. `FILE_STORAGE_WORKER=true` opts into migration. Generated UUID keys are server controlled. Never expose root paths, object keys or provider choices in public request bodies. Disabling the worker stops future switches; existing filesystem rows still need the configured root for reads.

The same storage provider must cover owner downloads, non-workflow task attachments, workflow-shared files and entity-context attachments. Each path first checks current resource authority and clean scan state. Storage itself grants no access.

## Recovery

`backup:core` and its rehearsal cover the database only. Their report explicitly does not establish full recoverability for external objects.

The paired backup implementation restores a dump into a generated fixture first and reads its exact object inventory. It copies and verifies those immutable objects, then writes a bounded final manifest. Inventory is derived from the dump snapshot, rather than from a separately queried changing live database.

A complete rehearsal must restore both database and object root, verify every referenced size/checksum, and exercise an authorized download through the application loader. A report with `downloadVerified:false` is an intermediate copy-verification checkpoint. It is not completed application recovery. Artifact directories and unreferenced objects are retained; there is no automatic deletion.

This provides local filesystem storage and local rehearsal. Distributed object storage, high availability and offsite recovery require separate implementation and acceptance.
