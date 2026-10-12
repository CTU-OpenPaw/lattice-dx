# Phase one foundation

Approved scope: Duy's phase 1, 12–14 October. Work on branch codex/phase-one-foundation.

1. Start Docker without moving or deleting its existing disks; validate the current core baseline.
2. Add a pinned standalone NocoBase runtime with its own PostgreSQL/storage. Preserve upstream notices; record runtime/source version differences. Do not imply SSO or plugins are already integrated.
3. Extend JWT/repository authorization with signed organization scope. Test missing scope, expiration and the same subject in different organizations; migrate existing records conservatively.
4. Provide API examples and a UC1 state/role contract for team integration.
5. Verify unit tests, typecheck, builds, Compose validation and runtime smoke where Docker is available. Record blockers explicitly.

6. Implement basic durable task assignment/decision with organization/assignee/version gates; validate concurrent updates against PostgreSQL.
7. Implement scoped small-file metadata/content storage and ClamAV quarantine; fail closed when scanning fails. PostgreSQL bytea is bootstrap storage, not the lakehouse/object-store target.
8. Check persistence across restart and record actual limitations. Full phase needs Hưng/Nhi integration; runtime startup alone is not phase acceptance.
