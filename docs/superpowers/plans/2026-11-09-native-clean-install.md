# Duy — clean native installation and handoff, 09/11

## Goal

Complete the independently verifiable platform slice of stage7: reproduce native NocoBase from committed source and an empty database, install the three owned plugins, verify migrations/ACL/workflow, and seed the existing native UI fixture. Open a PR; do not merge teammate branches or claim full-system acceptance.

## Boundaries

- Use the pinned official2.2.38 image and existing host/package installer; no new CRUD, UI, workflow engine or upstream edits.
- Export committed Git source into a unique ignored output directory. Build only in that export, keeping live bind mounts and dirty/untracked work unchanged.
- Use a unique `lattice-native-clean-<id>` project, new named volumes and a loopback port. Refuse an occupied project or nonempty database. No restore/reseed/reset/removal of existing environments.
- Native auth/ACL/workflow are verified; actual Keycloak/provider/broker/n8n/shared files remain explicit separate deployment/acceptance requirements. No release/tag or broad checklist tick.

## Work

1. Audit HưngPR47 and Nhi's integration branch against source and committed evidence, distinguishing helpers from connected production consumers.
2. Add failing tests for isolation, reserved ports, occupied resources, empty database proof, source-export cwd and opt-in installer targeting. Reuse installer defaults unchanged.
3. Extend installer with explicit source/Compose targeting; add clean-install orchestrator and operation guide. Reuse native foundation/document acceptance and native page fixture setup.
4. Execute a real empty-volume bootstrap and record source SHA, package versions/license fields, expected migration names, API results and page path. Independently review new code and run repository checks.
5. Commit/push `feat/native-clean-install`, open PR, wait for CI and update Notion with scoped evidence and teammate bottlenecks. Leave whole-system completion open until teammates' integration is demonstrated.

## Verified checkpoint

- Source-only teammate audit: HưngPR47 has native role-aware shell/tasks and green CI, no confirmed source blocker; author reports seven-role/browser checks. Nhi has queue/retry and native observation helpers, but no PR or production native envelope caller; legacy rule identity/transport still need cutover. Do not report these as end-to-end native AI/n8n acceptance.
- First fresh run exported main260ec65, proved0publictables, installed3packages/10migrations on2.2.38, passed8foundation+23document/workflow API checks and seeded a persisted native page. No DBrestore or existingvolumes were used.
- Full `pnpm check` passed817tests/typecheck/build; Foundation+bridge contracts243passed. Focused isolation/installer tests13passed. Independent review caught and verified the Dockercontext fix; no remaining P1/P2. A second committed-source run with conflicting inherited context follows before PR handoff.
