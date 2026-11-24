<!--
@file LatticeDX — Open Digital Enterprise Platform
@author CTU-OpenPaw
@copyright (C) 2026 CTU-OpenPaw
@license Apache-2.0
@see https://github.com/CTU-OpenPaw/lattice-dx
SPDX-License-Identifier: Apache-2.0
-->
# Thiết Kế Kiến Trúc Phiên Lớn: LatticeFlow v2 DAG Studio, Real LLM Flow Architect & PoF 50/50 (`v1.0.0`)

## 1. Mục tiêu, Động lực & Đối chiếu Phán quyết BTC OLP PMNM 2026

Phiên nâng cấp này thay thế hoàn toàn mô hình rule tuyến tính cố định `actionsJson[]` + bộ regex giả lập ("Copilot" cũ) + panel chật hẹp trong Tab 8 bằng **LatticeFlow v2** — nền tảng **DAG Automation Engine Tầng 1 tổng quát (domain-agnostic)** kết hợp **Full-Screen Infinite Canvas Studio**, **DX-OS Flow Architect dùng LLM thật** và đợt **làm sạch kho mã nguồn đạt 50/50 PoF** trước hạn nộp **17:00 ngày 06/12/2026** (chấm mã 07–09/12, chung kết 10/12).

Toàn bộ thiết kế bám sát 4 phán quyết trực tiếp của Hội đồng Giám khảo / BTC VFOSSA trong trao đổi chuẩn bị OLP 2026:
1. **Hơn nửa điểm số đến từ chuẩn & quy trình PMNM (`msg 1136–1137, 1186, 1287–1288`):** Tuân thủ tuyệt đối giấy phép OSI-approved trong kho mã, lịch sử commit rõ ràng, `CHANGELOG.md` đầy đủ, CycloneDX SBOM chuẩn xác, release `.tar.gz` tự build lại được, và sản phẩm demo chạy trực tiếp 10–15 phút không slide.
2. **Ranh giới OSI tuyệt đối trong kho Git (`msg 1362–1376`):**
   - Những gì **nhúng trong kho mã nguồn dự án** phải tuân thủ hoàn toàn giấy phép **OSI-approved** (100% Apache-2.0 / MIT / BSD / ISC / MPL-2.0).
   - Không giữ hoặc chỉnh sửa mã nền tảng có điều khoản ngoài OSI (`NocoBase License Agreement 2026-02-24` chứa Điều 4.2 & 5.4 hạn chế SaaS/PaaS); do đó **gỡ bỏ hoàn toàn submodule `upstream/nocobase` và `.gitmodules` khỏi kho Git**, chỉ giữ container `nocobase/nocobase:2.2.50@sha256:...` (và `n8n` tùy chọn) ở dạng dịch vụ runtime bên ngoài nạp vào lúc chạy (`msg 1371–1373, 1375`).
   - Dịch vụ LLM bên thứ ba (Gemini/OpenAI/Claude) hoặc local gateway (9Router/Ollama) kết nối qua API không bị tính vào giấy phép kho mã nguồn (`msg 1383–1386`).
3. **Phân tách 3 Tầng chuẩn mực (`msg 1393, 1400, 1423, 1424`):**
   - **Tầng 1 (LatticeFlow Core + Node Registry + Admin Flow Studio):** độc lập 100% với nghiệp vụ cụ thể — **nghiêm cấm hardcode** chuỗi lạnh, vắc-xin, MKT, hay CMMS vào engine, node hoặc Architect. Cung cấp Admin UI cấu hình hạ tầng (`msg 1393`), không cấp UI end-user.
   - **Tầng 2/3 (Declarative Solution Blueprints cắm rút):** mọi kịch bản nghiệp vụ đa ngành (Chuỗi lạnh/CMMS, Phê duyệt Mua sắm nhiều cấp HITL, Leo thang SLA, Báo cáo AI định kỳ, Đồng bộ Webhook đối tác) là các **Blueprint JSON/YAML khai báo độc lập** dành cho người kiến trúc giải pháp cắm rút lên Tầng 1.

