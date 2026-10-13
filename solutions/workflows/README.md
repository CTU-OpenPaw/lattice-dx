# Workflow definitions

`definitions.ts` khai báo hai quy trình version 1: `procurement` và `onboarding`. API dùng chung runtime trong `apps/api/src/workflows`; cấu hình chỉ khai báo trạng thái, role, input và event.

Không sửa version đã có run đang dùng. Muốn phát triển quy trình mới, bổ sung định nghĩa và policy/acceptance tests; cơ chế chọn version mới chưa được xây dựng. Cấu hình được quản lý trong source, chưa nhận cấu hình không tin cậy từ người dùng.

Xem [API và hướng dẫn tích hợp](../../docs/workflow-runtime.md), [thiết kế](../../docs/superpowers/specs/2026-10-12-phase-two-workflow-design.md) và [kế hoạch triển khai](../../docs/superpowers/plans/2026-10-12-phase-two-workflow-runtime.md).
