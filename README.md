# LatticeDX · PMNM 2026

LatticeDX là nền tảng dựng và vận hành ứng dụng nghiệp vụ. Luồng native dùng NocoBase cho collections, trình dựng trang, phân quyền và workflow. Các plugin LatticeDX bổ sung mô hình nghiệp vụ, ràng buộc dữ liệu, đăng nhập doanh nghiệp và các điểm kết nối với dịch vụ ngoài.

Để thử luồng native từ một database mới, chạy `pnpm native:clean` theo [hướng dẫn cài và nghiệm thu](docs/native-clean-install.md). Xem [kiến trúc hiện tại](docs/architecture.md) để biết các luồng đã kiểm chứng và phần cần ghép tiếp. Phần hướng dẫn core bên dưới phục vụ API và các luồng legacy.

## Chạy core bằng Docker

Yêu cầu Docker Engine với Linux containers và Docker Compose. Từ root repo:

Trên Windows máy Duy, Docker đã nâng lên 4.94.0 và kiểm tra ba lần startup chuẩn sau lỗi socket ở 4.64. Dùng `pnpm local:up` để chạy Docker và core/NocoBase. Dừng/khởi động lại Desktop bằng `pnpm docker:stop` / `pnpm docker:restart`; xem [bản sửa và lịch sử phục hồi Docker](docs/docker-desktop-recovery.md).

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

[Entity sharing](docs/entity-sharing.md) bổ sung quyền read/edit cho người hoặc phòng ban cùng đơn vị, thu hồi quyền và lịch sử rút gọn cho người nhận. Thử bằng `pnpm test:entity-sharing` sau khi đồng bộ local identity/directory và rebuild API.

Theo dõi nền backend ở [kế hoạch hoàn thiện](docs/backend-completion-plan.md). [Task lifecycle](docs/task-lifecycle.md) hỗ trợ hàng đợi phòng ban/claim/chuyển/hủy/deadline; [typed query và blocks](docs/entity-query-blocks.md) dùng chung entity repository; [workflow lifecycle](docs/workflow-lifecycle.md) có compound conditions và cancel/transfer đồng thời. [Organization directory](docs/organization-directory.md) bổ sung metadata phân cấp và snapshot có revision; [inbound events](docs/inbound-events.md) tạo workflow theo subscription pinned. [Enterprise modules](docs/enterprise-modules.md) cài schema/workflow atomically và bật/tắt start mới. Các năng lực có smoke tương ứng trong package scripts; UI và adapter vẫn do Hưng/Nhi nối.

Kiểm vận hành bằng [operations](docs/operations.md), local backup/restore rehearsal theo [recovery](docs/recovery.md). Các mục chưa nghiệm thu trong kế hoạch không được coi đã hoàn thành.

[Workflow timers](docs/workflow-timers.md) thực thi bước đã cấu hình bằng danh tính dịch vụ có quyền hiện tại; [entity data tools](docs/entity-data-tools.md) bổ sung tệp theo quyền thực thể, nhập JSON/CSV theo publication pin, xuất dữ liệu có giới hạn và nâng schema explicit. Thử bằng `pnpm test:workflow-timers` và `pnpm test:entity-data-tools`. Các kết quả kiểm thử và mục chưa chốt được ghi ở [verification](docs/verification.md).

Gateway: http://localhost:8080. Keycloak: http://localhost:8081. API và PostgreSQL trong Compose không mở port ra host. Web hiện tại vẫn là giao diện demo riêng, chưa có login SSO hoặc màn hình hồ sơ; xem [hướng dẫn core](docs/core-local.md) để thử API.

Cấu hình này dùng mật khẩu PUBLIC cho môi trường local, được ghi rõ trong hướng dẫn. Không dùng cấu hình này để triển khai Internet. Xem [nguồn và giấy phép](docs/third-party.md).

## Chạy tại máy phát triển

Yêu cầu Node.js 24 và pnpm 10.23.0. Clone kèm bản nguồn NocoBase:

```sh
git clone https://github.com/CTU-OpenPaw/lattice-dx.git
cd lattice-dx
```

Khi cần khảo sát source upstream, chạy `git submodule update --init --recursive` để tải commit NocoBase đã khóa. `pnpm dev` khởi động web, API và worker. Để chạy riêng NocoBase tại cổng 13000, dùng `pnpm nocobase:up`. Để thử native với ba plugin đã cài và dữ liệu mẫu, dùng đường cài sạch ở đầu tài liệu.

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
- Task/decision nền có lưu bền và kiểm tra phiên bản. Tệp 1 MiB mặc định lưu PostgreSQL bytea, quét ClamAV trước khi tải; có filesystem provider với chuyển bytes được kiểm SHA256, quyền tải hiện tại và sao lưu ghép database/object. Chưa có remote object provider hoặc quét lại nền. Đọc [hợp đồng nền](docs/phase-one-handoff.md) và [filesystem storage](docs/filesystem-storage.md).
- Workflow API chạy cả cấu hình builtin trong source và cấu hình custom publish theo đơn vị; run giữ phiên bản bất biến. Các block có thể giao task theo người/phòng ban hoặc dispatch connector, chờ kết quả và áp dụng điều kiện. API draft/publish và bundle đã có; Studio UI, adapter ngoài và bộ dựng biểu mẫu cần tích hợp tiếp.
- Endpoint demo agent là kiểm tra kết nối cục bộ; không được công bố qua gateway core và chưa có xác thực.
- Các thẻ ứng dụng/dữ liệu trên giao diện ghi rõ chưa tích hợp; không phải kiểm tra sức khỏe dịch vụ.

Backend đã bổ sung liên kết thực thể–workflow, journal giao dịch, automation bền vững, phép tính kiểu dữ liệu trong workflow, module binding, aggregate chính xác, snapshot kiểm lại quyền và full-text search. Xem [API index](docs/backend-api-index.md) để Studio/adapters nối đúng contract; `pnpm test:enterprise-composition` kiểm luồng xuyên các năng lực bằng PostgreSQL thật. Worker cần bật rõ bằng env, metrics thuộc process và queue diagnostics thuộc tenant. Những năng lực backend này chưa xác nhận UI, broker, n8n hoặc agent đã tích hợp hoàn chỉnh.

## Giấy phép

Mã gốc của nhóm dùng Apache-2.0 theo `LICENSE` và các file giấy phép trong từng plugin. Dependency, source tham chiếu trong submodule và image NocoBase 2.2.38 giữ giấy phép và thông báo upstream tương ứng. Xem [kiểm kê nguồn và giấy phép](docs/third-party.md).
