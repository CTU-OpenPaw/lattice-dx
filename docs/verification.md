# Verification — 2026-10-13

## Bộ mẫu workflow — xuất, kiểm tra và nhập nguyên bộ

- `pnpm check` đạt **183 tests / 27 files**, typecheck và workspace build. Policy/route có RED thiếu module và endpoint; live smoke trên image cũ RED 404 ở export, sau build/recreate API thì GREEN. Bộ mẫu giới hạn 1–10 custom definitions, 12,288 byte UTF-8 mỗi definition; HTTP request tối đa 131,072 byte. Test byte dùng cấu hình vẫn hợp lệ theo validator cơ sở để phân biệt đúng giới hạn, gồm ký tự nhiều byte.
- `pnpm test:workflow-bundles` đạt qua Keycloak → APISIX → API → PostgreSQL thật: export đúng published v1 sau v2, preview không ghi draft, signed design role, body không được chọn tenant, nhập draft-only, xung đột không ghi dở, publish rõ ràng trước khi tạo/chạy workflow. Bundle không có runtime version hoặc tenant/actor của draft nguồn.
- Private PostgreSQL schema kiểm tra nhập cấu hình vào tenant khác, createdBy/updatedBy của người nhập, cấu hình đích chưa publish không chạy được, chỉnh sửa đích không đổi nguồn. Lỗi ở item sau rollback item trước. Hai import đảo thứ tự trên **hai connection** chỉ một thành công; thứ tự insert ổn định tránh deadlock. Import và reconnect cũng chạy với pool max 1. Chỉ schema tên UUID đã xác minh được drop; dữ liệu REST demo giữ nguyên.
- Demo import gồm `bundle-hr-7ee52d7d7b104127be3e61f4c82dad03-copy` và `bundle-purchase-7ee52d7d7b104127be3e61f4c82dad03-copy`, run hoàn thành `2d27f010-44bd-4c72-9e90-3514364513b7`.
- Regression `pnpm test:workflow-studio` đạt: tenant registry, version pin/replay, 106 draft phân trang, pool max 1 starts/transitions. `pnpm test:workflow-completion` đạt task/wait/callback/guard/restart/deadline và private SQL; demo run `d1b63d02-28a0-4f15-9f5d-ace69ecfb886`.
- Không thêm dependencies, không thay NocoBase/license hoặc role grants, không tick Notion/merge/release. Bundle chỉ vận chuyển workflow cấu hình; không gồm UI layouts hay dịch vụ ngoài. Literal văn bản khác vẫn giữ nguyên, người xuất phải kiểm tra nội dung bí mật. Preview requiredRoles tổng hợp các vai trò khác nhau, không khuyến nghị cấp tất cả cho một user.

Hợp đồng bàn giao: [Workflow bundles](workflow-bundles.md).

## Durable completion và guard

