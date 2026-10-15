# Attachment and Activity Timeline — phase-two increment

Foundation 0.12.0, 15 October 2026. Hưng's follow-up branch: `codex/attachment-timeline-blocks`. PR #15 was merged while this increment was being implemented, so this feature is proposed in a separate draft from current main. This increment changes plugin/UI code and adds the plugin test suite to CI, not backend policy or Notion checkboxes.

## What builders can use

The native Studio Add block menu exposes **Lattice Attachment** and **Lattice Activity Timeline**, in addition to the four earlier blocks. Select an installed application/block through **Chọn ứng dụng và block**. The two new types also accept an optional **ID hồ sơ / quy trình** in the native binding settings; it persists after reload and is still checked by the API. Connect the business account in Workspace before using native blocks.

Both are regular manifest block types, not business-specific pages. In Workspace they accept the runtime's selected ID through existing selection bindings. Approval can reference an Attachment and Timeline in the same collection/definition scope; the default `work` manifest embeds them after opening an Inbox request.

### Attachment configuration

`type: "attachment"` uses a `lattice-api` collection with resource `workflows` or `records`.

- Workflow source: optional `runId`/`definitionId`; `fileFields` is a list of declared workflow data fields holding file IDs. Missing fields are skipped; invalid IDs fail visibly. The sample manifest declares `attachmentId` and `receiptAttachmentId` outside the generic engine.
- Record source: optional `recordId`; files upload with that record link. The current backend has no list-files-by-record endpoint, so the block does not pretend to recover all historical record attachments. Users can inspect an authorized file by ID.
- `allowUpload` defaults to true. Approval additionally disables upload when a write is uncertain or there is no currently authorized action accepting a file field. The API checks file-write permission independently.

Workflow uploads intentionally remain unbound until the user confirms a workflow action. Reading a workflow is not permission to write its underlying record. Once a file is clean, a **Dùng tệp vừa tải cho …** button lets the user choose it for the relevant action input; no transition is submitted automatically. The transition validates and links evidence through the existing API.

Uploads are limited to the existing bridge's 1 MiB contract. Local FileReader progress is measured; upload/server scanning is indeterminate rather than a fabricated percentage. Uploads are never automatically retried. After an uncertain upload, inspect the result before uploading again; there is no new rescan endpoint.

Only clean files can be viewed/downloaded. Metadata and content are reauthorized at the bridge/API when read; a previously clean UI badge cannot bypass a later denial. Failed download removes cached filename/preview for that file from the block. Pending/error/rejected files remain blocked. A denied manually entered ID never reveals its filename.

Text preview supports `.txt`, `.md`, `.csv`, `.json` and `.log`, showing at most the first 64 KiB as escaped React text. There is no HTML execution, iframe/document embedding or Office viewer. Other file types retain metadata/download controls. The older Form attachment helper remains for phase-one compatibility.

### Timeline configuration

`type: "activity-timeline"` uses the `workflows` resource, optional `runId`/`definitionId`, `pageSize` (1–100, default 10), and optional plain-text `actionLabels`/`stateLabels`.

The block shows actor, occurrence time, action, state transition and version from actual history events. It displays an explicit event `reason` or `metadata.reason` only when the API returns one. **Current transition audit APIs do not persist the rejection input as an event reason.** The block does not copy the current run's reason backward into historical events. Showing historical rejection reasons completely still requires a backend audit-contract change agreed with Duy.

Actors resolve through the current directory only when the business account has directory-read capability. Otherwise the caller's known name or a shortened actor ID is shown, with the full ID available in the title. No identity is invented.

History currently returns at most 100 events. Pagination is over the loaded events, newest first within that returned set; a 100-event result warns that the full history may be incomplete. It is not a server-paginated history API. Add a backend cursor/page contract before claiming complete history for long-running workflows.

## Verification

- 51 Node tests pass across Foundation and bridge. New cases cover resource/definition isolation, file fields and IDs, scan-state gates, byte-size validation, event validation/sorting, reason provenance, revoked-download cache removal, disconnect during local file read, no stale upload, explicit workflow attachment linking delayed-history disposal, and first-render privacy when session/selection changes.
- After moving the increment onto main `0d97071`, plugin build, the 51 Node tests and API TypeScript checks passed. The broader Windows run passed529/530 tests; the unchanged filesystem symlink fixture failed with Windows `EPERM` creating a symlink. No storage test was disabled or backend code changed. Ubuntu CI runs the full check, followed by the plugin suite.
- `node scripts/smoke-lattice-evidence.cjs` passes on the real local stack: warehouse upload and safe text preview; byte-identical downloads; receipt selection/receive/accept transitions; live history updates; manager read after linking; and outsider file/history denial.
- The browser test renders an HTML-like string inside a text preview and checks that it did not execute.
- The harmless standard antivirus test signature is assembled in memory, uploaded and scanned by the real scanner. The resulting rejected file has disabled preview/download controls, and direct content access returns409.
- The same blocks read evidence/history for a second domain, Logistics, without another UI implementation. No browser page errors were reported.
- Native smoke saves both evidence blocks with the workflow context on isolated page `/admin/lta06f8056fa`, reloads and verifies bindings/context persist. The original expense-page schema remains identical. All six native menu entries are present.

Test requests, files and the hidden native page remain local as evidence. Screenshots, scan fixtures, package archives and the previous plugin backup stay under ignored `output/`; no backup or business data is committed.

## Remaining phase-two boundaries

This does not implement Context Entity, UC1 dashboard, full UI package export/import, standalone task history, or real n8n/NGSI-LD synchronization. Historical rejection reasons and complete server-paginated workflow history require the API changes above. The follow-up branch contains current main as its base; the local API container remains the previously verified runtime, with no backend upgrade or database reset performed by this UI increment.
