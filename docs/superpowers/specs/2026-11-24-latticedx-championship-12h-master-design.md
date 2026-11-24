<!--
@file LatticeDX — Open Digital Enterprise Platform
@author CTU-OpenPaw
@copyright (C) 2026 CTU-OpenPaw
@license Apache-2.0
@see https://github.com/CTU-OpenPaw/lattice-dx
SPDX-License-Identifier: Apache-2.0
-->
# Thiết Kế Kiến Trúc Tổng Thể Chiến Dịch 12 Giờ — LatticeDX v1.0.0 OLP Championship Edition

- **Nhánh triển khai:** `feat/v1.0.0-olp-championship` (worktree `native-multi-portal-pof`, base `a21e176`)
- **Mục tiêu tối thượng:** Hoàn thiện 100% toàn bộ các phân hệ của **LatticeDX** (không cắt bỏ, không tính năng giả lập), biến nền tảng thành một **Enterprise App Builder Agent** đẳng cấp hàng đầu cho **OLP PMNM 2026** (50 PoF + 50 Chung kết: Chấm mã nguồn `07–09/12` + Demo Live 15 phút `10/12`).

---

## 1. Bốn Trụ Cột Hoàn Thiện (Zero Cuts · End-to-End Wiring)

### Trụ cột 0 (Trung tâm Xuyên suốt) — Enterprise App Builder Agent & Tri thức Thực
1. **Full-Stack Enterprise App Builder (`app-builder-orchestrator.js` + `ai-builder-tools.js`):**
   - Hỗ trợ đủ **10 Native v2 BlockModels** (`DxosWebGisBlockModel`, `DxosKanbanScheduleBlockModel` được mở vào `ALLOWED_BLOCK_MODELS`).
   - Mở rộng `dxos_extend_collection_schema` hỗ trợ trường quan hệ `belongsTo`, `json`, `enum`, tạo index an toàn + gắn `FORCE ROW LEVEL SECURITY` + phản chiếu `/api/dxos:openapi`.
   - Cho phép Agent cấu hình **Bảng Quyết định DMN (`dxosDmn`)** và **quản trị 2 chiều Stock n8n Public REST API v1** (tạo/cập nhật/bật/tắt/kiểm tra/retry execution).
   - **Closed-Loop Build → Deterministic Verifier → Self-Healing (tối đa 2 vòng tự sửa):** trước khi dựng sẽ tự chụp `Snapshot` rollback; sau khi dựng chạy kiểm chứng thật (PG RLS `relrowsecurity=true`, OpenAPI reflection, schema/route UI hợp lệ, negative RBAC không leo thang, DMN & LatticeFlow dry-run PASS, n8n workflow active) và tự vá nếu phát hiện sai lệch.
2. **AI Thật 100% & Đo lường Token Thực:**
   - Sửa lỗi phân loại timeout `15s` ở `aiAssist` (`LLM_TIMEOUT` thay vì `AUTOMATION_AI_REFUSED`) và sửa `portal-agent-launcher.js` truyền đủ `nodeSummary`.
   - Nối node `ai.agent` (`flow/nodes/ai.js`) và `proactive-triage.js` gọi `callLlmJson` thật với JSON Schema kiểm soát (giữ fallback deterministic khi offline gắn cờ `mode`).
   - Lưu **token usage thật từ provider LLM** (`promptTokens`, `completionTokens`, `totalTokens`, `tokenSource`) vào `latticeAiAuditLogs` & `latticeAiQuotaUsage`.
3. **Hoàn thiện `plugin-dxos-para`:**
   - Mở khóa dimension `pgvector` linh hoạt (`DX_EMBEDDING_DIM`), gom nhóm batch embedding (tối đa 16 chunk/lượt), xử lý lỗi `afterCommit` có log & retry metadata, cải thiện trích xuất PDF tiếng Việt (`ToUnicode` CMap), và hoàn thiện UI client Quản trị Tri thức & OCR Autofill.

