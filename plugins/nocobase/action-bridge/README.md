# LatticeDX Action Bridge

Original team server plugin, Apache-2.0. Tested with NocoBase 2.2.20. Host provides `@nocobase/server`; no upstream implementation is copied or bundled. `server.cjs` is the plugin entry; `bridge.cjs` owns short-lived connections and outbound calls. CommonJS runs directly in the pinned host; no build artifact required. Plugin tests run in root Vitest.

This server-only plugin uses public resource/ACL hooks with explicit identity and method checks; it does not add UI or replace NocoBase login. Group licensing does not relicense the upstream SDK/runtime or resolve distribution obligations. See source/license review in `docs/nocobase-source-review.md` and [integration guide](../../../docs/nocobase-action-auth.md).

Context Entity uses the fixed read-only `workflow` operation `entityContext` (`GET /v1/workflows/:id/entity-context`) and `entity` operation `detail` (`GET /v1/entities/:id`). Both retain the current business session token server-side and preserve upstream authorization errors. No broker integration credential, caller URL or tenant override is accepted. See [Context Entity](../../../docs/context-entity-block.md).
