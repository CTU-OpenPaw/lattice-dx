# LatticeDX Foundation plugin

Original team code, Apache-2.0. Foundation plugin for NocoBase 2.2.x. Workspace at http://localhost:13000/lattice now renders reusable Form/List blocks from manifests; FlowModels expose them in the native builder. See ../../../docs/lattice-blocks.md, ../../../docs/lattice-workspace.md and ../../../docs/lattice-application-config.md for contracts and limitations.

## Data

Internal collections: `latticeDepartments`, `latticeEmployees`, `latticeLocations`, `latticeAssets`. Each record has a unique code and organizationId. Employees and locations belong to departments; assets link to a department, location and custodian employee. Tables live in NocoBase PostgreSQL, separately from the LatticeDX API database; no synchronization or automatic Keycloak identity mapping is claimed.

Installation seeds two demo organizations, each containing one department, employee, warehouse location and asset (8 rows total). Codes start with DEMO- and email uses example.invalid. Seed runs in a transaction and preserves existing rows; an organization identity conflict fails instead of overwriting data. These are demo fixtures, not a production tenant isolation policy. No generic collection CRUD ACL grants are added; the manifest catalog is authenticated. Internal collections are not automatically listed in the UI data-source editor. Reusable API-backed Form/List blocks are registered separately.

## Build and package

From this package directory:

```powershell
node scripts/build.mjs
node --test tests/*.test.cjs
npm pack --ignore-scripts
```

Build validates and copies authored CommonJS into dist. The runtime supplies the NocoBase SDK; no upstream SDK code is bundled. NocoBase loads the server entrypoint, collection definitions and afterSync migration. Initial install seeds through install(); upgrades use the migration mechanism and schema synchronization. There are no hooks deleting business data on disable or uninstall.

## Install

Copy the generated tgz into the container, then install with the official package manager. It extracts into persistent storage/plugins and links the package for Node.js. Inside the container:

```sh
yarn nocobase pm add /tmp/latticedx-plugin-lattice-foundation-0.14.0.tgz
yarn nocobase pm enable @latticedx/plugin-lattice-foundation
yarn nocobase pm list
yarn nocobase pm disable @latticedx/plugin-lattice-foundation
yarn nocobase pm enable @latticedx/plugin-lattice-foundation
```

The repository's official Compose also mounts this package read-only; build before starting/recreating NocoBase. Existing test runtime uses persistent storage/plugins and keeps its existing database. Never remove storage or database volumes to install a plugin. Generic CRUD here does not implement logistics/mua-sam transitions; those must use Duy's authorized API.

## Logistics in 0.8.0

`/lattice/apps/logistics` uses the shared Form/List blocks for real orders, a scoped warehouse directory selector, clean attachments and server pagination. Order detail uses Duy's submit/receive API with expectedVersion and idempotency keys. Native builder bindings expose the same configured Form/List; their Workspace link opens business actions. The old `assign-warehouse-task` binding remains for existing generic task blocks, but is hidden from the business Workspace. The `create-order-record` binding now creates an order with required customer/address/SKU/quantity/warehouse fields, instead of a generic record; existing instances need those inputs. See ../../../docs/logistics-workspace-deployment.md for evidence and limits.

## Application extensions in 0.9.0

Workspace is a shell: it delegates to the application runtime and contains no purchasing/Logistics branches. Manifest workspace panels reference trusted registered renderers; block bindings declare selection fields. Generic Form/List/actions/validation read registered contracts. Sample-specific views and API adapters live in src/applications. Native bindings and current endpoints are preserved. Trusted plugins can register views via app.latticeRuntime, contracts via app.latticeContracts, and server manifests via app.latticeApplications after Foundation loads. See ../../../docs/workspace-extension-runtime.md for extension steps, security boundaries and regression evidence. Dynamic publication and a universal workflow designer are still outside this release.

## Backend compatibility in 0.9.1

Record/task forms use the backend's Unicode code-point limits. Their catalog actions send an idempotency key through the server bridge. An uncertain result locks new submissions; manual retry preserves the original key and payload and checks current action permissions again. A confirmed result clears the command; a deliberate new submission receives a new key. File uploads are not automatically retried.

The workflow bridge also exposes fixed, session-bound operations `waits`, `executions`, `completeWait` and `retrySync`. Mutation operations require a key and body; the backend remains responsible for permissions and business validation. These adapters do not add Inbox/Approval/Timeline/Context blocks or a workflow designer.

## Inbox and Approval in 0.10.0

`/lattice/apps/work` demonstrates reusable workflow Inbox and Approval blocks across the caller's permitted workflows. Both are registered as native FlowModels and in the Add block menu. Builders select an installed manifest/block; the Inbox's `approvalBlockId` opens its configured Approval inline. Standalone Approval needs a manifest `runId` or a Workspace selection binding. See [configuration, semantics and test evidence](../../../docs/inbox-approval-blocks.md).

These are workflow work items. Independent foundation tasks and task/connector wait completion are not included. Permissions are enforced by the backend; manifest labels and permission metadata do not grant roles.

## Workspace layout in 0.11.0

The home screen now uses the reviewed sidebar/header/shortcut layout and includes the shared Inbox. `/lattice?view=apps` shows installed applications. `workspace.home` selects the home manifest; optional `workspace.shortcut` supplies `hidden`, plain-text `description`, a registered `icon`, and a Form `createBlockId`/`createLabel`. Arbitrary shortcut URLs are rejected. Ctrl+K searches application names; work-item search stays in Inbox.

Unsupported tabs and modules remain disabled, with no invented counts or deadlines. See [UI checkpoint and API requirements](../../../docs/workspace-ui-checkpoint.md).

## Attachment and Timeline in 0.12.0

Reusable Attachment and Activity Timeline blocks are available in native Studio and Workspace. The default work manifest embeds both inside Approval. Workflow uploads are linked only by explicit action submission, clean text previews are escaped, downloads recheck authorization, and history displays server events without inventing missing reasons. Native settings can persist a workflow/record context ID. See [configuration, verification and API limitations](../../../docs/attachment-timeline-blocks.md).

## Terms

- Plugin: code that adds functionality to this NocoBase installation.
- Entrypoint: the first file the host runs to load the plugin.
- Collection: definition of a record type and its fields/relationships.
- Migration: versioned code for schema/data evolution.
- Seed: code creating repeatable demo records.
- Build: preparing source as a runtime-installable package.
- Runtime: the running NocoBase service into which this plugin is installed.

## Context Entity

Foundation 0.13.0 adds the reusable Context Entity block, its Studio model and authorized entity read bridge. See [context-entity-block.md](../../../docs/context-entity-block.md) for manifest mappings, permission checks, verification and the remaining broker integration contract.

## Workflow operation Forms

Foundation 0.14.0 adds the reusable Workflow Form with receiving, acceptance and handover presets. Record and workflow Forms share field rendering; workflow writes keep the existing authorized Approval controller. See [operation Forms](../../../docs/receiving-acceptance-handover-forms.md) for configuration, verification and broker limitations.
