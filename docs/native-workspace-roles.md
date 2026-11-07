# Workspace native theo vai trò

Workspace của người dùng cuối nằm tại `/admin/lattice-workspace`. Builder có quyền `allowConfigUI` tiếp tục dùng shell Config / Build UI hiện có. Người dùng cuối không có quyền thiết kế được dùng shell Workspace trên cùng runtime và phiên đăng nhập NocoBase.

## Phạm vi

- Công việc của tôi: hai tab Cần xử lý / Đã xử lý, dùng component `WorkflowTodo` và popup `PagePopups` do NocoBase cung cấp. Quyền xem và xử lý công việc do backend native kiểm tra.
- Ứng dụng: danh sách các trang native được cấp quyền, lối tắt ba trang đầu và tìm theo tên trang. Đây là danh mục trang; chưa giả định mỗi trang là một sản phẩm độc lập.
- Báo cáo: chỉ xuất hiện nếu cây trang được cấp quyền có metadata `options.workspace.section = "reports"`. Nhãn trang không được dùng để suy đoán loại trang.
- Header giữ `PinnedPluginList` của host, bao gồm menu tài khoản/đăng xuất và các chức năng plugin đã bật. Các module tùy chọn hiển thị theo cấu hình host.
- Sidebar thu gọn trên màn hình nhỏ. Khi mở trang nghiệp vụ, nội dung vẫn do native renderer xử lý, gồm cấu hình field, validation, data scope, action và API của trang đó.

Không thêm logic Logistics hay tên collection nghiệp vụ vào shell. Không dùng manifest hoặc API tác vụ của Workspace `/lattice` cũ. Mã shell không cấp quyền mới cho role và không thay workflow.

## Cài đặt và tái tạo

Build Foundation và cập nhật plugin trên NocoBase 2.2.38 theo quy trình deploy plugin của repo. Shell được đăng ký bởi `src/client/native-builder-navigation.js`; không sửa upstream. Runtime thiếu SDK bắt buộc giữ shell native cũ.

Cấp desktop routes và collection/action permissions bằng cơ chế NocoBase hiện có cho từng role. Hai lớp quyền này độc lập: thấy link không thay cho quyền truy cập dữ liệu. Gắn metadata báo cáo bằng `desktopRoutes:update`, giữ nguyên những trường `options` khác khi cập nhật:

```json
{"options":{"workspace":{"section":"reports"}}}
```

Có thể đặt metadata trên group để áp dụng cho các trang con. Trang/group ẩn và link ngoài không được liệt kê trong danh mục Workspace. Thứ tự theo `sort` của host.

Role `ldx_employee`, `ldx_manager`, `ldx_warehouse`, `ldx_dispatcher`, `ldx_driver`, `ldx_director`, `ldx_admin` chỉ được dịch tên để hiển thị. Danh sách trang, task, action và dữ liệu không được quyết định bằng tên role trong frontend.

## Kiểm chứng local

Ngày 07/11/2026, môi trường tách biệt tại `localhost:13001`, NocoBase 2.2.38:

- Quản lý mở task thật từ Workspace, xem form workflow native và duyệt hồ sơ thử “Hồ sơ thử kho tệp chung”. Task chuyển Resolved.
- Kho đăng nhập bằng tài khoản riêng, nhận task tiếp theo của chính workflow, mở form native và Hoàn thành. Task chuyển Resolved. Sidebar không có Báo cáo vì không được cấp trang đó.
- Mục Báo cáo của quản lý chỉ liệt kê trang đã gắn metadata; tìm tên không tồn tại trả trạng thái rỗng.

- Nhân viên mở danh mục và form Yêu cầu có đính kèm trong shell mới. Không thấy task của quản lý; truy cập trực tiếp URL popup task quản lý không trả bản ghi (backend thêm filter userId của nhân viên).
- Tab Cần xử lý của kho rỗng sau khi hoàn thành; tab Đã xử lý hiển thị đúng task Resolved. Mỗi tab có đường dẫn field Formily riêng để không dùng lại bộ lọc của tab trước.
- Màn hình 390 × 844 mở/đóng sidebar và điều hướng được; menu tài khoản vẫn dùng native. Header chỉnh màu icon để hiển thị rõ trên nền sáng.
- Đăng xuất trả về Sign in. Root đăng nhập vẫn thấy Config / Build UI và cây trang native.
- Build client/server thành công; 224 Foundation tests đạt, gồm hồi quy quyền hiển thị trang và tuyến popup task.

