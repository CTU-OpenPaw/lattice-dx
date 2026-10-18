# Receiving, acceptance and handover Forms — Foundation 0.14.0

## Delivered scope

Workspace's existing Approval view now renders the three procurement operation forms with Vietnamese field/action labels, short instructions, per-field validation and explicit clean-file selection. NocoBase Studio also exposes **Lattice Workflow Form**, a reusable single-action Form with three installed presets:

| Preset block | API workflow/action | Required fields, declared by the API |
| --- | --- | --- |
| `operation-receive` | `procurement` / `receive` | `receiptAttachmentId`: clean receiving report file |
| `operation-accept` | `procurement` / `accept` | `acceptanceNote`: acceptance findings |
| `operation-handover` | `procurement` / `handover` | `assetId`, `recipientId`, `departmentId`, `locationId`, `attachmentId` |

These are manifest presets, not three domain-specific components. Record Forms and workflow Forms share `client/schema-fields.js` for field rendering. Workflow Forms reuse the Approval controller because workflow transitions require `expectedVersion`, current `availableTransitions` and an idempotency key; they are not record-creation actions. Backend policy and immutable workflow definitions are unchanged.

## Builder configuration

Select **Lattice Workflow Form** in Add block, then **Chọn ứng dụng và block**. Choose one of the three presets and optionally bind **ID hồ sơ / quy trình** to a workflow UUID. A standalone native Form needs a bound run; it does not automatically consume selection from an unrelated native Inbox. In Workspace, the application runtime can pass the selected ID using the existing manifest layout binding. Native siblings refresh independently; reload their details after another block changes the run.

A trusted installed manifest can define another workflow Form without changing the renderer:

```json
{
  "id": "review-form",
  "type": "workflow-form",
  "title": "Review case",
  "collection": "workflow-runs",
  "permissions": ["workflow:start"],
  "definitionId": "support-case",
  "actionId": "resolve",
  "actionLabels": {"resolve": "Resolve"},
  "fieldLabels": {"note": "Resolution note"},
  "actionDescriptions": {"resolve": "Record the result before confirming."}
}
```

The collection must use the `workflows` API resource. `actionId` is required for `workflow-form`, with safe identifier validation. Optional `attachmentBlockId`, `timelineBlockId` and `contextBlockId` must reference blocks in the same collection/definition scope. API fields remain authoritative; manifests supply presentation, not new fields, permissions or executable URLs. Studio binds installed configurations; an arbitrary workflow/field editor is outside this increment.

## Interaction and authorization

- Required/type errors appear under the field and focus the first invalid control. Validation uses Unicode code points for workflow text; HTML's UTF-16 `maxLength` does not cut valid emoji input prematurely.
- Department/location choices come from current authorized workflow references. Loading/failure is visible, and unavailable or unlisted required selections block submission. Retry by reloading details. People suggestions are requested only when the connection advertises directory read capability; otherwise manual account IDs remain supported and validated by the backend.
- Upload or select a clean file in Attachment, then explicitly use it for the chosen field. A syntactically valid file ID does not prove scan/link permission; the backend rechecks it when accepting the transition. Quarantined files cannot be chosen, previewed or downloaded. Displayed text is escaped by React.
- Only an action currently returned by the API is rendered. A single-action Form also constrains its controller to the configured action; it cannot execute a different available action. Unavailable steps display a read-only explanation, rather than inventing a completion state.
- Writes preserve `expectedVersion` and the command key. Concurrent clicks cannot create multiple local commands. Uncertain results lock new actions and preserve exact retry payloads; successful actions refresh state and evidence. Rebinding or changing account hides the previous run immediately and loads the correct context.

## Verification — 15 October 2026

- Foundation/bridge Node suite: **64 passed**, including six new checks for action restriction, accessible required-field errors/focus, reference failure, Unicode validation, unsafe/cross-scope configuration and rebinding.
- Focused bridge/installer Vitest suite: **25 passed**. Foundation build and API TypeScript check passed.
- `scripts/smoke-lattice-operation-forms.cjs` passed real host login, Keycloak PKCE and warehouse UI: required receiving evidence, clean upload/selection, receipt at version 4, required acceptance findings at version 5, real department/location choices and handover at version 6. Two immediate handover submissions produced exactly one handover audit row and one pending synchronization job. Reload preserved data and an employee had no warehouse action. A pre-existing record Form also created/read back Unicode text successfully after the shared field-renderer change. No page errors.
- Studio exposed all **eight** team block models. Native preset binding and Timeline configuration survived reload; the original expense page schema stayed identical. A further native check connected the warehouse account, opened the receiving Form with the approved fixture, verified the authorized `receive` form and reloaded it successfully on `/admin/ltfd350c68a6`. Binding checks use isolated hidden test pages, not changes to an existing business page.

For manual Workspace testing, connect the existing local `warehouse` account and search **Operation Forms Ready 1792077813928**. Workflow `cf92e714-3a0b-4068-be10-3e761955505b` is left approved/version 3, ready for receiving. The completed acceptance fixture is `e25b2cbe-4cb3-4c64-9dae-79709b4e96b5`, handed_over/version 6. Screenshots and machine-readable results are in ignored `output/`.

The NocoBase database and installed Foundation 0.13.0 were backed up under `output/backups/workflow-forms-20261015` before build/install. Foundation 0.14.0 was installed through the official package manager; no database reset or backend permission change was performed. A restore rehearsal was not performed.

## Remaining boundary

Handover creates a pending backend synchronization job; this proves enqueueing, not broker delivery. The acceptance fixture uses an explicit test Asset URN, without claiming verified engine UUID-to-broker mapping. Broker status/authorized retry, UC1 dashboard, complete versioned UI export/import and cross-team broker acceptance remain separate phase-two work. These Forms operate workflow transitions; they do not replace standalone `/v1/tasks` or wait-completion contracts.
