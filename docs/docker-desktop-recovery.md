# Docker Desktop trên Windows — socket startup recovery

## Sửa bằng bản Docker chính thức — 14/10/2026

Máy đã nâng cấp tại chỗ từ **4.64.0.221278** lên **4.94.0.241994**, Engine **29.8.2**. Maintainer Docker thông báo nhóm lỗi này được sửa từ 4.92 trong [issue #625](https://github.com/docker/desktop-feedback/issues/625#issuecomment-5909191315); kênh appcast chính thức cung cấp 4.94.0 tại lúc kiểm tra. Bộ cài lấy từ `desktop.docker.com`, SHA256 `a9814e31049d66156477a86614e83365669677733014ec72f74229623ff3890a`, chữ ký Authenticode Valid của Docker Inc; installer exit0.

Kiểm chứng: ba lần khởi động bằng **Docker Desktop.exe gốc**, gồm hai vòng orderly stop → start, đều Engine ready. Không gọi launcher phục hồi, không đổi tên/xóa socket trong các vòng này. Bốn named volumes và bảy container trước nâng cấp vẫn tồn tại. Startup HKCU Run đã trả về Docker Desktop.exe; installer đã trả shortcut Desktop về chương trình gốc. Không reset, prune, unregister distro hoặc di chuyển data disk. VHDX đang được tham chiếu qua junction tới `E:\Docker\wsl\disk`; đường này được giữ nguyên.

Đây là bản sửa upstream đã được kiểm chứng cho lỗi tái diễn khi restart trên máy hiện tại. Chưa kiểm chứng Windows reboot/logon trong lượt này; không tự reboot máy. Script phục hồi cũ vẫn giữ để tham khảo/khôi phục bản Docker cũ, nhưng đường startup thường ngày không còn phụ thuộc nó. Artifacts/log/settings backup nằm trong `output/docker-upgrade` được ignore.

## Lịch sử phục hồi trên 4.64

Máy Duy: Docker Desktop 4.64.0, Linux engine 29.2.1, Windows 11 build 26200. Log xác nhận lỗi socket reparse point `Docker/run/dockerInference` và từng có `docker-secrets-engine/engine.sock`. Backend chết trước khi engine sẵn sàng. Chưa có bằng chứng lỗi do chuyển ổ data; driver afunix đang running, ổ C/E/D NTFS healthy.

Lỗi tương tự còn được báo tại [Docker issue #625](https://github.com/docker/desktop-feedback/issues/625). Tắt Docker AI hoặc chỉ đổi tên socket một lần không bảo đảm hết tái diễn. Đây là cách phục hồi có kiểm soát, **không phải bản vá cho Docker/Windows**.

```powershell
pnpm docker:start
pnpm docker:stop
pnpm docker:restart
pnpm local:up
```

Script `scripts/docker-desktop.ps1` kiểm tra Engine với timeout. Nếu Engine đã chạy thì không đụng runtime. Khi startup có log xác nhận lỗi socket, script xác nhận Engine không khả dụng, dừng đúng tiến trình từ thư mục cài Docker, chờ chúng thoát, giữ hai thư mục runtime dưới tên `*-stale-<timestamp>` rồi tạo runtime mới và thử lại một lần. Không động đến VHDX, volume, image, WSL distro hoặc thư mục source. Lỗi khác không kích hoạt sửa tiếp. Stop/Restart dùng `docker desktop stop --timeout 55`; nếu dừng sạch thất bại thì không force-stop Engine đang chạy.

Trên máy Duy đã cài bản launcher độc lập tại `%LOCALAPPDATA%/LatticeDX/docker-desktop.ps1`, trỏ shortcut Desktop `Docker Desktop.lnk` và HKCU Run `Docker Desktop` tới launcher đó. Bản gốc shortcut và giá trị Run giữ tại `%LOCALAPPDATA%/LatticeDX/`. Vì launcher là bản sao, cập nhật repo không tự đổi bản local. Dùng `pnpm docker:restart` khi cần restart; nút restart trong Docker/tray vẫn dùng đường khởi động upstream và có thể gặp lại lỗi.

Khôi phục startup trước đây: lấy `Value` trong `docker-startup-before.json` đặt lại HKCU Run `Docker Desktop`, rồi copy `Docker Desktop.original.lnk` về Desktop. Không cần xóa archive runtime để dùng dự án. Không tự dọn archive hoặc chạy factory reset/prune để xử lý lỗi này.

Kiểm chứng: hai vòng orderly stop → startup tái hiện lỗi → launcher giữ runtime lỗi → Engine sẵn sàng; cả bốn volume lattice-dx vẫn có. Chưa thử Windows reboot/logon ở lượt này. Sau khi nhà cung cấp sửa socket lifecycle, có thể bỏ launcher và kiểm tra lại đường startup chuẩn.
