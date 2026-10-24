# Đặc tả thiết kế UI/UX Workspace LatticeDX

Phiên bản 1.0 · 13/10/2026 · Chủ phần việc: Hưng

Tài liệu dành cho designer, người dựng prototype và lập trình viên. Đây là đặc tả đề xuất cho bước hoàn thiện giao diện; không phải xác nhận mọi chức năng bên dưới đã triển khai. Không thay đổi runtime, API, Notion hoặc phạm vi nghiệm thu giai đoạn trước.

## 1. Mục tiêu và phạm vi

Workspace là cổng làm việc của doanh nghiệp: nhân viên mở ứng dụng builder đã cấu hình, tìm công việc của mình, thực hiện thao tác hợp lệ và theo dõi kết quả. Studio là nơi builder thiết kế/cấu hình; dùng cơ chế NocoBase và plugin Lattice đã phát triển.

Mục tiêu trải nghiệm:

1. Nhận ra ngay công ty, tài khoản và ngữ cảnh ứng dụng đang sử dụng.
2. Tìm đúng ứng dụng/công việc với ít bước và không cần nhớ mã kỹ thuật.
3. Hiểu trạng thái, người chịu trách nhiệm và thao tác tiếp theo.
4. Hoàn thành đúng công việc, không tạo trùng hoặc xử lý nhầm bản ghi.
5. Giữ được ngữ cảnh khi chuyển trang, quay lại hoặc gặp lỗi.
6. Giao diện thống nhất khi nhiều builder xây nhiều ứng dụng khác nhau.

Phần Hưng thiết kế: khung Workspace, điều hướng, danh sách ứng dụng, cách trình bày công việc, mẫu chi tiết, component chung và các trạng thái tương tác. Các màn hình nghiệp vụ là ví dụ áp dụng component và phải tương thích cấu hình builder/API; không biến Workspace thành ứng dụng ERP cố định.

Không thiết kế lại toàn bộ Studio trong lượt này. App Registry, cơ chế xuất bản, SSO, dữ liệu tổng hợp Inbox và dịch vụ AI là các phụ thuộc cần chốt với nhóm khi triển khai.

## 2. Căn cứ và cách đặc tả

| Căn cứ | Áp dụng |
| --- | --- |
| [Chương 0](C:/Users/HUNG/Downloads/Chuong0_GioiThieuHocPhan.pdf), trang 4–5 | Liên kết yêu cầu, dữ liệu, xử lý và giao diện. |
| [Chương 1](C:/Users/HUNG/Downloads/Chuong1_MoiTruongPhatTrienHeThong.pdf), trang 5, 14–15 | Tính đến con người, quy trình, môi trường; xác định vấn đề trước giải pháp. |
| [Chương 2](C:/Users/HUNG/Downloads/Chuong2_QuanTriYeuCauNguoiDung.pdf), trang 5–7, 12–13, 19–22, 26 | Vai trò, kịch bản, yêu cầu chức năng/phi chức năng, tính nhất quán và khả năng kiểm chứng. |
| [Chương 3](C:/Users/HUNG/Downloads/Chuong3_MoHinhHoa_QuyTrinhNghiepVu.pdf), trang 13, 17, 25–35 | Người thực hiện, trigger, điều kiện, nhánh xử lý và lỗi. |
| [Chương 4](C:/Users/HUNG/Downloads/Chuong4_ThietKeDuLieu.pdf), trang 3–4, 16, 29–31, 46–50 | Ngữ nghĩa, định danh, ràng buộc và dữ liệu lịch sử. |
| [Chương 5](C:/Users/HUNG/Downloads/Chuong5_ThietKeXuLy.pdf), trang 6, 13–14, 21–25 | Dữ liệu vào/ra, tiền/hậu điều kiện, đặc tả xử lý và tính nhất quán giữa các mức. |
| [Bàn giao API Logistics](D:/AI/OSS/LatticeOSS-workflow-integration/docs/logistics-ui-handoff.md) | Hợp đồng thực tế của Duy: quyền, payload, pagination, phiên bản và lỗi. |
| [Kết quả triển khai](D:/AI/OSS/LatticeOSS-workflow-integration/docs/logistics-workspace-deployment.md) | Foundation 0.8.0, luồng đã kiểm và giới hạn runtime. |

Các thông số giao diện và mục tiêu usability trong tài liệu này là đề xuất cho LatticeDX; không phải số liệu đo thực tế hay ngưỡng do slide quy định. Một số hình ở Chương 3 bị thiếu ngay trong PDF; không suy đoán nội dung bị thiếu.

Mỗi màn hình phải có: người dùng → mục tiêu → tiền điều kiện → dữ liệu → hành động → phản hồi thành công → ngoại lệ → tiêu chí kiểm tra. Mỗi tính năng mới phải ghi người phụ trách, phụ thuộc API và phiên bản đặc tả.

## 3. Vai trò và nguyên tắc phân quyền

| Vai trò nghiệp vụ | Mục tiêu chính | Ví dụ thao tác |
| --- | --- | --- |
| Nhân viên/sales | Tạo, theo dõi yêu cầu và đơn | Tạo đơn, gửi kho, theo dõi đơn của mình. |
| Nhân viên kho | Nhận công việc được giao | Xem đơn/tệp, nhập ghi chú, nhận việc. |
| Người quản lý/duyệt | Ra quyết định có căn cứ | Đọc yêu cầu, duyệt/từ chối theo policy. |
| Builder | Xây ứng dụng cho công ty | Vào Studio, cấu hình block và giao diện trong phạm vi được cấp. |
| Quản trị nền tảng | Quản trị cài đặt và vận hành | Plugin, cấu hình chung, thương hiệu và quản trị quyền. |

Đây là nhóm công việc để nghiên cứu UX, không phải một role kỹ thuật duy nhất. Một người có thể có nhiều quyền. Designer không được hard-code tên tài khoản demo thành quyền.

UX-P01: Chỉ hiển thị hành động được backend cho phép; backend kiểm tra lại khi thực thi.

UX-P02: Manifest và việc ẩn nút không phải cơ chế bảo mật. Quyền NocoBase quản trị/designer và quyền API nghiệp vụ phải được mapping rõ.

