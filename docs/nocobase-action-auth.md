# NocoBase → LatticeDX: xác thực action

Ngày 12/10/2026. Plugin nhóm `@latticedx/plugin-action-bridge`, đã thử trên NocoBase 2.2.20.

```text
Đăng nhập NocoBase → dxActions:connect
  → đăng nhập Keycloak (Authorization Code + S256 PKCE)
  → callback kiểm tra state và cookie cùng trình duyệt
  → plugin giữ access token phía server
  → block gọi catalog/run → Gateway → API kiểm tra quyền và đơn vị
```

Đây là **kết nối tài khoản, chưa phải SSO**. Người dùng chủ động đăng nhập hai hệ thống; không tự ánh xạ email hoặc biến NocoBase admin thành Keycloak admin. Quyền tác nghiệp lấy từ Keycloak; quyền vào plugin lấy từ NocoBase.

Token Keycloak không trả cho browser/URL/localStorage hoặc lưu database. Cookie `dx_action_connection` ngẫu nhiên, HttpOnly/SameSite=Lax, scope `/api`, gắn với NocoBase user ID. Hai trình duyệt dùng cùng user không tự chia sẻ token. Pending state một lần, tối đa hai phút; phiên token tối đa năm phút hoặc thời hạn token nếu ngắn hơn. Timer dọn state/token hết hạn; restart cần kết nối lại. Không giữ refresh token. Status phản ánh connection local; Gateway/API vẫn kiểm tra access token khi gọi.

Disconnect hủy cả callback đang trao đổi code, nhưng không revoke/đăng xuất Keycloak toàn hệ thống hoặc rollback action đã bắt đầu. Code nhóm không log token/password/code; cần rà logging upstream trước deployment thật.

## Khởi động local

```powershell
cd E:\pmnm2026
pnpm install --frozen-lockfile
pnpm infra:up
pnpm test:infra
pnpm identity:sync-local
pnpm nocobase:up
pnpm test:nocobase
pnpm nocobase:bridge:install
pnpm test:nocobase:bridge
```

Local sync tạo/cập nhật client `dx-nocobase`: public client, code flow, bắt buộc PKCE S256, exact redirect URI, audience `dx-api` và claim đơn vị; password/implicit grant tắt. Giữ user/password/volume, nhưng cập nhật client local này về fixture. Không dùng admin fixture trên môi trường khác.

Compose mount plugin read-only vào container; CLI `pm enable` lưu trạng thái trong database. Package tồn tại sau recreate nhờ mount. NocoBase Compose không tự dựng core. Không dùng `--remove-orphans` hoặc `down -v` để giải quyết cảnh báo hai Compose cùng project.

Smoke dùng NocoBase admin và Keycloak Alice fixture **trong tiến trình test**, thực hiện code flow thật, tạo một record rồi giữ dữ liệu. Không dùng password grant cho bridge hoặc đưa password vào UI; chưa kiểm chứng client block.

## API cho Hưng

Base cùng origin: `/api/dxActions:<action>`. Private routes cần bearer NocoBase; sau kết nối còn cần cookie trình duyệt. Plugin trả JSON trực tiếp, không bọc `{data:...}`; Axios response vẫn có `.data`.

| Action | Method / input | Kết quả |
| --- | --- | --- |
| `connect` | POST | `{authorizationUrl}`, đặt cookie HttpOnly |
| `callback` | GET do Keycloak redirect với code/state | Link connection, redirect cố định `/admin` |
| `status` | GET | `{connected:false}` hoặc `{connected:true,identity:{subject,username},expiresAt}` |
| `catalog` | GET | `{items:[...]}` theo quyền API |
| `run` | POST `{actionId,version,input}` | `{actionId,version,status:"succeeded",result}` |
| `disconnect` | POST | Xóa connection/cookie, `{connected:false}` |

Ví dụ dùng API client NocoBase sẵn có trong block:

```typescript
const { data } = await app.apiClient.request({
  url: 'dxActions:connect', method: 'post',
});
window.location.assign(data.authorizationUrl);
```

Lưu cấu hình trước khi rời trang. Sau callback, gọi status và hiển thị **tài khoản Keycloak đang kết nối** trước khi cho chạy action. Không nhúng password hoặc token fixture vào block.

```typescript
const { data } = await app.apiClient.request({
  url: 'dxActions:run', method: 'post',
  data: { actionId: 'tasks.create', version: 1,
    input: { title: 'Kiểm tra thiết bị', assigneeId: '<Keycloak subject>' } },
});
// Hiển thị data.result; khóa nút khi request đang chạy.
```

Hưng cần viết UI kết nối/trạng thái, chọn action/form và lỗi; server plugin chưa cung cấp màn hình.

## Lỗi và giới hạn

400: state/code/input sai; 401: thiếu identity/link, hết hạn hoặc bị hủy; 403: thiếu quyền/phạm vi; 405: sai method; 502: lỗi/timeout/malformed upstream; 503: thiếu cấu hình/capacity. Action/Gateway có thể trả 404/409/413/429. Plugin giữ status phù hợp nhưng không trả body lỗi upstream có thể chứa token.

Timeout có thể xảy ra **sau khi action đã ghi**: không tự retry creation, chưa có idempotency/journal. Memory store một process, tối đa 1000 pending/in-flight/linked; không phục vụ nhiều replica hoặc giữ session qua restart. Cần session store an toàn, TLS, lifecycle/logout và review deployment trước dùng môi trường chia sẻ. Callback yêu cầu HTTPS ngoài localhost; Compose HTTP/credential fixture chỉ dùng local.

Code plugin nhóm là original Apache-2.0, LICENSE được giữ riêng; SDK/runtime upstream vẫn có điều khoản riêng. Không claim audit an toàn hoặc license compliance toàn nền tảng.
