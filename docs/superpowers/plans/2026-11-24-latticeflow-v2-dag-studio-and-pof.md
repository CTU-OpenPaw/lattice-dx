<!--
@file LatticeDX — Open Digital Enterprise Platform
@author CTU-OpenPaw
@copyright (C) 2026 CTU-OpenPaw
@license Apache-2.0
@see https://github.com/CTU-OpenPaw/lattice-dx
SPDX-License-Identifier: Apache-2.0
-->
# LatticeFlow v2 DAG Studio, Real LLM Flow Architect & PoF 50/50 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended, parallel `self` subagents with zero file overlap per wave) or `superpowers:executing-plans` to implement this plan wave-by-wave. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a full-screen, domain-agnostic DAG Automation Platform (**LatticeFlow v2**), backed by a modular Node Registry & durable PostgreSQL Pause/Resume engine, real `llmServices`-powered **DX-OS Flow Architect** with validator self-repair, `@xyflow/react` (MIT) + `@dagrejs/dagre` (MIT) infinite canvas Studio UI, and **50/50 OLP PMNM 2026 PoF** source purity (removing the `upstream/nocobase` submodule from Git).

**Architecture:** Tier 1 DAG engine & plug-and-play `nodes/*.js` live in `plugins/nocobase/plugin-dxos-studio/src/server/flow/` (`<= 350 lines/file`, zero business-domain hardcoding); Tier 2/3 industry packs live strictly as declarative blueprints in `flow/blueprints/*.json`. The full-viewport Studio UI lives in `src/client/flow/` using `@xyflow/react` + `@dagrejs/dagre` bundled with `esbuild` while keeping host `react`/`react-dom`/`antd`/`@nocobase/client` external. `@latticedx/plugin-dxos-ai` keeps `adminMcpToolsListed17 === 17` by upgrading `dxos_configure_workflow` to drive LatticeFlow v2 & `flow/architect.js`.

**Tech Stack:** NocoBase `2.2.50` host runtime (external OCI container), Node.js 24 CJS/ESM, PostgreSQL 16 + RLS, `@xyflow/react@12.12.1` (MIT), `@dagrejs/dagre@3.1.3` (MIT), `esbuild@0.28.2` (MIT), Vitest + `node --test`.

**Spec:** [2026-11-24-latticeflow-v2-dag-studio-and-pof-design.md](../specs/2026-11-24-latticeflow-v2-dag-studio-and-pof-design.md)

## Global Constraints
- Worktree ONLY: `C:\Users\Truong Duy\.codex\worktrees\native-multi-portal-pof` (branch `feat/v1.0.0-olp-championship`). Never edit `e:\pmnm2026` directly until final user-approved integration.
- Version stays `1.0.0` across root `package.json`, all 7 plugins, and runtime metadata.
- License purity: 100% Apache-2.0 first-party code with CTU-OpenPaw SPDX header; only OSI-approved permissive/compatible libraries in workspace (`@xyflow/react` MIT, `@dagrejs/dagre` MIT); ZERO `BSL-1.1` / `ThingsBoard` / `EMQX`; ZERO `upstream/nocobase` submodule or upstream source bundled in Git or `.tar.gz` release archives; `n8n` documented strictly as optional external container integration.
- Host SDK isolation: all 7 NocoBase plugins keep `"sdkProvidedByHost": true`; `plugin-dxos-studio` client build keeps `react`, `react-dom`, `antd`, `@nocobase/client` strictly external (plus `react/jsx-runtime` mapped to host React shim).
- Modularity: every new file in `src/server/flow/` and `src/client/flow/` stays `<= 350` lines (single responsibility; no new monoliths).
- Domain generality (Tier 1 vs Tier 2/3): ZERO cold-chain/vaccine/MKT/CMMS business strings inside Tier 1 core engine (`schema`, `validator`, `registry`, `nodes/*`, `executor`, `architect`).
- Naming: ZERO new "Copilot" wording across Wave 9+ files, APIs, UI labels, eval categories, or docs (`DX-OS Flow Architect` / `automation-architect`). Preserve legacy pre-Wave-9 `dxos_my_tasks_copilot` & `ai-copilot-tools.js`.
- Tool matrix invariant: `adminMcpToolsListed17 === 17`; `dxos_configure_workflow` remains `adminOnly: true`.
- Preserve NocoBase Clause 5.2 attribution (`Powered by NocoBase`, `v2.2.50`, `https://www.nocobase.com`, `License settings`).
- Stop cleanly before `git push`, PR creation, merge, or GitHub release publication.

