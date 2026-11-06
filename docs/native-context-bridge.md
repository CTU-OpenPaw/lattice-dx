# Native data → NGSI-LD: hợp đồng tích hợp

Ngày 05/11/2026, foundation 0.24.0. Owner: Duy. Phạm vi: giai đoạn 5, đầu việc nối dữ liệu native với NGSI-LD. Không thay pages Hưng, workflow/AI/n8n Nhi hoặc adapter legacy.

## Nguồn dữ liệu và mapping

Nguồn chính vẫn là `latticeAssets`, `latticeDepartments`, `latticeLocations`. Khi tạo/cập nhật bằng repository native, hook ghi snapshot ngữ cảnh vào `latticeContextOutbox` trong **cùng transaction**. Dữ liệu tài khoản, nhân viên, khách hàng, chứng từ và ghi chú không gửi sang broker.

| Native collection | NGSI-LD type | ID |
| --- | --- | --- |
| latticeAssets | Asset | urn:ngsi-ld:Asset:{organizationId}:native:{id} |
| latticeDepartments | Department | urn:ngsi-ld:Department:{organizationId}:native:{id} |
| latticeLocations | Location | urn:ngsi-ld:Location:{organizationId}:native:{id} |

`organizationId` là mã định danh ASCII gồm chữ/số/gạch ngang/gạch dưới, tối đa 80 ký tự; record ID là số nguyên dương. Namespace `native` tránh đụng URN dữ liệu legacy. Không sửa organizationId của record đã có; chuyển đơn vị pháp nhân cần một migration chủ ý, không âm thầm đổi namespace và để lại entity cũ.

Thuộc tính chia sẻ: `businessId`, `organizationId`, `name`, `active`, `source=nocobase-native`, `sourceEventId`; Asset thêm `status`. `observedAt` lấy từ updatedAt thực sự được lưu. Quan hệ `belongsToDepartment`, `locatedAt` dùng URN native của cùng tổ chức. Cảm biến có thể bổ sung telemetry trên entity; sender chỉ merge thuộc tính mình sở hữu, không replace toàn entity. Quan hệ bị xóa được xóa tương ứng ở broker, tránh giữ dữ liệu cũ. Xóa record native phát tombstone `active=false`, không xóa toàn entity đang chứa telemetry của bên khác.

## Transaction, thứ tự và retry

- Hook sau lưu **đọc lại row trong transaction** trước khi tạo snapshot; tránh model cũ mang trường chưa đổi của một writer khác. Model save, repository save-with-associations và bulk FK update đều được theo dõi; native association set/remove được kiểm chứng.
- Event ID là SHA-256 của projection + identity + observedAt; unique constraint/findOrCreate chống enqueue trùng cùng snapshot. Không có journal nghiệp vụ hay workflow engine mới.
- Dispatcher lấy một event bằng PostgreSQL `FOR UPDATE SKIP LOCKED`; event cũ chưa delivered chặn event mới của cùng entity. Row lock được giữ trong request broker có ngân sách 7 giây, nên sender khác không vượt thứ tự.
- Broker lỗi: source transaction đã commit vẫn còn; event chuyển retry với backoff 1s → tối đa 5 phút. Sau 8 lần thất bại chuyển failed, chặn entity đó đến khi root retry. Entity khác vẫn gửi được.
- Nếu broker nhận rồi tiến trình chết trước commit acknowledgement, event sẽ gửi lại. Đây là **at least once**, upsert snapshot có thể lặp; không tuyên bố exactly once hoặc loại bỏ trùng notification phía consumer.
- NocoBase `cronJobManager` chạy một event mỗi 10 giây khi được bật. Không có timer/process/hàng đợi runtime riêng. Đây là mức tải nhỏ hiện tại; chưa benchmark cho lưu lượng lớn. Có thể gọi dispatch để xử lý thêm, vẫn chịu lock/thứ tự.
- Không đọc/bù lịch sử tự động. Record cũ được đồng bộ khi có thay đổi mới; backfill phải được lập và chạy riêng có kiểm chứng.