---

## 2. Mục tiêu (Goals), Ngoài phạm vi (Non-Goals) & Điều tránh (Anti-Goals)

- **Goals:**
  - Đồ thị DAG tùy ý (`nodes[]` + `edges[]` + cổng `ports` đa nhánh), hỗ trợ Trigger sự kiện/ORM record/Cron/Inbound Webhook/Manual, Flow Control (`if`, `switch`, `parallel`, `merge`, `loop`, `delay`, `approval` HITL Pause/Resume bền vững, `subflow`), Data CRUD/Query, DMN Node, Safe Transform, **`ai.llm` / `ai.agent` Node**, Vault HTTP, Digital Twin, Notify, Emit Event.
  - Durable PostgreSQL execution với lưu trạng thái `input/output/durationMs/error` tới **từng node**, Pause/Resume (`SUSPENDED`) kiểu DBOS/Temporal, **Test This Node**, **Pin Mock Data**, **Dry-Run** và **Time-Travel Playback**.
  - Giao diện **Full-Screen Studio (`/admin/settings/dxos-flow-studio`)** dùng `@xyflow/react@12.12.1` (MIT) + `@dagrejs/dagre@3.1.3` (MIT), tối đa `<= 350 dòng/file`.
  - **DX-OS Flow Architect** gọi **`llmServices` thật** của NocoBase với Structured Graph Operations + **Validator & Tối đa 2 vòng Self-Healing**, kèm **Offline Deterministic Fallback** khi chưa cấu hình API key LLM.
  - Tương thích ngược 100% các rule `actionsJson[]` v1, endpoint `dxosAutomations:*` cũ, GitOps Bundle v3, `adminMcpToolsListed17 === 17`, `0` lỗi HTTP 500 / console error, và `50/50 PoF` xanh toàn bộ.
- **Non-Goals:** Không viết lại NocoBase runtime, không xóa `apps/api` (giữ lớp Headless Fastify + 152 Vitest suites), không kéo thêm cụm Temporal/Kafka/Cassandra ngoài PostgreSQL 16 + Valkey 8.1 đang có.
- **Anti-Goals:**
  - Không dựng canvas 4 khung tuyến tính cố định; không để regex giả lập AI khi đã có LLM; không dùng chữ `Copilot` cho bất kỳ module/UI mới nào của Wave 9+ (vẫn giữ nguyên tool cũ pre-Wave-9 `dxos_my_tasks_copilot` và `ai-copilot-tools.js` để không vỡ tương thích ngược).
  - Không tạo file monolith `> 400` dòng trong cây `flow/` mới; không dùng `eval`/`new Function`; không làm rò secret Vault hoặc phá vỡ `Powered by NocoBase` (Điều 5.2).

---

## 3. Các Phương án Đã Cân nhắc & Lý do Lựa chọn

| Phương án | Kiến trúc chính | Đánh đổi | Quyết định |
| :--- | :--- | :--- | :--- |
| **A. LatticeFlow v2 DAG Studio + `@xyflow/react` MIT + Real LLM Architect + PoF Hardening** | Xây mới module DAG Engine Tầng 1 thuần Apache-2.0 (`flow/`), UI toàn màn hình `@xyflow/react` MIT + `@dagrejs/dagre` MIT (giữ `react`/`react-dom`/`antd`/`@nocobase/client` external từ host), LLM Architect nối `llmServices` + Self-Repair, và gỡ submodule `upstream/nocobase`. | Khối lượng phát triển lớn hơn (chia 6 Wave rõ ràng), nhưng làm chủ 100% lõi tự động hóa OSI, UX ngang n8n/Dify/Sim Studio và giữ trọn ngữ cảnh RBAC/RLS/Tenant/DMN/Twin/AI của LatticeDX. | **CHỌN** |
| **B. Mở rộng cây dọc `@nocobase/plugin-workflow`** | Thêm custom trigger & instruction node vào Workflow plugin sẵn có của NocoBase. | Giao diện cây dọc cứng nhắc (không có infinite free-form canvas/playback/graph diff), một số node nâng cao bị tách bản Commercial. | Loại |
| **C. Nhúng ngoài Activepieces (MIT) / Kestra (Apache-2.0)** | Dựng thêm container orchestration độc lập thay cho lõi nội bộ. | Tách rời PG RLS 42 bảng, RBAC 7 vai trò `ldx_*`, Digital Twin HITL, DMN và 17 AI Tools; nặng hạ tầng demo 15 phút và giảm tính tự chủ lõi. | Loại |

