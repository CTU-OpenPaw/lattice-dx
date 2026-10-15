# Bounded typed expressions and private workflow projections

Tasks4–5 of approved composition; no code-executing DSL. Parent constraints apply; resource IDs/context/authority bindings remain unchanged.

## Pure scalar model and evaluator

`TypedScalar` is `{type:'text'|'integer'|'decimal'|'boolean'|'date'|'enum'|'null',value:string|number|boolean|null}` with exact type/value validation. Integer safe JS integer; decimal **string** with no exponent, <=80 total digits and scale<=18; boolean actualbool; date real YYYY-MM-DD; text<=4000 Unicode codepoints without controls; enum string<=200. Null permitted only optional projected fields/coalesce, never stored as entity attribute. Entity publication validation retains existing decimal38digit constraint; intermediate calculations may have up to80 digits.

AST forms:

```ts
type Expression=
 |{op:'literal';value:TypedScalar}
 |{op:'ref';source:'data'|'input';field:string;as:Exclude<ScalarType,'null'>}
 |{op:'ref';source:'projection'|'evaluation';stepId:string;field:string}
 |{op:'add'|'subtract'|'multiply'|'divide'|'eq'|'ne'|'gt'|'gte'|'lt'|'lte'|'all'|'any'|'not'|'coalesce';args:Expression[]};
```

Maxdepth8/nodes100/args20. add/multiply require2..20 numericargs; subtract/divide/comparisons exactly2; all/any1..20bools; not1bool; coalesce1..20. Integer-only add/subtract/multiply returns safeinteger or400overflow; mixeddecimal arithmetic usesBigInt coefficient/scale. Division returns decimal fixedmax18 fractiondigits, round half-away-from-zero; dividezero400. Add/multiply results preserve required operandprecision and reject scale/digit bounds, not silently float/coerce. Comparisons numeric crossinteger/decimal allowed; text/date/enum onlysame type and lexicographiccomparison; bool/null only eq/ne, nulls onlymatchnull. Coalesce returns firstnonnull, allnull returnsnull. Unknownref is400; optional declaredprojection field absent is explicitnull, not an unknownkey bypass.

`evaluateExpression(expression,environment):TypedScalar` is pure. Environment resolves typed data/input/projection/evaluation refs via explicit own-property keys, never arbitrary path/accessor/prototype. Pure validator accepts allowed static ref context; runtime code validates AST again with bounds before recursion. Invalidcycles rejected through shape/depth/node validation. No eval, regex execution, user-function dispatch or SQL.

## Projection and private runtime

New step `entities.project` input `{id:WorkflowBinding,fields:string[]}` unique1..20 declared fields. Requires current data:read and resourceACL. Pin is entity's existing publication; choose declaredattributes only (no owner/roles/tenant/titles). Runtime captures TypedScalars in a private map keyed by stepID+field, type from publication; missing optional declaredfield becomesnull. Public result `{id,version,schemaVersion,projectedFields:[names]}` and input containsid/fieldnames only. No attribute values in normal run/data/history/executions/receipts/jobs.

`data.evaluate` input `{values:Record<string,Expression>}` max20 named values; needsdata:read. Each expression can reference only earlier projected/evaluated steps or declared data/input fields; no self/forwardreferences. Public output `{evaluatedKeys:[names]}`, private map stores actual TypedScalar values.

`data.assert` input `{condition:Expression}` needsdata:read; requires booleantrue, false409 sanitized message, nonboolean400. Public result `{asserted:true}` only. A failed assertion rolls back earlier entity/audit/event/workflow/receipt effects.

WorkflowTypedBinding gains `{source:'expression',expression:Expression}` **only in attribute/filter value bindings**; value must evaluate to nonnullscalar, then normal entity query/publication validators apply. Existing WorkflowBinding/expectedVersion/resourceID remain unchanged. Projection resultmetadata ID may be referenced only as an alias of alreadygloballyprelocked/fresh entity; no querylistselection/expression-derived IDs. Initial automation transition whitelist remains restricted until separately designed safe prelocking.

Implementation should extract focused `expression-policy.ts`, `expressions.ts`, `decimal.ts`, `private-blocks.ts` as needed rather than growing executor into an unbounded interpreter. `executeBlocks` maintains privatevaluesmap distinct from existing publicresults map. Pass a private resolver totypedbinding evaluation; no privatevalues escape through error messages.

Catalog exposes complete input/outputschemas. Bundle previews include neededdata:read and reject literalresourceUUID bindings as existing portability rule, while pureexpressionliterals remain portable. Schemas/types validated at runtime beforeuse; installingdefinitions doesn'tgrantservice/actor dataread. No newdeps/frameworks.

## Acceptance

Exact large signed decimal arithmetic/rounding/bounds/zero/types/missingrefs/null coalesce AST shape/controlkey/depth/node negatives. Freshentityprojection/finalpin aftermigration/currentrevoke/filter errors. Multi-step calculationupdatesourceentity using expectedversion from earlierentityresult, resultreceipt retains metadataonly. Projection values absent in get/history/executions/jobs/receipt/error paths, evenworkflowreader has noentityread. Falseassert late rollback restores entity/events/run/audit/results. ExistingID locks sortedonce and freshIDsnotextra locked, max1/restart/currentservice timercapabilities and portablebundles. Independent source review plus realPG/signedacceptance beforeclaimcomplete.