## Review Focus
1. **React instance duplication / `react-dom` AMD resolution in NocoBase `2.2.50`:** If `@xyflow/react` pulls a bundled copy of `react` or misses `react/jsx-runtime` / `react-dom`, runtime throws `"Invalid hook call"` -> pinned in Task 3.1 (`esbuild` external/shim test verifying zero bundled `react` & single hook dispatcher).
2. **DAG Cycles, Loop Exhaustion, Prototype Pollution, O(n) ReDoS, & SSRF:** Malicious or LLM-generated graphs with cycles (`A -> B -> A`), >100 loop iterations, depth >8, `__proto__` keys, nested `{{...}}`, or metadata IP `169.254.169.254` in `ai.llm`/`integration.http` must fail closed before execution -> pinned in Tasks 1.1 & 1.2 (`flow-validator.test.cjs` + `flow-nodes.test.cjs`).
3. **Cross-Tenant Resume Spoofing & Double-Resume Race on `SUSPENDED` Runs:** Calling `dxosAutomations:resumeRun` from a wrong org, with an invalid/reused `resumeToken`, or concurrently twice on the same HITL/Delay run must reject cleanly (`403`/`404`/`409`) -> pinned in Task 1.3 (`flow-executor.test.cjs`).
4. **Backward Compatibility for v1 `actionsJson[]`, Bundle v3, & 17 MCP Tools:** Existing showcase rules, Bundle v3 export/import, legacy UI `data-testid`s, and `dxos_configure_workflow` v1 arguments must keep passing -> pinned in Tasks 1.3, 2.2, and 3.2.
5. **PoF 50/50 Audit After Removing `upstream/nocobase` Submodule & Adding MIT Canvas Deps:** Non-git tarball audit (`pnpm release:tarball`), `pnpm pof:check`, `pnpm release:sbom -- --check`, and `source-headers --check` must all pass with `0` unverified components -> pinned in Tasks 0.1 & 5.2.

---

## Wave 0 — PoF Hardening & Clean Foundation

### Task 0.1: Remove `upstream/nocobase` Git Submodule & Align PoF Auditors
**Files:**
- Remove: `.gitmodules`, `upstream/nocobase` (Gitlink `160000` entry)
- Modify: `scripts/verify-pof-readiness.mjs:178-197`
- Modify: `scripts/tests/oss-pof-audit.test.mjs:101-190`
- Modify: `COPYRIGHT.txt:13-24`, `NOTICE`, `docs/nocobase-source-review.md:1-31`, `docs/third-party.md:1-66`, `docs/oss-pof-compliance.md:1-44`
- Test: `scripts/tests/oss-pof-audit.test.mjs`

**Interfaces:**
- Produces: clean `pnpm pof:check` (`upstream-clean` enforces zero `.gitmodules` `upstream/nocobase` submodule and zero tracked `upstream/` source files, both in Git and extracted non-git release tarballs).

- [ ] **Step 1: Update failing PoF test assertions first**
  - Add assertion in `scripts/tests/oss-pof-audit.test.mjs`: `runPofAudit` returns `upstream-clean.passed === false` when `.gitmodules` or `upstream/nocobase/...` is tracked in Git.
  - Run `node --test scripts/tests/oss-pof-audit.test.mjs` -> verify FAIL before code edit.
- [ ] **Step 2: Remove submodule cleanly via Git**
  - Run `git rm -f upstream/nocobase` and `git rm -f .gitmodules` (clean `.git/modules/upstream/nocobase` if needed so `git status` shows clean deletion of `.gitmodules` + `upstream/nocobase`).
- [ ] **Step 3: Update `checkUpstreamClean` in `scripts/verify-pof-readiness.mjs`**
  - Signature: `function checkUpstreamClean(rootDir, trackedFiles, { isGit = true } = {})`
  - Fail if `trackedFiles` contains `upstream/` entries or `.gitmodules` references `upstream/nocobase`.
- [ ] **Step 4: Sync governance & legal docs (`COPYRIGHT.txt`, `NOTICE`, `docs/nocobase-source-review.md`, `docs/third-party.md`, `docs/oss-pof-compliance.md`)**
  - State clearly per BTC `msg 1371–1375`: 100% of Git repo is pure OSI (Apache-2.0 + MIT); `nocobase/nocobase:2.2.50@sha256:...` is loaded exclusively as an external Docker runtime image outside the repo; `n8nio/n8n:2.48.1` is an optional external integration container.