### Đối chiếu đủ bảy vai trò

`scripts/acceptance-native-workspace-roles.mjs` tạo fixture có backup trong runtime local tách biệt. Script không sửa user có sẵn, quyền resource hay workflow; chỉ thêm tài khoản thử và cấp đúng một trang thử cho bảy role có sẵn. Trang thứ hai được giữ ngoài quyền để kiểm tra truy cập URL trực tiếp. Fixture được giữ lại cho browser acceptance, không tự xóa dữ liệu sau mỗi lần chạy.

```powershell
$env:NOCOBASE_URL='http://localhost:13001'
$env:NOCOBASE_DB_CONTAINER='lattice-native-studio-nocobase-db-1'
node scripts/acceptance-native-workspace-roles.mjs
```

Manifest lưu trong `output/native-platform/workspace-roles-lab.json`; kết quả HTTP trong `output/native-platform/workspace-roles-acceptance.json`. Đây là output local được ignore, không chứa bearer token. Tài khoản thử có dạng `native.workspace.<role>@example.invalid`, mật khẩu fixture `NativeLab-2026!`; chỉ dùng trên môi trường thử localhost.

| Vai trò | Số hồ sơ nhìn thấy trong fixture | Quyền cập nhật qua API |
| --- | ---: | --- |
| Nhân viên | 2 | Nháp do mình tạo |
| Quản lý | 8 | Nháp do mình tạo |
| Kho | 1 | Nháp do mình tạo |
| Điều phối | 8 | Nháp do mình tạo |
| Tài xế | 2 | Nháp do mình tạo |
| Giám đốc | 8 | Chỉ đọc |
| Admin nghiệp vụ | 8 | Nháp do mình tạo |

Cả bảy vai trò đều đạt các kiểm tra HTTP thật: ánh xạ đúng tổ chức; danh sách khớp chính xác phạm vi requester/assignee hoặc toàn tổ chức; không đọc được hồ sơ tổ chức khác; không sửa hồ sơ đã giao việc; không ghi thẳng trạng thái hoặc đổi tổ chức; không xóa hồ sơ hoặc sửa ánh xạ nhân viên. Giám đốc bị chặn cả create/update. Các con số trong bảng là dữ liệu kiểm thử, không phải số liệu của doanh nghiệp.

Đã đăng nhập và đối chiếu browser riêng cho bốn vai trò bổ sung: điều phối, tài xế, giám đốc và admin nghiệp vụ. Trang bảng native hiển thị đúng 8/2/8/8 hồ sơ tương ứng; không hiển thị `WS-FOREIGN`. Giám đốc không có action tạo; ba vai trò còn lại có action tạo theo quyền native. Cả bốn giữ shell Workspace, không có Config / Build UI và đều nhận trang 404 khi mở UID trang chưa được cấp quyền. Ảnh lưu ở `output/native-platform/workspace-role-<role>.jpg`.

`pnpm check` và 240 kiểm tra hợp đồng Foundation + Action Bridge đạt. Các kiểm tra trên là bằng chứng local; vẫn cần review PR và nghiệm thu trên môi trường nhóm. Không tự đánh dấu hoàn tất toàn bộ Giai đoạn 4. Luồng tác vụ thật trước đó được kiểm chứng bằng quản lý/kho; không suy diễn thành đã chạy workflow của mọi vai trò.

### Trạng thái UX và khả năng khôi phục

- Danh sách trang được xác nhận khi mở Workspace, có trạng thái đang tải và thời điểm cập nhật thật. Trong lúc tải hoặc khi tải lỗi, không hiển thị lối tắt cũ như kết quả hiện hành. Không tự thử lại thao tác ghi.
- Phân biệt không có trang được cấp quyền, tìm kiếm không có kết quả, lỗi đọc dữ liệu và phiên hết hạn. Lỗi có nút Thử lại; HTTP 401 đưa về đăng nhập native. Nội dung lỗi kỹ thuật không được đưa ra giao diện.
- Tìm kiếm nằm ngay trong danh mục, dùng được trên điện thoại, có nút Xóa tìm kiếm. Xóa tìm kiếm tại Báo cáo vẫn ở danh mục Báo cáo. Số kết quả và trạng thái tải/cập nhật được thông báo qua vùng `status`.
- Công việc dùng nguyên request service, bộ lọc, danh sách và popup native. Wrapper chỉ bổ sung trạng thái tải, lỗi đọc có thể thử lại và thông báo rỗng tiếng Việt. Không hiển thị “không có công việc” khi request còn đang tải hoặc đã lỗi. Thông báo thao tác ghi vẫn do native xử lý.
- Menu điện thoại có thể đóng bằng Escape, nút chuyển trạng thái hoặc bấm nền ngoài; Escape trả focus về nút mở menu. Ô tìm kiếm và icon header có màu rõ trên nền sáng, link có dấu focus bàn phím.