---

## 4. Đặc tả Kiến trúc Chi tiết

### 4.1 Phần A — Làm sạch Nguồn Mở & PoF 50/50
1. **Gỡ submodule `upstream/nocobase` khỏi Git:** Chạy `git rm upstream/nocobase` (hoặc gỡ `.gitmodules` + entry submodule `160000` + dọn `.git/modules/upstream/nocobase`), giữ `upstream/` không tồn tại trong Git tree của bản nộp nguồn `latticedx-1.0.0-src.tar.gz`.
2. **Cập nhật bộ kiểm toán `scripts/verify-pof-readiness.mjs` & `scripts/tests/oss-pof-audit.test.mjs`:**
   - Kiểm tra `upstream-clean` xác nhận **không còn `.gitmodules` trỏ `upstream/nocobase`**, không có tệp nguồn upstream bị đóng gói hoặc track trong kho Git, thay thế khái niệm "dirty submodule" trước đây.
   - Giữ kiểm tra `spdx-headers`, `governance-files`, `plugin-isolation` (`sdkProvidedByHost: true`, `Apache-2.0`, Điều 5.2 NocoBase), `compose-digests` (`@sha256:`), `no-secrets`.
3. **Đồng bộ tài liệu & SBOM:** Cập nhật [`COPYRIGHT.txt`](../../../COPYRIGHT.txt), [`NOTICE`](../../../NOTICE), [`docs/nocobase-source-review.md`](../../nocobase-source-review.md), [`docs/third-party.md`](../../third-party.md), [`docs/oss-pof-compliance.md`](../../oss-pof-compliance.md), [`docs/dependency-inventory.md`](../../dependency-inventory.md), [`CHANGELOG.md`](../../../CHANGELOG.md) và [`docs/sbom-cyclonedx.json`](../../sbom-cyclonedx.json) (bổ sung `@xyflow/react@12.12.1` + `@dagrejs/dagre@3.1.3` + transitive MIT deps). Ghi rõ container `nocobase/nocobase:2.2.50` là host runtime ngoài kho và container `n8n` là **tích hợp tùy chọn bên ngoài (`optional`)**, không nằm trong lõi Automation LatticeDX.

### 4.2 Phần B — Mô hình Dữ liệu LatticeFlow v2 & Migration Đảo ngược
Tạo migration **`20261126000100-latticeflow-v2-dag-and-durable-runs.js`** (có `up()` và `down()` hoàn chỉnh, kiểm tra dialect PostgreSQL, bảo toàn PG RLS theo `organizationId`):
- **Bảng `latticeAutomationRules` (thêm cột tương thích ngược với rule v1):**
  - `schemaVersion` (`INTEGER DEFAULT 1`, giá trị `2` cho LatticeFlow v2)
  - `graphJson` (`JSONB NULL`): `{ version: 2, nodes: [], edges: [], viewport: { x, y, zoom }, settings: { errorPolicy, cooldownSec, maxDepth, timeoutMs } }`
  - `draftGraphJson` (`JSONB NULL`): bản nháp đang chỉnh trên Canvas chưa publish
  - `publishedVersion` (`INTEGER DEFAULT 1`)
  - `triggerIndexJson` (`JSONB NOT NULL DEFAULT '[]'`): danh mục trigger chuẩn hóa để match nhanh `event`, `record`, `schedule`, `webhook`