- [ ] **Step 5: Verify & commit**
  - Run: `node --test scripts/tests/oss-pof-audit.test.mjs && pnpm pof:check && node scripts/source-headers.mjs --check` -> expect PASS.
  - Commit: `chore(pof): remove upstream/nocobase submodule for pure-OSI source repository`

---

## Wave 1 — LatticeFlow v2 Core DAG Engine & Plug-and-Play Node Registry

*(3 parallel `self` subagents: W1-A, W1-B, W1-C — strict non-overlapping file ownership)*

### Task 1.1 (W1-A): Collections, Reversible Migration v2, Graph Schema & Security Validator
**Files:**
- Create: `plugins/nocobase/plugin-dxos-studio/src/server/migrations/20261126000100-latticeflow-v2-dag-and-durable-runs.js`
- Create: `plugins/nocobase/plugin-dxos-studio/src/server/flow/schema.js`
- Create: `plugins/nocobase/plugin-dxos-studio/src/server/flow/validator.js`
- Create: `plugins/nocobase/plugin-dxos-studio/src/server/flow/durable-store.js`
- Modify: `plugins/nocobase/plugin-dxos-studio/src/server/collections/automation-rules.js`
- Modify: `plugins/nocobase/plugin-dxos-studio/src/server/collections/automation-runs.js`
- Test: `plugins/nocobase/plugin-dxos-studio/tests/flow-validator.test.cjs`

**Interfaces:**
- Produces (`flow/schema.js`):
  - `FLOW_SCHEMA_VERSION = 2`
  - `normalizeGraph(rawGraph) -> { version: 2, nodes, edges, viewport, settings }`
  - `v1RuleToGraphV2(rule) -> GraphV2`
  - `graphV2SummaryToV1Compat(ruleOrGraph) -> { triggerEventType, filterJson, dmnTableKey, cooldownSec, maxDepth, actionsJson }`
  - `serializeFlowDsl(rule, format = 'json' | 'yaml') -> string` and `parseFlowDsl(text) -> object`
- Produces (`flow/validator.js`):
  - `validateFlowGraph(graph, { nodeRegistry, allowlistedCollections, systemProtectedCollections, maxNodes = 50 }) -> { ok, topoOrder, triggerNode, errors }`
  - `assertSafeFlowTemplate(value)` (linear `O(n)` scanner + prototype-key guard reusing safe helpers)
- Produces (`flow/durable-store.js`):
  - `createRunRecord(db, payload)`, `updateNodeState(db, runUid, orgId, nodeId, state)`, `suspendRun(db, opts)`, `claimSuspendedRun(db, { organizationId, runUid, expectedNodeId, resumeToken, actor }) -> { ok, run, error }`

- [ ] **Step 1: Write failing tests in `tests/flow-validator.test.cjs`**
  - Test cycle rejection (`A -> B -> A` throws/fails `FLOW_CYCLE_DETECTED`), `> 50` nodes rejected, multiple triggers rejected, `__proto__` / `{{1+1}}` / `users` collection rejected, lossless `v1RuleToGraphV2` conversion of a 5-step branching v1 rule, reversible migration `up()` + `down()`, and atomic `claimSuspendedRun` preventing double-resume.
- [ ] **Step 2: Run test to verify failure**
  - Run: `node --test plugins/nocobase/plugin-dxos-studio/tests/flow-validator.test.cjs` -> expect module missing FAIL.
- [ ] **Step 3: Implement collection columns, reversible migration `20261126000100`, `schema.js`, `validator.js`, `durable-store.js`**
  - Keep every file `<= 350` lines; zero cold-chain/domain hardcode. Migration must use PostgreSQL `ADD COLUMN IF NOT EXISTS` in `up()` and `DROP COLUMN IF EXISTS` in `down()`.
- [ ] **Step 4: Re-run tests & verify PASS**
  - Run: `node --test plugins/nocobase/plugin-dxos-studio/tests/flow-validator.test.cjs` -> expect all PASS.

