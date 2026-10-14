# Reusable Task Inbox and Approval blocks

Hưng's phase-two increment, Foundation 0.10.0, 14 October 2026. No backend policy changes or Notion checklist edits are made by this increment.

## Scope and usage

Open `http://localhost:13000/lattice/apps/work`, sign in to the NocoBase host, and connect the business account through the existing PKCE bridge. **Cần xử lý** calls the workflow API with `inbox=true`: the server selects runs with an available transition for this actor. **Có quyền xem** lists readable runs, including owned and role-readable requests; it does not mean “created by me” or a completed-task category.

Search, state filters and pagination execute at the API. State choices are derived from readable published workflow definitions; persisted runs can retain older definition versions, so the displayed latest state choices need not cover every historical state. Row titles open a fresh detail request. The server's `availableTransitions` controls which action forms appear, and its `fields` controls required inputs. Custom actions use their IDs unless the manifest supplies plain-text labels. Reason is required when the API declares it, rather than inferred from a hardcoded rejection rule. Backend authorization remains authoritative on every write.

Approval supports the current workflow field kinds: text, positiveInteger, subject, department, location and file ID. Department/location choices come from scoped workflow references. Subject inputs currently require the opaque account identifier; file inputs require the ID of an already clean file. This release does not provide a people picker or Attachment block.

## Builder configuration

Native Add block exposes **Lattice Task Inbox** and **Lattice Approval**. Add a block, open its **Chọn ứng dụng và block** setting, choose an installed application/block and save. Binding persists through page reload.

The installed `work` manifest is a cross-workflow sample. To build a domain application, a trusted extension registers another manifest using a `lattice-api` collection with resource `workflows`. Keep business names and labels in configuration. No changes to Workspace or the block components are needed.

An Inbox block accepts:

- `type: "task-inbox"`, `collection`, `id`, `title`, `permissions`.
- Optional `definitionId` to restrict the block to one workflow definition; omission means all permitted definitions.
- Optional `pageSize` from 1 to 100, default 10.
- Optional `stateLabels` mapping state IDs to plain text.
- Optional `approvalBlockId` naming an Approval in the same manifest and definition scope. Selection opens that Approval **inside the Inbox** in both Workspace and native Studio pages.

An Approval block accepts `type: "approval"`, the same workflow collection, optional matching `definitionId`, optional `runId` UUID, and plain-text `actionLabels`/`fieldLabels`. Standalone native Approval uses `runId`; it does not automatically share selection with a different native Inbox block. In Workspace, separate blocks can use the existing `selectFrom: "id"` binding and receive the runtime's selected ID. The default work manifest uses only Inbox in its Workspace layout, with Approval rendered inline.

Manifest `permissions` are descriptive contract metadata, not ACL grants or proof that every account has those roles. Read access and returned action availability come from the signed business identity and backend policy. Labels cannot supply scripts, components or URLs.

## Errors, concurrency and sessions

Loading, empty list, disconnected state and API errors are visible. No successful result is shown for delayed responses after disconnect or changing actor. Approval checks the run ID, workflow definition and version of the mutation response before accepting success.

Transition writes include `expectedVersion` and a generated idempotency key. Pending writes block duplicate clicks. A network/5xx/invalid-response result retains the command and locks selection/new actions; manual retry uses exactly the same key and payload. A definitive 4xx other than rate limiting clears it; after 409 the user must reload detail before acting again. Success refreshes Inbox and shows the returned state/version. The server rechecks authority on retry.

The pending command is in memory, not durable across browser reload. After reload, read the latest detail before attempting another action. No automatic retry, role bypass or arbitrary API URL is introduced.

## Verification

- 41 Node tests passed for Foundation and bridge, including seven new tests covering unrelated workflow definitions, unavailable actions, required/type validation, exact retry snapshots, stale version, mismatched result, invalid manifest scope and delayed responses after disconnect.
- Plugin build and AMD/FlowModel loading tests passed.
- Browser smoke `node scripts/smoke-lattice-inbox.cjs` passed manager approval/rejection, required reason, server state filter and an employee account with no approve action. The same blocks handled procurement and onboarding.
- The browser test deliberately forwarded a successful write, then returned a simulated 502 to the browser. Manual retry kept the same key, returned version 3 and produced exactly one approval audit row; selection was locked while the result was uncertain. No browser page errors occurred.
- Native binding smoke `LATTICE_BUILDER_APP=work node scripts/smoke-lattice-builder-save.cjs` saved both block types on the isolated hidden page `/admin/lt71ed11dda9`; bindings survived reload. The original `diox035kb4o` schema was checked before/after and remained identical.
- Native Add block menu smoke confirmed all four Lattice block types. Demo runs and the hidden page remain local as test evidence. Screenshots/packages and the previous Foundation 0.9.1 backup are under ignored `output/`.

## Remaining work

This increment covers **workflow-based** Inbox and transition Approval. Standalone `/v1/tasks` decisions and task/connector `workflowWaitId` completion use different contracts and are not routed through these blocks. Waiting workflows display a waiting message and no transition action, rather than incorrectly approving their tasks. Attachment, Timeline, Context Entity, dashboard, app publication and full UI export/import remain separate increments. Real n8n/NGSI-LD integration is still required for full phase-two acceptance.