- `pnpm check` cuối đạt **175 tests / 25 files**, typecheck và build; baseline 166 tests / 23 files. Completion policy/repository/config tests xác minh ký quyền, resource identity, result schema, locked ordering, exact key replay, minimal receipt và deadline. Status/operator array không được coi là enum string. Numeric guard nhận plain decimal hữu hạn tối đa 20 ký tự, JS/SQL khớp; CASE bảo vệ SQL cast. Regression newline positiveInteger đã qua với policy hiện có, không cần đổi production regex.
- `pnpm test:workflow-completion` đạt trên Gateway/Keycloak/PostgreSQL thật: task và wait cùng commit, restart API khi pending vẫn giữ yêu cầu, generic task decision bị chặn, early transition/inbox không được chạy, IT nhận completion receipt không có workflow data, duplicate key trả receipt cũ, payload khác/actor sai/connector sai bị chặn. Connector callback đồng thời chỉ một kết quả được nhận. Worker thực tế settle wait hai giây và chặn callback muộn.
- Demo cuối: run `64950f04-21cd-4baa-8f5d-c28ba7f5018d`, task `22997921-57aa-491d-bbc0-912fd43c1392`, connector event `e98072e9-8398-42d0-8c21-79b89516332c`. Acceptance cuối xác minh authorized failure evidence và guard SQL với scientific/Infinity/control character/numeric JSON/null. Dữ liệu REST demo giữ; private schema SQL có tên UUID được kiểm tra rồi drop.
- SQL private pool một connection kiểm tra năm completion khác nhau chỉ một thành công, task/run/audit đúng version, failed result, late callback bị từ chối trước timeout settle, reinitialize repository vẫn xử lý deadline lưu bền vững. Callback receipt không cấp quyền đọc wait listing; listing được quyền có failure reason để UI hiển thị.
- Independent review không critical/important finding; targeted 8 tests qua trước evidence closure. Hai giới hạn ghi nhận: read có thể là snapshot cũ khi concurrent completion (mutation vẫn kiểm tra version dưới lock); timeout batch có thể dừng nếu DBA trực tiếp làm lệch task/run mà API hỗ trợ không tạo ra.
- Docker build từng gặp TLS handshake timeout khi lấy metadata Node image, retry thành công; không reset Desktop/volume. Lượt SQL smoke đầu lỗi escape quote trong script eval; sửa sang parameterized status query rồi acceptance qua. Không kết luận đây là lỗi runtime workflow.
- Regression cuối Studio, blocks, Logistics và source workflows đạt: Logistics `a89be6b2-8876-4aa4-ac2f-5ac427f14c2d`, procurement `8083bf8a-b7bf-4f52-a63e-bfd8c37f1dde`, onboarding `dda5b3fe-10c2-4736-800a-768b0853e4e4`. Legacy task/state/outbox/manual retry vẫn hoạt động.
- Không thêm dependency/framework, không sửa upstream hoặc tick Notion/merge/release. Completion tự chuyển trạng thái, không tự chạy action với owner-role snapshot. Adapter nghiệp vụ và Studio UI vẫn cần Hưng/Nhi nối; timeout không bảo đảm hủy side effect bên ngoài.

Hợp đồng: [Workflow completion](workflow-completion.md).

## Workflow blocks và giao việc theo phòng ban

- `pnpm check` cuối đạt **166 tests / 23 files**, typecheck và build. Baseline increment trước 150 tests. RED đã quan sát cho block schema, runtime thiếu module, department catalogue, nested audit payload, step ordinal, malformed transition và chọn người trong phòng ban. Review phát hiện transition null có thể gây 500; validator chuyển sang hai lượt kiểm tra để trả 400.
- `pnpm test:workflow-blocks` chạy thật Keycloak/APISIX/API/PostgreSQL: catalogue block lọc theo role, department API, record → department task → connector request, explicit-person task, task record read đúng người, executions scoped/paged/ordered, replay không thêm side effect, thiếu integrate role rollback, department sai/ambiguous từ chối. Transition thay thế được publish sẵn cho chọn người trong phòng ban: chọn IT cho kho bị chặn; chọn đúng kho thành công trên cùng bản workflow đang chạy.
- Live demo cuối: definition `blocks-15b1bab84b5345eaa25db21ad1cf9065`, workflow `2eb86877-66e3-499e-83ee-8e7510269205`, record `a6208585-0481-4fdb-bee1-daa408da8570`, task IT `dce2e74c-66c1-43cd-bbcb-2047e3d8e840`. Dữ liệu demo giữ lại.
- SQL schema riêng kiểm tra rollback đầy đủ record/task/job/result khi block cuối thất bại; assignee foreign/disabled/missing/wrong-department không được giao; selector chọn từ hai người chỉ nhận người active đúng role/department/tenant, không fallback. Năm transition cùng expectedVersion/pool một connection chỉ một thành công. Replay giữ số row. Lịch sử 105 execution được tạo bằng 21 transition thật và phân trang 100+5, giữ đúng ordinal; 106 department phân trang 100+6. Chỉ schema fixture có tên UUID đã kiểm tra được drop.
- Worker outbox gửi sáu job đến receiver HTTP local với ba connector ID n8n/ngsi-ld/agent; kiểm tra bearer token và Idempotency-Key bằng eventId. Đây là kiểm thử hợp đồng và worker, không phải adapter n8n/broker/LLM thật. Local production-demo outbox chưa cấu hình endpoint vẫn pending.
- Review độc lập spec/quality đạt sau fix, không còn critical/important finding: 45 targeted tests; refinement selector 13 targeted tests. Không thêm dependency/framework, không sửa upstream, không tick Notion hoặc merge/release.
- Regression Studio sau wiring đạt version pinning/replay/paging; Logistics đạt scoped reads và atomic task/state. Smoke workflow nguồn mua sắm/onboarding và durable outbox/manual retry đã qua: procurement `1a632a11-f6f3-4ca7-a2b1-b76a9a868d9a`, onboarding `032dc1e2-5452-4e46-8ad9-f3fe2296d7c4`. Directory tiếp tục là admin snapshot; generic task block chưa tự chuyển trạng thái workflow hoặc cấp workflow read. Chưa có nested department hierarchy hay auto manager selection.