UX-P03: Settings trong Workspace mặc định là cài đặt cá nhân. Studio và quản trị nền tảng là entry riêng theo capability.

UX-P04: Công ty hiện tại luôn rõ. Bộ chọn công ty chỉ hiện khi tài khoản có membership hợp lệ ở nhiều công ty; chưa có hợp đồng chuyển scope thì chỉ hiện tên công ty, không có dropdown giả.

UX-P05: Khi chuyển công ty/tài khoản hợp lệ, xóa dữ liệu/cache thuộc scope cũ, đóng chi tiết, tải lại quyền và danh sách. Không mang bản nháp sang công ty khác. Nếu đang có lệnh chưa xác định kết quả, yêu cầu giải quyết trạng thái lệnh trước.

## 4. Phân loại mức sẵn sàng

| Nhóm | Trạng thái thực tế | Cách thiết kế |
| --- | --- | --- |
| Workspace chọn ứng dụng, Form/List, chi tiết mua sắm/Logistics, tệp, bridge | Có nền chức năng local | Thiết kế để thay diện mạo, giữ hợp đồng dữ liệu và hành vi. |
| Logistics Order tối thiểu | Có create/submit/receive và task liên kết | Tên trạng thái phải nói nhận việc, không khẳng định nhập/xuất kho. |
| Apps catalog | Hiện là manifest cấu hình sẵn | Có thể thiết kế gallery; quy trình xuất bản/registry và capability filtering tổng quát cần bổ sung. |
| Inbox đa ứng dụng, số đếm, “Tôi đã tạo”, tên người liên quan | API từng nguồn có một phần | Cần adapter/contract và policy rõ; không giả có endpoint tổng hợp. |
| Ghim/gần đây, lưu bộ lọc, global search | Cần phát triển UI và/hoặc dịch vụ | Prototype được; phân biệt lưu trên thiết bị với lưu theo tài khoản. |
| SSO, switch company, application lifecycle | Chưa hoàn thiện | Thiết kế bộ mở rộng riêng. |
| SLA/deadline/priority, notifications, activity feed, reports tổng hợp, AI | Chưa có đủ hợp đồng | Không đưa dữ liệu giả vào UI hoạt động. Ẩn hoặc đánh dấu trong prototype. |
| Shipment, tồn kho, vận tải | Ngoài Order tối thiểu đã kiểm | Không dùng mã/nhãn Shipment để mô tả Order hiện tại. |

“Có nền chức năng” không có nghĩa bố cục/interaction đề xuất đã được code. Quyền builder đầy đủ chưa được kiểm chứng; logo chung chưa được đổi.

## 5. Kiến trúc thông tin và điều hướng

Sidebar bản lõi:

| Mục | Ý nghĩa | Quy tắc |
| --- | --- | --- |
| Inbox / Công việc của tôi | Danh sách việc được phép đọc/xử lý | Là trang mặc định mục tiêu khi Inbox đủ dữ liệu; hiện chưa coi là thay thế route /lattice đã có. |
| Apps / Ứng dụng | Toàn bộ ứng dụng được phép dùng | Đây là danh sách đầy đủ; tên nghiệp vụ không cố định trong sidebar chung. |
| Reports / Báo cáo | Các báo cáo được cấp | Chỉ xuất hiện khi có cấu hình và nguồn dữ liệu. |
| AI Assistant | Trợ lý có ngữ cảnh | Chỉ bật khi có dịch vụ và quyền; prototype có nhãn Dự kiến. |
| Help / Trợ giúp | Hướng dẫn theo ngữ cảnh | Không hiển thị dashboard trống khi chưa có trung tâm trợ giúp. |
| Cài đặt cá nhân | Hồ sơ, tùy chọn hỗ trợ | Chỉ cho chỉnh các thuộc tính được chính sách cho phép. |

Thông báo đặt ở bell trên header; không cần thêm mục Notifications trùng nội dung trên sidebar bản lõi. Approval dùng bộ lọc trong Inbox; chưa tách thành menu riêng.

Khi mở ứng dụng: header cho biết Workspace → tên ứng dụng; sidebar/menu nghiệp vụ lấy từ cấu hình ứng dụng. Luôn có cách về Apps/Inbox. Builder đưa màn hình nghiệp vụ vào vùng content thông qua block/route đã đăng ký; không nhận component hoặc URL tùy ý không kiểm tra.

Route đề xuất cho prototype: /workspace/inbox, /workspace/apps, /workspace/apps/:appId, /workspace/settings/profile. Đây chưa phải route đang chạy. Route hiện có /lattice, /lattice/apps/purchasing, /lattice/apps/logistics cần được migration/redirect rõ nếu đổi; không làm hỏng liên kết đã lưu.

## 6. Khung giao diện và hệ thống thiết kế

### 6.1 Kích thước và phong cách

- Desktop thiết kế chính: 1440×900; kiểm thêm 1280×720 và 1920×1080. Không để thao tác chính nằm ngoài vùng sử dụng ở 1280×720.
- Header 56–64 px; sidebar mở 224 px, thu gọn 64 px; padding content 24 px desktop, 16 px tablet/mobile.
- Grid 8 px: spacing 4/8/12/16/24/32; gutter 16–24. Radius 8 px cho input/card, 12 px cho drawer/modal.
- Màu gợi ý: nền #F5F7FA; surface #FFFFFF; chữ chính #172B4D; chữ phụ #536579; primary #2563EB; border #D8E0EA. Đây là token thiết kế, cần kiểm tương phản theo từng cặp màu.
- Font sans-serif có đủ dấu Việt, ưu tiên hệ font hiện có trên host. Body 14–16 px, title trang 24–28 px, title section 18–20 px; chú thích 12–13 px nhưng không dùng chữ nhỏ cho nội dung quyết định nghiệp vụ.
- Màu semantic: xanh dương đang xử lý, xanh lá thành công, vàng cần chú ý/chờ quyết định, đỏ lỗi/quá hạn/từ chối. Luôn kèm chữ/icon; “chờ” không tự đồng nghĩa “khẩn cấp”.
- Icon line nhất quán 18–20 px; cùng một khái niệm dùng cùng icon. Không thêm đồ thị chỉ để trang trông đầy.
- Dùng lại component host nếu đáp ứng yêu cầu; style scoped vào vùng Lattice, không ghi đè CSS toàn bộ NocoBase.

