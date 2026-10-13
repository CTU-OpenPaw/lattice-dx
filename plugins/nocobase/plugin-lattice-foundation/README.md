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
yarn nocobase pm add /tmp/latticedx-plugin-lattice-foundation-0.6.0.tgz
yarn nocobase pm enable @latticedx/plugin-lattice-foundation
yarn nocobase pm list
yarn nocobase pm disable @latticedx/plugin-lattice-foundation
yarn nocobase pm enable @latticedx/plugin-lattice-foundation
```

The repository's official Compose also mounts this package read-only; build before starting/recreating NocoBase. Existing test runtime uses persistent storage/plugins and keeps its existing database. Never remove storage or database volumes to install a plugin. Generic CRUD here does not implement logistics/mua-sam transitions; those must use Duy's authorized API.

## Terms

- Plugin: code that adds functionality to this NocoBase installation.
- Entrypoint: the first file the host runs to load the plugin.
- Collection: definition of a record type and its fields/relationships.
- Migration: versioned code for schema/data evolution.
- Seed: code creating repeatable demo records.
- Build: preparing source as a runtime-installable package.
- Runtime: the running NocoBase service into which this plugin is installed.