Hợp đồng cho Hưng và Nhi: [Workflow blocks](workflow-blocks.md).

## Engine cấu hình workflow — bản nháp và publish

- Baseline 145 tests / 18 files; sau mở rộng `pnpm check` đạt 150 tests / 21 files, typecheck và build. Validator được kiểm tra RED thiếu module, sau đó RED phát hiện enum field nhận nhầm array; đã sửa. Studio smoke trước triển khai RED 404 ở route draft.
- `pnpm test:workflow-studio` đạt trên Keycloak → APISIX → API → PostgreSQL: role thiết kế, reserved ID, cấu hình sai/graph không tới được, revision conflict, publication đồng thời, catalogue theo tenant, workflow mới dùng latest, workflow cũ giữ v1, replay start v1 sau khi v2 thêm trường bắt buộc, inbox động, history và outbox.
- Isolated PostgreSQL schema kiểm tra hai tenant dùng cùng ID nhưng khác cấu hình, hai save cùng revision chỉ một thành công, hai publication cùng revision trả cùng version; 106 draft phân trang 100+6 không trùng. Khởi tạo lại registry vẫn đọc được v1/v2. Năm create và năm transition đồng thời với pool chỉ một connection chạy thành công, chứng minh resolver không chiếm thêm connection trong transaction. Schema fixture được xóa riêng theo tên UUID đã kiểm tra; dữ liệu doanh nghiệp giữ nguyên.
- Đã restart API và đọc lại hai workflow demo: v1 `8245f3fb-9023-4a66-a6f9-6701908763ad`, v2 `5de3c874-52fc-4ed8-907a-859bd49e7ddf`; definition `studio-a1f50b55553343f0a092a9c58c03205e` vẫn pin đúng phiên bản.
- Regression `pnpm test:logistics` đạt: Order `934e2c56-27eb-4838-b13e-f7c2d02ba08c`, task `b3381295-e75c-4fb6-a186-9792a3d21d0a`; `pnpm test:workflows` đạt procurement, onboarding, file sharing và isolated SQL outbox/manual retry.
- Independent review nhận xét spec/quality đạt, không critical/important finding; reviewer chạy 9 tests về validator, draft routes và workflow routes. Test runtime registry riêng có tên `database-registry.test.ts`; full suite của lượt triển khai đã chạy nó.
- Không thêm dependency, không sửa nguồn NocoBase, không tick Notion hoặc tự merge/release. Custom definition chưa nhận task hook và chưa có canvas/page builder. Block action, n8n, broker và agent mở rộng thuộc increment tiếp theo; outbox pending không phải bằng chứng connector ngoài đã xử lý.

API bàn giao: [Workflow Studio](workflow-studio.md). Local designer `alice` cần `identity:sync-local`; quyền này không tự cấp production.

## Bổ sung backend cho UI Logistics

