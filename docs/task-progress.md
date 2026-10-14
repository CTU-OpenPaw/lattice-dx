# Tiến độ Lattice — ghi chú bàn giao

Cập nhật: 2026-10-13. Phân biệt phần đã code, phần đã kiểm tra trên runtime và phần còn thiếu. Không coi các phép thử local là chứng nhận production.

14/10/2026: sau review của Hưng, Foundation 0.9.0 tách Workspace/application runtime dùng chung khỏi panel mẫu, dùng contract/view/catalog registry. Thêm app thứ ba được kiểm bằng test contract giả; hai workflow thật và native builder hồi quy PASS. Xem [cơ chế mở rộng](workspace-extension-runtime.md). Đây chưa phải App Registry/publish UI hay engine dựng mọi nghiệp vụ bằng zero-code.

Trên nhánh tích hợp feat/nocobase-workflow-integration, PR #5 đã bổ sung source API procurement/onboarding, membership và shared evidence. [Checkpoint tích hợp](workflow-integration-checkpoint.md) ghi mốc chỉ code, trước khi triển khai runtime.

Cập nhật sau phê duyệt deploy: API mới + bridge và UI procurement đã chạy trên runtime cũ với Foundation 0.7.0; luồng browser tạo/gửi/duyệt/nhận/nghiệm thu/bàn giao và shared file PASS. Outbox worker vẫn tắt. Xem [triển khai mua sắm](procurement-workflow-deployment.md); đây không phải nghiệm thu Order/Shipment logistics hoặc onboarding UI.

Cập nhật tiếp: PR #6 (863bf8f) đã được tích hợp local; Foundation 0.8.0 chạy trên NocoBase 2.2.22. Logistics tạo đơn → gửi đơn → đúng người kho nhận việc, directory, tệp chia sẻ và pagination server đã được kiểm trên API/browser. Procurement vẫn PASS. Xem [báo cáo Logistics](logistics-workspace-deployment.md) để phân biệt nhận việc với xử lý tồn kho/vận chuyển thật.

## Tổng quan sáu bước

| Bước | Trạng thái | Kết quả hiện có |
| --- | --- | --- |
| 1. Plugin nền tảng | Đã làm trong phạm vi demo | Package Foundation, build/cài/bật trên NocoBase; collection Department, Employee, Location, Asset; migration và seed hai đơn vị. |
| 2. Cấu hình ứng dụng và API nghiệp vụ | Đã có hai luồng trong phạm vi demo | Procurement và Logistics Order tối thiểu nối API thật; chưa có Shipment/inventory và onboarding UI. |
| 3. Workspace và API client | Đã làm phần chức năng | Chọn ứng dụng, điều hướng, đăng nhập/đăng xuất, kết nối tài khoản nghiệp vụ, loading/lỗi và xử lý phiên. Giao diện hiện là bản cơ bản. |
| 4. Form/list dùng chung | Đã làm phần chức năng | Form cấu hình, quantity số nguyên, directory selector, bảng lọc/phân trang server; đăng ký và lưu binding Form/List trong native builder. |
| 5. Mẫu nghiệp vụ hoàn chỉnh và tệp | Đã triển khai phần có API; còn blocker nghiệp vụ | Hai mẫu dùng block chung, upload/scan/download thật và giao việc sang tài khoản kho cùng đơn vị đã PASS; chưa phải quy trình Order/Shipment hoàn chỉnh. |
| 6. Kiểm tra tích hợp toàn bộ | Đã kiểm phần sẵn sàng; chưa nghiệm thu toàn sản phẩm | Test dự án/plugin, browser, API, scanner và native builder PASS; các workflow/API còn thiếu được đánh dấu chưa kiểm được. |

## Những việc chưa hoàn thành / giới hạn cần giữ lại

### Bước 1

- [ ] Kiểm chứng migration trên dữ liệu nâng cấp thực tế, ngoài kiểm tra lặp lại seed local.
- [ ] Chốt mapping nhân viên với tài khoản nghiệp vụ và chính sách phân quyền đa đơn vị thực tế.
- [ ] Chốt có cần đồng bộ collection nền tảng trong NocoBase với database API nghiệp vụ không. Hiện không được giả nhận hai nguồn đã đồng bộ.

### Bước 2

- [x] Duy cung cấp API procurement/onboarding qua PR #5; procurement đã nối bridge/UI và kiểm end-to-end.
- [x] Logistics Order có definition/API/bridge/UI cho draft → submitted → received và linked task completed.
- [ ] Shipment, tồn kho và xử lý hàng thực tế; onboarding mới có backend, chưa có UI trong phạm vi này.
- [ ] Phân biệt tạo generic record/task với tạo đơn hàng, vận chuyển và duyệt nghiệp vụ thật. Chưa tuyên bố các workflow đó hoàn tất.
- Manifest hiện được cấu hình bằng file; chưa có trình sửa manifest tổng quát trên giao diện.

### Bước 3

