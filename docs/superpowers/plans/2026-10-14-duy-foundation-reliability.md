# Duy foundation reliability — kế hoạch ngày 14/10/2026

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Checkboxes track repository implementation only, never Notion completion.

**Goal:** Củng cố API record/task độc lập: gửi lặp an toàn, cùng hợp đồng REST/action, đúng quyền và có bằng chứng PostgreSQL thật.

**Architecture:** Một cơ chế thực thi lệnh tạo dùng chung ở backend, với kết quả chống lặp lưu PostgreSQL cùng giao dịch với bản ghi/task. REST và action giữ envelope/status hiện tại, dùng cùng parser và cùng logical operation. Các API workflow hiện có không bị thay đổi.

**Tech Stack:** TypeScript, Fastify, pg/PostgreSQL, Vitest, JWT Keycloak và APISIX; không thêm dependency.

## Global Constraints

- Chỉ phần Duy: API, storage, identity authorization, backend contracts và tests. Không sửa NocoBase plugin/UI, n8n, broker hoặc agent của đồng đội.
- Một branch `codex/foundation-create-reliability` từ main mới nhất, một PR vào main; chưa tự merge. Không tick Notion, tạo release hoặc sửa license/upstream.
- Giữ API client cũ: Idempotency-Key optional; thiếu key vẫn tạo như trước, không hứa chống trùng cho request không có key. Key được cung cấp phải match `^[A-Za-z0-9._:-]{1,128}$`.
- Scope key = signed organization + signed subject + logical operation(records.create/tasks.create) + key. Cùng key giữa hai operation không xung đột. REST và action của cùng operation chia sẻ kết quả tạo, dù response envelope khác nhau.
- Fingerprint từ input đã chuẩn hóa, thứ tự key ổn định; authority tenant/actor không nhận từ body. Cùng key khác nội dung trả409. Không kiểm tra chống trùng theo tiêu đề: hai yêu cầu có chủ ý giống nhau vẫn hợp lệ với key khác.
- Kiểm tra signed identity, role và quyền tham chiếu trước replay. Replay không né việc người nhận bị disable hay quyền liên kết hồ sơ đã mất. Ghi kết quả và entity atomic; lỗi không giữ key thành công.
- Kết quả replay là snapshot kết quả tạo đã nhận, không phải trạng thái mới nhất của task. API đọc detail trả trạng thái hiện tại. Không TTL/cleanup tự động ở đợt đầu; ghi rõ tăng trưởng bảng kết quả.
- Preserve CV.pdf, a.png, output/ và mọi thay đổi đồng đội. Không factory reset, xóa volume hoặc restore đè database đang dùng.

## Checklist trọn ngày

### 1. Baseline và hợp đồng

Files: apps/api/src/{app.ts,actions.ts,foundation.ts,database.ts,foundation-database.ts,records.ts}, packages/contracts/src/actions.ts.

- [ ] Fetch main, kiểm tra branch và thay đổi local; tạo đúng một branch khi bắt đầu implementation.
- [ ] Chạy `pnpm check`; ghi baseline, không khẳng định trạng thái ngày trước là kết quả hôm nay.
- [ ] Chốt optional-key, scope logical operation và replay snapshot; kiểm tra REST/action response giữ tương thích.
- [ ] Ghi spec nhỏ cho giao dịch và API trước code; chỉ thêm helper cần thiết, không dựng framework commands mới.

### 2. Thống nhất đầu vào REST/action

Files: packages/contracts/src/actions.ts, apps/api/src/{app.ts,foundation.ts,actions.test.ts,foundation.test.ts,records.test.ts}.

- [ ] Viết RED cho body array/null, field lạ, authority override, title trống/quá dài, assignee sai, recordId sai và header key sai.
- [ ] REST dùng parseRecordCreateInput/parseTaskCreateInput đang có; thống nhất Unicode code-point length và trim title với action. Assignee là opaque ID, không tự trim/thay đổi.
- [ ] Giữ HTTP record/task create201, action run200; lỗi malformed400, identity401, permission403, hidden resource404, key conflict409.
- [ ] Rerun targeted tests, cập nhật tài liệu nếu client cũ gửi field bị bỏ qua trước đây giờ phải loại bỏ.

### 3. Giao dịch chống tạo trùng

Files: create apps/api/src/create-command.ts, create-command.test.ts; modify database.ts, foundation-database.ts, repository interfaces và bootstrap wiring khi cần.

- [ ] RED cho cùng key/input trả cùng entity ID, khác input409, actor/org khác tách biệt, operation khác tách biệt và không-key vẫn có hành vi cũ.
- [ ] Lưu command results với unique(organization_id,actor_id,operation,key), fingerprint và kết quả tạo; mọi thao tác thành công cùng PoolClient transaction.
- [ ] Khóa/serialize theo command identity trước check result; dùng một connection, không gọi pool.connect bên trong transaction hiện có. Lock collision chỉ serialize thêm, không chia sẻ quyền/kết quả.
- [ ] Đưa hàm tạo record/task về routine có thể dùng cùng client; kiểm tra lại assignee/org và ownership link trong write transaction để tránh race với directory/reference changes.
- [ ] Lỗi sau insert entity nhưng trước persist receipt phải rollback cả hai. Không lưu token/body lỗi hoặc metadata bí mật vào log.
- [ ] GREEN targeted tests và typecheck trước commit.