## Deployment

Compose native hiện có:

```yaml
DX_NATIVE_CONTEXT_BROKER_URL: http://orion-ld:1026
DX_NATIVE_CONTEXT_AUTO_SYNC: "true"
```

Sender dùng tenant từ row source, không nhận URL/tenant/organization từ request browser hay model. Broker hiện là dịch vụ private trên Docker network, port thử local bind loopback. Không cung cấp public ingress từ thay đổi này. Deployment khác cần cấu hình bảo mật/auth/network của broker tương ứng; không coi setup local là production-hardened.

Outbox là collection riêng không expose trong Collection Manager hay preset role. Quyền quản lý đồng bộ dùng native authenticated root và được kiểm lại trong handler.

## API vận hành dành cho root

Các endpoint đều dưới `/api/`, dùng phiên NocoBase native; response được host bọc `data`.

| Endpoint | Nội dung |
| --- | --- |
| GET latticeContextSync:status?page=1&pageSize=20 | items + total; chỉ trả ID, trạng thái, attempts, thời điểm và mã lỗi; không trả payload |
| POST latticeContextSync:dispatch | gửi tối đa một event đủ điều kiện; body `{}` hoặc `{ "eventId": "native-<sha256>" }` để chọn một event; vẫn không vượt predecessor/backoff |
| POST latticeContextSync:retry | `{ "eventId": "native-<sha256>" }`; reset retry/failed về pending ngay, không sửa snapshot |

State: pending → delivered hoặc retry → failed. Lỗi chỉ trả `BROKER_UNAVAILABLE` hoặc `BROKER_HTTP_<status>`, không đưa nội dung upstream/credential vào browser. Root status có phân trang và lọc `eventId`, `state`.

## Kiểm chứng

```powershell
node scripts/acceptance-native-context.mjs
node scripts/acceptance-native-context.mjs --auto
node --test plugins/nocobase/plugin-lattice-foundation/tests/native-context*.test.cjs
```

Manual suite dùng tenant test riêng; ghi/xóa chỉ fixtures của chính lần chạy. Kiểm thứ tự chính xác cần tránh sender khác tranh cùng fixture; chạy suite trên môi trường riêng với AUTO_SYNC=false khi cần kết quả lặp lại độc lập với tick cron. `--auto` cần AUTO_SYNC=true và xác minh không gọi API dispatch. Probe DB chỉ dùng fixture PostgreSQL local đã công khai, không lấy secret hay chạy SQL người dùng cung cấp.

Evidence: `output/native-platform/native-context-acceptance.json`, `native-context-auto-acceptance.json`. Các kiểm tra này là HTTP/DB/Orion thật, không thay cho nghiệm thu UI/AI/n8n.

## Bàn giao cho nhóm

**Hưng:** giữ pages/builder/blocks native của mình. Source API không đổi; nếu thêm status đồng bộ vào UI, dùng contract được Duy mở theo quyền riêng, không đưa root token vào UI nhân viên. Hiện status vận hành là root-only.

**Nhi:** lấy namespace native và thuộc tính/observedAt nêu trên khi cấu hình subscription/rule/tool. Không để luồng legacy và native cùng ghi những thuộc tính domain do native sở hữu. Ingress broker → rule/case, tool evidence và orchestration nghiệp vụ vẫn là đầu việc tiếp theo, chưa được coi đã hoàn thiện chỉ vì chiều native → broker chạy.

Giới hạn: chưa có replay/backfill lịch sử hoặc retention job; chưa có transaction phân tán giữa PostgreSQL và Orion; các thao tác bypass native hooks (raw SQL/hook disabled) phải do migration riêng chịu trách nhiệm. Trình duyệt/AI không tự điều khiển queue hoặc phê duyệt bằng các endpoint này.
