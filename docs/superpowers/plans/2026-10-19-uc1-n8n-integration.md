# UC1 Nhi Integration Implementation Plan

Ngày mở: 19/10/2026. Người phụ trách: Thạch Thanh Nhi.
Phạm vi: n8n, tích hợp UC1, đồng bộ bàn giao, Asset và truy vết.
**Goal:** Triển khai và nghiệm thu sáu task UC1 của Nhi; lưu bằng chứng thực tế và lịch sử commit khi ghép vào phiên bản của team.

**Architecture:** n8n gọi API UC1 qua integration service; event bàn giao được lưu durable inbox trước khi worker đồng bộ broker và hệ thống mẫu. Backend nghiệp vụ giữ quyền quyết định trạng thái giao dịch.

**Tech Stack:** Node.js 24, pnpm 10.23.0, n8n, Fastify, PostgreSQL, Orion-LD, Docker Compose và Vitest.

Hướng dẫn chạy và test case: [UC1 integration](../../uc1-nhi-integration.md).

## 1. Quy tắc ghi nhận tiến độ

- Sáu task dưới đây đi theo thứ tự nghiệm thu; một task có thể dùng chung module với task sau.
- Code đã chuẩn bị trên snapshot main `b13109c`; chưa xác nhận đã áp dụng vào checkout Windows của Nhi.
- Chỉ đánh dấu hoàn thành khi có code, kiểm tra phù hợp và bằng chứng chạy thật trong môi trường nghiệm thu. Unit test không thay thế kết nối thật.
- Mỗi thay đổi có ý nghĩa được commit sau khi review/check phù hợp. Không tạo commit rỗng, chia commit giả hoặc sửa ngày/tác giả để tăng số lượng commit.
- Cập nhật bằng chứng bằng ID, HTTP status và kết quả đã lọc secret. Không đưa JWT, credential, bản dump database hay payload cá nhân vào Git.
- Khi gặp lỗi: ghi hiện tượng, bước tái hiện, expected/actual, nguyên nhân nếu đã xác định, commit sửa và test chạy lại.

## 2. Checkpoint trước khi sửa code

- [X]  Xác nhận đúng repository, origin và branch hiện tại.
- [X]  Không còn merge dang dở; working tree được kiểm tra trước khi chuyển nhánh.
- [X]  Xác nhận nhánh tích hợp phiên bản thực tế với team; tên dự kiến `integration/v0.1.0`. Nếu đã có `ver0.1.0`, dùng đúng nhánh đó, không tạo thêm tên tương đương.
- [X]  Có nhánh công việc `feat/uc1-n8n-handover` dựa trên main/team baseline đã thống nhất.
- [X]  Backup PostgreSQL và MongoDB có sẵn, đọc được; không reset/xóa volume để xử lý lỗi môi trường.
- [X]  Ghi baseline SHA, phiên bản Docker/Node và trạng thái các service.

Lệnh kiểm tra đầu tiên, chưa thay đổi branch hoặc dữ liệu:

```powershell
cd E:\Project\LatticeDX
git status
git branch --show-current
git log -1 --oneline
git remote -v
git branch -a
```

Chỉ chuyển/tạo nhánh và áp dụng bản vá sau khi xem kết quả này. Nếu working tree có thay đổi, phân loại và giữ lại trước; không dùng reset --hard, clean -fd hoặc tự hủy merge.


| Thông tin baseline        | Giá trị nghiệm thu     |
| ---------------------------- | --------------------------- |
| Main SHA của máy Nhi     | Checked                   |
| Feature branch             | Checked                   |
| Release/integration branch | Checked                   |
| Docker engine              | Checked                   |
| API / Gateway / Keycloak   | Checked                   |
| n8n import và publish     | Checked                   |
| Orion-LD với volume cũ   | Errors in some situations |

## 3. Sáu task nghiệm thu

### Task 1 — Webhook nhận đơn, kiểm schema và gọi API UC1