### 6.2 Header

Trái: logo LatticeDX, Workspace; trong ứng dụng thêm tên ứng dụng/breadcrumb. Giữa: tìm kiếm/command palette. Phải: công ty, trạng thái kết nối nếu cần, bell nếu có dịch vụ, avatar và tên hiển thị.

Logo là định danh sản phẩm, không mở menu quản trị. Menu avatar: hồ sơ, tùy chọn, đăng xuất; entry Studio/quản trị chỉ với capability phù hợp.

Không biến nút “New Action” thành một hành động vô định. Nếu có launcher tạo mới, menu phải chỉ gồm thao tác đã đăng ký, có label và quyền rõ; với ít lựa chọn ưu tiên hành động trong ứng dụng.

Hiện hai phiên riêng: phân biệt “Phiên Workspace” và “Kết nối tài khoản nghiệp vụ”. Chưa có SSO thì không dựng UX giả đăng nhập một lần. Không hiện token, URL nội bộ hoặc mã lỗi kỹ thuật lên header.

### 6.3 Component phải giao

| Component | Variants/states bắt buộc |
| --- | --- |
| Button | Primary, secondary, tertiary, destructive; hover/focus/disabled/loading; label rõ. |
| Input/Textarea | Label, required, helper, filled, error, read-only, disabled; có đơn vị khi cần. |
| Select/Autocomplete | Loading, kết quả, không kết quả, lỗi tải, xóa lựa chọn; bàn phím. |
| Badge | Semantic status; label có ngữ nghĩa; không chỉ phân biệt bằng màu. |
| Tabs | Selected/focus, số đếm có nguồn, không số đếm khi chưa xác định. |
| Data table | Loading/empty/error, sort có hỗ trợ, pagination, row focus, permission-specific actions. |
| App card | Icon fallback, tên dài, mô tả, mở, action nhanh, ghim khi được hỗ trợ. |
| Drawer/Modal | Focus trap, close, unsaved confirmation, footer actions, mobile full-screen. |
| Toast/Inline alert | Success/info/warning/error; aria-live; lỗi quan trọng không tự biến mất. |
| Attachment | Upload progress, scanning, clean, rejected/error, download, permissions. |
| Audit timeline | Actor, action, thời điểm, nguồn, trạng thái thiếu dữ liệu; không giả activity tổng hợp. |
| Connection banner | Chưa kết nối, đang kết nối, hết phiên, service unavailable. |
| Skeleton/Empty state | Theo từng screen/section, có đường tiếp tục phù hợp. |

Mỗi component có props/slots, token, quy tắc hiển thị, accessibility, responsive và ví dụ sử dụng. Mọi spinner/icon/tooltip có accessible label phù hợp.

## 7. WS-01 — Inbox / Công việc của tôi

**Người dùng:** người có quyền đọc công việc. **Mục tiêu:** tìm và xử lý công việc của mình. **Tiền điều kiện:** phiên và quyền hợp lệ; nguồn dữ liệu có mapping đã xác nhận.

### 7.1 Thứ tự bố cục

1. Title “Công việc của tôi”, mô tả phạm vi dữ liệu.
2. Lối tắt ứng dụng thường dùng: tối đa 3–4 thẻ, có tiêu đề, nút thu gọn và link “Xem tất cả ứng dụng”.
3. Tabs lọc công việc.
4. Toolbar lọc/tìm kiếm, trạng thái cập nhật.
5. Bảng công việc và pagination.
6. Panel chi tiết xuất hiện khi mở một dòng.

Thẻ ứng dụng đặt **ngoài vùng tabs**, không khiến người dùng hiểu nhầm rằng thẻ là các công việc “Cần xử lý”. Nếu chưa có dữ liệu ghim/gần đây, title là “Lối tắt ứng dụng”, không tự nhận là ứng dụng dùng thường xuyên. Khi nhiều việc, người dùng có thể thu gọn; lựa chọn lưu theo scope hợp lệ.

Không thêm panel SLA/feed mặc định trong bản lõi. Inbox ưu tiên công việc; panel mở rộng phải có dữ liệu thật và thu gọn được.

### 7.2 Tabs và ý nghĩa

| Tab | Ý nghĩa mục tiêu | Điều kiện triển khai |
| --- | --- | --- |
| Cần xử lý | Người hiện tại có hành động cần thực hiện hoặc task được giao đang pending | Kết hợp policy workflow/task đúng ngữ nghĩa; không dùng chỉ một status để suy ra mọi loại công việc. |
| Đang thực hiện | Công việc đã nhận và còn bước tiếp theo trong định nghĩa của ứng dụng | Logistics hiện nhận việc làm task completed; received không được đưa vào tab này như thể có quy trình tiếp theo. |
| Đã hoàn thành | Phần trách nhiệm đã hoàn thành, hoặc quy trình kết thúc; phải ghi rõ loại nào | Thống nhất terminal states từng nguồn; không đồng nhất received với đã giao hàng. |
| Tôi đã tạo | Bản ghi/quy trình do tài khoản tạo | Không dùng /tasks assignee-only làm danh sách tất cả việc đã tạo. |

Chưa có mapping hoặc nguồn thì ẩn tab trong bản hoạt động; prototype được hiển thị với annotation phụ thuộc. Một hàng canonical cho một công việc; task và workflow liên kết không trở thành hai việc trùng cần xử lý. Phải thống nhất identity và quy tắc dedup giữa task/workflow.

### 7.3 Toolbar

- Search trong phạm vi công việc hiện tại; placeholder nói đúng khả năng tìm kiếm.
- Filter ứng dụng, trạng thái; người được giao/hạn/priority chỉ khi backend hỗ trợ.
- Có nút “Xóa bộ lọc”, chips cho bộ lọc đang dùng; reset offset khi thay filter.
- Search debounce đề xuất 350 ms, Enter tìm ngay. Cancel/ignore response cũ, không để kết quả truy vấn trước ghi đè truy vấn mới.
- “Cập nhật lúc …” phản ánh last success của section đó. Nút tải lại có accessible label; không làm mất filters.
- Sort chỉ hiện khi API hỗ trợ; không sort một trang rồi ngụ ý toàn bộ danh sách đã được sắp xếp.
- Không lấy task counts từ số dòng trang hiện tại. Nếu chưa có endpoint total, dùng label không số hoặc “Đã tải N việc”.

