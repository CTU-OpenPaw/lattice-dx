# Business bindings in enterprise modules

A module manifest can declare up to ten bindings. A binding connects one workflow owned by that module to a published business schema and a list of allowed transitions. It grants no user or service permissions.

```json
{
  "bindings": [
    {
      "id": "asset-lifecycle",
      "schemaId": "assets",
      "schemaVersion": 1,
      "definitionId": "asset-onboarding",
      "allowedTransitions": ["review", "approve"]
    }
  ]
}
```

The schema must be owned by the module, at its installed version one, or supplied by an exact enabled dependency. This version binds the module's own workflows only. Preview, install and enable validate the references. Omitting `bindings` preserves existing module behavior and hashes.

Every new start of a bound workflow requires an entity context with that exact schema and publication. This applies equally to generic workflow starts, module starts, inbound events and automation dispatch. A different endpoint cannot bypass the binding.

`POST /v1/enterprise-modules/:id/versions/:version/bindings/:bindingId/start` takes `{entityId,title,input}` and an `Idempotency-Key`. The server resolves the workflow definition. Normal workflow start capabilities, current entity access and enabled-module checks still apply.

The run stores immutable metadata:

```json
{
  "binding": {
    "moduleId": "asset-management",
    "moduleVersion": "1.0.0",
    "bindingId": "asset-lifecycle",
    "allowedTransitions": ["review", "approve"]
  }
}
```

Only these transitions can execute on the run, subject to their ordinary roles, ownership and state. Disabling a module prevents new starts; an existing run keeps its captured policy. Binding metadata is server derived and cannot be supplied in a start body.

Expected errors include invisible resources (404), wrong/missing context or disabled module (409), and denied transitions (403). Use the returned run version and ordinary transition idempotency rules.

Acceptance is tracked in the [composition ledger](superpowers/plans/2026-10-14-enterprise-composition.md). The parent PostgreSQL command is `pnpm test:module-bindings` once registered and verified.