- [X]  Review contract intake; procurement v1 hiện chỉ nhận title và input rỗng, metadata nguồn lưu riêng.
- [X]  Áp dụng/review integration service, cấu hình local và workflow `uc1-intake.json`.
- [X]  Tạo credential tại n8n; publish workflow; không ghi secret vào export.
- [X]  Gửi payload hợp lệ: HTTP 201, đúng procurement draft, lấy được runId.
- [X]  Payload sai bị trả 400 trước khi gọi API; token nguồn sai bị từ chối.
- [X]  Ghi bằng chứng và commit thay đổi đã kiểm tra.

Bằng chứng: TC-I01/I02/I03 trong hướng dẫn; runId, sourceRecordId, thời gian và commit SHA.

### Task 2 — Idempotency không tạo hồ sơ trùng

- [X]  Gửi lại cùng key và payload: cùng runId.
- [X]  Cùng sourceSystem/sourceRecordId nhưng key mới: vẫn cùng runId.
- [X]  Cùng key/source record nhưng payload khác: HTTP 409.
- [X]  Kiểm tra mất phản hồi sau khi backend đã tạo: gửi lại phục hồi cùng hồ sơ.
- [X]  Kiểm tra actor/quyền hiện tại; không dùng receipt cũ để vượt quyền.
- [X]  Ghi bằng chứng và commit thay đổi phát sinh.

Bằng chứng: TC-I04/I05/I06, PostgreSQL acceptance; khi mô phỏng timeout ghi rõ downstream simulated.

### Task 3 — Đồng bộ bàn giao ra hệ thống mẫu

- [X]  Review workflow `uc1-handover.json`, durable inbox và sample endpoint.
- [X]  Event hợp lệ được lưu trước khi trả 202; đọc được pending/processing/succeeded/failed.
- [X]  Kiểm tra log attempt và lastError đã lọc secret.
- [X]  Tái hiện lỗi downstream, backoff có giới hạn và failed sau tối đa 5 attempt.
- [X]  Retry thủ công giữ eventId/payload; retry cùng decision key không reset ngân sách nhiều lần.
- [X]  Sample sink nhận payload gốc đúng một logical record cho eventId.
- [X]  Ghi bằng chứng và commit thay đổi phát sinh.

202 xác nhận nhận bền vững, không xác nhận hai đích đã đồng bộ. Code hiện ghi broker rồi gọi sample; nghiệm thu live task này phụ thuộc broker của task 5. Khi broker còn lỗi chỉ ghi kết quả unit/SQL, để checklist live mở.

### Task 4 — Mapping bàn giao → Asset

- [ ]  Chốt với Duy ý nghĩa business assetId, departmentId và locationId trong envelope.
- [X]  Kiểm tra business ID/full URN đều dẫn đến đúng một URN, không ghép URN hai lần.
- [X]  Kiểm tenant, type, businessId của Department và Location đích.
- [X]  Chỉ map ngữ cảnh cần dùng; không đẩy dữ liệu kế toán/giao dịch lên broker.
- [X]  Giữ occurredAt gốc trong inbox; ghi rõ observedAt broker dùng độ phân giải giây.
- [X]  Ghi bằng chứng và commit thay đổi phát sinh.

### Task 5 — Job bàn giao → connector broker, upsert/retry

- [X]  Khôi phục Orion-LD và kiểm /version; xác nhận Department/Location fixture đúng tenant.
- [X]  Chạy controlled handover smoke, phân biệt với event thật từ backend outbox.
- [X]  Kiểm create, update, create race, timeout sau ghi, replay và sample-failure retry.
- [X]  Kiểm event cũ/equal-time conflict không ghi đè trạng thái mới.
- [X]  Cùng event chạy lại: không tăng số Asset cho cùng URN.
- [ ]  Thống nhất routing outbox chung với Duy trước khi bật worker backend.
- [X]  Thực hiện bàn giao thật qua UI/API; theo dõi backend job → n8n → inbox → broker/sample.
- [X]  Restart broker nguyên volume, đọc lại Asset, replay vẫn đúng một Asset.
- [X]  Ghi bằng chứng và commit sửa lỗi/regression nếu có.