### Task 1.2 (W1-B): Plug-and-Play Node Registry, All 20 Node Types & Real `llmServices` Client
**Files:**
- Create: `plugins/nocobase/plugin-dxos-studio/src/server/flow/registry.js`
- Create: `plugins/nocobase/plugin-dxos-studio/src/server/flow/llm-client.js`
- Create: `plugins/nocobase/plugin-dxos-studio/src/server/flow/nodes/triggers.js`
- Create: `plugins/nocobase/plugin-dxos-studio/src/server/flow/nodes/control.js`
- Create: `plugins/nocobase/plugin-dxos-studio/src/server/flow/nodes/data.js`
- Create: `plugins/nocobase/plugin-dxos-studio/src/server/flow/nodes/logic.js`
- Create: `plugins/nocobase/plugin-dxos-studio/src/server/flow/nodes/ai.js`
- Create: `plugins/nocobase/plugin-dxos-studio/src/server/flow/nodes/integrations.js`
- Test: `plugins/nocobase/plugin-dxos-studio/tests/flow-nodes.test.cjs`

**Interfaces:**
- Produces (`flow/registry.js`):
  - `registerNodeType(def)`, `getNodeType(type)`, `listNodeSchemas() -> NodeSchema[]`
  - Default registry exports all 5 Triggers (`trigger.event`, `trigger.record`, `trigger.schedule`, `trigger.webhook`, `trigger.manual`), 7 Control nodes (`control.if`, `control.switch`, `control.parallel`, `control.merge`, `control.loop`, `control.delay`, `control.approval`, `control.subflow` — split clean), Data (`data.query`, `data.create`, `data.update`), Logic (`logic.dmn`, `logic.transform`), AI (`ai.llm`, `ai.agent`), Integrations (`integration.http`, `iot.twin_command`, `notify.send`, `event.emit`).
- Produces (`flow/llm-client.js`):
  - `resolveActiveLlmService(db, env) -> { configured, provider, baseURL, apiKey, modelName } | null`
  - `callConfiguredLlm({ db, env, messages, jsonSchema, maxTokens, timeoutMs, fetchImpl }) -> { ok, mode: 'llm' | 'unconfigured' | 'error', content, parsedJson, usage, reason }` (SSRF-checked, PII-redacted).

- [ ] **Step 1: Write failing tests in `tests/flow-nodes.test.cjs`**
  - Cover all node schemas (`inputSchema`, `ports`), `control.if` & `control.switch` port selection, `control.loop` 100-item safety cap, `logic.transform` safe expression mapping (zero `eval`), `data.query` org isolation, `ai.llm` mock HTTP OpenAI-compatible JSON parsing + offline fallback + SSRF block on `169.254.169.254`, and PII redaction before LLM dispatch.
- [ ] **Step 2: Run test to verify failure** -> expect FAIL.
- [ ] **Step 3: Implement `llm-client.js`, `nodes/*.js`, and `registry.js`** (each file `<= 350` lines; pure domain-agnostic Tier 1 primitives).
- [ ] **Step 4: Run test to verify PASS** -> `node --test plugins/nocobase/plugin-dxos-studio/tests/flow-nodes.test.cjs`.

### Task 1.3 (W1-C): DAG Executor, Pause/Resume Lifecycle, ORM/Cron/Webhook Hooks & Tier-2 Blueprints
**Files:**
- Create: `plugins/nocobase/plugin-dxos-studio/src/server/flow/executor.js`
- Create: `plugins/nocobase/plugin-dxos-studio/src/server/flow/blueprints/index.js`
- Create: `plugins/nocobase/plugin-dxos-studio/src/server/flow/blueprints/{coldchain-emergency,mkt-quarantine,sla-escalation,procurement-hitl-approval,scheduled-ai-digest,partner-webhook-sync}.json`
- Modify: `plugins/nocobase/plugin-dxos-studio/src/server/automation-engine.js` (delegate v2 DAG execution & preserve all v1 exports/APIs)
- Modify: `plugins/nocobase/plugin-dxos-studio/src/server/domain-builder.js` (install v2 blueprint for `cmms-maintenance`)
- Modify: `plugins/nocobase/plugin-dxos-studio/src/server/index.js` (mount ORM record listeners, due-delay ticker opt-in, `acl.allow` for new actions)
- Test: `plugins/nocobase/plugin-dxos-studio/tests/flow-executor.test.cjs`