- **Bảng `latticeAutomationRuns` (thêm cột Durable Execution):**
  - `graphVersion` (`INTEGER DEFAULT 1`)
  - `nodeStatesJson` (`JSONB NOT NULL DEFAULT '{}'`), khóa theo `nodeId`: `{ status, input, output, error, startedAt, finishedAt, durationMs, branchTaken, attempt, pinned }`
  - `suspendedNodeId` (`VARCHAR(128) NULL`)
  - `resumeTokenHash` (`VARCHAR(128) NULL`): SHA-256 của resume token khi chờ Webhook/Delay/HITL
  - `resumeAt` (`TIMESTAMPTZ NULL`): thời điểm đánh thức cho `control.delay`
  - `approvalId` (`BIGINT NULL`): liên kết hàng chờ `latticeAiApprovalQueue` cho `control.approval`
  - `triggerPayloadJson` (`JSONB NULL`): lưu snapshot sự kiện kích hoạt để hỗ trợ Replay / Time-Travel Playback
  - Bổ sung index `(organizationId, status, resumeAt)` để quét các run `suspended` hiệu quả.

**Tương thích ngược v1 ↔ v2:** Hàm `v1RuleToGraphV2(rule)` tự chuyển bất kỳ rule `actionsJson[]` v1 nào (kể cả `filterJson`, `dmnTableKey`, `act.when`) sang DAG `nodes[]` + `edges[]` có `control.if` khi cần mở lên Canvas v2; và `graphV2SummaryToV1Compat(graph)` giữ thông tin tóm tắt cho `dxosAutomations:listRules` / GitOps Bundle v3.

### 4.3 Phần C — Kiến trúc Backend Mô-đun (`plugins/nocobase/plugin-dxos-studio/src/server/flow/`)
Mỗi tệp `<= 350 dòng`, không chứa logic nghiệp vụ hardcode:
1. **`schema.js`:** Định nghĩa Graph v2 IR, chuẩn hóa port (`in`, `main`, `true`, `false`, `case_N`, `default`, `item`, `done`, `approved`, `rejected`, `error`), chuyển đổi hai chiều v1↔v2 và YAML/JSON DSL export/import sạch.
2. **`validator.js`:**
   - Kiểm tra chu trình DAG bằng **Kahn's Topological Sort** (`400 FLOW_CYCLE_DETECTED`).
   - Giới hạn an toàn: tối đa **50 nodes/flow**, **100 iterations/loop**, `maxDepth <= 8`, chỉ cho phép đúng 1 node `trigger.*` gốc (hoặc tách nhánh từ trigger) với mọi cạnh trỏ tới `nodeId` & `handle` hợp lệ.
   - Ràng buộc bảo mật: kiểm tra `SYSTEM_PROTECTED_COLLECTIONS` + allowlist collection (gồm `latticeCustom*`), chặn trường voucher lõi bất biến, kiểm tra `hasUnsafeTemplateSyntax` tuyến tính `O(n)`, chặn `BLOCKED_PROTO_KEYS` (`__proto__`, `constructor`, `prototype`), và kiểm tra SSRF URL.
3. **`registry.js` + `nodes/` (Plug-and-Play Node Registry):**
   - `nodes/triggers.js`: `trigger.event` (CloudEvents Bus + filterJson), `trigger.record` (`create`/`update`/`delete` gắn hook `db.on('<collection>.afterCreate/afterUpdate/afterDestroy')`), `trigger.schedule` (Cron 5 trường kiểm tra hợp lệ, thực thi qua `setInterval` opt-in/manual tick an toàn), `trigger.webhook` (endpoint `POST /api/dxosAutomations:webhookIngress?orgId=...&ruleKey=...` xác thực HMAC-SHA256 / token vault), `trigger.manual`.
   - `nodes/control.js`: `control.if` (`true`/`false`), `control.switch` (N nhánh + `default`), `control.parallel` & `control.merge`, `control.loop` (For-Each giới hạn an toàn + `{{loop.item}}`, `{{loop.index}}`), `control.delay` (DBOS-style `SUSPENDED` với `resumeAt`), `control.approval` (HITL `SUSPENDED` tạo phiếu trong `latticeAiApprovalQueue` + nhánh `approved` / `rejected`), `control.subflow` (gọi flow con cùng org giữ `depth + 1 <= maxDepth`).
   - `nodes/data.js`: `data.query` (truy vấn có giới hạn & lọc `organizationId`), `data.create`, `data.update`.
   - `nodes/logic.js`: `logic.dmn` (gọi `dmn-engine.js` thành 1 node trong đồ thị), `logic.transform` (biến đổi JSON/công thức khai báo an toàn — không `eval`).
   - `nodes/ai.js`: `ai.llm` (gọi `llm-client.js` có kiểm soát schema JSON output, giới hạn token, che PII), `ai.agent` (chạy `trigger_ai_triage` / RAG context lookup).
   - `nodes/integrations.js`: `integration.http` (Connector Vault AES-256-GCM + SSRF + HMAC), `iot.twin_command`, `notify.send`, `event.emit`.
