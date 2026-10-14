# Timer và danh tính dịch vụ

Workflow có transition `execution:"service"`; transition này không xuất hiện trong inbox/availableTransitions và public transition API không thực thi được. Bước `timers.schedule` ở cuối transition cấu hình `{afterSeconds,serviceId,transitionId,input}`; afterSeconds1–604800, yêu cầu workflow:schedule. Không đồng thời wait task/connector và timer ở cùng transition. Target phải là service transition từ state đích, không ownerOnly/assigneeField.

Timer giữ definitionVersion/runVersion và input snapshot, clock DB tính dueAt. Khi đến hạn, worker lấy serviceId từ bảng profile được deployment quản trị, rồi đọc người/roles active từ directory trên cùng connection. Cần workflow:service +target role +quyền đọc run và capabilities của từng block. Không dùng JWT/roles của owner đã lưu, không tự cấp quyền đọc entity hoặc file.

Profile không có public CRUD. GET `/v1/workflow-services` chỉ workflow:design, trả ID/enabled không subject/token. Quản trị provisioning profile và current directory từ nguồn tin cậy; module import không tạo mappings. Default worker tắt; đặt `WORKFLOW_TIMER_WORKER=true` khi đã cấu hình profile và quyền. Worker single-flight, shutdown drain. CLI/local smoke gọi tickOne trong fixture, không có public tick endpoint.

GET `/v1/workflows/:id/timers` dùng current run read ACL/phân trang. POST `/:id/timers/:timerId/retry` body `{expectedVersion:run.version}`, key và workflow:sync +runread. Retry chỉ timer failed còn tương thích version/state; dueattempt đọc lại quyền hiện tại. Attempts tối đa3, backoff giới hạn; sanitized error code không có secrets. Failed timer giải phóng waiting để người dùng xử lý/cancel; chuyển state làm retry cũ409.

Một transaction runlock→timerlock→profile/directorysharelocks→transition effects/audit/receipt→timerresult. Savepoint rollback effect nếu thất bại. Nhiều tick chỉ một thực thi; crash trước commit không để lại effect. Cancel kết thúc timer trong transaction run, không phục hồi bằng lease/retry cũ. Connector chỉ enqueueoutbox; không có HTTP trong transaction và không hứa hủy effect đã gửi ra ngoài.

Kiểm chứng `pnpm test:workflow-timers`: signed service listing, actualPG currentprofileauthority/publicservice403, raceexactoneeffect, disabledsource no effect +retry quyền mới, receiptfailure rollback/recovery, cancel vàmax1restart. Snapshotdirectory freshness khác live upstream revocation, cần sync quản trị rõ ràng.