**Interfaces:**
- Consumes: `flow/schema.js`, `flow/validator.js`, `flow/durable-store.js`, `flow/registry.js`.
- Produces (`flow/executor.js`):
  - `executeFlowGraph(db, ruleRow, triggerContext, opts) -> RunResult`
  - `dryRunFlowGraph(db, ruleOrGraph, sampleEvent, opts) -> RunResult`
  - `testSingleFlowNode(db, { graph, nodeId, pinnedInputs, organizationId, actor }) -> { ok, status, input, output, durationMs, error }`
  - `resumeFlowRun(db, { organizationId, runUid, decision, payload, resumeToken, actor, dryRun }) -> RunResult`
  - `dispatchRecordTriggerEvent(db, eventCtx)`, `dispatchWebhookIngress(db, { organizationId, ruleKey, headers, rawBody, parsedBody })`

- [ ] **Step 1: Write failing tests in `tests/flow-executor.test.cjs`**
  - Test full DAG branching (`control.if` + `control.switch`), `control.parallel` -> `control.merge`, `error` port routing on node failure, `control.approval` HITL pause (`status === 'suspended'`) followed by `resumeFlowRun(approved)` resuming downstream node, cross-org `403`/double-resume `409` guards, `testSingleFlowNode`, `trigger.webhook` HMAC validation, and backward-compatible execution of v1 `actionsJson[]` rules.
- [ ] **Step 2: Run test to verify failure** -> expect FAIL.
- [ ] **Step 3: Implement `executor.js`, 6 declarative `blueprints/*.json`, and clean delegation in `automation-engine.js` / `domain-builder.js` / `index.js`**
- [ ] **Step 4: Verify & commit Wave 1**
  - Run: `node --test plugins/nocobase/plugin-dxos-studio/tests/flow-*.test.cjs plugins/nocobase/plugin-dxos-studio/tests/automation-engine.test.cjs plugins/nocobase/plugin-dxos-studio/tests/domain-builder.test.cjs` -> expect 100% PASS.
  - Commit: `feat(flow): add LatticeFlow v2 modular DAG engine, durable Pause/Resume, and 20-node registry`

---

## Wave 2 — Real LLM **DX-OS Flow Architect** & `@latticedx/plugin-dxos-ai` Integration

*(2 parallel `self` subagents: W2-A and W2-B — strict non-overlapping file ownership)*

### Task 2.1 (W2-A): `flow/architect.js` (LLM Planner + 2-Round Self-Repair) & Studio Endpoints
**Files:**
- Create: `plugins/nocobase/plugin-dxos-studio/src/server/flow/architect.js`
- Modify: `plugins/nocobase/plugin-dxos-studio/src/server/automation-engine.js` (wire `nodeRegistry`, `testNode`, `resumeRun`, `webhookIngress`, `aiAssist` -> `flow/architect.js` + `flow/blueprints/`)
- Remove/Replace safely: `plugins/nocobase/plugin-dxos-studio/src/server/automation-copilot.js` (keep thin deprecated re-export or remove after updating all callers/tests in `plugin-dxos-ai` so zero "Copilot" file remains)
- Test: `plugins/nocobase/plugin-dxos-studio/tests/flow-architect.test.cjs`
- Update: `plugins/nocobase/plugin-dxos-studio/tests/automation-engine.test.cjs`

**Interfaces:**
- Produces (`flow/architect.js`):
  - `buildFlowStudioCatalog(db, organizationId) -> { nodeTypes, eventTypes, dmnTables, collections, roles, connectors, llmConfigured, blueprints }`
  - `applyGraphOperations(baseGraph, ops) -> { graph, graphDiff: { addedNodes, updatedNodes, removedNodes, addedEdges, removedEdges } }`
  - `runFlowArchitect({ db, env, mode: 'full' | 'node' | 'suggest' | 'fix_error', prompt, rule, graph, targetNodeId, runTrace, organizationId })`

- [ ] **Step 1: Write failing tests in `tests/flow-architect.test.cjs`**
  - Verify (a) configured mock LLM returning valid Graph Ops synthesizes arbitrary multi-branch HITL+Webhook+Cron+LLM graphs for any domain (e.g., School Scholarship Approval or Hospital Lab Alert); (b) if LLM emits a cycle or forbidden `users` collection on attempt 1, `validator.js` catches it and LLM self-heals on retry #1; (c) exhausted invalid retries fail closed cleanly; (d) `mode: 'fix_error'` patches a failing node from `runTrace`; (e) unconfigured LLM cleanly executes `modeUsed: 'offline-fallback'` without `"Copilot"` strings anywhere.
