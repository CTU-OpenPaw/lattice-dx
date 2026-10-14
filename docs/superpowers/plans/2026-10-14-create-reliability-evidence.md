# Evidence ledger — Duy create reliability

Base main e6d6657; one branch codex/foundation-create-reliability, one PR planned into main.

- Baseline pnpm check: 183 tests/27 files, typecheck and build passed.
- Plan/spec committed ce702fc; production/tests 94cc4ee. TDD missing-module RED and signed strict-parser tests recorded in output/reviews/create-reliability-implementation.md.
- Live old-image RED reproduced duplicate record IDs with the same key across REST/action.
- Live new-image create reliability GREEN: REST/action shared key, normalization, conflict, role denial, strict authority/header, task snapshot/detail, no-key distinct records and 5 concurrent keyed requests.
- Private SQL GREEN: actor/org/operation namespaces; 5-connection equal/different-input task races; current active assignee and owner link checks before replay; failed validation does not consume key; forced receipt failure rolls back entity; max1 execution and fresh-pool reconnect preserve receipt.
- pnpm check after production: 201 tests/28 files, typecheck/build passed.
- Regression actions, foundation, workflow-blocks passed. Completion batch hit logged Gateway429; rerun after existing rate window passed; bundles passed.
- Pending: independent task/final review, final-image smoke if runtime changes, handoff commit, PR creation/attachment and head CI.
- No Notion ticks, merge/release, dependencies/upstream changes or user-artifact cleanup. Parent docs/scripts remain uncommitted until final validation/review.
