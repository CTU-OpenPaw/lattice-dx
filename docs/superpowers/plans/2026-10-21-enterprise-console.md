# Enterprise Console Implementation Plan

**Goal:** Expose existing engine capabilities through a discoverable enterprise home, organization/data administration and configurable workflow Studio.

**Architecture:** Add focused React components in the current Foundation plugin and fixed proxy operations in Action Bridge; extend optional recipe metadata and compile through existing validators. Preserve existing recipes and routes. Work on feat/enterprise-console, stacked on PR29.

## 1. Contracts and safety
- [x] Write failing compiler tests for optional block layout, custom transitions/conditions, invalid workflow and old manifest compatibility.
- [x] Implement optional recipe configuration and presentation label filtering through the existing validator.
- [x] Write bridge tests before adding fixed catalog/organization/schema/operations/data-share paths; reject unknown IDs/versions/queries and writes without keys.

## 2. Shared console and administration
- [x] Extract reusable session/frame/form controls from the previous Studio without changing behavior; add capability loading and enterprise navigation.
- [x] Add enterprise home and personal work inbox, paginated published systems, block/connector catalog and authorized operations status.
- [x] Add paginated/searchable departments/directory; create/update departments with optimistic versions and manager selection. Keep identity/SSO writes out of scope.

## 3. Data designer/runtime
- [x] Add schema list/editor, existing scalar field types/enum/required flags, save/publish and exact published-version link.
- [x] Add dynamic typed create/update forms, paginated record listing, detail/history and explicit shares through existing authorization.
- [x] Handle uncertain schema creation by checking exact ID/content before replay; retain the established immutable command controller for other writes.

## 4. Configurable systems
- [x] Add module block checkboxes/order controls and transition editor for roles/states/fields/task effects and optional equality conditions.
- [x] Render only configured blocks, in configured order; runtime actions still come from backend availableTransitions.
- [x] Expose registered automation/connector availability without hardcoding runnable integrations or changing specialized worker behavior.

## 5. Verification and handoff
- [x] Add model/component tests for serialization, typed fields, capability gating and retries.
- [x] Extend disposable PostgreSQL acceptance with custom extra approval step, department/schema/data sharing and role denial.
- [x] Run full project/plugin checks; independent review and fix blockers; install after backup and test actual browser paths.
- [x] Update separate manual guide, commit/push and create stacked PR; leave teammate branches/Notion/README unchanged.

## Execution evidence

- Compiler/bridge/model tests ran red before implementation. Legacy recipe manifests remain byte-identical; custom workflow readers preserve owner/assignee restrictions.
- Independent task and whole-change review findings fixed: custom reviewer access, displayed schema vs create publication mismatch, stale input state between inbox records, department-history pagination, and bridge pin forwarding. Follow-up review confirmed no remaining blocker.
- `pnpm check`: 121 files / 655 tests, all typechecks/builds passed. Foundation 68 tests and Bridge 12 tests passed. `pnpm test:system-studio` passed against a disposable PostgreSQL database, including two-module lifecycle, extra finance approval, department/schema/share permissions and explicit schema pinning after a later publication.
- Actual browser verification completed: create department, schema publish, dynamic record create/share, custom system publish with reordered/excluded blocks, then Alice → manager review-extra → manager approve → warehouse complete through shared inbox. Final state completed/version 5 with five history events.
- Local evidence image: output/verification/enterprise-console-completed.png. Detailed handoff: docs/testing/enterprise-console.md.
- Installed Foundation 0.16.0 and Bridge 0.3.0 with a NocoBase database backup. No upstream code/dependency additions, no Notion/README edits, no teammate-branch changes or volume reset. Specialized agent/n8n/broker workers remain unchanged.