### 7.4 Bảng

| Cột | Yêu cầu |
| --- | --- |
| Công việc | Title có nghĩa, tối đa 2 dòng; mã nghiệp vụ nếu có thật. Title là link/button mở chi tiết. |
| Ứng dụng | Tên/icon từ nguồn ứng dụng, không suy đoán từ title. |
| Người liên quan | Label “Người tạo”/“Người được giao”; tên đã được phép đọc. Không tải toàn directory trái quyền để lấy tên. |
| Trạng thái | Label theo definition và trạng thái thực. |
| Hạn xử lý | Chỉ hiện khi có deadline/timestamp/timezone; “—” nếu không có và cột thật sự cần. |
| Thao tác | Một CTA theo availableTransitions/capability, menu phụ cho phần còn lại. |

Row desktop tối thiểu 56 px, tăng theo title/helper text. Không làm cả dòng một button chứa các button con. Checkbox chỉ hiện với batch action đã hỗ trợ và permission rõ.

Không ép mọi row có Duyệt/Từ chối. Người chỉ đọc có “Xem chi tiết”. Từ chối cần lý do và luồng xác nhận. Task Logistics phải dùng receive Order, không generic task approval.

Pagination: page size 10/20/50 phù hợp với limit API; trước/sau theo hasMore/nextOffset; không hiển thị số trang cuối/total giả. Khi dữ liệu thay đổi giữa trang, cho tải lại; không đảm bảo snapshot cố định với offset pagination hiện tại.

### 7.5 State variants

- First load: skeleton, không flash empty.
- Empty thực: “Bạn chưa có công việc trong mục này”; gợi ý Apps nếu hữu ích.
- Empty do filter: “Không có kết quả phù hợp”, nút xóa filter.
- Một nguồn lỗi trong Inbox tổng hợp: hiện nguồn lỗi và nguồn còn dùng được; không thông báo “không có việc” hoặc total hoàn chỉnh.
- Data stale khi refresh fail: giữ dữ liệu cũ chỉ khi cùng scope và được phép, đánh dấu chưa cập nhật; thao tác đọc lại version trước khi ghi.
- Hết quyền/đổi scope: dọn dữ liệu không còn được phép; không giữ stale cross-scope.
- Chi tiết đóng/quay lại: giữ tab/filter/page/scroll; đưa focus về hàng trước đó nếu còn tồn tại.

## 8. WS-02 — Apps / Ứng dụng

**Mục tiêu:** tìm và mở ứng dụng được cấp. **Nguồn hiện tại:** catalog manifest cấu hình sẵn. **Mục tiêu mở rộng:** registry ứng dụng đã xuất bản, được cấp quyền.

Layout: title, search, grid/list toggle nếu cần, sections toàn bộ/gần đây/đã ghim khi có lưu trữ, cards, trạng thái loading/error/empty. Không nhân đôi toàn catalog trên Inbox.

Card: icon hoặc fallback, tên, mô tả ngắn, “Mở ứng dụng”; tối đa một quick action được đăng ký và kiểm quyền. Tên dài wrap 2 dòng; có tooltip/chi tiết để đọc đầy đủ. Không tự cắt hai tên ứng dụng thành cùng chuỗi không phân biệt được.

| Ứng dụng mẫu | Quick action được phép theo role |
| --- | --- |
| Mua sắm | Tạo yêu cầu workflow nếu có quyền. |
| Logistics | Tạo đơn với sales; kho có thể chỉ mở ứng dụng. |
| Chi tiêu | Chỉ thêm khoản chi khi ứng dụng thực sự đăng ký thao tác và quyền. |

Trạng thái mục tiêu: ứng dụng sẵn sàng mở; quyền bị thu hồi; route không tồn tại; service tạm lỗi. Ứng dụng bị lỗi không được tự coi là bị xóa. Người không được cấp không thấy tên/dữ liệu nhạy cảm; deep link vẫn kiểm lại tại server.

Chưa có ứng dụng: hướng dẫn liên hệ người quản trị/builder. Không cho employee tự vào Studio chỉ vì gallery trống.

Ghim/gần đây phải scope theo tài khoản/công ty. Không lưu token hoặc dữ liệu nghiệp vụ nhạy cảm trong localStorage. Nếu dùng device-local preferences, ghi rõ chưa đồng bộ thiết bị.

## 9. WS-03 — Khung ứng dụng và chi tiết công việc

Mở chi tiết từ Inbox bằng drawer rộng 560–640 px trên desktop; có “Mở trang đầy đủ”. Chi tiết dài/phức tạp được mở trang đầy đủ trong ứng dụng. Tablet/mobile dùng drawer full-screen. Deep link khôi phục được chi tiết sau đăng nhập nếu còn quyền.

Thứ tự vùng: title/mã/trạng thái → thông tin người liên quan → dữ liệu cần quyết định → tệp → lịch sử → hành động. Footer hành động sticky không che nội dung/focus. Không dùng sticky quá nhiều vùng làm mất chiều cao đọc.

Các CTA quan trọng hiển thị người nhận hoặc tác động: “Gửi đơn cho kho”, “Nhận việc”, “Duyệt yêu cầu”. Không dùng chỉ “OK”, “Run”, “Submit”. Luôn giữ “Đóng/Quay lại”. Esc đóng nếu không có thay đổi hoặc lệnh pending; trường hợp còn dữ liệu/lệnh phải có guard tương ứng.

Lịch sử lấy audit thật của bản ghi. Hiện actor/name nếu có quyền và nguồn đáng tin; action, thời điểm/timezone, trạng thái sau xử lý. Version/UUID trong vùng thông tin bổ sung với copy. Không coi audit một đơn là activity feed toàn công ty.

UI giúp hiểu lịch sử: thông tin chứng từ tại thời điểm phát sinh không tự thay bằng danh mục hiện tại. Nếu nghiệp vụ cần giá/thuộc tính snapshot nhưng backend chưa có, yêu cầu bổ sung dữ liệu; không mô phỏng lịch sử bằng dữ liệu hiện tại.

## 10. WS-04 — Mẫu Logistics dùng API hiện có

### 10.1 Form tạo đơn

