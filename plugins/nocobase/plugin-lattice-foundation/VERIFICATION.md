# Step 1 verification

Date: 2026-10-13 (Asia/Bangkok). Base repository fast-forwarded to e8d7635, with existing output/reports/tmp preserved. No merge conflicts.

Tested runtime: existing nocobase_test-app-1, NocoBase 2.2.22, PostgreSQL nocobase_test-postgres-1. No database volumes removed or replaced. The official repository Compose pins 2.2.20; its new mount has been configured but that separate runtime was not started/tested.

- JavaScript build: PASS.
- Seed test: PASS, repeatability, edit preservation and identity conflict.
- Real database migration up() repeated twice: PASS, counts unchanged, all asset/department/location/custodian relations within the correct demo organization. This is a focused migration-body test; it does not claim an upgrade of an older production release.
- Official pm add of packaged tgz: success.
- pm disable: installed=true, enabled=false; asset table/data retained.
- pm enable: installed=true, enabled=true; all counts retained.
- PostgreSQL counts: 2 departments, 2 employees, 2 locations, 2 assets.
- /admin and /api/app:getLang: HTTP 200 after lifecycle tests.

Initial manual storage copy needed a Node.js package symlink; documented installation now uses pm add, which handles extraction/linking. The generic plugin CLI can exit 0 after a logged error, so installed/enabled state and database contents were verified independently.

Only demo foundation data is created. Client blocks, Workspace, API Data synchronization, Keycloak subject linkage and production tenant permissions remain later steps.

## Browser loading fix — 0.1.1

The initial 0.1.0 HTTP checks did not validate browser rendering. NocoBase published a dist/client/index.js URL even though the server-only package lacked that file; RequireJS failed with Script error / App error.

Version 0.1.1 adds minimal AMD client and client-v2 entrypoints plus package wrappers. The declared URLs from pm:listEnabled both return HTTP 200. Actual headless Edge navigation to /admin redirects to /signin?redirect=/admin without App error or pageerror. This verifies the unauthenticated entry flow, not a full logged-in UI session. Real migration-body/relations checks still PASS with two records per collection. No blocks or Workspace screens were added.

## Step 2 — 0.2.0

- Eight Node tests PASS: seed; manifests; payload/scope whitelist; shared logistics controller; 401/403/network failure without retries; concurrent submission protection; missing catalog permission and mismatched result; built AMD registration.
- Plugin packaged/installed, runtime restarted to load updated server code.
- Real authenticated GET latticeApps:list: 200, purchasing and logistics returned. GET purchasing: 200. Unknown app: 404. Anonymous catalog: 401.
- Real database check: migration repeat and relationships still PASS; two rows per foundation collection.
- Headless Edge login through sign-in form to existing admin page: plugin asset 200, no pageerror or App error, existing expense page and four records visible. Browser showed an unauthenticated toast from the initial pre-login request; authenticated admin content loaded successfully afterward.
- Bridge/core absent in this runtime. Controller request/response tests use a fake HTTP adapter; no live record/task write through Gateway/Keycloak was claimed. Business transitions remain unavailable until Duy supplies API actions.

Follow-up 2026-10-13: deployed core and Action Bridge on the existing runtime. scripts/smoke-lattice-form.mjs PASS through actual PKCE/cookie-bound bridge, same form controller, Gateway/API and PostgreSQL. Record/task readback and direct SQL checks PASS; browser login/old admin page PASS with both plugin assets 200. See docs/lattice-form-e2e.md for IDs and runtime setup. Business transitions still unavailable.

## Step 3 — 0.3.0

12 Node tests PASS, including common API client timeout, session/error classification, no automatic retries and signOut order. Browser smoke PASS for login, manifest-driven selection/navigation, actual Keycloak PKCE connection and return to selected app, disconnect/logout; controlled HTTP 403 and 401 responses show appropriate UI. Workspace routes use /lattice/apps/* because /apps/* is reserved for NocoBase multi-app. No business form/list UI or workflow transitions are claimed complete. See docs/lattice-workspace.md.

## Step 4 — 0.4.0

13 Foundation tests plus one bridge list security test PASS. Browser Form/List smoke PASS: required validation, actual record/task writes, table readback, client filter and paging boundary, clearing table on disconnect. IDs and SQL confirmation in docs/lattice-blocks.md. Native builder on the existing page uses FlowModel; both Lattice entries verified visible with no schema insertion. FlowModel binding enum/handler also checked in Node tests. No native page schema was modified to test save of model binding; no such end-to-end claim is made. Form/list UI now available in Workspace, business transitions and file upload remain later work.

## Step 5 — 0.5.0

17 combined Foundation/bridge tests PASS. Actual browser file upload (clean scan), metadata/download byte match and client size rejection PASS; sales -> linked task -> separate same-org warehouse inbox PASS. Actual warehouse file metadata/content requests for Alice's file return 404. Added shared attachment panel and record reference suggestions via manifests, without an application-specific UI. Scanner healthy; isolated warehouse fixture added; organization scope admin-only in Keycloak profile. No native builder binding persistence or Order/Shipment workflow completion claimed. See docs/lattice-step5.md for evidence, earlier failed fixture attempt retained and remaining API blockers.

## Step 6 — 0.6.0

20 combined Foundation/bridge Node tests and 96 monorepo Vitest tests PASS. Workspace login/logout/error handling PASS; real bridge expiry after ~296s disables form and clears list. Native Form/List bindings configured through the UI, saved and present after reload/API readback on a separate hidden test page; original expense schema unchanged. Real clean/rejected scans, scanner outage quarantine, record links and concurrent task decision API checks PASS. Fixed delayed form results, UTF-16 length agreement and native block expiry handling (native expiry timer unit-tested; real browser expiry test covers Workspace). No business workflow completion or production certification claimed. Full evidence and pending items: docs/lattice-step6.md.

## Procurement deployment — 0.7.0

Existing runtime retained; new workflow API deployed from integrated PR #5 after DB backups. Allowlisted session-bound workflow proxy and procurement Workspace UI added. 23 Node tests and 120 Vitest tests PASS; browser Alice/Manager/Warehouse full procurement sequence PASS through handed_over/version 6, clean evidence and manager shared-download bytes verified. SQL audit versions 1–6; outbox remains pending/0 and worker disabled. Cross-org run/file requests return 404. See docs/procurement-workflow-deployment.md for retained failed-test run, backups and explicit limits. Reject branch/onboarding UI/Order/Shipment and production are not claimed browser-verified.
