# Kiến trúc LatticeDX

Luồng nghiệp vụ native chạy trên NocoBase. Quản trị viên cấu hình collections, trang, biểu mẫu, quyền và workflow trong cùng môi trường. Workspace hiển thị các trang người dùng được cấp quyền và mở hộp công việc của NocoBase.

## Ranh giới thực thi

| Thành phần | Trách nhiệm |
| --- | --- |
| NocoBase và PostgreSQL native | Lưu cấu hình trang, collections, ACL, hồ sơ và lịch sử workflow. Thực thi CRUD, kiểm quyền theo vai trò/trường/phạm vi dữ liệu, chạy workflow và manual task. |
| Foundation | Cài mô hình nghiệp vụ, migration và guard về thành viên, tổ chức và tham chiếu. Cung cấp API nhận sự kiện, đồng bộ ngữ cảnh và lưu đề xuất có bằng chứng. |
| Enterprise Login và Keycloak | Đăng nhập doanh nghiệp khi cấu hình provider. ACL nghiệp vụ vẫn được kiểm tra trên phiên native. |
| Core API và kho tệp chung | Xử lý lưu/quét tệp khi bật overlay tệp. NocoBase kiểm quyền hồ sơ trước khi gọi API nội bộ. PostgreSQL core và kho tệp có phạm vi backup riêng. |
| Orion-LD và n8n | Orion-LD phục vụ ngữ cảnh Asset. n8n kết nối hệ thống qua webhook/API. Quy trình phê duyệt native do NocoBase thực thi. |
| API, Action Bridge và `/lattice` legacy | Duy trì luồng và dữ liệu cũ trong giai đoạn chuyển đổi. Kiểm tra caller, dữ liệu và luồng tương đương trước khi chuyển điểm ghi. |

Với luồng yêu cầu nội bộ, nhân viên gửi hồ sơ qua biểu mẫu native. API kiểm quyền và phạm vi tổ chức, sau đó workflow native tạo công việc cho quản lý. Quản lý xử lý công việc qua hộp việc native. Cấu hình workflow, hồ sơ và lịch sử xử lý được lưu trong PostgreSQL của NocoBase.

Với tích hợp sự kiện, connector ghi vào inbox qua API có quyền. Workflow native có thể nhận sự kiện từ inbox. Agent có thể đọc dữ liệu theo quyền hiện hành và gửi đề xuất kèm bằng chứng để người có quyền xử lý. Việc ghép nguồn sự kiện, workflow và model thật cần nghiệm thu theo từng kịch bản.

## Bàn giao và nghiệm thu

- [Cài sạch và thử native](native-clean-install.md) dựng môi trường riêng từ source đã commit. Lượt ghép PR #45, #47 và #48 ngày 09/11/2026 đã xác nhận cài ba plugin, chạy mười migration, 31 kiểm API nền/workflow và phạm vi quyền HTTP của bảy vai trò.
- [Workspace theo vai trò](native-workspace-roles.md) mô tả đường vào `/admin/lattice-workspace`, dữ liệu thử và kiểm tra trên trình duyệt.
- Trên môi trường nhóm, commit `bd75225` của PR #51 đã qua luồng nhân viên tạo yêu cầu, quản lý duyệt và kho hoàn thành. Hồ sơ `PR51-TEAM-20261112-01` vẫn ở `completed` sau khi tải lại và công việc của kho xuất hiện trong **Đã xử lý**. Bản ghép vào `main` là `991de11`. [CI sau merge](https://github.com/CTU-OpenPaw/lattice-dx/actions/runs/43437463966)
- [Khôi phục database native](native-database-recovery.md), [kho tệp chung](native-shared-file-storage.md) và [khôi phục store legacy](recovery.md) ghi rõ phạm vi từng bộ dữ liệu.
- [Ingress và proposal tools](native-integration-tools.md) mô tả hợp đồng cho workflow, n8n và agent. Nghiệm thu bản bàn giao cần chạy lại browser, đăng nhập doanh nghiệp, kho tệp và luồng broker/n8n/model trên cùng bản ghép.
- [Nguồn và giấy phép](third-party.md) phân biệt mã nhóm, image dịch vụ và source upstream tham chiếu. [Thiết kế DX-OS](dx-os-minimum-design.md) ghi lại mục tiêu ban đầu của dự án.