- [ ] **Step 2: Run test to verify failure** -> expect FAIL.
- [ ] **Step 3: Implement `flow/architect.js` (`<= 350 lines`) and wire Studio actions (`builderCatalog`, `nodeRegistry`, `testNode`, `resumeRun`, `webhookIngress`, `aiAssist`); remove legacy `automation-copilot.js` once callers are updated.**
- [ ] **Step 4: Run Studio server test suite** -> expect PASS.

### Task 2.2 (W2-B): Upgrade `dxos_configure_workflow`, Remove Wave 9 "Copilot" Naming & Expand NL Eval (80+ cases)
**Files:**
- Modify: `plugins/nocobase/plugin-dxos-ai/src/server/ai-builder-tools.js`
- Modify: `plugins/nocobase/plugin-dxos-ai/src/server/ai-nl-router.js`
- Modify: `plugins/nocobase/plugin-dxos-ai/src/server/ai-schemas.js`
- Modify: `plugins/nocobase/plugin-dxos-ai/tests/ai-builder-tools.test.cjs`
- Modify: `plugins/nocobase/plugin-dxos-ai/tests/vietnamese-nl-eval.test.cjs`
- Modify: `scripts/eval-vietnamese-nl-agent.mjs`

**Interfaces:**
- Consumes: `dxosAutomations` actions + `flow/architect.js`.
- Preserves: `adminMcpToolsListed17 === 17` and pre-Wave-9 `dxos_my_tasks_copilot` / `ai-copilot-tools.js`.

- [ ] **Step 1: Update failing tests in `ai-builder-tools.test.cjs` & `vietnamese-nl-eval.test.cjs`**
  - Assert `dxos_configure_workflow` supports Graph v2 `draftAutomation`, `patchAutomation`, `suggestAutomation`, `testAutomation`, and `resumeAutomation`, preserves `17` MCP tools, routes natural Vietnamese multi-branch/HITL/Cron/LLM-node prompts cleanly, and contains ZERO Wave 9 `"Copilot"` labels (`automation_architect_assist`).
- [ ] **Step 2: Update `ai-builder-tools.js`, `ai-nl-router.js`, `ai-schemas.js`, and expand `scripts/eval-vietnamese-nl-agent.mjs` to 80 cases (`automation-architect` category).**
- [ ] **Step 3: Verify & commit Wave 2**
  - Run: `node --test plugins/nocobase/plugin-dxos-ai/tests/*.test.cjs && node scripts/eval-vietnamese-nl-agent.mjs --min-pass=95` -> expect 100% PASS (80/80).
  - Commit: `feat(ai): wire Real LLM DX-OS Flow Architect, remove Wave 9 Copilot branding, and expand NL eval to 80 cases`

---

## Wave 3 — Full-Screen `@xyflow/react` Studio UI

*(2 parallel tasks: W3-A build pipeline first, then W3-B UI modules — or separate file sets)*

### Task 3.1: Install `@xyflow/react@12.12.1` & `@dagrejs/dagre@3.1.3` (MIT) and Upgrade `plugin-dxos-studio/build.mjs`
**Files:**
- Modify: `plugins/nocobase/plugin-dxos-studio/package.json`
- Modify: `package.json` / `pnpm-lock.yaml`
- Modify: `plugins/nocobase/plugin-dxos-studio/build.mjs`
- Create: `plugins/nocobase/plugin-dxos-studio/src/client/flow/vendor-shims.js`
- Test: `plugins/nocobase/plugin-dxos-studio/tests/flow-build-bundle.test.cjs`

**Interfaces:**
- Produces: `plugins/nocobase/plugin-dxos-studio/dist/client/index.js` bundled cleanly with `@xyflow/react` + `@dagrejs/dagre` (MIT) + inlined CSS string, zero duplicated React instances (`react`, `react-dom`, `antd`, `@nocobase/client` stay host externals via AMD/CJS factory).

- [ ] **Step 1: Add MIT packages & lockfile update**
  - Add `@xyflow/react: 12.12.1` and `@dagrejs/dagre: 3.1.3` under `devDependencies` (bundled into `dist/client/index.js` at build time; `nocobase.sdkProvidedByHost: true` preserved; host-provided libs excluded).
