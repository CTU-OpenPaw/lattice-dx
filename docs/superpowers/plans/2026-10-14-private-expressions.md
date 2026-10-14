# Private Typed Expressions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Pure evaluator task reviewed before private executor integration.

**Goal:** Use actual authorized business fields in calculations/assertions without exposing them through wider workflow readership.

**Architecture:** A pure bounded typed AST/BigInt decimal library plus transient private maps in the existing caller-client block executor. Public evidence remains metadata and resourceidentitybindings unchanged.

**Tech Stack:** Existing TypeScript/contracts/Vitest/pg; no dependencies.

## Global Constraints

Exact private-expressions spec counterpart and enterprisecompositionglobalconstraints. No deps/eval/rawSQL/resourceID expressions/authoritypayload/privatevalue persistence. Onecurrentbranch; sourceonlycommits; no implementerpushswitchmerge/Notion/UI/upstream/Nhiadapters/userfiles/volume edits. Parent scripts/docs/package.

### Task4: pure evaluator and decimal arithmetic

Files contracts/src/expressions.ts/index.ts; workflows/{expressions,expression-policy,decimal}.ts +tests.

Produces `Expression`, `TypedScalar`, `evaluateExpression(expr,env):TypedScalar`, `validateExpression(expr,referencePolicy?):void`. Env explicit scalarref map; static policy restricts allowed declaration names/earlierprojectionfields.

- [ ] RED scalar types/bounds/date/integercanonical/null; AST unsafekeys/depth/nodes/unknownops/arity/missingrefs.
- [ ] RED largeprecise add/subtract/multiply/divide, signedhalf rounding, safeintegeroverflow/divzero/decimaldigit andscale bounds.
- [ ] Implement scalarvalidator/BigIntdecimalhelper/pureevaluator; no JSONfloatingpoint monetary conversion.
- [ ] Run focusedtests +API/contracts typecheck; sourceonlycommit/reviewgate. Parent may continue acceptance/docs without touching evaluator.

### Task5: projections and computation blocks

Files contracts/workflows.ts, workflows blockpolicy/database/catalog/bundles and tests, focused private-blocks helper. Onlyrequired entityclient helper extensions.

```ts
type WorkflowProjectionStep={id:string;action:'entities.project';input:{id:WorkflowBinding;fields:string[]}};
type WorkflowEvaluationStep={id:string;action:'data.evaluate';input:{values:Record<string,Expression>}};
type WorkflowAssertionStep={id:string;action:'data.assert';input:{condition:Expression}};
```

- [ ] RED static earlierdeclaredrefs/unknownfieldnames/self-forwardrefs/expressionID denial/requiredcapability.
- [ ] Extend private projection/evaluationmap separate from publicresultmap, typedbindings resolver optionallyprivateexprenvironment. Resource locking remains run→sortexistingUUIDs, all newprojectids prelocked.
- [ ] Implement livepublicationfieldtypedprojection/currentACL, pure evaluate and booleanassert409; publicinput/result onlyfieldnames/keys/status/id/version. No values/errors leakage.
- [ ] Complete descriptors and portablebundlechecks, serviceblockrole mapping updates; preserve existing timer/entity/action behavior.
- [ ] Targetedtests/typecheck/sourceonlycommit, parent signed/privatePG actualprecision/update/lateassertrollback/revoke/projectionevidence/max1/bundleregressions, independentreview/fixes.
