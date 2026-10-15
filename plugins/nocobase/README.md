# NocoBase plugins

Vị trí dành cho plugin do nhóm phát triển. [Action Bridge](action-bridge/README.md) cung cấp server-side account linking và proxy action, đã thử với runtime 2.2.20; phần đọc dữ liệu/tệp mở rộng được kiểm trên 2.2.22.

[Foundation](plugin-lattice-foundation/README.md) bổ sung bốn collection Department, Employee, Location, Asset, seed hai đơn vị mẫu và Workspace/Form/List dùng chung. Build trước khi chạy Compose; collection nền chưa đồng bộ với API Data. Xem [tiến độ và giới hạn](../../docs/task-progress.md).

Bản nguồn upstream đã clone riêng tại `upstream/nocobase/` để khảo sát. Xem [ghi nhận nguồn và giấy phép](../../docs/nocobase-source-review.md). Toàn bộ nền tảng NocoBase không phải plugin để đặt vào thư mục này.

Chỉ thêm plugin sau khi chọn phiên bản NocoBase có giấy phép phù hợp và kiểm chứng SDK của phiên bản đó. Mỗi plugin là một package độc lập trong thư mục con, với README, manifest và thông tin giấy phép.