Kiểm chứng browser trên runtime thật: tìm kiếm không kết quả → Xóa tìm kiếm → khôi phục danh sách; cập nhật danh mục thành công; màn hình 320px không tràn ngang, tìm kiếm vẫn dùng được, Escape/backdrop đóng menu; mở công việc đã xử lý vẫn hiện đúng popup native với nút duyệt bị khóa, đóng popup giữ tab Đã xử lý. Không thay đổi trạng thái hồ sơ trong lượt rà UX này.

250 kiểm tra hợp đồng Foundation + Action Bridge đạt sau lượt UX và đồng bộ main (gồm các ca đối soát upload đã được review trong #46). Bốn kiểm tra mới dùng request service được kiểm soát để xác nhận chặn đọc trùng, xử lý lỗi/401, khôi phục sau retry và không biến lỗi task thành trạng thái rỗng. Đây là kiểm tra tích hợp component bằng adapter, không phải bằng chứng đã ngắt mạng hoặc làm hết hạn phiên thật trên browser. Lần tải đầu của danh sách trang được kiểm tra lại vì provider của host ghi log rồi bỏ qua lỗi khởi tạo.

### Review vòng đời layout trong PR #47

Review nội bộ ngày 07/11/2026 tìm được hai thiếu sót và đã bổ sung ca hồi quy tái hiện trước khi sửa:

- Đổi từ builder sang nhân viên sau khi lệnh bật designer đã hoàn tất không đưa flow settings về tắt. Shell hiện luôn đồng bộ trạng thái này và chỉ bật khi role có `allowConfigUI`, đang thiết kế, ngoài Config và ngoài bố cục mobile. Hàng đợi enable/disable vẫn được giữ để lệnh cũ không thắng trạng thái mới.
- Nhánh nhân viên trước đó bỏ qua đồng bộ menu model và theo dõi breakpoint của native layout. Hiện cả builder và nhân viên đều đồng bộ cây trang được cấp quyền và `isMobileLayout`; menu hiển thị vẫn do shell tương ứng quyết định.

Hai ca adapter từng thất bại trên code cũ, đạt sau sửa; tổng Foundation + Action Bridge hiện là 252 ca đạt. Không thay quyền API hay workflow và không coi trạng thái designer còn bật là bằng chứng đã vượt ACL backend.

Browser smoke bổ sung trên fixture `flowPage` native: builder khởi tạo và lưu nội dung Markdown bằng designer; reload builder rồi đăng nhập nhân viên vẫn đọc đúng nội dung đã lưu, không có Add block/flow settings; chuyển màn hình desktop/390px vẫn hiển thị được. Chỉ có bản ghi desktop route chưa phải là bằng chứng đã có cấu hình Page/Grid được lưu. Fixture và ảnh nằm trong output local (`workspace-modern-review.json`, `workspace-review-modern-employee.jpg`), không đưa vào Git.

Đây là review và kiểm chứng local của nhánh, không phải review độc lập/approval thay cho thành viên khác trên GitHub, và không tự nghiệm thu toàn bộ Giai đoạn 4.

## Giới hạn hiện tại

Danh sách công việc giữ nội dung/tên trạng thái của plugin workflow native theo ngôn ngữ host. Lối tắt chỉ mở trang; nút tạo nhanh theo từng sản phẩm cần cấu hình action rõ ràng, chưa suy đoán từ tên trang. Không có tab “Tôi đã tạo” hoặc “Đang thực hiện” chung vì cần hợp đồng dữ liệu phân loại xuyên workflow. Không hiển thị các màn hình giả lập cho tính năng chưa có.

Trang đăng nhập và theme host vẫn theo cấu hình NocoBase. Workspace không thay quy tắc phân quyền backend, quản lý phiên hay chính sách tệp.
