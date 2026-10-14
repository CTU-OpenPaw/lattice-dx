# Declarative business bindings for enterprise modules

Task6 of approvedcomposition. Bindings constrain how a module's own workflows operate on own/exactdependency data. No UIlayout or executable plugin deployment.

Optional manifest `bindings` array<=10:

```ts
type BusinessBinding={
 id:string;
 schemaId:string; schemaVersion:number;
 definitionId:string;
 allowedTransitions:string[];
};
```

Names slug/safe IDs, unique bindingIDs and **one binding per own workflow definition** in this version. Definition must be in own bundle. Schema is either declared in own manifest (installed publication1 only) or available from an exact declared enabled module dependency; no global unrelatedschema/workflowreference. External workflow bindings are excluded to avoid conflicting policy on a dependency-owned definition. AllowedTransitions unique1..20 IDs must exist in own definition; service transitions may be declared but public execution still scheduler-only. Missing bindings remains legacy-compatible, including immutable manifesthash when optionalkey omitted.

Preview/install validate all references/types/action IDs before writes. Ownschema pin1 known; dependency schema pin must already exist in dependency's declared schema set/currenttenant. Enable validates exact published workflow mapping and publication references again while module/dependencies locked in deterministic ID/version order. No grant/role/service authority installation. Enabled module behavior remains failclosed newstarts; disabling does not change alreadyrunning immutable bindings.

Each newrun of a bound definition must have entityContext; the locked currententity schema ID/version must match binding. This applies to generic workflow start, module start, inbound/automation start and newbindingstartendpoint. No alternate route bypass. Existing unbounddefinitions start normally. `assertModuleStartEligible` may return a narrow binding plan from existingmodule FOR SHARE eligibility query before entity locks; validateentity andpersist binding aftercontextvalidation without acquiring modulelocks afterentitylocks.

Persist optional `WorkflowRun.binding:{moduleId,moduleVersion,bindingId,allowedTransitions}` as immutable server-derived JSONB metadata in workflow_runs and receipts. Exact existing runcontext remains businesssource association. Runbody cannot supply binding or alter it through workflowinput. On transition, enforce snapshot allowedTransitions before receipt and in availableTransitions/planTransition; blocked403. Do not re-read latest modulebinding to silently change a historicalrun. Cancellation/tasktransfer retain existing administrative policies.

`POST /v1/enterprise-modules/:id/versions/:version/bindings/:bindingId/start` body `{entityId,title,input}` keyrequired; resolvebounddefinition server-side anddelegate sameworkflowcaller-client createpath. Existing module `start` parseCreate gains optionalcontext naturally. Wrongbinding404/wrongschema409/role403/invisibleentity404/disabledmodule409. Returnedmodule detail/previewincludesbinding metadata and resolved workflow publication whereavailable. Exportmanifestportable contains schema/definitionnames, no literalentityUUID or policy grants.

Acceptance: oldmanifesthash/preview unchanged, unknownresource/unpublishedpin/action/differenttenant/dependencydeny, allstartpaths missing/wrongcontext fail, blockedtransitionlistandexecutionconsistent, persistedboundrun policyunchangedaftermoduledisable, acceptedstartreplaycurrententityACL, forcedcontext/bindingreceiptrollback, start/disable race, max1newexecution andserialization. No broad bindingmutation/uninstall/upgrade engine added.