Form là mẫu áp dụng shared block; app-specific schema không đưa vào shell Workspace cố định. Chia section “Thông tin đơn”, “Người xử lý”, “Tệp đính kèm”. Desktop 2 cột nếu label/field vẫn dễ đọc; address và attachment full-width. Mobile 1 cột.

| Trường | Input/validation hiện tại | UX |
| --- | --- | --- |
| title | Required, string ≤200 code points | Label “Nội dung đơn”; ví dụ cụ thể, không thay label bằng placeholder. |
| customerName | Required, string ≤2000 | Text hiện tại; không dựng dropdown master customer giả. |
| deliveryAddress | Required, string ≤2000 | Textarea; giữ xuống dòng nếu hợp đồng xử lý hỗ trợ. |
| sku | Required, string ≤2000 | Text; chưa giả có tra cứu inventory. |
| quantity | JSON number, integer 1–1.000.000 | Numeric input, min/max/step; không tự làm tròn số lẻ. |
| warehouseAssigneeId | Subject active, cùng công ty, role kho | Chọn từ directory; label “Người kho nhận việc”; không bắt nhập UUID. |
| attachmentId | Optional UUID của tệp sạch được phép dùng | Người dùng upload/chọn tệp; ID kỹ thuật ở vùng bổ sung khi cần hỗ trợ. |

Directory loading/error/empty có state riêng. Lỗi dịch vụ: “Chưa tải được danh sách người kho”, cho thử lại; không mở nhập tùy ý để vượt kiểm tra. Không có người phù hợp: hướng dẫn liên hệ quản trị. Tên trùng cần thông tin phân biệt được phép đọc; không lấy email/sensitive fields mà API chưa cấp.

Validation sau blur hoặc submit; chưa đánh lỗi ngay ở field chưa chạm. Khi submit lỗi, đưa focus đến summary/field đầu tiên; giữ các giá trị hợp lệ. Frontend validation hỗ trợ người dùng, server vẫn quyết định.

CTA tạo: “Lưu đơn nháp”. Chỉ thiết kế nút “Lưu và gửi” khi nhóm xác nhận luồng hai lệnh và cách phục hồi; backend hiện create/submit riêng. Chưa có update/delete draft thì không đưa nút Lưu chỉnh sửa/Xóa/Hủy nghiệp vụ như chức năng sẵn có.

### 10.2 Trạng thái và hành động

| State API | Label UI | Ai và thao tác hiện có |
| --- | --- | --- |
| draft | Bản nháp | Chủ đơn sales được phép: Gửi đơn cho kho. Kho chưa thấy draft. |
| submitted | Đã gửi, chờ kho nhận việc | Đúng người kho được giao: Nhận việc; sales theo dõi theo quyền. |
| received | Kho đã nhận việc | Xem kết quả/ghi chú/lịch sử theo quyền; task linked completed. |

Không gọi received là đã giao khách, đã xuất kho hoặc shipment completed. Nếu muốn tab “Đang thực hiện” sau nhận việc cần nghiệp vụ/API tiếp theo, không suy ra từ demo.

Submit: trước khi gửi cho biết người kho và dữ liệu/tệp sẽ được chia sẻ. Có thể dùng confirmation ngắn một lần ở thao tác này; không hiện confirm cho mọi click.

Receive: yêu cầu receiptNote, hiển thị người được giao, CTA “Nhận việc”. Chỉ thực thi khi availableTransitions cho phép và expectedVersion đúng. Nếu người khác đã xử lý, báo rõ bản ghi thay đổi rồi tải lại.

Sau success: đọc lại detail/history, cập nhật row đúng scope, thông báo kết quả; không dùng snapshot replay làm trạng thái mới nhất. Task.recordId mở Order detail; không dùng generic record endpoint để né workflow policy.

## 11. WS-05 — Mẫu mua sắm

Thiết kế bằng cùng component; giữ definition, policy và fields hợp đồng workflow. Các bước đã có: draft → submitted → approved → received → accepted → handed_over; rejected là nhánh riêng khi phù hợp, không là bước tiếp theo bắt buộc.

Phân biệt “Tạo hồ sơ nền” với “Tạo yêu cầu workflow”; hành động nhanh chỉ mở luồng nghiệp vụ mà tên nút mô tả. Không đặt hai form dễ nhầm ở cùng vị trí ưu tiên.

Duyệt/từ chối: xem dữ liệu quan trọng và tệp trước quyết định; từ chối có lý do; hậu quả và người được nhận bước sau rõ. Các bước nhận hàng/nghiệm thu/bàn giao dùng fields backend yêu cầu và chỉ hiện khi hợp lệ.

Người nhận bàn giao hiện chưa có directory selector hoàn chỉnh. Prototype có thể vẽ selector nhưng phải ghi dependency; bản hoạt động không tự lấy UUID Employee thay Keycloak subject. Chưa đồng bộ assets registry thì không coi bàn giao workflow là cập nhật inventory/ERP.

## 12. WS-06 — Tệp đính kèm

- Trước chọn file: nêu tối đa 1 MiB và định dạng nếu có policy được xác nhận; không tự hứa mọi loại tệp có preview.
- Sau chọn: filename, size, bỏ lựa chọn; thao tác upload explicit, không upload tự động khó kiểm soát.
- Trong upload: progress nếu đo được, nếu không thì loading có label. Không dựng % giả.
- scan pending: “Đang kiểm tra tệp”; chưa dùng tệp như clean. clean: dùng/tải nếu có quyền. rejected/error: nói rõ tệp chưa dùng được, hành động tiếp theo phù hợp.
- API trả metadata cuối thì không mô phỏng scan realtime. Poll chỉ khi endpoint/policy hỗ trợ.
- Metadata/tải xuống kiểm quyền; không mở link public để vượt API.
- Upload timeout: kết quả chưa xác định; kiểm metadata/kết quả trước upload lại. Chưa có idempotency upload thì không auto retry.
- File được thêm bởi người khác không tự cấp quyền thay/thêm file vào hồ sơ đó.

## 13. WS-07 — Tìm kiếm, thông báo, báo cáo, AI

### 13.1 Tìm kiếm

