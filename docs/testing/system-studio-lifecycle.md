# Tự kiểm thử Studio → hệ thống doanh nghiệp → nhân viên

## Phạm vi

Đây là một luồng cấu hình chạy thật trên engine hiện có. Studio tạo hệ thống nội bộ gồm tối đa 5 module, mỗi module tối đa 12 trường văn bản/số nguyên dương và ba vai trò: người tạo, người duyệt, người thực hiện. Mẫu quy trình: nháp → gửi duyệt → phê duyệt/giao việc → hoàn thành, hoặc từ chối có lý do.

Studio không tạo tenant, tài khoản Keycloak, vai trò SSO, hoặc tự sinh mọi loại quy trình. Việc giao tài khoản/quyền hạ tầng vẫn thuộc quản trị hệ thống. Agent, n8n và broker của các use case hiện hữu không bị thay thế; mẫu này không tự động thêm bước gọi chúng.

## Khởi động local

Chạy ở PowerShell tại `E:\pmnm2026`:

```powershell
pnpm docker:start
docker --context desktop-linux compose --env-file .env.integration -f infra/compose/core.yml up -d --build
docker --context desktop-linux compose -f infra/compose/nocobase.yml up -d
pnpm workspace:install
```

Installer sao lưu database NocoBase trước khi cập nhật plugin. Không xóa volume hoặc reset dữ liệu. Các connector tích hợp dùng `.env.integration` hiện có; không đưa file này lên Git. Cập nhật plugin làm mất phiên bridge trong bộ nhớ: kết nối lại tài khoản nghiệp vụ sau khi cài.

Mở `http://localhost:13000/signin` nếu chưa đăng nhập NocoBase: `admin@nocobase.com` / `admin123` là fixture local. Sau đó mở `http://localhost:13000/lattice/studio` và chọn **Kết nối tài khoản nghiệp vụ**.

| Vai trò kiểm thử | Tài khoản Keycloak | Mật khẩu fixture local |
|---|---|---|
| Thiết kế + nhân viên tạo yêu cầu | alice | local-alice-password |
| Quản lý phê duyệt | manager | local-manager-password |
| Nhân viên được giao | warehouse | local-warehouse-password |
| Nhân viên khác cùng phòng | warehouse2 | local-warehouse2-password |
| Khác đơn vị | bob | local-bob-password |

Quyền thiết kế yêu cầu cả `workflow:design` và `data:design`. Mẫu mặc định dùng `employee`, `procurement:manager`, `logistics:warehouse`; đây là các vai trò đã có trong fixture. Không dùng các mật khẩu demo cho triển khai thật.

## 1. Tạo và publish hệ thống

1. Kết nối **alice** tại Studio. Chọn **Mẫu mới**.
2. Đặt mã mới, ví dụ `my-company`, tên `Điều phối công ty`, phiên bản `1.0.0`.
3. Đặt tên module `Đề xuất liên phòng ban`; thêm trường tùy nhu cầu, ví dụ `quantity` / `Số lượng` / số nguyên dương. Có thể **Thêm module** thứ hai, đặt mã khác để chứng minh nhiều module dùng chung engine.
4. **Lưu bản nháp**. Reload, chọn bản nháp đã lưu: cấu hình và revision phải còn.
5. **Kiểm tra cấu hình / tải trạng thái triển khai**: xem danh sách workflow, quyền cần có, conflicts và dependencyErrors.
6. **Cài gói cấu hình**: trạng thái ban đầu `enabled: false`.
7. **Publish các quy trình**, sau đó **Bật sử dụng**: `enabled: true`, các workflow có `definitionVersion`.
8. Mở **Lịch sử quản trị** để xem install/enable. Chọn **Mở hệ thống**.

Các bước triển khai độc lập và lưu bền vững. Nếu mất kết nối: dùng **Thử lại lệnh cũ** khi nút này xuất hiện; nếu đã reload thì tải lại bản nháp và trạng thái triển khai trước khi tiếp tục. Không nhấn liên tục để tạo lệnh mới. Cài lại cùng nội dung không nhân bản module. Nếu thay đổi nội dung của phiên bản đã cài, tăng phiên bản; Studio đối chiếu hash để chặn việc bật nhầm nội dung cũ.

## 2. Nhân viên tạo → quản lý duyệt → giao việc

