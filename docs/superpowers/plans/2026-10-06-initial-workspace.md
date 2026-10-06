# Initial Workspace Implementation Plan

> **For agentic workers:** Execute inline with the executing-plans skill, task by task.

**Goal:** Build a runnable monorepo and demonstrate web → API → agent worker communication.

**Architecture:** Next.js provides the portal. A Fastify API forwards a validated demo request to an independent Fastify worker over HTTP. Shared TypeScript contracts define the boundary; the demo does not use an LLM or persistent queue.

**Tech Stack:** Node.js 24, pnpm 10, TypeScript, Next.js, React, Fastify, Vitest.

## Global Constraints

- Work in the empty E:/pmnm2026 workspace; no existing Git checkout to isolate.
- Keep NocoBase out of runtime dependencies until version-specific licensing is resolved.
- Bind backend services to loopback by default. No production authentication claims.
- No database, provider credentials, automatic execution of business actions, or deployment in this iteration.
- Adopt Apache-2.0 for original code; preserve upstream licenses and document dependency review limits.

### Task 1: Workspace and boundaries

- [x] Create root package.json, pnpm-workspace.yaml, tsconfig.base.json and ignore rules.
- [x] Create apps/web, apps/api, apps/agent-worker and packages/contracts manifests.
- [x] Install pinned dependencies and retain pnpm-lock.yaml.

### Task 2: Test communication before implementation

Files: tests/system.test.ts, apps/api/src/app.ts, apps/agent-worker/src/app.ts, packages/contracts/src/index.ts.

Interfaces: POST /v1/agent/demo accepts { message: string }; POST /run on the worker returns { mode: 'demo', summary: string }; GET /health returns service identity.

- [x] Write tests for an actual API → worker HTTP round trip, invalid input, and worker unavailability. Run pnpm test and confirm missing behavior.
- [x] Implement validation, bounded HTTP requests and sanitized upstream error responses.
- [x] Run pnpm test and confirm all scenarios pass.

### Task 3: Portal and operational documentation

Files: apps/web/src/app/{layout.tsx,page.tsx,globals.css}, apps/web/src/app/api/agent/demo/route.ts, README.md, docs/architecture.md, infra/README.md, plugins/nocobase/README.md, solutions/README.md, .github/workflows/ci.yml.

- [x] Add a Vietnamese portal with a demo form and explicit demo result labeling.
- [x] Document commands, service ports, extension rules, and limitations.
- [x] Run pnpm typecheck, pnpm test, pnpm build; start all three services and smoke-test the web proxy.
- [x] Review the working tree and report verified results without committing or publishing.