Command palette Ctrl+K/Cmd+K chỉ kích hoạt khi focus không đang nhập trong trường nghiệp vụ. Có search label, Esc đóng, mũi tên/Enter, scope Apps/Tasks nếu các nguồn hỗ trợ. Chưa có global task search thì chỉ search app catalog hoặc nguồn đã có, placeholder phản ánh đúng phạm vi.

Logistics q hiện tìm title; không hứa tìm SKU, customer, nội dung tệp hoặc mọi mã chứng từ. Kết quả theo quyền; có loading/no result/error. Chỉ lưu recent queries khi chính sách privacy cho phép, theo scope.

### 13.2 Thông báo và activity

Chỉ triển khai sau khi có nguồn: id, recipient scope, type, title, timestamp, target, read state và pagination. Không dùng số badge hard-code. Click kiểm quyền/deep link mới nhất. Không coi bell là unread tasks nếu chưa định nghĩa rõ.

Hoạt động công ty cần policy riêng; không gom audit nhạy cảm của mọi người thành feed công khai. Gộp sự kiện lặp, hiển thị nguồn/thời gian; menu “Đánh dấu đã đọc” phải có API thật.

### 13.3 Báo cáo và SLA

Báo cáo do app đăng ký/cấu hình, có scope, period, timezone, unit/currency, lastUpdated; trạng thái zero khác unknown/error. Export chỉ khi có quyền và backend hỗ trợ.

SLA cần quy tắc start/pause/stop, lịch làm việc, timezone và deadline nguồn; một timestamp không đủ gọi là SLA. Deadline chưa có thì bỏ panel “Radar & SLA Timeline”, không tạo ví dụ giả trong bản chạy.

### 13.4 AI Assistant — thiết kế mở rộng

Panel mở theo yêu cầu, thu gọn được. Gợi ý theo ngữ cảnh: “Tóm tắt việc của tôi”, “Giải thích trạng thái đơn”, “Bước tiếp theo là gì?”. Kết quả kèm nguồn bản ghi được phép mở, thời điểm dữ liệu và cách kiểm tra.

Phân biệt read-only assistance và action proposal. Đề xuất ghi dữ liệu phải hiển thị đối tượng, thay đổi, người nhận và nút xác nhận; gửi qua service/API có quyền. Không biến văn bản AI thành lệnh tự chạy. AI không có quyền vượt người dùng.

Có thinking/cancel/error/insufficient-data state. Không hứa SLA, prediction, truy vấn đa app hoặc tự duyệt khi chưa có engine/tool contract. Chưa tích hợp thì ẩn entry trong bản hoạt động; nhãn “Dự kiến” dùng trong concept.

## 14. WS-08 — Hồ sơ, trợ giúp và cài đặt

Tên hiển thị đúng dấu, ví dụ Hưng. Hồ sơ cho xem công ty, tài khoản và quyền ở mức người dùng hiểu được; không đưa danh sách token/realm kỹ thuật làm UI mặc định.

Cho chỉnh language/timezone/preferences chỉ khi đã có persistence và policy. Đổi mật khẩu/identity dùng nguồn xác thực phù hợp; không giả NocoBase account và tài khoản nghiệp vụ đã hợp nhất.

Đăng xuất phải rõ phạm vi; hiện hai phiên thì phân biệt ngắt kết nối nghiệp vụ với sign out Workspace. Không hứa đăng xuất mọi ứng dụng/thiết bị nếu backend chưa hỗ trợ.

Trợ giúp theo screen/task; hướng dẫn đúng action/role hiện tại. Entry hỗ trợ có thể kèm error reference không nhạy cảm. Không xuất token, credentials hoặc dữ liệu công ty khác vào log/ticket.

## 15. Quy tắc tương tác và phục hồi chung

| Tình huống | Hành vi bắt buộc |
| --- | --- |
| Đang submit | Lock CTA, status có chữ; không chấp nhận double click. |
| Mất phản hồi sau ghi | Giữ key/body, khóa ý định mới; “Kết quả chưa xác định”, xem/kiểm tra hoặc retry đúng lệnh cũ. |
| Success/replay success | Tải detail mới; không suy trạng thái từ toast hoặc snapshot cũ. |
| 400 | Lỗi dữ liệu, giữ input; server chỉ trả lỗi chung thì báo chung, không đoán field sai. |
| 401 | Phân biệt host và bridge session; dọn dữ liệu trái quyền, kết nối lại; giữ return path hợp lệ. |
| 403 | Không có quyền; không coi là chưa tồn tại, không tạo đường bypass. |
| 404 | “Không tìm thấy hoặc bạn không có quyền truy cập”; không tiết lộ existence bằng thông báo khác. |
| 409 | Trạng thái/version/key xung đột; tải lại, giải thích và yêu cầu xác nhận ý định mới nếu cần. |
| 413 | Nêu giới hạn file trước và sau lỗi; cho chọn tệp khác. |
| 429 | Tạm hạn chế tần suất; dùng Retry-After nếu được cung cấp, không loop retry. |
| 5xx/network | Read có nút retry; write phải giữ trạng thái chưa xác định đúng semantics. |
| Bản nháp chưa gửi khi đóng | Confirm bỏ thay đổi; không hứa autosave nếu chưa có lưu draft. |
| Response đến muộn | Bỏ qua nếu khác actor/scope/record/query hoặc component đã unmount. |

Idempotency hiện trong bộ nhớ trang: reload/đóng/hết phiên có thể mất key. Designer cần lời nhắc kiểm tra kết quả trước khi tạo lại; muốn phục hồi bền vững phải chốt backend/client contract, không tự lưu business payload nhạy cảm xuống browser.

Không khóa app vô thời hạn bằng spinner. Timeout chuyển sang state rõ; tránh success toast rồi data failed làm người dùng hiểu toàn bộ lệnh thất bại. Phân biệt kết quả ghi đã xác nhận với lỗi refresh sau đó.

## 16. Responsive và accessibility