### Task 6 — Dữ liệu nguồn, thời điểm và trace

- [X]  Đối chiếu sourceSystem/sourceRecordId → intake receipt → backend runId.
- [X]  Đối chiếu eventId/runId/version/occurredAt → assetURN → sample receipt.
- [X]  Có receivedAt/updatedAt, trạng thái và attempt history để điều tra lỗi.
- [X]  Retry/restart không mất payload nguồn và không thay danh tính Asset.
- [X]  Kiểm quyền đọc trace; source token không có quyền operator/retry.
- [X]  Lưu bằng chứng đã lọc secret và cập nhật hướng dẫn người dùng/dev.

## 4. Nhật ký bằng chứng

Thêm một dòng sau mỗi lần chạy quan trọng; FAIL cũng phải lưu để theo dõi nguyên nhân.


| Ngày giờ + timezone | Task / test case      | Môi trường + SHA | Expected  | Actual / PASS-FAIL | ID / log đã lọc secret | Commit sửa hoặc follow-up |
| ----------------------- | ----------------------- | --------------------- | ----------- | -------------------- | --------------------------- | ----------------------------- |
| Chưa ghi             | Chưa chạy local UC1 | Chưa ghi           | Chưa ghi | Chưa nghiệm thu  | Không có                | Không có                  |

Bằng chứng chuẩn bị code trong môi trường assistant: pnpm check đạt 623 test, 1 skipped; plugin suite 67 test đạt; kiểm SQL bằng PostgreSQL WASM đạt các case đã mô tả. Đây không phải kết quả Docker PostgreSQL/n8n/Orion live của Nhi. Không chuyển các kết quả này thành PASS end-to-end.

## 5. Commit và review trong cuộc thi

Luồng mong muốn: feature Nhi → nhánh phiên bản của team → main.
Giữ nguyên commit thực và tác giả; dùng PR để ghi phạm vi, kết quả test và người review. Nếu cần giữ SHA từng commit trên main, team chọn merge commit thay vì squash/rebase merge. Chính sách branch protection của team vẫn áp dụng.

Mốc commit gợi ý theo thay đổi thực tế:

1. `docs(uc1): add process checklist and acceptance plan`.
2. `feat(uc1): add integration service and durable intake foundation` — có thể chứa hạ tầng dùng chung cho handover, mô tả đúng phạm vi.
3. `feat(n8n): add validated UC1 intake workflow` — kèm kiểm chứng idempotency thích hợp.
4. `feat(uc1): add handover workflow and broker sync` — nếu chưa nằm trong commit nền; không giả tạo lại một thay đổi đã commit.
5. `test(uc1): cover replay retry and handover trace` — test và evidence thực tế.
6. `docs(uc1): record local acceptance and operator instructions`.

Không bắt buộc sáu task = sáu commit. Bản vá hiện chứa code dùng chung; nếu chọn áp dụng toàn bộ một lần, review/stage theo đơn vị có nghĩa và kiểm tra từng commit. Không chia file tùy tiện khiến commit mất dependency hoặc không chạy được.

Trước mỗi commit: `git diff --check`, xem `git diff --cached --stat` và diff nội dung được stage, không git add . khi chưa review. Trước PR cuối: pnpm check trên Node 24/pnpm 10.23.0; theo CONTRIBUTING chạy Compose config và pnpm test:infra khi sửa deployment.

## 6. Merge phiên bản rồi main — chỉ thực hiện sau nghiệm thu

Các lệnh dưới là kế hoạch; không chạy ngay khi đang xử lý task 1. Thay tên release branch theo kết quả đã xác nhận, ví dụ `integration/v0.1.0` hoặc `ver0.1.0`.