- [ ] **Step 2: Write failing bundle verification test `tests/flow-build-bundle.test.cjs`**
  - Assert built `dist/client/index.js` passes `node --check`, keeps `'react'`, `'react-dom'`, `'antd'`, `'@nocobase/client'` as AMD externals without embedding React source (`react/cjs/react.production`), bundles `@xyflow/react` + `@dagrejs/dagre`, and includes idempotent CSS injection.
- [ ] **Step 3: Upgrade `plugins/nocobase/plugin-dxos-studio/build.mjs` using `esbuild` + host React/jsx-runtime shim**
- [ ] **Step 4: Run build + test -> verify PASS**
  - Run: `pnpm -F @latticedx/plugin-dxos-studio build && node --test plugins/nocobase/plugin-dxos-studio/tests/flow-build-bundle.test.cjs`.

### Task 3.2: Modular Full-Screen Flow Studio UI Components (`<= 350 lines/file`)
**Files:**
- Create: `plugins/nocobase/plugin-dxos-studio/src/client/flow/flow-studio-app.js`
- Create: `plugins/nocobase/plugin-dxos-studio/src/client/flow/flow-canvas.js`
- Create: `plugins/nocobase/plugin-dxos-studio/src/client/flow/node-palette.js`
- Create: `plugins/nocobase/plugin-dxos-studio/src/client/flow/node-inspector.js`
- Create: `plugins/nocobase/plugin-dxos-studio/src/client/flow/architect-drawer.js`
- Create: `plugins/nocobase/plugin-dxos-studio/src/client/flow/playback-bar.js`
- Modify: `plugins/nocobase/plugin-dxos-studio/src/client/index.js` (register `/admin/settings/dxos-flow-studio` full-screen page)
- Modify: `plugins/nocobase/plugin-dxos-studio/src/client/builder-broker-panels.js` (slim Tab 8 launcher + summary card; keep Vault & legacy `data-testid`s)
- Retire: old `plugins/nocobase/plugin-dxos-studio/src/client/automation-studio-panel.js` monolith once `flow/` replaces it cleanly (keep thin compat re-export if any legacy test imports it directly, otherwise migrate test assertions cleanly to `flow/`!)
- Test: `plugins/nocobase/plugin-dxos-studio/tests/flow-ui-studio.test.cjs` + `plugins/nocobase/plugin-dxos-studio/tests/builder-broker-ui.test.cjs`

**Interfaces:**
- Consumes: `dxosAutomations:{builderCatalog,nodeRegistry,listRules,saveRule,deleteRule,testRule,runNow,listRuns,testNode,resumeRun,aiAssist}`, `dxosVault:list`.
- UI Contract:
  - Dedicated settings route `dxos-flow-studio` (`DX-OS Flow Studio`) rendering `100vh`-fitted infinite React Flow canvas + Dagre Auto-Layout + Minimap + Controls + categorized Node Palette + 3-tab n8n-style Inspector (`Config`, `Input/Pin`, `Output` + `{{` Variable Tree Picker + `Test This Node`) + **DX-OS Flow Architect** sliding drawer (`Suggest`, `Patch Node`, `Build Flow`, `Fix Last Error` + Diff Preview + 1-click Apply) + VCR Step Playback Bar with live HITL Approve/Reject controls.
  - Zero `"Copilot"` strings anywhere in UI.

- [ ] **Step 1: Write failing UI tests in `tests/flow-ui-studio.test.cjs` & update `tests/builder-broker-ui.test.cjs`**
  - Verify full-screen plugin route registration, 3-pane Flow Studio rendering with `@xyflow/react`, node selection stability across edits, Variable Picker insertion, Test Node + Dry-Run Playback highlights, HITL Approve/Reject resume action, and **DX-OS Flow Architect** Diff + Apply (zero `"Copilot"` text).
- [ ] **Step 2: Implement the 6 modular UI components (`<= 350 lines` each) + wire into `src/client/index.js` & `builder-broker-panels.js`**
- [ ] **Step 3: Rebuild & verify UI + bundle tests**
  - Run: `pnpm -F @latticedx/plugin-dxos-studio build && pnpm -F @latticedx/plugin-dxos-studio test` -> expect 100% PASS.
  - Commit: `feat(studio-ui): add full-screen React Flow LatticeFlow Studio and DX-OS Flow Architect drawer`

---

## Wave 4 — Whole-Delta Security & Quality Review + Seeder / Acceptance Sync

