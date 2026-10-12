# NocoBase plugins

Vị trí dành cho plugin do nhóm phát triển. Plugin đầu tiên: [Action Bridge](action-bridge/README.md), server-side account linking và proxy action, đã thử với runtime 2.2.20. Chưa có client block nghiệp vụ của nhóm.

Bản nguồn upstream đã clone riêng tại `upstream/nocobase/` để khảo sát. Xem [ghi nhận nguồn và giấy phép](../../docs/nocobase-source-review.md). Toàn bộ nền tảng NocoBase không phải plugin để đặt vào thư mục này.

Chỉ thêm plugin sau khi chọn phiên bản NocoBase có giấy phép phù hợp và kiểm chứng SDK của phiên bản đó. Mỗi plugin là một package độc lập trong thư mục con, với README, manifest và thông tin giấy phép.