- [ ] Hoàn thiện giao diện sau sáu bước theo quyết định của người dùng.
- [ ] Chốt cấu hình origin/auth khi triển khai ngoài local; cấu hình đã thử là runtime local.
- NocoBase và tài khoản nghiệp vụ là hai phiên riêng, chưa phải đăng nhập một lần (SSO).
- Chưa xây Workspace riêng hoàn chỉnh cho client-v2; đã đăng ký FlowModel native cho block trên runtime hiện tại.

### Bước 4

- [x] Thử thêm Form/List, lưu binding và tải lại trên trang native thử riêng; UI và model lưu qua API PASS. Schema trang cũ không đổi.
- [x] Form/List dùng phân trang/lọc API; smoke backend kiểm 106 bản ghi qua hai trang. Procurement lọc definitionId trên server.
- [ ] Bổ sung các kiểu trường và nghiệp vụ cần cho bước 5; không coi các form record/task hiện tại là bộ form tổng quát cho mọi collection.

### Bước 5

- [x] Logistics Order dùng Form/List chung; procurement có panel workflow chuyên biệt dùng chung API client/command controller.
- [x] Kinh doanh tạo/gửi đơn và đúng tài khoản kho nhận việc qua API thật. Chưa thực hiện xuất kho/giao vận.
- [x] Tích hợp tải tệp và liên kết tệp vào bản ghi qua dịch vụ thật; metadata/download và byte đọc lại PASS.
- [x] Khởi động ClamAV healthy; tệp thử scan clean; kiểm giới hạn 1 MiB và quyền riêng chủ tệp.
- [x] Kinh doanh giao task liên kết hồ sơ; tài khoản kho riêng cùng đơn vị đọc task qua UI.
- [x] PR #6 kiểm assignee active cùng đơn vị, directory snapshot, chia sẻ hồ sơ/tệp theo task và phân loại Logistics Order. Generic records vẫn là hồ sơ nền.

### Bước 6

- [x] Kiểm xuyên suốt phần tạo/đọc/task/tệp đã có API; nghiệp vụ chuyển trạng thái mua sắm/Order/Shipment vẫn chưa kiểm được.
- [x] Kiểm quyền API, hết phiên bridge thật, lỗi mô phỏng, chống gửi lặp và hồi quy phản hồi muộn. Chưa load test/production certification.
- [x] Kiểm block dùng chung qua hai ứng dụng và native builder lưu/reload binding.
- [x] Ghi [báo cáo bước 6](lattice-step6.md), lệnh chạy và giới hạn còn lại. Chưa nghiệm thu phần API còn thiếu.

## Bằng chứng hiện có

- Bước 2: [cấu hình ứng dụng](lattice-application-config.md), [lưu form end-to-end](lattice-form-e2e.md).
- Bước 3: [Workspace](lattice-workspace.md).
- Bước 4: [block và các phép kiểm](lattice-blocks.md).
- Bước 5: [mẫu ứng dụng, tệp và blocker](lattice-step5.md).
- Bước 6: [kiểm tra tích hợp](lattice-step6.md).
- Sau bước 6: 20 Node tests Foundation/bridge và 96 Vitest tests PASS; browser file, hai tài khoản và builder binding PASS.
- Browser đã tạo record/task thật, đọc lại bảng; SQL xác nhận liên kết. Native builder thêm/lưu block trên trang thử riêng, không sửa schema trang cũ.
- Runtime đã thử: NocoBase 2.2.22, Foundation 0.6.0. Compose riêng trong repo pin 2.2.20 chưa được chạy trong lần này.

## Git và nguyên tắc tiếp tục

- Nền code e8d7635; checkpoint bước 1–6 được lưu trên nhánh feat/nocobase-foundation-config theo xác nhận mới của người dùng. Xem git log -1 trên nhánh để lấy SHA; không coi checkpoint là nghiệm thu các API/workflow còn thiếu.
- [x] Tạo nhánh riêng để commit tiến độ trước khi tích hợp PR #5 của Duy. Chưa push, chưa merge PR hoặc đổi runtime trong thao tác checkpoint.
- Bước 5 và 6 đã được người dùng xác nhận, đã triển khai/kiểm phần sẵn sàng; vẫn chờ API còn thiếu. Mỗi bước tiếp theo phải trình bày việc sẽ làm trước.
- Không reset dữ liệu hoặc xóa các bản ghi cũ để làm phép thử PASS.

## Thuật ngữ

- Manifest: file mô tả ứng dụng dùng route, collection, block và action nào.
- Binding: cấu hình nối một block với ứng dụng/nguồn dữ liệu cụ thể.
- End-to-end: thử từ thao tác giao diện qua API tới dữ liệu thật và kiểm kết quả.
- Workflow: chuỗi trạng thái và thao tác nghiệp vụ, ví dụ tạo đơn rồi duyệt/giao kho.
- Production: môi trường dùng thật, cần kiểm bảo mật và vận hành ngoài demo local.
