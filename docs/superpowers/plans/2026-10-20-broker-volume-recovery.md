# Broker volume recovery plan

**Goal:** Restore Orion-LD availability without changing or deleting the original MongoDB volume.

**Architecture:** Read-only archive, restore into a new named volume, repair only the known invalid hosted-context URL on the copy, verify content and broker startup, then switch the existing Mongo service to that volume. Use an optional Compose volume name; do not change database credentials or public ports.

- [x] Identify and reproduce exit 139 on a disposable copy; confirm the single-context correction restores startup.
- [x] Save full archive and restore Orion namespaces into a fresh recovery volume.
- [x] Compare every source document with the restored copy, allowing only the specific URL correction.
- [x] Test broker startup against the recovered volume before switching services.
- [x] Switch Mongo volume with writers stopped; preserve the original volume and archive.
- [x] Verify subscription delivery, data preservation and broker restart.
- [x] Document rollback and the remaining upstream recurrence risk; review the small Compose change.

Restart verification caught recurrence after subscription PATCH. An object context alone and an expanded-term PATCH were insufficient; the final fix uses Orion's native hosted-context API and references its returned URL. A failing regression preceded the fix. Both disposable and recovered production-local brokers passed notification tests and restart with zero null-URL contexts.

Independent review corrected the volume default to preserve Compose project isolation; configuration was checked for two project names and the actual recovery override. Final `pnpm check`: 636 tests in 115 files, typecheck and all builds passed. See `docs/broker-recovery.md` for artifacts, data scope, administrative context growth and upstream limitations.