- Desktop ≥1200: sidebar mở, bảng; không bắt buộc panel phải luôn hiện.
- Tablet 768–1199: sidebar thu gọn/drawer; ưu tiên công việc/state/action; detail full-screen khi thiếu diện tích.
- Mobile <768: navigation drawer, application cards 1 cột; task cards gồm title/app/state/action; filter trong drawer; không chỉ thu nhỏ bảng desktop.
- Các breakpoint là đề xuất, kiểm trên content thật và zoom 200%; không khóa orientation.
- Target thiết kế WCAG 2.2 AA, cần kiểm bằng công cụ và người dùng; không tuyên bố đã đạt chỉ vì dùng component library.
- Văn bản thường tương phản tối thiểu 4.5:1, chữ lớn 3:1; control/focus phân biệt được. Mục tiêu vùng chạm chính mobile 44×44 px; icon-only không có accessible name là lỗi.
- Keyboard: tab order hợp lý, skip to content, Enter/Space theo loại control, Esc đóng an toàn, focus trap modal và trả focus khi đóng.
- Form label/programmatic association, required và error bằng text; error summary liên kết field. Loading/result được thông báo aria-live phù hợp.
- Status phải có text; animation nhẹ, hỗ trợ reduced motion. Không ép người dùng dựa vào hover để đọc dữ liệu bắt buộc.

## 17. Bản đồ tích hợp và dữ liệu UI

Browser dùng host APIClient → NocoBase bridge → gateway/API. Không giữ Keycloak bearer token trong browser hoặc cho người dùng nhập organization/owner/roles để cấp scope.

| UI | Bridge hiện có | API nguồn |
| --- | --- | --- |
| Catalog Apps | latticeApps:list | Manifest package, chưa registry xuất bản động. |
| Session/connection | auth:check, dxActions:status/connect/disconnect | Host + PKCE bridge. |
| Logistics list/detail | dxActions:logistics orders/detail | /v1/logistics/orders; detail :id. |
| Create/submit/receive | dxActions:logistics create/submit/receive | POST Order endpoints, key + expectedVersion. |
| Warehouse selector | dxActions:logistics people | /v1/directory/people; cần directory:read. |
| Task list/detail | dxActions:list tasks; logistics task | /v1/tasks, /v1/tasks/:id. |
| Procurement/inbox | dxActions:workflow | /v1/workflows theo definitionId/policy/inbox. |
| Audit | workflow/logistics history | /v1/workflows/:id/history. |
| Files | dxActions:files | /v1/files + metadata/content. |

Page contract hiện tại: items và page {limit, offset, hasMore, nextOffset}; limit 1–100, offset không âm. q tìm title/displayName theo endpoint. Không có tổng số chính xác trong contract. Directory là admin snapshot, không live revoke; không tự đồng bộ registry Employee/Department NocoBase.

Task view model mục tiêu (không phải payload đã có): stable key, appId, recordId, source type, title, businessCode nếu có, actor labels được phép đọc, canonical state, available actions, optional dueAt, lastUpdated, detail target. Adapter chỉ nhận registry source tin cậy; những field thiếu phải có contract/fallback rõ.

Inbox tổng hợp nhiều nguồn phải có quy tắc paging/count/sort/dedup thống nhất. Nếu client chỉ có trang dữ liệu từng nguồn, không tuyên bố đó là danh sách toàn bộ đã được globally paged/sorted. Có thể làm Inbox theo app trước hoặc thống nhất API tổng hợp với Duy.

Hưng: shell, components, render adapter, interaction, UI error/permission states. Duy: policy/API, enrichment, aggregation, version/idempotency và nguồn authoritative. Builder: cấu hình ứng dụng bằng capability của engine. Thành viên tích hợp sự kiện: connector/context theo phân công nhóm. Không tự thêm hoặc sửa API của người khác để chiều prototype.

## 18. Kịch bản và acceptance criteria

| ID | Given / When | Then |
| --- | --- | --- |
| AC-01 | Người có quyền vào Apps và chọn Logistics | Mở đúng ứng dụng, thấy identity/company đúng; back giữ vị trí gallery. |
| AC-02 | Sales nhập đơn hợp lệ và chọn người kho | Lưu draft thật; quantity number; người kho subject từ nguồn được phép. |
| AC-03 | Bấm Lưu liên tiếp hoặc retry sau mất phản hồi | Không tạo hai Order cho cùng key/ý định; trạng thái chưa xác định được trình bày rõ. |
| AC-04 | Chủ đơn gửi draft | Detail mới submitted, linked task đúng người; UI nói chờ kho nhận việc. |
| AC-05 | Đúng kho mở đơn submitted và nhận việc | Đơn received, linked task completed; lịch sử đúng; không ghi “đã giao hàng”. |
| AC-06 | Kho khác cùng công ty/công ty khác dùng list/deep link | Không xem/ghi đơn hoặc tải tệp trái quyền; không rò dữ liệu qua badge/search/feed. |
| AC-07 | Người duyệt mở mua sắm | Chỉ có action hợp lệ; từ chối yêu cầu reason; kết quả đọc lại từ backend. |
| AC-08 | Record bị xử lý ở tab khác trước submit | 409 được giải thích; dữ liệu mới được tải; không ghi đè im lặng. |
| AC-09 | Tệp quá lớn/rejected/pending | Không sử dụng/tải như clean; nêu cách xử lý, giữ nội dung form. |
| AC-10 | API đọc lỗi hoặc một nguồn Inbox tổng hợp lỗi | Error state rõ; không báo empty/total chính xác giả. |
| AC-11 | Lọc danh sách, mở chi tiết rồi quay lại | Giữ tab/filter/page/scroll; focus quay lại vị trí phù hợp. |
| AC-12 | Hết host/bridge session | Thông báo đúng phiên; reconnect/return path; không gửi lệnh trái quyền. |
| AC-13 | Thay query/actor/scope trong lúc request cũ đang chạy | Response cũ không ghi đè context mới. |
| AC-14 | Dùng keyboard và mobile | Hoàn thành các kịch bản chính, không mất action/field/focus. |
| AC-15 | Tính năng AI/SLA/notifications chưa được tích hợp | Không có hành động giả hoặc dữ liệu giả trong bản hoạt động. |

AC-16: Khi triển khai publish app, ứng dụng chưa publish hoặc không được cấp không xuất hiện với employee; deep link phải kiểm quyền. Đây là criterion có dependency, không tự đánh pass với catalog tĩnh hiện tại.

## 19. Mục tiêu usability và hiệu năng đề xuất

Đây là mục tiêu ban đầu để nhóm xác nhận sau nghiên cứu người dùng, không phải kết quả hiện tại:

