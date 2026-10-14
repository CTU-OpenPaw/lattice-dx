# LatticeDX · PMNM 2026

Bộ khung nền tảng chuyển đổi số LatticeDX. Có cổng web, API và agent worker độc lập; core local gồm Keycloak, APISIX, PostgreSQL và ClamAV. Có runtime NocoBase, action catalog/runtime, plugin server kết nối Keycloak bằng PKCE, API task/quyết định và lưu/quét tệp nhỏ. Backend workflow dùng chung đã chạy được mua sắm–bàn giao và tiếp nhận nhân viên liên phòng ban, có lịch sử và outbox retry. UI workflow, NGSI-LD và mô hình AI còn chờ tích hợp.

## Chạy core bằng Docker

Yêu cầu Docker Engine với Linux containers và Docker Compose. Từ root repo:

Trên Windows máy Duy, dùng `pnpm local:up` để khởi động Docker có phục hồi lỗi socket rồi chạy core/NocoBase. Dừng/khởi động lại Desktop bằng `pnpm docker:stop` / `pnpm docker:restart`; xem [cách phục hồi Docker](docs/docker-desktop-recovery.md).

```sh
pnpm infra:up
pnpm test:infra
pnpm identity:sync-local
pnpm test:foundation
```

Thử backend giai đoạn 2 sau khi core chạy: `pnpm workflow:seed-local` rồi `pnpm test:workflows`. Xem [workflow runtime và bàn giao tích hợp](docs/workflow-runtime.md) để biết tài khoản, payload, quyền và giới hạn. Smoke giữ dữ liệu demo, kiểm chứng worker bằng receiver HTTP local; chưa gọi broker thật.

Giao việc hiện cần directory đã đồng bộ: sau `pnpm identity:sync-local` chạy `pnpm directory:sync-local` trước smoke/task writes. Thử kinh doanh → kho bằng `pnpm test:logistics`; xem [API bàn giao UI Logistics](docs/logistics-ui-handoff.md). Order/task/workflow/record lists có phân trang/lọc; shared read theo assignee không mở quyền ghi hồ sơ.

Mở rộng engine bằng cấu hình quy trình: [hợp đồng Workflow Studio](docs/workflow-studio.md), smoke `pnpm test:workflow-studio`. Bản nháp được quản lý theo đơn vị, publish tạo phiên bản bất biến; hồ sơ đang chạy giữ phiên bản ban đầu. [Workflow blocks](docs/workflow-blocks.md) bổ sung tạo hồ sơ, giao việc theo người/phòng ban và outbox connector; smoke `pnpm test:workflow-blocks`. Studio UI và adapter ngoài cần tích hợp tiếp.

[Workflow completion](docs/workflow-completion.md) bổ sung chờ kết quả task/connector, callback theo quyền, deadline bền vững và guard eq/gt/exists; thử `pnpm test:workflow-completion`. Completion tự chuyển trạng thái đã cấu hình; action ở bước tiếp vẫn cần quyền của người gọi.

[Workflow bundles](docs/workflow-bundles.md) cho phép xuất nhiều published workflow, xem trước và nhập nguyên bộ thành bản nháp trong đơn vị đích; thử `pnpm test:workflow-bundles`. Không chuyển người dùng/quyền, dữ liệu đang chạy hoặc bố cục UI, không tự publish và không ghi đè cấu hình đích.

[Create reliability](docs/create-reliability.md) bổ sung optional `Idempotency-Key` cho REST/action tạo record/task, với kiểm tra đầu vào thống nhất và kết quả lưu trong cùng giao dịch; thử `pnpm test:create-reliability`. Không-key giữ hành vi cũ, replay trả snapshot lúc tạo và vẫn kiểm tra quyền/tham chiếu hiện tại.

Engine quản lý dữ liệu nghiệp vụ dùng chung theo [backend capabilities](docs/backend-capabilities.md). [Enterprise data](docs/enterprise-data.md) thêm schema typed có phiên bản, CRUD/quan hệ/archive/audit và published schema API để Studio dựng biểu mẫu; smoke `pnpm test:enterprise-data`. Đây là increment dữ liệu, các nhóm quyền/lifecycle/block/module mở rộng trong roadmap chưa được coi là đã triển khai.

[Entity sharing](docs/entity-sharing.md) bổ sung quyền read/edit cho người hoặc phòng ban cùng đơn vị, thu hồi quyền và lịch sử rút gọn cho người nhận. Thử bằng `pnpm test:entity-sharing` sau khi đồng bộ local identity/directory và rebuild API. Đây là phần chia sẻ của nhóm quyền; phân cấp tổ chức và lifecycle task vẫn thuộc các đợt tiếp theo.

Gateway: http://localhost:8080. Keycloak: http://localhost:8081. API và PostgreSQL trong Compose không mở port ra host. Web hiện tại vẫn là giao diện demo riêng, chưa có login SSO hoặc màn hình hồ sơ; xem [hướng dẫn core](docs/core-local.md) để thử API.

Cấu hình này dùng mật khẩu PUBLIC cho môi trường local, được ghi rõ trong hướng dẫn. Không dùng cấu hình này để triển khai Internet. Xem [nguồn và giấy phép](docs/third-party.md).

## Chạy tại máy phát triển