4. **`executor.js` & `durable-store.js`:**
   - Thực thi DAG theo thứ tự topo + điều hướng cạnh động (`activeEdges` theo branch quyết định từ `if`/`switch`/`approval`), hỗ trợ rẽ nhánh lỗi `error` handle hoặc `stopOnError`.
   - Lưu `nodeStatesJson` từng bước: `{ status: 'completed' | 'simulated' | 'skipped' | 'suspended' | 'failed', input, output, error, durationMs, branchTaken }`.
   - Hỗ trợ đầy đủ: `executeGraph` (live), `dryRunGraph` (`dryRun: true`, không ghi/bắn webhook thật), `testSingleNode` (chạy 1 node cô lập bằng `pinnedInputs` để xem ngay Output JSON), và `resumeSuspendedRun` (xác thực `organizationId`, `suspendedNodeId`, `approvalId` / `resumeToken` chống đánh tráo tenant hoặc resume trùng lặp).
5. **`llm-client.js`:** Đọc dịch vụ LLM đang bật trong `llmServices` (ưu tiên dịch vụ cấu hình trong DB/env `AGENT_API_KEY` + `AGENT_BASE_URL`), gọi endpoint OpenAI-compatible `/chat/completions` qua `fetch` có `AbortSignal.timeout`, lọc SSRF nghiêm ngặt (chỉ cho phép loopback/`host.docker.internal` nếu được khai báo tường minh trong bản ghi `llmServices` của quản trị viên), che PII trước khi gửi và tính fallback sạch nếu chưa có API key.
6. **`architect.js` (**DX-OS Flow Architect**):**
   - Nhận `{ mode: 'full' | 'node' | 'suggest' | 'fix_error', prompt, rule, graph, targetNodeId, runTrace, organizationId }`.
   - Thu thập ngữ cảnh động (`registry.getCatalog()`, collections & fields thật, DMN, connectors, `ldx_*` roles).
   - Khi có LLM khả dụng (`mode: 'llm'`): gọi LLM sinh danh sách **Graph Operations** (`create_graph`, `add_node`, `update_node`, `delete_node`, `connect_edge`, `insert_branch`, `fix_from_trace`), biên dịch xác định ra `draftGraph`, chạy `validator.js`; nếu validator phát hiện lỗi, gửi lại chính thông báo lỗi đó cho LLM tối đa **2 vòng tự sửa (self-healing)**.
   - Khi chạy offline / test không có API key (`mode: 'offline-fallback'`): dùng bộ tổng hợp Graph v2 tổng quát dựa trên Node Registry & từ khóa ngôn ngữ tự nhiên tiếng Việt/Anh (không hardcode nghiệp vụ riêng).
   - Trả về `{ modeUsed: 'llm' | 'offline-fallback', summary, graphDiff: { addedNodes, updatedNodes, removedNodes, addedEdges, removedEdges }, draftGraph, draftRule, sampleEvent, suggestions, dryRunPreview }`.
