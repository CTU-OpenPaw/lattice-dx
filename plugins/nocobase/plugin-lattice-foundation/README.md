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
yarn nocobase pm add /tmp/latticedx-plugin-lattice-foundation-0.10.0.tgz
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

## Terms

- Plugin: code that adds functionality to this NocoBase installation.
- Entrypoint: the first file the host runs to load the plugin.
- Collection: definition of a record type and its fields/relationships.
- Migration: versioned code for schema/data evolution.
- Seed: code creating repeatable demo records.
- Build: preparing source as a runtime-installable package.
- Runtime: the running NocoBase service into which this plugin is installed.
