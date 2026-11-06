# Enterprise login trên NocoBase native

## Phần đã triển khai

Plugin độc lập `@latticedx/plugin-enterprise-auth` bổ sung loại xác thực `lattice-keycloak` bằng public SDK NocoBase 2.2.38. `openid-client` 6.8.9 kiểm tra discovery/issuer, authorization code, PKCE S256, state, nonce và chữ ký ID token. Không dùng mã của plugin OIDC thương mại và không sửa core NocoBase.

Keycloak xác thực danh tính; `usersAuthenticators` ánh xạ subject với user native đã có. User phải gắn với một Employee đang hoạt động. Sau xác thực, `BaseAuth` của NocoBase phát hành phiên; quyền, đơn vị, dữ liệu và workflow tiếp tục dùng native ACL/collections. Không tự tạo user, không ghép email, không lấy role Keycloak để tự cấp quyền.

## Thử ngay tại local

1. Mở **http://localhost:13000/signin**, chọn **Đăng nhập doanh nghiệp**.
2. Trên Keycloak dùng `alice` / `local-alice-password` hoặc `manager` / `local-manager-password` — tài khoản fixture công khai, chỉ dùng local.
3. Đăng nhập thành công sẽ vào NocoBase bằng user tương ứng `native.lab.employee@example.invalid` hoặc `native.lab.manager@example.invalid`.
4. Mở **http://localhost:13000/admin/nativeuilabeb8c2601e3**. Vai trò và dữ liệu vẫn theo tài khoản native; nhân viên không được tự sửa builder hay mapping.
5. Đăng xuất bằng menu người dùng NocoBase. Để đổi người dùng SSO, cần đăng xuất/đổi tài khoản bên Keycloak nữa; phiên Keycloak còn hiệu lực có thể tự đăng nhập lại cùng người.

Quản trị native local vẫn dùng `admin@nocobase.com` / `admin123`. Đăng nhập thường được giữ làm đường dự phòng. Không dùng các mật khẩu fixture khi triển khai thật.

## Thêm block trong builder

Đăng nhập quản trị → mở trang native → bật **UI Editor** → **Add block → Other blocks → Enterprise login**. Block được lưu trong schema NocoBase, có mục sửa tiêu đề và xóa bằng công cụ native. Khi có nhiều authenticator enterprise đang bật, block cho chọn phương thức đăng nhập.

Block chỉ là điểm bắt đầu đăng nhập. Nó không cấp quyền, không quyết định bảo mật của trang và không tự biến một trang `/admin` thành trang công khai. Nút tương tự cũng có ở trang `/signin`, nên người chưa đăng nhập không cần truy cập trang admin để dùng SSO. Kiểm chứng builder hiện thực hiện trên trang native schema của UI Lab; chưa kiểm chứng builder V2/FlowModel cho block này.

## Cấu hình và ánh xạ

- Bật plugin trong Plugin Manager, rồi **Settings → Authentication → Authenticators → Add new → Enterprise login (Keycloak)**. Đặt tên và bật phương thức đó.
- **Settings → Authentication → Enterprise identity mappings**: root nhập tên authenticator, **Keycloak user ID (subject)** và **NocoBase user ID**. User native, Employee, đơn vị và role phải tồn tại trước. Tên tài khoản/email không phải subject.
- Nếu đã có mapping khác cho subject/user, thao tác trả 409; không âm thầm đổi người được liên kết. Root cần kiểm tra và xóa mapping cũ có chủ ý trước khi liên kết lại.
- Provider của bản đầu cấu hình ở deployment: `DX_NATIVE_AUTH_ISSUER`, `DX_NATIVE_AUTH_CLIENT_ID`, `DX_NATIVE_AUTH_ORIGIN`. Public client, chỉ authorization code + PKCE S256, redirect URI chính xác `<origin>/api/enterpriseAuth:callback`. Không nhập client secret vào block.
- `DX_NATIVE_AUTH_INTERNAL_ISSUER` chỉ phục vụ loopback → dịch vụ `keycloak:8080` của Docker local; issuer công khai vẫn được kiểm tra. HTTPS bắt buộc ngoài loopback, không tắt kiểm tra chứng chỉ.

## Khởi động và kiểm tra

```powershell
docker compose -f infra/compose/core.yml up -d postgres keycloak
node scripts/install-workspace.mjs
node scripts/setup-native-auth-lab.mjs
node scripts/acceptance-native-auth.mjs
```

Installer backup DB trước thay đổi, khôi phục dependency từ lockfile bằng `npm ci --ignore-scripts`, build rồi cài các plugin nội bộ. `npm pack` chứa cả thư viện OIDC và thông báo MIT của openid-client/oauth4webapi/jose; host SDK không được bundle. Script setup chỉ áp dụng local: tạo dedicated public client `dx-native`, authenticator và mapping cho hai user lab đã có; không đổi password, role hay client cũ. Có `--rehearsal` cho cổng 13001.

## Phạm vi và giới hạn

- Native app dùng một phiên NocoBase; bridge Keycloak cũ vẫn tồn tại cho consumer legacy, chưa hợp nhất toàn bộ `/lattice`.
- Bộ nhớ tạm/lock native local dùng cho state 5 phút và handoff 1 phút, gắn cookie HttpOnly, dùng một lần; không đưa bearer token vào URL. Cần cấu hình shared cache/lock và kiểm chứng trước khi scale nhiều process; bản hiện tại chưa sẵn sàng cho multi-instance.
- Logout hiện chấm dứt phiên NocoBase; chưa có RP-initiated/global/back-channel logout Keycloak hoặc đồng bộ thu hồi phiên tức thời từ provider. Thay đổi quyền/nhân viên tiếp tục chịu kiểm soát backend native.
- Đây là public-client adapter cho Keycloak, chưa phải bộ tích hợp mọi nhà cung cấp OIDC và chưa thay thế plugin OIDC Professional của NocoBase.
- Mã extension giữ giấy phép dự án; NocoBase và các thư viện có giấy phép riêng. Không đổi giấy phép upstream thành Apache chỉ vì dùng SDK.

Evidence: `output/native-platform/native-auth-acceptance.json`, `runtime-audit.json`, và bản rehearsal tương ứng. API acceptance là luồng HTTP thật; browser evidence được ghi riêng, không đánh đồng với E2E toàn bộ sản phẩm.