### Task 4.1: Update Showcase Seeder & Live Automation Acceptance Suite for LatticeFlow v2
**Files:**
- Modify: `scripts/seed-v100-championship-showcase.mjs`
- Modify: `scripts/acceptance-broker-automation-builder.mjs`
- Modify: `scripts/tests/seed-v100-championship-showcase.test.mjs`
- Modify: `scripts/tests/acceptance-broker-automation-builder.test.mjs`

- [ ] **Step 1: Update seeder to seed representative Graph v2 DAG blueprints cleanly & idempotently** (zero duplicate runs/rules/work orders on repeat run).
- [ ] **Step 2: Expand `acceptance-broker-automation-builder.mjs`** to exercise live `nodeRegistry`, DAG branching + `control.loop`, `testNode`, `control.approval` HITL Pause/Resume + negative cross-org/replay rejection, `webhookIngress` HMAC rejection on invalid sig, and `dxosAutomations:aiAssist` (`automationStudioAndArchitectOk: true`), cleaning up all temp artifacts in `finally`.
- [ ] **Step 3: Run script unit tests & verify PASS**
  - Run: `node --test scripts/tests/seed-v100-championship-showcase.test.mjs scripts/tests/acceptance-broker-automation-builder.test.mjs`.
  - Commit: `test(acceptance): cover LatticeFlow v2 DAG, HITL Pause/Resume, and Flow Architect`

### Task 4.2: Parallel Whole-Delta Security & Architecture Review + Remediation
- [ ] Dispatch 2 parallel independent `self` reviewers covering: (1) backend `flow/` DAG execution, durable HITL resume, SSRF/LLM security, and PoF rules; (2) frontend `@xyflow/react` bundling, React hook uniqueness, `plugin-dxos-ai`, and scripts.
- [ ] Remediate all P0/P1 findings and re-run affected tests before Wave 5.

---

## Wave 5 — Live Docker `2.2.50` Full-Stack Deploy, Playwright E2E, SBOM & Final Offline Gates

### Task 5.1: Repack, Deploy to Docker `2.2.50` & Verify Live Acceptance + Playwright E2E
- [ ] Run `pnpm -r build` and pack `@latticedx/plugin-dxos-studio@1.0.0` + `@latticedx/plugin-dxos-ai@1.0.0` tarballs.
- [ ] Install + `pm enable` + `yarn nocobase upgrade` + restart `nocobase` in `lattice-v100-e2e` (`http://localhost:13015`).
- [ ] Run idempotent showcase seeder **twice** (`createdRules: []`, `upgradedRules: []` on pass #2) and run ALL 4 live acceptance suites (`acceptance-headless-paas.mjs`, `acceptance-logistics-and-rbac.mjs`, `acceptance-dxos-ai-and-mcp.mjs`, `acceptance-broker-automation-builder.mjs`).
- [ ] Run Playwright Browser E2E on `/admin/settings/dxos-flow-studio`: inspect Infinite Canvas, Minimap, Node Palette, add/connect node, Auto-Layout, 3-tab Inspector + `{{` Variable Picker, `Test Node`, `Dry-Run Playback`, HITL Pause/Resume, **DX-OS Flow Architect** drawer (zero `"Copilot"` text), plus `/p/cmms`, capturing host-verified screenshots and confirming `0` HTTP 500, `0` `pageerror`, `0` post-login console errors.

### Task 5.2: Final SBOM, `CHANGELOG.md`, Release Tarball Check & Offline Gates
- [ ] Run `pnpm release:sbom` (updating `docs/sbom-cyclonedx.json` with `@xyflow/react@12.12.1` MIT + `@dagrejs/dagre@3.1.3` MIT), sync `docs/dependency-inventory.md` & `CHANGELOG.md`.
- [ ] Run full verification suite on final clean HEAD:
  - `pnpm check` (typecheck + Vitest + build)
  - Full `node --test` across `plugins/` and `scripts/tests/` (`Get-ChildItem -Recurse -Include "*.test.cjs","*.test.mjs"`)
  - `node scripts/eval-vietnamese-nl-agent.mjs --min-pass=95` (`80/80` = 100%)
  - `pnpm release:sbom -- --check`
  - `pnpm pof:check`
  - `node scripts/source-headers.mjs --check`
  - `pnpm audit --prod --audit-level=low`
  - `pnpm release:tarball --ref=HEAD` + non-git extracted `pnpm pof:check`
- [ ] Verify `git status --short` is completely empty and stop before `git push` / PR / merge / release.