- `pnpm check`: typecheck, **145 tests / 18 files**, workspace build đạt. Directory có lượt RED REST/action nhận assignee không hợp lệ và route thiếu, rồi GREEN; policy Logistics RED thiếu cấu hình, facade RED 404 trước triển khai, pagination RED thiếu module. Full suite giữ các regression workflow/action/file/bridge cũ.
- `pnpm test:logistics` đã chạy thật Keycloak → APISIX → API → PostgreSQL. Directory dropdown theo role/department và page; REST/action chặn unknown/disabled/foreign assignee; Order draft không lộ cho kho, submit tạo một task, replay giữ taskId; đúng kho mở detail/file, cùng-role peer và org-b bị chặn. Hai receive cùng version chỉ một thành công, workflow và linked task hoàn thành cùng giao dịch; quyết định task riêng bị chặn. Task chung mở đúng record/file, không mở cả đơn vị.
- Pagination acceptance seed 106 workflow/record/task fixture trong SQL, đọc 100 + 6 qua Order/workflow/task/record lists, kiểm tra không trùng ID, peer inbox không lộ. Chỉ fixture có UUID do script tạo được dọn, business demo giữ lại. Directory đã thử limit/offset và literal role/department filter; chưa tải hàng nghìn user thật từ Keycloak.
- Lượt `pnpm test:logistics` cuối chạy riêng đạt exit 0, thêm kiểm tra optional attachment rejected bởi ClamAV và tệp của actor khác bị từ chối khi tạo đơn: order `358e6c6b-587a-4e15-8e38-737e95f51ad5`, linked task `60d9dbb2-dffd-45d2-8aed-1cc880a1e93c`, generic shared record `b43d38d3-8b94-489a-8f7e-c96fd5e21188`. Lượt trước chạy sát workflow smoke gặp 429 ở concurrent receive; không thay rate limit, chạy lại sau cửa sổ 60 giây.
- `test:infra`, `test:foundation`, `test:actions`, `test:record-links`, `test:nocobase:bridge`, `test:workflows` đạt sau wiring. Procurement/onboarding và isolated real SQL outbox/manual retry tiếp tục đạt, chưa gọi n8n/broker thật.
- Directory task review và whole-change review độc lập đều đạt, không finding important. Whole reviewer chạy lại 28 tests về facade/policy/pagination/record links; đọc SQL transaction/permission/lease integration. Directory reviewer chạy lại 64 tests. Các reviewer không tự chạy live acceptance, kết quả live là của lượt triển khai này.
- Local Docker cần archive runtime socket cũ rồi startup bằng launcher hiện có. Directory pnpm process có một lần Windows fail-fast; chạy lại bằng Node và pnpm đều sync thành công. Fixture sales2 mới báo account not fully set up do thiếu email; thêm email local và sync chỉ điền email còn thiếu, không reset mật khẩu. Không kết luận Node/Docker upstream đã hết lỗi.
- Không thêm dependency, không sửa upstream NocoBase, không tick Notion hoặc tự merge/release. Directory là admin snapshot, phải sync sau identity changes; generic task read giữ sau hoàn thành, chưa revoke/reassignment. Order một SKU, nhận việc chưa là xuất kho/giao hàng. UI/proxy NocoBase và broker/n8n vẫn chờ tích hợp.

Hợp đồng đầy đủ: [Logistics UI handoff](logistics-ui-handoff.md), [directory](directory.md).

---

# Verification — 2026-10-12

## Duy — backend workflow giai đoạn 2

