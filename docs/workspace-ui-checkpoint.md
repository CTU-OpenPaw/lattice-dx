# Workspace UI checkpoint — 15 October 2026

Foundation 0.11.0 implements the reviewed Workspace layout on Hưng's `feat/nocobase-workflow-integration` branch. Draft review: https://github.com/TrDuy-pan3000/LatticeDX/pull/15. This does not mark phase two complete or merge the branch into main.

## Current UI

- `/lattice` opens Công việc của tôi; `/lattice?view=apps` opens the installed application directory. The existing `/lattice/apps/<id>` routes still render configured applications.
- The shell includes LatticeDX branding, sidebar, responsive mobile navigation, account/session controls, application search with Ctrl+K and a keyboard-accessible help dialog.
- Application shortcut cards come from validated manifest metadata. They do not branch on procurement/Logistics IDs. Only installed, visible manifests appear; no expense application card is invented for the illustration. The original native expense page is not modified.
- Shortcut creation links reference installed Form blocks, not arbitrary URLs. The purchasing shortcut is explicitly **Tạo hồ sơ**, because its foundation record form does not start the procurement workflow. The Logistics shortcut opens its configured order form.
- Inbox retains server-side search, state/definition filters and paging. Rows show the workflow title, creator, actual state, available action entry point and detail. Clicking a row action opens Approval for review; it does not silently approve.
- Creator names are resolved only when the connected token has the directory-read capability. Otherwise the current user's known name or a shortened owner ID is displayed. Role hints do not grant authority; directory and mutations remain authorized by the API. Role hints are derived only after the same token has passed catalog verification; no token is returned to the browser.
- No unread-notification badge, company name, total-count badge, deadline or nonexistent application is fabricated. Deadline is shown as unavailable. Company switching, notifications, Reports, AI and personal settings are not presented as working features.

## API-dependent parts of the illustration

**Cần xử lý** and **Có quyền xem** retain their existing backend meanings. **Đang thực hiện**, **Đã hoàn thành** and **Tôi đã tạo** are disabled placeholders until a server-side view contract is agreed. Client-side filtering of just one returned page would produce incorrect counts and miss authorized matches, so it is not substituted for server queries.

To finish those views with Duy, agree a scoped work-item query providing:

1. Explicit view semantics for action-required, in-progress, completed and created-by-me, including workflow tasks/waits and independent tasks. Lack of an available action must not be interpreted as completion.
2. Server-side application/definition, state, text and view filters with stable pagination; exact scoped counts if a count badge is shown.
3. Resource kind/ID/version, application or definition display metadata, requester/assignee display metadata only when readable, nullable deadline and server-authorized action descriptors.
4. A supported route/command for each action type; workflow transition Approval must not be used to complete a wait or decide an independent task.

These are integration requirements, not newly implemented API endpoints. Draft main `ee10614` contains additional enterprise/task capabilities; this UI checkpoint does not silently merge that large backend increment or assume it is installed locally. The running API remains the previously verified integration baseline. The new directory adapter uses an existing endpoint.

## Verification and local deployment

- Foundation browser/server package builds; 42 Foundation/bridge Node tests and 220 existing Vitest tests pass on this branch.
- `smoke-workspace-layout.cjs` checks desktop 1440×1000 and mobile 390×844, Ctrl+K application search, help/Escape handling, app navigation, disabled unsupported tabs and page-level horizontal overflow.
- Workspace session/navigation smoke retains PKCE, return-to-app, logout and controlled 401/403 coverage. Inbox/Approval and native menu smokes cover business behavior and Studio registration.
- Screenshots are saved locally as ignored `output/workspace-ui-desktop.png` and `output/workspace-ui-mobile.png`. Package archives and the previous Foundation package remain under ignored output; they are not committed.
- Docker Desktop was initially stopped. Its current per-user installation was started with its CLI; existing containers were started in dependency order. No database or volume reset was performed.

The layout is implemented with scoped CSS and original SVG primitives, using the host's existing React runtime. No upstream NocoBase code or new UI dependency is bundled.