### Trụ cột 1 — Lõi An Ninh, PG RLS Thực, `prod.yml` Đầy Đủ, OTel + PITR, Workflow & Governance
1. **PostgreSQL RLS Fail-Closed & Role Phi-Superuser:**
   - Nâng [pg-rls.js](plugins/nocobase/plugin-lattice-foundation/src/server/pg-rls.js) lên `FORCE ROW LEVEL SECURITY` + fail-closed predicate (chỉ mở khi khớp `app.current_org`, `*`, hoặc `app.rls_bypass = 'on'` đặt trong scope hệ thống).
   - Khởi tạo role phi-superuser `nocobase_app` (`NOSUPERUSER NOBYPASSRLS`) trong `prod.yml` để NocoBase chạy migrations hợp lệ nhưng vẫn bị PostgreSQL cưỡng chế RLS.
   - Bịt hở tenant trên `charts:queryData` và 7 bảng `latticeRecordChatter`, `latticeContextOutbox`, `latticeIntegrationInbox`, `latticeAgentProposals`, `latticeAiAuditLogs`, `latticeAiQuotaUsage`, `latticeUiSnapshots`.
2. **OpenTelemetry Thật & PostgreSQL PITR Thật:**
   - Xây [otel-exporter.js](plugins/nocobase/plugin-lattice-foundation/src/server/otel-exporter.js) (Apache-2.0 thuần Node.js, truyền W3C `traceparent` & OTLP/HTTP JSON tới `otel-collector:4318`, gắn cả `apps/api` và `apps/file-scanner`).
   - Nối [pitr.conf](infra/config/postgres/pitr.conf) & [pitr-archive.sh](infra/config/postgres/pitr-archive.sh) + volume `postgres-wal-archive` thật trong `prod.yml`, kiểm chứng WAL trong `scripts/stack-recovery.mjs`.
3. **Sửa Hoàn Chỉnh `prod.yml`, SSO, IIoT, APISIX, Caddy, Node-RED & `action-bridge`:**
   - Sửa `deploymentConfig` ở `policy.js` cho phép `DX_NATIVE_AUTH_INTERNAL_ISSUER` đi cùng `https://` public issuer và đọc đúng `DX_NATIVE_AUTH_SESSION_REDIS_URL` (Valkey `8.1`).
   - Kết nối `nocobase ↔ mosquitto ↔ nodered`, bật `credentialSecret` & `adminAuth` cho Node-RED theo biến môi trường, mở `Caddyfile` cho `{$N8N_DOMAIN}`, đồng bộ route APISIX công khai (`enterpriseAuth:*`, `publicTrack`, `verifySignature`), và giữ `action-bridge` khởi động an toàn khi thiếu env bridge.
4. **Hoàn Thiện Workflow Engine, Delegations & PAT Scope & CI:**
   - Thêm `'latticeflow.approval'` vào `SUPPORTED_HITL_TOOLS` của `plugin-dxos-ai` để Duyệt/Từ chối tự `resumeRun`.
   - Ghim `graphSnapshotJson` & `triggerPayloadJson` khi `suspend`/`replay`, cưỡng chế `node.timeoutMs`, chạy Cron thật (`trigger.schedule`) + Delay/Approval-expiry ticker mặc định `15000ms` (tắt ở unit test bằng `0`).
   - Cưỡng chế `latticeDelegations` khi duyệt (`ai-hitl`, `voucher-lifecycle`, `flow resume`), siết PAT scope mặc định `write` cho mutation, và bổ sung đầy đủ PoF/SBOM/SPDX/NL-eval/audit vào `.github/workflows/ci.yml` + `codeql.yml`.

### Trụ cột 2 — Stock n8n Enterprise Hub, OAuth2 Vault & Usecase Doanh Nghiệp Tầm Cỡ
1. **Stock n8n Public REST API v1 Client & OAuth2 PKCE + Single-Flight Refresh:**
   - `connector-vault.js`: bổ sung SSRF allowlist an toàn cho host nội bộ (`n8n`, `orion-ld`, `nodered`), OAuth2 Authorization Code + PKCE (`S256`) và cơ chế Single-Flight Token Refresh (refresh trước hạn 180s).
   - `n8n-api-client.js`: giao tiếp `X-N8N-API-KEY` từ Vault quản lý workflows, executions, retry và đồng bộ credentials sang Stock `n8nio/n8n:2.48.1` (không chỉnh sửa mã nguồn n8n, tuân thủ SUL).
2. **Giao diện "Connected Apps & n8n" 1 Cửa:**
   - Hợp nhất toàn bộ cấu hình Connector App ngoài + Stock n8n Live Monitors vào tab `Workflow -> Connectors & n8n` (gỡ trùng ở Studio Tab 8, chỉ giữ thẻ tóm tắt + nút mở nhanh).
   - Hỗ trợ thẻ kết nối thật: **Telegram Bot**, **Email SMTP / Gmail OAuth2**, **Google Sheets OAuth2**, **Slack / Discord / Teams**, **GitHub**, **RustFS S3**, **Partner Webhook** + Live Execution Table + `Retry` + link mở n8n Editor tab mới.