- Ít nhất 90% người thử đại diện hoàn thành kịch bản cốt lõi không cần trợ giúp; báo cáo sample, role và lỗi, không dùng tỷ lệ này như chứng nhận thống kê.
- Tìm ứng dụng được yêu cầu trong 15 giây; tìm việc được giao trong 20 giây ở dataset thử được công bố.
- Mở công việc đến đúng panel trong tối đa 2 thao tác từ Inbox; đo tạo đơn/duyệt riêng, không đếm gõ từng ký tự là click.
- Không chấp nhận lỗi nghiêm trọng: sai đối tượng, lộ scope, tạo trùng, báo success khi chưa xác nhận hoặc thao tác sai quyền.
- Dùng bộ dữ liệu thử đủ lớn và tên dài, tên trùng, không có deadline, có nhiều ứng dụng. Kiểm filter/pagination vượt 100 hàng.
- Mục tiêu phản hồi visual khi click ≤100 ms; tương tác đọc phổ biến p95 ≤2 giây trong môi trường/network/data đã thống nhất. Slow request có loading; đo UI và server tách biệt.
- File scan/AI không ép vào cùng ngưỡng đọc danh sách; cần thông báo quá trình/thời gian theo dữ liệu thực.

Test usability dùng người đại diện sales, kho, quản lý và builder; không thay bằng developer tự thao tác. Quan sát first click, thời gian, tỷ lệ hoàn thành, lỗi, câu hỏi và độ tự tin sau thao tác. Chạy ít nhất hai vòng prototype để sửa lỗi nghiêm trọng; số người/từng vai trò xác định theo điều kiện thực tế.

## 20. Bộ deliverables dành cho designer

| Nhóm | Frame/flow cần giao |
| --- | --- |
| Foundations | Tokens, typography, icon rules, spacing, grid, accessibility notes. |
| Components | Variants ở mục 6.3, props/slots, keyboard và responsive. |
| Inbox | Desktop loaded/empty/filter-empty/loading/error/partial-source-error; drawer open; long names; expired session. |
| Apps | Grid, search, no-result, empty, permission change, app unavailable. |
| Logistics | Create valid/invalid/directory-error; draft/submitted/received; submit/receive; uncertain write và conflict. |
| Mua sắm | Detail trước duyệt, reject form, các bước cần fields và tệp; readonly khi thiếu action. |
| Files | Upload/scanning/clean/rejected/error/oversize/download forbidden. |
| Navigation | Back/deep link, unsaved form guard, long breadcrumb, mobile menu. |
| Profile/Help | Chỉ thuộc tính được hỗ trợ; identity source rõ. |
| Responsive | 1440×900, 1280×720, tablet 834×1112, mobile 390×844. |
| Extensions | AI/Reports/SLA/Notification/SSO/Company switch trong trang riêng, gắn dependency. |

Prototype phải nối được: Apps → Logistics → lưu draft → gửi → kho nhận việc; Inbox → mua sắm → duyệt/từ chối; filter → detail → back; lỗi → phục hồi. Có các prototype role/context riêng, không giả một nhân viên có mọi quyền.

Layer/frame đặt tên bằng mã WS/AC, không để Frame 123. Handoff gồm component specs, content dictionary, empty/error copy, state diagrams, API mapping và unresolved decisions. File thiết kế không chứa secrets hoặc dữ liệu doanh nghiệp thật.

## 21. Trình tự thực hiện và các quyết định phải chốt

1. Xác nhận vai trò và kịch bản cùng người dùng đại diện; ghi nhu cầu bằng ngôn ngữ công việc.
2. Đối chiếu policy/state/dữ liệu với Duy; chọn scope bản lõi có nguồn hỗ trợ.
3. Wireframe Inbox/Apps/detail, kiểm thứ tự thông tin và navigation.
4. Chốt design system và high-fidelity prototype, đầy đủ ngoại lệ.
5. Kiểm usability, sửa lỗi; cập nhật SRS/AC theo version.
6. Triển khai frontend qua plugin/block/client đã có; kiểm tích hợp và hồi quy app hiện tại.

Các quyết định chưa được coi là đã chốt:

- Inbox tổng hợp qua endpoint mới hay theo từng app trước; canonical task/workflow identity, counts và ordering.
- App registry/publish/capability metadata; quy tắc app hiển thị trên Apps.
- Identity và quyền builder, branding/admin; SSO và multi-company.
- Data enrichment tên người, mã nghiệp vụ và deadline/SLA.
- Persistence favorites/preferences/draft; audit/enrichment lịch sử.
- Báo cáo/notification/AI/event delivery và trách nhiệm thành viên.

Không tăng phạm vi chức năng chỉ vì designer thêm card/menu trong mockup. Mỗi thay đổi cần ghi lý do, tác động API/data/permission, người phụ trách và acceptance criteria. Phần chức năng local đã kiểm ở giai đoạn trước vẫn là baseline; bản này bổ sung đặc tả UX và không tự đánh dấu toàn bộ hệ thống đã nghiệm thu.

## 22. Brief có thể copy cho AI/designer

Thiết kế Workspace LatticeDX cho nhân viên doanh nghiệp, phong cách sáng, rõ, nhất quán với NocoBase. Trang chính là Inbox; Apps chứa các ứng dụng builder cấu hình. Giữ thẻ lối tắt gọn phía trên tabs, có thể thu gọn; tabs chỉ lọc bảng công việc. Sidebar không chứa module ERP cố định. CTA phải theo ứng dụng, vai trò và trạng thái: Logistics tạo/gửi/nhận việc; mua sắm duyệt/từ chối theo API. Không đặt Duyệt/Từ chối trên mọi dòng. Header có identity và công ty, không giả SSO hoặc company switching đã hoạt động. Thiết kế loaded/loading/empty/error/conflict/expired/uncertain-write và responsive. Có shared components, accessible labels, keyboard/focus, semantic colors. AI/SLA/notification/reports tổng hợp tách thành bộ dự kiến có dependency. Ưu tiên người dùng biết việc nào cần làm, cần thông tin gì, thao tác sẽ gây tác động gì và xử lý lỗi ra sao. Giao đầy đủ các frames và acceptance scenarios theo tài liệu này, không tự thêm nghiệp vụ hoặc API chưa được thống nhất.