Yêu cầu Node.js 24 và pnpm 10.23.0. Clone kèm bản nguồn NocoBase:

```sh
git clone --recurse-submodules https://github.com/TrDuy-pan3000/LatticeDX.git
cd LatticeDX
```

Nếu đã clone repo trước đó, chạy `git submodule update --init --recursive` để tải NocoBase tại commit được khóa. Submodule dùng để khảo sát nguồn; `pnpm dev` chưa khởi động NocoBase. Chạy runtime riêng bằng `pnpm nocobase:up`, mở http://localhost:13000. Đọc [hợp đồng nền và bàn giao giai đoạn 1](docs/phase-one-handoff.md); SSO NocoBase chưa tích hợp.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Mở http://127.0.0.1:3000 và gửi yêu cầu demo. API chạy ở cổng 4000, worker ở cổng 4001. Các tiến trình mặc định chỉ lắng nghe loopback.

```sh
pnpm typecheck
pnpm test
pnpm build
```

`pnpm build` tạo bản build Next.js và biên dịch TypeScript backend. Chạy bản web đã build bằng `pnpm --filter @dx/web start`; hai backend chạy bằng `pnpm --filter @dx/api start` và `pnpm --filter @dx/agent-worker start` (thực thi source TypeScript bằng tsx). Chưa đóng gói backend để triển khai production.

Các biến môi trường có giá trị mặc định được mô tả ở `.env.example`. File này là tài liệu; lệnh root không tự nạp `.env`. Với PowerShell, đặt biến trước khi chạy, ví dụ `$env:WORKER_PORT='4101'; $env:WORKER_URL='http://127.0.0.1:4101'`.

## Cấu trúc

| Thư mục | Trách nhiệm |
| --- | --- |
| `apps/web` | Giao diện người dùng và proxy cùng origin |
| `apps/api` | API chung; điều phối yêu cầu tới worker |
| `apps/agent-worker` | Điểm chạy tác vụ agent; hiện chỉ có demo xác nhận yêu cầu |
| `packages/contracts` | Cấu trúc và kiểm tra dữ liệu giữa các thành phần |
| `plugins/nocobase` | Vị trí dành cho plugin NocoBase của nhóm |
| `upstream/nocobase` | Git submodule chứa bản nguồn NocoBase, khóa tại commit đã khảo sát |
| `infra` | Quy ước cấu hình và triển khai dịch vụ ngoài |
| `solutions` | Quy ước lưu ứng dụng nghiệp vụ, workflow và dữ liệu demo |
| `tests` | Kiểm thử giao tiếp nhiều thành phần |

Thêm server độc lập vào `apps/`, thư viện tái sử dụng vào `packages/`. Không import source của app khác trong mã production. Đọc [kiến trúc](docs/architecture.md) trước khi thêm thành phần.

## Phạm vi bản đầu

- Worker trả kết quả xác định, không phân tích bằng AI, không gọi công cụ nghiệp vụ.
- API demo gọi agent worker đồng bộ bằng HTTP. Workflow nghiệp vụ có trạng thái bền vững và PostgreSQL outbox với retry riêng; chưa có hàng đợi tác vụ agent.
- API hồ sơ trong core xác minh JWT và quyền read/write, giới hạn theo chủ sở hữu và claim đơn vị `organization_id` đã ký. Token thiếu đơn vị bị từ chối. Bản ghi cũ chưa có đơn vị không tự được gán quyền. `pnpm dev` không tự nạp cấu hình core và endpoint hồ sơ trả 503 nếu thiếu cấu hình identity/database.
- Task/decision nền có lưu bền và kiểm tra phiên bản; chưa tự đổi trạng thái hồ sơ mua sắm. Tệp 1 MiB lưu PostgreSQL bytea, quét ClamAV trước khi tải; chưa có object storage hoặc quét lại nền. Đọc [hợp đồng nền](docs/phase-one-handoff.md).
- Workflow API chạy cả cấu hình builtin trong source và cấu hình custom publish theo đơn vị; run giữ phiên bản bất biến. Các block có thể giao task theo người/phòng ban hoặc dispatch connector, chờ kết quả và áp dụng điều kiện. API draft/publish và bundle đã có; Studio UI, adapter ngoài và bộ dựng biểu mẫu cần tích hợp tiếp.
- Endpoint demo agent là kiểm tra kết nối cục bộ; không được công bố qua gateway core và chưa có xác thực.
- Các thẻ ứng dụng/dữ liệu trên giao diện ghi rõ chưa tích hợp; không phải kiểm tra sức khỏe dịch vụ.

## Giấy phép

Mã gốc của nhóm trong repo này dùng Apache-2.0; xem `LICENSE`. Dependency giữ giấy phép riêng. Phiên bản khóa trong `pnpm-lock.yaml`; chưa kiểm toán giấy phép toàn bộ dependency. NocoBase source giữ nguyên trong submodule `upstream/nocobase/`; runtime 2.2.20 chạy riêng và có plugin server nhóm. Checkout có điều khoản bổ sung và thông báo giấy phép khác nhau; chưa xác nhận đủ điều kiện dự thi. Plugin dùng SDK upstream không tự giải quyết nghĩa vụ phân phối của SDK/host. Xem [ghi nhận nguồn và giấy phép](docs/nocobase-source-review.md).