- `pnpm check`: typecheck, **120 tests / 12 files** và build đạt. Policy/routes/manual retry/shared evidence đã có lượt test đỏ trước triển khai hoặc sửa; không thêm dependency.
- `pnpm test:infra`, `test:foundation`, `test:actions`, `test:record-links`, `test:nocobase`, `test:nocobase:bridge` chạy lại đạt sau bổ sung workflow/claim đơn vị. Task/action/file cũ tiếp tục hoạt động, NocoBase vẫn kết nối PKCE và giữ token ở server plugin.
- Smoke workflow đã chạy thật hai cấu hình procurement/onboarding qua Keycloak → APISIX → API → PostgreSQL. Kiểm tra version/quyền, tạo/chuyển bước lặp, hai quyết định đồng thời, lý do từ chối, tham chiếu người nhận/đơn vị/vị trí, tệp clean/rejected và participant sharing. Kết quả worker dùng schema SQL riêng và receiver HTTP local: hai delivery cùng eventId, một xử lý hiệu lực; lease/fencing/retry và production job isolation đạt. Chưa gọi broker NGSI-LD/n8n thật.
- Lượt cuối `pnpm test:workflows` đạt, exit 0 sau phục hồi stack: procurement `d73231d2-5284-4a46-b6ab-afcb471889b9`, rejected `0e77148f-68b0-4ade-ba97-6a8340ed4808`, onboarding `d81c3c06-e53b-4f50-bc5a-9719478e1aaf`; controlled receiver event `495f7267-50d3-48e9-9210-340011c64b5f`. Manual retry replay không reset lại attempt budget; key mới reset đúng job failed.
- Lượt baseline đầu lúc tiếp tục bị connection refused vì Docker Engine chưa chạy. `pnpm local:up` phục hồi socket runtime cũ và rebuild/up thành công; không đổi dữ liệu Docker. Lượt smoke workflow chạy sát toàn bộ baseline gặp HTTP 429 do Gateway giới hạn 120 request/phút; cần chạy riêng sau cửa sổ giới hạn, không tăng limit.
- Review độc lập phát hiện hai lỗi important: không cho participant gắn lại evidence đã chia sẻ, và manual retry chưa lưu kết quả idempotent. Đã sửa cùng regression tests; reviewer xác nhận không còn finding important trong phạm vi policy/repository/routes/outbox/identity wiring.
- Sau restart PostgreSQL/API, số lượng và hash toàn row của 6 workflow runs, 28 audit rows, 4 outbox jobs giống trước restart. Keycloak còn connection pool cũ, login đầu trả 500 với log PostgreSQL connection closed. Gateway trả 502 do còn IP API 172.18.0.4 trong khi container/DNS đã là 172.18.0.3. Restart Keycloak/Gateway để nạp lại kết nối trước smoke cuối; đã ghi runbook. Kiểm tra persistence này không thay thế backup/restore hoặc phục hồi production tự động.
- Compose core/NocoBase config, cú pháp seed/smoke và `git diff --check` đạt. Giữ nguyên mọi checkbox Notion theo yêu cầu Duy; không merge hoặc release tự động.

Đối chiếu sáu task backend: tạo/gửi/duyệt/từ chối và nhận/nghiệm thu nằm trong cấu hình + transition policy; bàn giao có scoped references và transaction; outbox có lease/retry/eventId; lịch sử có actor/time/from/to/version; smoke kiểm tra race/replay/role. Các tiêu chí UI và asset hiện trong broker vẫn chờ tích hợp Hưng/Nhi. Xem [hợp đồng workflow](workflow-runtime.md).

## NocoBase action authentication bridge

- `pnpm check`: 76 tests (18 plugin tests), workspace typecheck/build đạt. Plugin CommonJS kiểm tra syntax riêng bằng node --check; không claim có TypeScript typecheck cho plugin runtime JS.
- `pnpm test:nocobase:bridge`: auth NocoBase thật → Keycloak code + S256 PKCE → cookie-bound callback → plugin → Gateway/API → record PostgreSQL đúng Alice/org-a. Thiếu cookie, replay, browser khác và disconnect bị chặn.
- Recreate NocoBase giữ package bằng mount và trạng thái enabled trong DB; smoke metadata/frontend và bridge chạy lại đạt. Không giữ linked token qua restart.
- `pnpm test:actions` và `pnpm test:foundation` tiếp tục đạt.
- Review phát hiện capacity của callback đang trao đổi, disconnect hồi sinh session và dọn token hết hạn bằng request. Đã sửa reservation/cancellation, timer tự dọn; test hồi quy đạt.
- Kết nối tài khoản hai lần đăng nhập, chưa SSO; single-process short-lived session, chưa client block, refresh hoặc production deployment.

## Action runtime

- `pnpm check`: typecheck, 58 tests (20 action tests) và build đạt. Các test action ban đầu thất bại vì route chưa tồn tại, sau triển khai đạt.
- `pnpm test:actions`: gọi qua Keycloak/APISIX, catalog theo quyền, chặn role/scope giả và tạo record/task thật trong PostgreSQL; scope khác không đọc được dữ liệu đã tạo.
- `pnpm test:infra` và `pnpm test:foundation`: các luồng cũ tiếp tục đạt, gồm quyết định đồng thời và ClamAV thật.
- Compose core/NocoBase config, script syntax và git diff whitespace check đạt.
- Reviewer phát hiện schema maxLength và validator UTF-16 không khớp. Action parsers chuyển sang Unicode code points; thêm test biên 200/201 title và 100/101 assignee; reviewer xác nhận không còn finding trong phạm vi review. REST cũ giữ hành vi.
- Docker Desktop gặp lại socket runtime cũ sau khởi động; giữ bản sao hai thư mục runtime và tái tạo đường kết nối, không xóa ổ/volume. Engine 29.2.1 chạy lại, core được rebuild và smoke đạt. Chưa sửa nguyên nhân dài hạn của lỗi Docker.
- Catalog/execute là action runtime đồng bộ đầu tiên; không phải graph engine, workflow hoàn chỉnh, idempotency hoặc SSO NocoBase. Xem `action-runtime.md`.

