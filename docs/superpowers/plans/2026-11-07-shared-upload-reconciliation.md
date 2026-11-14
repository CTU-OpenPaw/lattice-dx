# Fix PR46 — durable native shared-upload receipts

## Confirmed failure

At SHA4f231f7 a blocked shared INSERT outlives NocoBase's20-second fetch timeout. Submit then succeeds, and releasing the INSERT makes a new file visible on a submitted request. Exact reproduction is retained locally in output/native-files-acceptance.

## Design

Persist private upload receipts before remote work. Each request/org/uploader/key records filename, SHA256, attempts and pending/complete/failed. Preparation and execution both use the existing native request UPDATE lock and membership/ACL checks. Preparation commits before network I/O; submit checks for any pending receipt under the same request lock.

Execution is serialized by the request lock. Success commits complete metadata, and duplicate callers replay it without another upload. Only a definitive400/409/413 on a first attempt can fail terminally; uncertain errors and errors after retries remain pending because a prior remote attempt may still commit. No expiry or automatic marker deletion. A same-user retry selecting identical filename/content can resume the pending canonical key after browser reload. Different content/uploader must wait.

Do not change native workflow authority, host ACL, UI, shared ObjectStore or legacy file routing. Receipt table has no public collection API. This protects the explicit native submit boundary; trusted admin/direct SQL changes remain operational responsibilities.

## Steps

1. Write failing tests for durable prepare-before-I/O, submit guard, replay, first-attempt rejected file, uncertain retry and changed-content conflict.
2. Add a small receipt helper and afterSync migration; integrate preparation/execution/submit checks into existing handlers.
3. Promote the real delayed-INSERT scenario into a repeatable isolated acceptance: submit409 before and after late commit; same-file retry confirms existing file; concurrent submit creates one task. Test revocation while pending, new UI key after reload and scanner rejection.
4. Build/migrate only the named acceptance clone after backing it up. Run existing API acceptance, permission/file tests, full checks and browser smoke.
5. Independent code review, fix findings, push to PR46, verify CI and merge the exact reviewed head. Update evidence/checkpoint without marking the whole stage complete.

## Limits

Crash-safe native workflow initiation remains separate. Uncertain uploads that never produce a successful receipt stay blocked until safely reconciled; operators must not delete receipts just because they are old. No source .env/secrets or upstream edits; private signing key stays on the machine.

## Verified before push

- New delayed-INSERT assertion failed against the old running code (submit200 instead of409), then passed on the corrected clone with 11 API acceptance groups, including reload/new-key reconciliation, current membership checks and one task after concurrent submit.
- `pnpm check` passed: 810 tests, typecheck and workspace builds. Foundation + action bridge Node contracts: 243 passed (including six new receipt tests).
- Two independent source reviewers found no remaining P1/P2 blocker. Retry/rollback uncertainty remains conservatively pending and is documented for operators.