### 4. Nối bốn đường API

Files: app.ts, foundation.ts, actions.ts, create-command.ts; tests liên quan.

- [ ] POST records, POST tasks và hai action create chuyển optional key đến cùng cơ chế tạo.
- [ ] Authorization vẫn chạy trên từng lần gọi trước replay. Khi receipt có sẵn, vẫn áp dụng quyền liên kết/assignee theo hợp đồng trên.
- [ ] Kiểm tra REST→action replay và action→REST replay cùng entity, mỗi route vẫn trả envelope đúng.
- [ ] Không thay workflow command/step execution; các helper create mới không làm acquire connection lồng nhau trong workflow.

### 5. PostgreSQL acceptance, concurrency và persistence

Files: create scripts/smoke-create-reliability.mjs; package.json `test:create-reliability`.

- [ ] RED smoke trên image cũ: cùng key hiện tạo thêm entity; fixture chỉ dùng ID riêng.
- [ ] Test qua Keycloak/Gateway/API: first/replay/conflict, permissions, invalid recipient, authority payload, cross-REST/action và no-key compatibility.
- [ ] Private schema UUID: 5 request cùng key chỉ một entity/receipt, khác input chỉ một payload thắng; hai actors/orgs không đọc receipt nhau; lỗi write không để bản ghi/key dở dang.
- [ ] Kiểm tra pool max1; đóng/mở pool mới rồi replay đúng ID. Snapshot receipt không thay theo quyết định task sau đó; detail vẫn trả trạng thái mới.
- [ ] Kiểm tra assignee disable và quyền record link sau lần tạo khiến replay bị chặn theo chính sách, không thêm entity.
- [ ] Chỉ drop schema fixture có tên UUID xác minh; giữ dữ liệu REST demo. Restart API/Gateway khi rebuild cần thiết, không reset DB.

### 6. Hồi quy các phase hiện có

- [ ] `pnpm check` gồm typecheck, toàn bộ tests và build.
- [ ] `pnpm test:actions`, `pnpm test:foundation`, `pnpm test:workflow-blocks`, `pnpm test:workflow-completion` và `pnpm test:workflow-bundles` khi code ảnh hưởng đường chung.
- [ ] Giữ Gateway rate limit; cách các smoke batch theo cửa sổ 60 giây khi cần, không tăng limit để che429.
- [ ] Mọi failure phải phân biệt code/runtime/container/network; sửa trong phạm vi task rồi rerun checks liên quan.

### 7. Bàn giao và tài liệu

Files: create docs/create-reliability.md; update docs/action-runtime.md, docs/phase-one-handoff.md, README.md, docs/verification.md.

- [ ] Mẫu request Idempotency-Key, first/replay/conflict; scope, optional-key và snapshot được giải thích rõ.
- [ ] Hướng dẫn Hưng/Nhi: giữ một key cho cùng thao tác khi retry, sinh key mới cho thao tác mới; không tự retry POST không-key. Chỉ tài liệu, chưa sửa plugin/adapter của họ.
- [ ] Ghi actual test output/count, fixture IDs và giới hạn; sửa ghi chú cũ chỉ nơi đã lỗi thời, không rewrite toàn bộ kiến trúc.

### 8. Review, PR và kết thúc

- [ ] Review độc lập transaction/authorization/concurrency và tương thích; sửa lỗi quan trọng, rerun covering checks.
- [ ] `git diff --check`, kiểm tra tracked diff và bảo toàn user artifacts.
- [ ] Push branch, tạo/attach một PR vào main, inspect CI; chưa tự merge.
- [ ] Báo cáo việc đã xong, giới hạn còn lại và API bàn giao. Sau khi Duy cho merge, sync main và xóa branch đã merge như quy ước mới.

## Tiêu chí kết thúc ngày

Người dùng/connector gửi lại cùng yêu cầu có key không tạo thêm record/task; request khác không dùng nhầm receipt; lỗi không ghi dở; REST/action có cùng quy tắc đầu vào và quyền; key/result tồn tại sau kết nối lại; workflow cũ không regress; có một PR được kiểm thử và tài liệu nối API.

## Việc chưa đưa vào đợt này

Phân cấp phòng ban/trưởng phòng, ủy quyền, chuyển assignee, auto workflow chaining, module registry mới, UI Studio và cài external adapters. Backup/restore cần một kế hoạch riêng với target isolated và nghiệm thu phục hồi; không ghép vào PR chống trùng. Khi checklist chính xong sớm, rà runbook để lên kế hoạch backup cho đợt sau, chưa restore vào DB đang sử dụng.