1. Trong hệ thống vừa mở, **alice** nhập tiêu đề, nội dung và chọn **warehouse** từ danh bạ. Tìm kiếm/danh sách người nhận phân trang theo API và lọc theo vai trò thực hiện.
2. **Tạo bản nháp yêu cầu** → mở chi tiết → **Gửi duyệt**. Trạng thái chuyển `draft` → `submitted`.
3. **Đổi tài khoản nghiệp vụ** → đăng nhập **manager**. Nếu Keycloak chỉ hiện ô mật khẩu của tài khoản trước, chọn **Restart login** cạnh tên để nhập tài khoản khác.
4. Mở hệ thống tại `/lattice/systems/<mã>/1.0.0`. Chọn **Chỉ xem việc chờ tôi xử lý**, mở yêu cầu và **Phê duyệt và giao việc**.
5. Backend tạo task thật, liên kết với hồ sơ; trạng thái `approved`. Chỉ đúng người được chọn mới có quyền hoàn thành.
6. Đổi sang **warehouse**, mở hệ thống và yêu cầu; nhập **Kết quả thực hiện**, chọn **Hoàn thành**. Trạng thái `completed`, task liên kết cũng hoàn thành.
7. Reload và xem lịch sử: phải có create, submit, approve, complete và người thực hiện từng bước.

Danh sách chỉ hiển thị hồ sơ được backend cho phép đọc; có phân trang, nút tải lại và chế độ việc chờ xử lý. Người thực hiện chưa được đọc hồ sơ khi chưa phê duyệt. Quản lý vẫn có thể chọn **Từ chối**, bắt buộc nhập lý do.

## 3. Kiểm tra quản trị, quyền và tái sử dụng

1. Với **warehouse2**, yêu cầu đã giao cho warehouse không được xuất hiện và truy cập trực tiếp bị từ chối. **bob** không được thấy hệ thống của org-a.
2. Quay lại **alice** trong Studio, chọn bản nháp → kiểm tra → **Tạm dừng tạo yêu cầu mới**. Hệ thống vẫn có trong danh sách, nhưng form tạo mới bị ẩn; hồ sơ cũ vẫn xử lý được. Có thể bật lại.
3. Kiểm tra cấu hình rồi **Tải gói cấu hình JSON**. Gói có recipe và manifest đã sinh; không có tài khoản, secret hay dữ liệu hồ sơ.
4. Dán gói vào ô nhập tại Studio và **Nhập vào bản nháp mới**. Import đối chiếu recipe với manifest được backend biên dịch lại; gói lệch nội dung bị chặn.
5. Sau khi nhập hợp lệ, đổi mã thành `my-company-copy`, lưu, kiểm tra, cài, publish, bật. Hệ thống thứ hai có workflow riêng và chưa có hồ sơ của hệ thống trước.

## Kiểm thử tự động

```powershell
pnpm test:system-studio
pnpm --filter @latticedx/plugin-lattice-foundation test
node --test plugins/nocobase/action-bridge/tests/*.test.cjs
pnpm check
```

`test:system-studio` dùng PostgreSQL thật, JWT fixture và HTTP qua Fastify, tạo database kiểm thử riêng rồi dọn đúng database đó. Kiểm tra draft/revision/idempotency, phân quyền, compile/install/publish/enable, giao việc đúng người, task hoàn thành, tạm dừng/tái sử dụng và dữ liệu còn sau kết nối lại. Không gọi model, broker hay workflow n8n bên ngoài.

## Bằng chứng tại local ngày 21/10/2026

- `pnpm check`: 120 file test / 650 test qua, typecheck và build qua.
- Foundation: 63 test qua; Bridge: 10 test qua.
- PostgreSQL acceptance: qua toàn bộ luồng và kiểm tra từ chối quyền.
- Browser: hệ thống `studio-proof-1021` được tạo, lưu, kiểm tra, cài, publish và bật qua Studio. Alice tạo/gửi yêu cầu; manager duyệt; warehouse ghi kết quả và hoàn thành. Trạng thái cuối `completed`, phiên bản hồ sơ 4, lịch sử đủ create/submit/approve/complete. Ảnh bằng chứng local: `output/verification/system-studio-completed.png`. Export/import và các tình huống từ chối quyền được kiểm tra tự động; chưa chạy toàn bộ nhánh từ chối trên trình duyệt.

Các tài khoản, URL và số test trên mô tả môi trường local; không đồng nghĩa hệ thống đã được chứng nhận hoặc mọi loại nghiệp vụ đã có trình thiết kế riêng.
