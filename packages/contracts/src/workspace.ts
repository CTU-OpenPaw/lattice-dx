/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */

export type TaskStatus =
  | 'pending_approval'     // Chờ duyệt
  | 'draft'                // Bản nháp
  | 'awaiting_receipt'     // Chờ kho nhận việc
  | 'received'             // Kho đã nhận việc
  | 'completed';           // Đã hoàn thành

export type TaskActionKind =
  | 'approve'              // Duyệt (Mua sắm)
  | 'reject'               // Từ chối (Mua sắm)
  | 'submit_to_warehouse'  // Gửi đơn cho kho (Logistics)
  | 'receive_work'         // Nhận việc (Logistics)
  | 'view_details';        // Xem chi tiết

export interface TaskAction {
  kind: TaskActionKind;
  label: string;
  isPrimary: boolean;
  requiresReason?: boolean;
  requiresNote?: boolean;
}

export interface TaskItem {
  id: string;
  businessCode: string;
  title: string;
  appId: 'purchasing' | 'logistics' | 'expenses';
  appName: string;
  stakeholderLabel: string;
  status: TaskStatus;
  statusLabel: string;
  dueDateLabel?: string;
  primaryAction?: TaskAction;
  secondaryActions?: TaskAction[];
  assignedTo: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface AppShortcutItem {
  id: 'purchasing' | 'logistics' | 'expenses';
  name: string;
  description: string;
  quickActionLabel: string;
  quickActionKind: string;
  openUrl: string;
}

export interface UserSessionInfo {
  userId: string;
  displayName: string;
  email: string;
  companyName: string;
  roles: string[];
}

export interface TaskFilterParams {
  tab: 'action_required' | 'in_progress' | 'completed' | 'created_by_me';
  appId?: string;
  status?: string;
  query?: string;
  page: number;
  pageSize: number;
}

export const INITIAL_DEMO_SHORTCUTS: AppShortcutItem[] = [
  {
    id: 'purchasing',
    name: 'Mua sắm nội bộ',
    description: 'Yêu cầu, phê duyệt và mua sắm thiết bị',
    quickActionLabel: '+ Tạo yêu cầu',
    quickActionKind: 'create_request',
    openUrl: '/apps/purchasing',
  },
  {
    id: 'logistics',
    name: 'Logistics',
    description: 'Tạo đơn và giao việc vận chuyển kho',
    quickActionLabel: '+ Tạo đơn',
    quickActionKind: 'create_order',
    openUrl: '/apps/logistics',
  },
  {
    id: 'expenses',
    name: 'Quản lý chi tiêu',
    description: 'Theo dõi và báo cáo các khoản chi công ty',
    quickActionLabel: '+ Thêm chi tiêu',
    quickActionKind: 'add_expense',
    openUrl: '/apps/expenses',
  },
];

export const INITIAL_ACTION_REQUIRED_TASKS: TaskItem[] = [
  {
    id: 'task-req-204',
    businessCode: '#REQ-204',
    title: 'Duyệt yêu cầu mua laptop Dell XPS',
    appId: 'purchasing',
    appName: 'Mua sắm nội bộ',
    stakeholderLabel: 'Người tạo: An Nguyễn',
    status: 'pending_approval',
    statusLabel: 'Chờ duyệt',
    dueDateLabel: '18:00 hôm nay',
    assignedTo: 'Hưng',
    createdBy: 'An Nguyễn',
    createdAt: '2026-10-13T08:00:00Z',
    updatedAt: '2026-10-13T08:00:00Z',
    primaryAction: {
      kind: 'approve',
      label: 'Duyệt',
      isPrimary: true,
    },
    secondaryActions: [
      {
        kind: 'reject',
        label: 'Từ chối',
        isPrimary: false,
        requiresReason: true,
      },
    ],
  },
  {
    id: 'task-ord-101',
    businessCode: '#ORD-101',
    title: 'Gửi đơn phụ kiện Tân Bình',
    appId: 'logistics',
    appName: 'Logistics',
    stakeholderLabel: 'Người tạo: Hưng',
    status: 'draft',
    statusLabel: 'Bản nháp',
    dueDateLabel: '—',
    assignedTo: 'Kho Tổng',
    createdBy: 'Hưng',
    createdAt: '2026-10-13T09:15:00Z',
    updatedAt: '2026-10-13T09:15:00Z',
    primaryAction: {
      kind: 'submit_to_warehouse',
      label: 'Gửi đơn cho kho',
      isPrimary: true,
    },
  },
  {
    id: 'task-ord-098',
    businessCode: '#ORD-098',
    title: 'Nhận xử lý đơn Cần Thơ',
    appId: 'logistics',
    appName: 'Logistics',
    stakeholderLabel: 'Người được giao: Hưng',
    status: 'awaiting_receipt',
    statusLabel: 'Chờ kho nhận việc',
    dueDateLabel: '15/10',
    assignedTo: 'Hưng',
    createdBy: 'Trần Kho',
    createdAt: '2026-10-12T14:30:00Z',
    updatedAt: '2026-10-13T07:45:00Z',
    primaryAction: {
      kind: 'receive_work',
      label: 'Nhận việc',
      isPrimary: true,
      requiresNote: true,
    },
  },
];

export const MAX_FILE_SIZE_BYTES = 1048576; // 1 MiB strict limit

export type FileScanStatus = 'pending' | 'scanning' | 'clean' | 'rejected' | 'error';

export interface AttachmentItem {
  id: string;
  name: string;
  size: number;
  scanStatus: FileScanStatus;
  scanDetails?: string;
  downloadUrl?: string;
  uploadedAt: string;
}

export interface WarehouseStaffItem {
  id: string;
  name: string;
  email: string;
  department: string;
  warehouseLocation: string;
  active: boolean;
}

export interface OrderCreateInput {
  title: string;
  customerName: string;
  deliveryAddress: string;
  sku: string;
  quantity: number;
  warehouseAssigneeId: string;
  note?: string;
  attachments?: AttachmentItem[];
}

export interface OrderCreateValidationErrors {
  title?: string;
  customerName?: string;
  deliveryAddress?: string;
  sku?: string;
  quantity?: string;
  warehouseAssigneeId?: string;
  attachments?: string;
}

export const MOCK_WAREHOUSE_STAFF: WarehouseStaffItem[] = [
  {
    id: 'staff-wh-01',
    name: 'Trần Kho',
    email: 'trankho@latticedx.internal',
    department: 'Kho vận & Phân phối',
    warehouseLocation: 'Kho Sài Gòn (Tân Bình)',
    active: true,
  },
  {
    id: 'staff-wh-02',
    name: 'Nguyễn Văn B',
    email: 'vanb.nguyen@latticedx.internal',
    department: 'Kho vận & Phân phối',
    warehouseLocation: 'Kho Cần Thơ (Cái Răng)',
    active: true,
  },
  {
    id: 'staff-wh-03',
    name: 'Lê Văn C',
    email: 'vanc.le@latticedx.internal',
    department: 'Kho vận & Phân phối',
    warehouseLocation: 'Kho Tổng (Bình Dương)',
    active: true,
  },
];

export function validateOrderCreateInput(
  input: Partial<OrderCreateInput>,
  availableStaff: WarehouseStaffItem[] = MOCK_WAREHOUSE_STAFF
): { isValid: boolean; errors: OrderCreateValidationErrors } {
  const errors: OrderCreateValidationErrors = {};

  if (!input.title || input.title.trim().length < 5) {
    errors.title = 'Tiêu đề đơn hàng là bắt buộc và phải có ít nhất 5 ký tự.';
  }

  if (!input.customerName || input.customerName.trim().length === 0) {
    errors.customerName = 'Tên khách hàng / đơn vị nhận không được để trống.';
  }

  if (!input.deliveryAddress || input.deliveryAddress.trim().length === 0) {
    errors.deliveryAddress = 'Địa chỉ nhận hàng không được để trống.';
  }

  if (!input.sku || input.sku.trim().length === 0) {
    errors.sku = 'Mã mặt hàng (SKU) không được để trống.';
  }

  if (
    input.quantity === undefined ||
    input.quantity === null ||
    typeof input.quantity !== 'number' ||
    isNaN(input.quantity) ||
    !Number.isInteger(input.quantity) ||
    input.quantity < 1 ||
    input.quantity > 1000000
  ) {
    errors.quantity = 'Số lượng phải là số nguyên dương từ 1 đến 1,000,000.';
  }

  if (!input.warehouseAssigneeId) {
    errors.warehouseAssigneeId = 'Vui lòng chọn nhân viên kho phụ trách nhận việc.';
  } else {
    const staff = availableStaff.find(s => s.id === input.warehouseAssigneeId && s.active);
    if (!staff) {
      errors.warehouseAssigneeId = 'Nhân viên kho đã chọn không hợp lệ hoặc không còn hoạt động.';
    }
  }

  if (input.attachments && input.attachments.length > 0) {
    for (const file of input.attachments) {
      if (file.size > MAX_FILE_SIZE_BYTES) {
        errors.attachments = `Tệp "${file.name}" vượt quá kích thước tối đa cho phép (1 MiB).`;
        break;
      }
      if (file.scanStatus === 'rejected') {
        errors.attachments = `Tệp "${file.name}" bị ClamAV phát hiện chứa mã độc hoặc vi phạm an toàn, không thể đính kèm.`;
        break;
      }
    }
  }

  return {
    isValid: Object.keys(errors).length === 0,
    errors,
  };
}

export function getScanStatusBadge(status: FileScanStatus): {
  label: string;
  color: string;
  bg: string;
  border: string;
  icon: string;
} {
  switch (status) {
    case 'pending':
      return {
        label: 'Chờ quét',
        color: '#64748B',
        bg: '#F1F5F9',
        border: '#CBD5E1',
        icon: '⏳',
      };
    case 'scanning':
      return {
        label: 'Đang quét ClamAV...',
        color: '#D97706',
        bg: '#FEF3C7',
        border: '#FDE68A',
        icon: '🔄',
      };
    case 'clean':
      return {
        label: 'An toàn (Clean)',
        color: '#166534',
        bg: '#DCFCE7',
        border: '#BBF7D0',
        icon: '🛡️',
      };
    case 'rejected':
      return {
        label: 'Từ chối (Malware)',
        color: '#991B1B',
        bg: '#FEE2E2',
        border: '#FECACA',
        icon: '🚫',
      };
    case 'error':
      return {
        label: 'Lỗi scanner (Fail-closed)',
        color: '#C2410C',
        bg: '#FFEDD5',
        border: '#FED7AA',
        icon: '⚠️',
      };
  }
}

export function validateTaskDecisionInput(
  actionKind: TaskActionKind,
  input: { reason?: string; receiptNote?: string }
): { isValid: boolean; error?: string } {
  if (actionKind === 'reject') {
    if (!input.reason || input.reason.trim().length < 3) {
      return { isValid: false, error: 'Lý do từ chối là bắt buộc (tối thiểu 3 ký tự).' };
    }
  }
  if (actionKind === 'receive_work') {
    if (!input.receiptNote || input.receiptNote.trim().length < 3) {
      return { isValid: false, error: 'Ghi chú tiếp nhận đơn hàng là bắt buộc (tối thiểu 3 ký tự).' };
    }
  }
  return { isValid: true };
}