- [ ]  Feature đã commit/push, working tree sạch; reviewer đã xem test và phạm vi còn thiếu.
- [ ]  Fetch origin, cập nhật main và nhánh phiên bản của team; nếu main thay đổi, đưa vào nhánh tích hợp rồi xử lý conflict và chạy lại regression.
- [ ]  Mở PR feature → nhánh phiên bản, ghi test ID, evidence và limitation; merge theo chính sách giữ lịch sử của team.
- [ ]  Test trên chính commit sau merge của nhánh phiên bản, không chỉ trên feature.
- [ ]  Mở PR nhánh phiên bản → main; yêu cầu checks/review và merge theo chính sách team.
- [ ]  Checkout main, pull --ff-only; kiểm commit feature đã reachable và chạy smoke sau merge.

Kiểm lịch sử sau khi pull main, với SHA thực của feature:

```powershell
$featureTip = "<SHA-thuc-te-cua-feature-da-merge>"
git merge-base --is-ancestor $featureTip main
$LASTEXITCODE
git log --graph --oneline --decorate -25
```

Exit 0 xác nhận ancestor khi dùng merge giữ SHA. Nếu squash/rebase đã được team chọn, kiểm PR và thay đổi tương ứng thay vì kết luận chỉ bằng ancestor check. Branch phiên bản không đồng nghĩa Git tag/release đã được phát hành; chỉ tạo tag v0.1.0 khi team chốt release.

## 7. Dọn nhánh của Nhi

- [ ]  Main đã có code và evidence; branch không còn commit riêng chưa bảo toàn.
- [ ]  Xác nhận từng nhánh là của Nhi, không còn PR mở hoặc teammate đang dùng.
- [ ]  Giữ nhánh phiên bản/backup theo thỏa thuận; không xóa nhánh dùng chung để dọn cá nhân.
- [ ]  Checkout main rồi xóa local từng nhánh bằng `git branch -d <ten-nhanh>`.
- [ ]  Nếu -d từ chối, dừng để kiểm commit còn thiếu; không chuyển sang -D tự động.
- [ ]  Sau xác nhận của team, xóa remote đúng tên bằng `git push origin --delete <ten-nhanh>`; không dùng lệnh xóa hàng loạt.
- [ ]  `git fetch origin --prune` chỉ dọn remote-tracking ref đã biến mất, không xóa branch trên server.

Chỉ cleanup sau khi hoàn thành merge main và kiểm chứng sau merge. Nhật ký commit vẫn tồn tại qua lịch sử merge dù feature branch đã xóa.

### UC1 intake — kiểm chứng ngày 20/10/2026

- [X]  Webhook riêng cho UC1, xác thực bằng Header Auth.
- [X]  Kiểm tra title và input theo contract procurement v1.
- [X]  Gọi POST /v1/workflows để tạo procurement draft.
- [X]  Chuyển tiếp Idempotency-Key đến backend.
- [X]  Cùng key và payload: HTTP 201, trả cùng workflow ID.
- [X]  Cùng key nhưng khác payload: HTTP 409.
- [X]  Title rỗng, trường không hỗ trợ, input không rỗng: HTTP 400.
- [X]  Thiếu hoặc sai webhook token: HTTP 403.
- [X]  Bổ sung Normalize UC1 Response để đọc JSON từ phản hồi dạng Text.
- [X]  Unit/contract tests: 29/29 PASS, exit code 0.
- [X]  Bản export chuẩn inactive, không pin data, bỏ credential ID local.

Bằng chứng:

- Workflow ID: f621b8fd-ddad-4b5f-882e-2b68d10cc82c.
- Workflow: infra/config/n8n/uc1-intake.json.
- Tests: tests/uc1-intake-workflow.test.ts.

Giới hạn:

- API hiện chỉ nhận title và input rỗng; tạo draft, chưa submit.
- Idempotency do backend xử lý theo actor; khác key chưa chống trùng.
- JWT API hết hạn cần được cập nhật trong n8n credential.
- Xử lý phản hồi HTML 401/403 đã qua unit test; chưa kiểm thử
  toàn luồng sau khi thêm node chuẩn hóa cho các tình huống này.
- Đồng bộ bàn giao, mapping Asset, broker upsert/retry và lưu trace
  chưa triển khai trong bước này.