---

# Verification — 2026-10-12

## Duy — bàn giao nền hôm nay

- `pnpm check`: typecheck cả logistics contract, **96 tests / 9 files** và build đạt. Test liên kết chạy đỏ trước khi hiện thực; ca lookup outage chạy đỏ rồi sửa trả 503.
- `pnpm test:infra`, `test:foundation`, `test:actions`, `test:record-links`, `test:nocobase`, `test:nocobase:bridge` đều đạt trên container thật. Liên kết task/file/action lưu PostgreSQL, decision giữ recordId, metadata/download và ClamAV clean/rejected đạt. Request không có recordId vẫn dùng được qua smoke cũ.
- Unit tests với token RSA thật kiểm tra người khác cùng đơn vị và cùng subject khác đơn vị đều không được liên kết; không ghi dữ liệu hoặc scan khi bị từ chối. Real smoke kiểm tra role denial, missing record, UUID sai; chưa kiểm tra cùng-role cross-scope bằng realm fixture hiện tại.
- `pnpm test:scanner-outage`: scanner thật bị dừng → upload error quarantine → download 409; scanner khởi động lại và healthy.
- Compose core/NocoBase parse hợp lệ; `git diff --check` đạt. Không thêm dependency/runtime version hoặc release.
- Logistics fixture/model/state/role ở `solutions/logistics`; kiểm tra local references, duplicate IDs, organization và state. Chưa provision roles/collections hoặc thực thi workflow logistics.
- Review độc lập: lỗi important về Docker context đã sửa; launcher probe và local:up nhắm desktop-linux rõ ràng. Kiểm tra với DOCKER_CONTEXT không tồn tại vẫn nhận đúng Engine local. Không có finding important ở API.

Tài liệu: [API/payload/giới hạn](phase-one-integration-handoff.md), [logistics](../solutions/logistics/README.md), [Docker recovery](docker-desktop-recovery.md). Hai task Duy còn lại là bàn giao backend; UI, broker/n8n/agent, workflow đa bước và nghiệm thu cả nhóm vẫn chưa hoàn thành.

## Docker — lỗi tái diễn và đường khởi động

Lỗi dockerInference tái hiện sau orderly stop. Hai vòng restart đã phục hồi qua archive runtime socket và Engine 29.2.1 sẵn sàng; bốn volume lattice-dx giữ nguyên. Launcher đã cài cho shortcut Desktop và HKCU Run của máy Duy, có backup bản gốc. Chưa thử Windows reboot/logon; chưa xác nhận lỗi upstream hết. Xem runbook để dùng pnpm docker:start/stop/restart thay đường restart trong tray.

Sau sửa context/guard, thêm một vòng pnpm docker:restart và pnpm local:up đạt. Trước/sau restart: 14 records, 14 tasks, 17 files; 2 task links và 1 file link giữ nguyên. Đây là kiểm tra số lượng/liên kết, không thay thế backup/restore hay đối chiếu toàn nội dung.

---

# Kết quả — 2026-10-11

## Giai đoạn 1 — kiểm chứng thực tế

- `pnpm check`: typecheck, 38 tests và build đạt sau đợt kiểm tra bổ sung.
- Core Docker build/up đạt; Keycloak 26.8.0, APISIX 3.19.0, PostgreSQL 16.13, API chạy thật.
- `pnpm test:infra`: token → Gateway → API → PostgreSQL; quyền ghi, owner và organization scope đạt.
- `pnpm test:foundation`: task tạo/đọc/quyết định lưu PostgreSQL; hai quyết định cùng version chỉ một thành công; đơn vị khác không thấy/duyệt task.
- Upload tệp sạch → ClamAV → clean → download đạt. Mẫu antivirus EICAR vô hại → rejected → download 409. Unit test scanner lỗi → error → download 409.
- Sau restart PostgreSQL/API: counts và hash trạng thái task/nội dung tệp giống trước restart. Kiểm tra này không thay thế thử backup/restore thảm họa.
- NocoBase runtime 2.2.20 xác nhận qua package server trong container. `pnpm test:nocobase`: API metadata và frontend đạt, http://localhost:13000.
- Compose core/NocoBase parse hợp lệ. Hai dịch vụ có database/volume riêng; NocoBase chưa SSO và chưa plugin nhóm.
- Review độc lập không có lỗi critical/important; đã sửa lỗi tên tệp chứa Unicode malformed và thêm regression test.

