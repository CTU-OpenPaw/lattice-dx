# Module Business Bindings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development; source implementation and independent review, parent real acceptance.

**Goal:** Define which business entities and actions a reusable module workflow can operate on.

**Architecture:** Optional manifest bindings validated against ownresources/exactdependency publications; server-derived immutable runbinding applied to all starts and transition policy.

**Tech Stack:** Existing TypeScript/Fastify/pg/Vitest, no dependencies.

## Global Constraints

Exact spec module-business-bindings and parentcompositionconstraints. No UI/upstream/deps/Nhiadapters/Notion/settings/volumes/userfile changes/newbranch. Source-onlycommits; parentdocs/scripts/package. No modulelock acquired afterentitylock, no new grant/role provisioning.

### Task6a: manifest references

Files modules types/policy/database and tests.

- [ ] RED optionalkey compatibility, uniqueID/workflow binding, ownschema pin1, exactdependency ownership, allowedtransitionvalidation.
- [ ] Parse/preview/install/enable boundedbindingmetadata; return bindings frommoduleversion andpreview. Keep omittedkeyhash unchanged.
- [ ] Lock enableddependency refs deterministically, check actual workflow publications atenable, not imaginary requestedversions.
- [ ] Focusedtests/typecheck/scopedcheckpoint.

### Task6b: bound execution

Files contracts/workflows.ts, workflow schema/database/policy/routes/tests; module eligibility helper returnplan, module routes/startmethod/tests.

```ts
type WorkflowBusinessBinding={moduleId:string;moduleVersion:string;bindingId:string;allowedTransitions:string[]};
startBinding(moduleId:string,version:string,bindingId:string,value:{entityId:string;title:string;input:Record<string,string>},actor:WorkflowActor,key:string):Promise<WorkflowRun>;
```

- [ ] RED generic/module/inbound contextmissing/wrongsource, blockedtransition evenvalidreceipt, allowedTransitions listparity.
- [ ] Apply bindingplan in sharedcreateWithClient before/aftercontextvalidation without lockinversion; persist immutablemetadata onnewrun.
- [ ] Enforceallowedactions in sharedtransitionpolicy and publicavailableTransitions; allruntimeentrypointsuseit.
- [ ] Add bindingstartendpoint based onserverbounddefinition; no clientdefinition/policy override.
- [ ] Targetedmodule/workflow/entity/automationregressions/typecheck; parentPGatomicrollback/startdisable/pin/max1andHTTPacceptance, independentreview/fixes.
