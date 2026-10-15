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

`start` resumes existing containers; on a fresh checkout use the documented Compose setup first. The installer requires a running NocoBase database, the Docker `desktop-linux` context, and Node dependencies already installed. It builds the two team plugins, writes an exclusive custom-format database dump and SHA-256 metadata in ignored `output/backups`, recreates only the NocoBase service with existing volumes, packs the mounted plugins offline, runs official `pm add`/`pm enable`, then verifies registry entries, versions and HTTP health. Failure to produce a valid backup prevents service recreation. It does not reset databases, volumes, accounts or native page schemas.

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

Warehouse sign-in was interrupted by an expired callback. On resumption, the browser tool denied access to the existing tab; no workaround was attempted. Consequently **warehouse receive through UI and browser verification after the automated reinstall remain pending**. API acceptance below is separate evidence and does not substitute for that UI check. No mobile, arbitrary Studio construction or full end-to-end broker/agent assertion is made.

Local screenshots/fixture IDs are retained under ignored `output/workspace-runtime-*`. The rejected-workflow screenshot is `output/workspace-runtime-rejected.png`. Two submitted workflows with prefix `UI Acceptance b6dbdb1a` remain available for manual permission/approval checks. The Logistics order above remains submitted for a warehouse UI check.

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

Finish the pending warehouse browser check and post-install browser reconnect when browser access is available. Keep unimplemented work views disabled until their query contracts are agreed. Nhi's integration branch remains independently owned and is not part of this acceptance. No Notion completion boxes were changed and no release was created.