## Kiểm tra bổ sung qua UI và lỗi biên

- Đăng nhập NocoBase qua trình duyệt bằng fixture local thành công, chuyển đến `/admin`. Trang báo No pages yet vì chưa có app/plugin của nhóm; không coi UI trống là lỗi runtime. Ảnh kiểm chứng local: `output/verification/nocobase-admin.png`.
- Unit tests mới kiểm tra tên tệp chứa đường dẫn/ký tự điều khiển, metadata không lộ content, giới hạn 1 MiB chính xác và đọc task/tệp cần token.
- TCP scanner test kiểm tra framing INSTREAM, kết quả clean/rejected, lỗi daemon và response thiếu terminator; lỗi scanner không được coi là clean.
- `pnpm test:scanner-outage` tắt ClamAV thật, upload tệp thử và xác nhận scanStatus error/download 409; script khởi động lại ClamAV trong finally. Script này gián đoạn scanner local ngắn, không chạy chung với người đang upload.

## Docker Desktop recovery

Daemon lúc đầu không khởi động do socket reparse point bị kẹt ở Docker/run/dockerInference và docker-secrets-engine/engine.sock. Dừng tiến trình Docker, giữ thư mục runtime cũ dưới tên `*-stale-20261011*`, tái tạo đường kết nối và khởi động lại. Giữ nội dung không phải socket của thư mục Secrets Engine. Không reset factory, xóa ổ VHD hay volume. Engine sau sửa trả phiên bản 29.2.1 và chạy các container.

Lỗi tương tự được báo ở https://github.com/docker/desktop-feedback/issues/460 . Nếu tái diễn cần xử lý vòng đời socket/phiên bản Windows–Docker; chưa kết luận do chuyển ổ dữ liệu.

## Giới hạn còn lại

Tại mốc 11/10 API task nền chưa liên kết UC1/recordId; recordId đã bổ sung ngày 12/10. Directory assignee, outbox và workflow đa bước vẫn chưa có. Tệp tối đa 1 MiB trong PostgreSQL bytea, chưa object storage hay quét lại nền. UI/plugin của Hưng và broker/n8n/agent của Nhi chưa tích hợp. Chưa nghiệm thu toàn bộ giai đoạn 1; chưa kiểm toán đủ license upstream/dependency và chưa đạt chứng nhận an toàn nào.

---

# Kết quả cũ — 2026-10-06

## Đã kiểm chứng ở máy phát triển

- `pnpm install --frozen-lockfile`: thành công.
- `pnpm check`: typecheck, 14 tests và build thành công.
- Kiểm thử token dùng RSA JWT thật: thiếu token, sai issuer/audience, thiếu quyền ghi, owner isolation, tiêu đề trống.
- Luồng API → demo worker được kiểm thử qua HTTP thật.
- `docker compose -f infra/compose/core.yml config --quiet`: hợp lệ.
- `node --check scripts/smoke-core.mjs`: cú pháp hợp lệ.
- Working tree upstream NocoBase sạch; upstream, .env và build output được ignore.

## Chưa kiểm chứng

Docker Engine không phản hồi ở máy trong lượt triển khai này, dù Docker Desktop đã được gọi khởi động. Chưa chạy Docker build/pull/up, truy vấn PostgreSQL thật, Keycloak realm import, xác thực APISIX hoặc restart persistence. Test records dùng repository trong bộ nhớ và JWKS local, không thay thế smoke container.

Chạy `pnpm infra:up` và `pnpm test:infra` khi Docker Engine sẵn sàng. Sau đó thử restart stack và truy vấn lại dữ liệu. Cập nhật tài liệu này bằng kết quả thực tế trước release.
