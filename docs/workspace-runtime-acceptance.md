# Workspace runtime acceptance — 15 October 2026

The merged UI from PR #15 is installed locally on NocoBase 2.2.20: Foundation 0.11.0 and Action Bridge 0.1.0. The engine continues to own business data in PostgreSQL. This checkpoint does not deploy Nhi's broker/n8n/agent work or declare the enterprise platform complete.

## Start and install

From the repository root, with the existing local environment configured:

```powershell
pnpm docker:start
docker --context desktop-linux compose -f infra/compose/core.yml start postgres keycloak clamav api gateway
docker --context desktop-linux compose -f infra/compose/nocobase.yml start nocobase-db nocobase
pnpm workspace:install
```

`start` resumes existing containers; on a fresh checkout use the documented Compose setup first. The installer requires a running NocoBase database, the Docker `desktop-linux` context, and Node dependencies already installed. It writes an exclusive custom-format database dump and SHA-256 metadata in ignored `output/backups`, builds the two team plugins, recreates only the NocoBase service with existing volumes, packs the mounted plugins offline, runs official `pm add`/`pm enable`, then verifies registry entries, versions and HTTP health. Failure to produce a valid backup prevents both plugin builds and service recreation. Run installation during a maintenance window: builds update live bind-mounted plugin artifacts. It does not reset databases, volumes, accounts or native page schemas.

Mounting source is insufficient: `pm enable` can exit successfully without a registered package. The registry check prevents reporting that case as successful. The backup covers **only the NocoBase database**; it does not include storage files or engine data, and no restore rehearsal was performed in this checkpoint. It is not a full recovery solution.

Open [Workspace](http://localhost:13000/lattice), sign into the existing NocoBase account, then connect the business account through Keycloak. Credentials remain in the existing local fixture documentation; do not copy tokens into the browser or repository. An expired callback cannot be reused: return to Workspace and initiate a new connection.

## Observed browser behavior

Before the later Docker restart, the supported browser tool verified:

- Normal NocoBase sign-in and Keycloak PKCE connection for manager and alice, with return to Workspace.
- The same Inbox/Approval blocks handled procurement and a separate onboarding workflow. Procurement approval and onboarding approval reached approved/version 3; procurement rejection reached rejected/version 3.
- Rejection without a reason was blocked. The reason and rejected state persisted after reload, server search and state filtering. Independent API reads confirmed the final versions and three history items per workflow.
- Alice could view a submitted workflow but had no approval/rejection actions. Disconnect removed business data and disabled controls.
- The application directory exposed purchasing and Logistics. Unsupported report/AI/settings and unimplemented work views remained disabled.
- Sales created Logistics order `b95726a1-0910-4694-b54a-ac250ea2fe65`, then submitted it at version 2 with linked warehouse task `3729fe1a-3ffb-4781-9123-5c83fc5a44b7`.

The initial warehouse sign-in was interrupted by an expired callback and a browser-tool access denial. A subsequent fresh connection from Workspace succeeded after reinstall: warehouse opened the submitted order above, entered a receive note, and clicked **Nhận việc kho**. The order reached **received/version 3**, its linked task reached **completed/version 2**, and the create/submit/receive history persisted after a full browser reload and reopening the task. This closes the two previously pending UI checks. No mobile, arbitrary Studio construction or full end-to-end broker/agent assertion is made.

A remaining UI issue is visible for warehouse: the sales-only creation panel shows an authorization error, including a page-level banner, while authorized order/task operations still work. It should eventually be hidden or clearly scoped by capability. No permission was broadened to suppress that message.

Local screenshots/fixture IDs are retained under ignored `output/workspace-runtime-*`. The rejected-workflow screenshot is `output/workspace-runtime-rejected.png`. Two submitted workflows with prefix `UI Acceptance b6dbdb1a` remain available for manual permission/approval checks. The Logistics order above is now received. Screenshots `output/workspace-runtime-received.png` and `output/workspace-runtime-received-detail.png` record the completed task and received order after reload.

## Verification after reinstall

The automated installer passed with both expected packages enabled and matching source versions, and healthy HTTP metadata. Its database-only backup was 262071 bytes; archive and metadata are under `output/backups/nocobase-before-workspace-a0d98453-5aff-4001-af2a-e69dd42943d0.dump`.

| Check | Result |
| --- | --- |
| `pnpm check` | Typecheck, 536 Vitest tests across 96 files, production builds passed |
| Both plugins' `node --test …/tests/*.test.cjs` | 42 tests passed |
| `pnpm test:team-integration` | Signed HTTP authorization, tenant isolation, grants/revokes, workflow authority, replay/version checks passed |
| `pnpm test:nocobase:bridge` | Actual host authentication, Keycloak authorization code + PKCE, bound one-use callback, Gateway action, session isolation/disconnect passed; no UI assertion |
| `pnpm test:logistics` | Directory/assignee policy, exact warehouse access, clean/rejected attachments, linked task/state, replay/concurrency and paging beyond 100 passed |

The Logistics API smoke retained order `a9a803b8-c86e-4a7b-8c19-ff1cc3e46b76` and task `343d398b-2841-4c75-9a6c-918039282b36`. It tests receiving work, not shipment dispatch, stock accounting or delivery completion. Installer tests cover backup failure, malformed archives, registry absence/disabled state, version mismatch and fixed command scope.

## Remaining work

The warehouse browser check and post-install reconnect passed on the follow-up. Keep unimplemented work views disabled until their query contracts are agreed. Nhi's integration branch remains independently owned and is not part of this acceptance. No Notion completion boxes were changed and no release was created.

Final installer review found builds ran before backup despite live mounts. Backup and exclusive metadata now precede builds; the regression failed before the fix and passed after it. Independent follow-up review found no remaining P1/P2. Final `pnpm check` remained 536/96 with typecheck/build passing. The live installer evidence above predates this ordering correction; its new ordering was verified by the focused test rather than another runtime recreation.