3. **Usecase Tầm Cỡ ("Cold-Chain Incident-to-Partner Settlement"):**
   - Pack `coldchain-partner-settlement` + workflow `dxos-enterprise-compliance-orchestrator.json` **22+ nodes** (`retryOnFail: true`, `saveDataErrorExecution: "all"`, `Error Trigger`), gọi song song PKI Ledger, Orion-LD, Node-RED và App ngoài thật (Telegram, Email SMTP, Google Sheets / Partner Webhook, Slack/GitHub) + workflow inbound 2 chiều `dxos-external-app-inbound-callback.json` + workflow bắt lỗi `dxos-enterprise-error-handler.json`.

### Trụ cột 3 — WebGIS MapLibre, ISO QR SVG, Public B2B `/track/:code`, Visual DMN, Portals & Mobile PWA
1. **MapLibre GL JS WebGIS & Desktop Twin Control (`plugin-dxos-blocks`):**
   - Dùng `maplibre-gl` (`BSD-3-Clause` OSI) đóng gói qua `esbuild` giữ `sdkProvidedByHost: true` và `client-v2` cô lập.
   - GeoJSON `FeatureCollection` + `cluster: true` + bỏ giới hạn 6 tài sản + fallback vector WGS84 khi mất mạng + Drawer điều khiển Digital Twin trực tiếp trên desktop (vượt `|delta| > 2.0°C` đẩy vào HITL).
2. **ISO QR SVG Thật, Print Sạch & Trang Public `/track/:code`:**
   - Mã QR SVG thuần JS chuẩn ISO/IEC 18004 (`qr-svg.js`) + ảnh chữ ký ePOD trong `wms-engine.js`, sửa `<iframe sandbox="">` ở `chatter-panel.js` để in chứng từ sạch.
   - Dựng tuyến công khai `/v/track/:code` (và `/track/:code`) không PII nối API `dxosWms:publicTrack` + xác minh chữ ký Ed25519/Merkle sống.
3. **Visual DMN Decision Table Studio, Operational WMS `/p/logistics`, Topbar SSE Bell & Multi-Tenant Un-hardcode:**
   - Visual grid DMN (`dmn-visual-editor.js`) + Live Test Simulator.
   - Đưa WMS FEFO Workbench & Bulk Import 2 pha ra `/p/logistics` cho `ldx_warehouse`/`ldx_manager`.
   - Đưa Notification Bell SSE lên Topbar chuẩn (cả `/v/mobile`), sửa `meta.count` Creative Studio, cột `unscheduled` Kanban, React Hook `command-palette.js` + `?paraDocId=`, thống nhất sự kiện `epod.captured`, bỏ hardcode `'native-ui-lab'` & lọc `startsWith('ldx_')`, ẩn `/lattice/*` khỏi menu chính (giữ nguyên `apps/api`).
4. **Mobile Field PWA (`/v/mobile`):**
   - Nâng hàng đợi ngoại tuyến lên **IndexedDB** (`mobile-offline-db.js`), hỗ trợ chụp ảnh camera đính kèm ePOD, quét QR đa nền tảng (`BarcodeDetector` + camera fallback), Outbox Inspector, và xử lý sạch xung đột route.

---

## 2. Nguyên tắc Bất biến (Global Constraints)
- Thực thi 100% trong worktree `native-multi-portal-pof` (`feat/v1.0.0-olp-championship`), tuyệt đối không chạm `e:\pmnm2026`.
- Không sửa mã nguồn `n8nio/n8n:2.48.1` và `nocobase/nocobase:2.2.50`; mọi code mới 100% Apache-2.0 (`SPDX-License-Identifier: Apache-2.0`); dependency mới chỉ cài Pure-OSI (`MIT`/`BSD-3-Clause`/`Apache-2.0`) trong `devDependencies` + cập nhật SBOM CycloneDX.
- Migration mới đánh số từ `20261127000100+`, hỗ trợ `up()`/`down()` và gắn PG RLS.
- Bảo toàn Điều 5.2 NocoBase (`Powered by NocoBase`, `v2.2.50`) và giữ `0` chuỗi `copilot` ngoài `docs/superpowers/*`.
- Dừng trước `git push`, PR, hoặc merge để bàn giao bản kiểm chứng sạch vào buổi sáng.