7. **`blueprints/*.json` (Tầng 2/3 Declarative Packs — ngoài lõi):**
   - 6 Blueprint JSON Graph v2 đa ngành tự động nạp khi cài pack / xem Thư viện mẫu:
     1. `coldchain-emergency.json` (IoT/Cold-Chain Emergency Response + DMN + HITL Twin + AI Triage + Connector)
     2. `mkt-quarantine.json` (WMS MKT Quarantine + Incident + Partner Sync)
     3. `sla-escalation.json` (SLA Switch Branching + Escalation)
     4. `procurement-hitl-approval.json` (`trigger.record` → `control.if` ngưỡng giá trị → `control.approval` HITL Giám đốc → `data.update` + `notify.send`)
     5. `scheduled-ai-digest.json` (`trigger.schedule` Cron → `data.query` → `ai.llm` tóm tắt → `notify.send`)
     6. `partner-webhook-sync.json` (`trigger.webhook` HMAC → `logic.transform` → `control.loop` từng item → `integration.http` + nhánh `error`)

### 4.4 Phần D — Giao diện Full-Screen LatticeFlow Studio (`plugins/nocobase/plugin-dxos-studio/src/client/flow/`)
1. **Đóng gói Client sạch (Host Externals + Bundled MIT Graph UI):**
   - Cài `@xyflow/react@12.12.1` (MIT) và `@dagrejs/dagre@3.1.3` (MIT) vào `plugins/nocobase/plugin-dxos-studio/package.json` (`devDependencies` — hoặc bundle trực tiếp bằng `esbuild@0.28.2`, giữ nguyên `sdkProvidedByHost: true` và **KHÔNG** bundle `react`, `react-dom`, `antd`, `@nocobase/client`).
   - Cập nhật `plugins/nocobase/plugin-dxos-studio/build.mjs` dùng `esbuild`:
     - External shim rõ ràng trong AMD factory: `@nocobase/client`, `react`, `react-dom`, `antd`.
     - Map `react/jsx-runtime` sang shim nội bộ gọi thẳng `React.createElement` từ instance React của host NocoBase để không bao giờ xảy ra lỗi `"Invalid hook call"` hay nhân đôi React 18.
     - Nhúng `@xyflow/react/dist/style.css` bằng helper idempotent gắn `<style id="dxos-xyflow-css">` vào `document.head` khi mở Canvas.
     - Vẫn xuất gọn vào `dist/client/index.js` và kiểm tra bằng `node --check`.
2. **Định tuyến & Khả năng mở rộng UI:**
   - Đăng ký route toàn màn hình trong Admin Settings: **`dxos-flow-studio`** (`/admin/settings/dxos-flow-studio`, tên **"DX-OS Flow Studio"**) trong `src/client/index.js`, với wrapper `height: calc(100vh - 110px)` gọn đẹp không cắt chữ ngang.
   - Trên Tab 8 (`Vault & Automation`) của `DX-OS Studio`: giữ gọn bảng danh sách Rule + nút **"Mở Full-Screen Flow Studio ↗"** + đầy đủ Vault Connectors và legacy `data-testid` để không gãy các test cũ.
