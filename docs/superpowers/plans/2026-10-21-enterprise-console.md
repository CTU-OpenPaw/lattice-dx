# Enterprise Console Implementation Plan

**Goal:** Expose existing engine capabilities through a discoverable enterprise home, organization/data administration and configurable workflow Studio.

**Architecture:** Add focused React components in the current Foundation plugin and fixed proxy operations in Action Bridge; extend optional recipe metadata and compile through existing validators. Preserve existing recipes and routes. Work on feat/enterprise-console, stacked on PR29.

## 1. Contracts and safety
- [ ] Write failing compiler tests for optional block layout, custom transitions/conditions, invalid workflow and old manifest compatibility.
- [ ] Implement optional recipe configuration and presentation label filtering through the existing validator.
- [ ] Write bridge tests before adding fixed catalog/organization/schema/operations/data-share paths; reject unknown IDs/versions/queries and writes without keys.

## 2. Shared console and administration
- [ ] Extract reusable session/frame/form controls from the previous Studio without changing behavior; add capability loading and enterprise navigation.
- [ ] Add enterprise home and personal work inbox, paginated published systems, block/connector catalog and authorized operations status.
- [ ] Add paginated/searchable departments/directory; create/update departments with optimistic versions and manager selection. Keep identity/SSO writes out of scope.

## 3. Data designer/runtime
- [ ] Add schema list/editor, existing scalar field types/enum/required flags, save/publish and exact published-version link.
- [ ] Add dynamic typed create/update forms, paginated record listing, detail/history and explicit shares through existing authorization.
- [ ] Handle uncertain schema creation by checking exact ID/content before replay; retain the established immutable command controller for other writes.

## 4. Configurable systems
- [ ] Add module block checkboxes/order controls and transition editor for roles/states/fields/task effects and optional equality conditions.
- [ ] Render only configured blocks, in configured order; runtime actions still come from backend availableTransitions.
- [ ] Expose registered automation/connector availability without hardcoding runnable integrations or changing specialized worker behavior.

## 5. Verification and handoff
- [ ] Add model/component tests for serialization, typed fields, capability gating and retries.
- [ ] Extend disposable PostgreSQL acceptance with custom extra approval step, department/schema/data sharing and role denial.
- [ ] Run full project/plugin checks; independent review and fix blockers; install after backup and test actual browser paths.
- [ ] Update separate manual guide, commit/push and create stacked PR; leave teammate branches/Notion/README unchanged.