3. **Các module UI tách nhỏ (`<= 350 dòng/file`):**
   - `flow-studio-app.js`: Thanh công cụ trên cùng (Chọn Flow, + Tạo mới, Thư viện 6 Blueprint đa ngành, Export/Import JSON/YAML, nút `Auto-Layout`, `Dry-Run`, `Publish`, mở Drawer `DX-OS Flow Architect`), quản lý undo/redo & trạng thái đồ thị.
   - `flow-canvas.js`: Render `@xyflow/react` (`Background`, `Controls`, `MiniMap`), node tùy biến hiển thị icon, loại node, trạng thái thực thi (`completed`, `simulated`, `suspended`, `failed`, `skipped`), thời gian `ms`, cổng nối màu theo loại (`true`, `false`, `case_N`, `approved`, `rejected`, `error`), nút `+` giữa cạnh để chèn nhanh node và layout tự động `@dagrejs/dagre`.
   - `node-palette.js`: Sidebar trái gom 5 nhóm Trigger / Control Flow / Data & Logic / AI / Integrations có ô tìm kiếm và nút bấm/kéo thả thêm node vào Canvas.
   - `node-inspector.js`: Drawer trượt bên phải chia 3 tab kiểu n8n (**Tham số Node** sinh từ Node Schema · **Input JSON / Pin Mock Data** · **Output JSON** + nút **Test Node này**), kèm **Variable Tree Picker** bật khi bấm `{ }` hoặc gõ `{{` hiển thị cây biến từ Trigger và mọi node tổ tiên.
   - `architect-drawer.js`: Drawer chat **DX-OS Flow Architect** ngay bên phải Canvas (tách/chuyển tab với Inspector), hiển thị badge nguồn suy luận (`LLM thật` vs `Offline Fallback`), danh sách các thao tác Diff (`+ Node`, `~ Sửa`, `→ Nối cạnh`), nút **"Tự sửa từ lỗi lần chạy gần nhất"** và nút **Áp dụng lên Canvas**.
   - `playback-bar.js`: Thanh playback lịch sử dưới đáy Canvas — chọn các Run gần đây, bấm tua từng bước làm sáng node/cạnh tương ứng, hiển thị nút **Approve / Reject** trực tiếp trên UI khi gặp Run đang **`suspended`** ở node `control.approval`.

### 4.5 Phần E — Tích hợp `@latticedx/plugin-dxos-ai` & Làm sạch Ngôn từ
- Giữ nguyên **17 MCP Tools** (`adminMcpToolsListed17 === 17`) bằng cách nâng cấp `dxos_configure_workflow` thêm `resumeAutomation` và hỗ trợ thao tác Graph v2 (`draftAutomation`, `patchAutomation`, `suggestAutomation`, `testAutomation`, `saveAutomation`, `listAutomations`, `runAutomation`) thông qua `flow/architect.js` & `dxosAutomations:*`.
- Xóa toàn bộ từ `"Copilot"` ở các phần Wave 9+ trong `ai-builder-tools.js`, `ai-nl-router.js`, `ai-schemas.js` (`dxos-architect` bio & prompt), `vietnamese-nl-eval.test.cjs`, `scripts/eval-vietnamese-nl-agent.mjs` (đổi category sang `automation-architect` và nâng lên **80+ case** bao phủ DAG rẽ nhánh, HITL approval, schedule Cron, webhook, `ai.llm` node, và từ chối leo thang quyền). Giữ nguyên tool cũ pre-Wave-9 `dxos_my_tasks_copilot` & `ai-copilot-tools.js`.

### 4.6 Phần F — Ràng buộc Bảo mật & Tuân thủ Bắt buộc
- **RBAC & PAT:** Mọi API sửa/dựng/chạy/duyệt Flow yêu cầu vai trò `ldx_admin` / `ldx_manager` / `root` và PAT scope phù hợp (`write` / `ai` / `iot`); riêng `webhookIngress` dùng HMAC-SHA256 + `webhookSecret` theo tenant, không mở cửa mù.
- **PG RLS & Cô lập Multi-Tenant:** Toàn bộ truy vấn, `resumeRun`, `approval`, `subflow`, `data.query/create/update` đều ép `organizationId` từ ngữ cảnh xác thực; cấm chéo tổ chức (`403` / `404`).
- **SSRF & Secret Safety:** Cả `integration.http` và `ai.llm` đi qua kiểm tra URL/SSRF; mật khẩu/token trong Vault không bao giờ trả ra UI, Architect prompt, Bundle v3 hay log trace; PII tiếng Việt được che trước khi gửi LLM ngoài hoặc ghi Run trace.
- **An toàn Biểu thức & Đồ thị:** Không `eval` / `new Function`, kiểm tra chu trình Kahn DAG, giới hạn depth `<= 8`, loop `<= 100`, regex tuyến tính `O(n)`, chặn prototype keys, giữ trọn **Điều 5.2 NocoBase**.
