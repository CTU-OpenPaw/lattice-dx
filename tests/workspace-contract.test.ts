/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect } from 'vitest';
import {
  INITIAL_ACTION_REQUIRED_TASKS,
  INITIAL_DEMO_SHORTCUTS,
  MOCK_WAREHOUSE_STAFF,
  MAX_FILE_SIZE_BYTES,
  EICAR_STANDARD_TEST_STRING,
  validateOrderCreateInput,
  getScanStatusBadge,
  validateTaskDecisionInput,
  type TaskItem,
  type AppShortcutItem,
  type OrderCreateInput,
  type AttachmentItem,
} from '../packages/contracts/src/index.js';

describe('workspace contract and fixtures', () => {
  it('has exactly 3 actionable tasks in action-required state', () => {
    expect(INITIAL_ACTION_REQUIRED_TASKS).toHaveLength(3);
  });

  it('validates each actionable task has a primary action', () => {
    for (const task of INITIAL_ACTION_REQUIRED_TASKS) {
      expect(task.primaryAction).toBeDefined();
      expect(task.primaryAction?.label).toBeTruthy();
      expect(task.businessCode).toMatch(/^#(REQ|ORD|EXP)-\d+$/);
    }
  });

  it('verifies purchasing task requires rejection reason', () => {
    const purchasing = INITIAL_ACTION_REQUIRED_TASKS.find(t => t.appId === 'purchasing');
    expect(purchasing).toBeDefined();
    expect(purchasing?.primaryAction?.kind).toBe('approve');
    const rejectAction = purchasing?.secondaryActions?.find(a => a.kind === 'reject');
    expect(rejectAction?.requiresReason).toBe(true);
  });

  it('verifies logistics tasks match Duy and Hưng specification states', () => {
    const draftTask = INITIAL_ACTION_REQUIRED_TASKS.find(t => t.status === 'draft');
    expect(draftTask).toBeDefined();
    expect(draftTask?.primaryAction?.kind).toBe('submit_to_warehouse');

    const receiptTask = INITIAL_ACTION_REQUIRED_TASKS.find(t => t.status === 'awaiting_receipt');
    expect(receiptTask).toBeDefined();
    expect(receiptTask?.assignedTo).toBe('Hưng');
    expect(receiptTask?.primaryAction?.kind).toBe('receive_work');
    expect(receiptTask?.primaryAction?.requiresNote).toBe(true);
  });

  it('exposes exactly 3 standard demo app shortcuts', () => {
    expect(INITIAL_DEMO_SHORTCUTS).toHaveLength(3);
    const ids = INITIAL_DEMO_SHORTCUTS.map(s => s.id);
    expect(ids).toEqual(['purchasing', 'logistics', 'expenses']);
  });
});

describe('Task H04: Order Creation & ClamAV Attachment Validation', () => {
  const validOrderInput: OrderCreateInput = {
    title: 'Đơn hàng linh kiện viễn thông',
    customerName: 'Viettel Telecom',
    deliveryAddress: '285 Cách Mạng Tháng Tám, Quận 10, TP.HCM',
    sku: 'SKU-VT-992',
    quantity: 50,
    warehouseAssigneeId: 'staff-wh-01',
    note: 'Giao trong giờ hành chính',
    attachments: [
      {
        id: 'att-1',
        name: 'spec_sheet.pdf',
        size: 500000,
        scanStatus: 'clean',
        uploadedAt: new Date().toISOString(),
      },
    ],
  };

  it('validates a correct order input successfully', () => {
    const result = validateOrderCreateInput(validOrderInput);
    expect(result.isValid).toBe(true);
    expect(result.errors).toEqual({});
  });

  it('rejects missing or too short title', () => {
    const emptyTitleResult = validateOrderCreateInput({ ...validOrderInput, title: '' });
    expect(emptyTitleResult.isValid).toBe(false);
    expect(emptyTitleResult.errors.title).toBeDefined();

    const shortTitleResult = validateOrderCreateInput({ ...validOrderInput, title: 'Đơn' });
    expect(shortTitleResult.isValid).toBe(false);
    expect(shortTitleResult.errors.title).toBeDefined();
  });

  it('rejects missing customerName and deliveryAddress', () => {
    const res = validateOrderCreateInput({
      ...validOrderInput,
      customerName: '',
      deliveryAddress: '   ',
    });
    expect(res.isValid).toBe(false);
    expect(res.errors.customerName).toBeDefined();
    expect(res.errors.deliveryAddress).toBeDefined();
  });

  it('rejects invalid quantity values', () => {
    expect(validateOrderCreateInput({ ...validOrderInput, quantity: 0 }).isValid).toBe(false);
    expect(validateOrderCreateInput({ ...validOrderInput, quantity: -5 }).isValid).toBe(false);
    expect(validateOrderCreateInput({ ...validOrderInput, quantity: 1.5 }).isValid).toBe(false);
    expect(validateOrderCreateInput({ ...validOrderInput, quantity: 2000000 }).isValid).toBe(false);
  });

  it('enforces selecting active warehouse staff from directory (no manual UUID)', () => {
    expect(MOCK_WAREHOUSE_STAFF.length).toBeGreaterThanOrEqual(3);

    const emptyStaff = validateOrderCreateInput({ ...validOrderInput, warehouseAssigneeId: '' });
    expect(emptyStaff.isValid).toBe(false);
    expect(emptyStaff.errors.warehouseAssigneeId).toBeDefined();

    const nonExistentStaff = validateOrderCreateInput({
      ...validOrderInput,
      warehouseAssigneeId: 'unknown-uuid-999',
    });
    expect(nonExistentStaff.isValid).toBe(false);
    expect(nonExistentStaff.errors.warehouseAssigneeId).toContain('không hợp lệ');
  });

  it('enforces 1 MiB ClamAV attachment size limit', () => {
    expect(MAX_FILE_SIZE_BYTES).toBe(1048576);

    const oversizedFile: AttachmentItem = {
      id: 'att-oversized',
      name: 'huge_archive.zip',
      size: MAX_FILE_SIZE_BYTES + 1, // 1 byte over 1 MiB
      scanStatus: 'clean',
      uploadedAt: new Date().toISOString(),
    };

    const res = validateOrderCreateInput({
      ...validOrderInput,
      attachments: [oversizedFile],
    });
    expect(res.isValid).toBe(false);
    expect(res.errors.attachments).toContain('vượt quá kích thước tối đa cho phép (1 MiB)');
  });

  it('rejects attachments flagged as rejected by ClamAV', () => {
    const infectedFile: AttachmentItem = {
      id: 'att-malware',
      name: 'eicar_test.com',
      size: 68,
      scanStatus: 'rejected',
      scanDetails: 'FOUND Eicar-Signature',
      uploadedAt: new Date().toISOString(),
    };

    const res = validateOrderCreateInput({
      ...validOrderInput,
      attachments: [infectedFile],
    });
    expect(res.isValid).toBe(false);
    expect(res.errors.attachments).toContain('ClamAV phát hiện chứa mã độc');
  });

  it('provides correct visual metadata for all ClamAV scan statuses', () => {
    const cleanBadge = getScanStatusBadge('clean');
    expect(cleanBadge.label).toContain('An toàn');
    expect(cleanBadge.color).toBe('#166534');

    const scanningBadge = getScanStatusBadge('scanning');
    expect(scanningBadge.label).toContain('Đang quét');
    expect(scanningBadge.color).toBe('#D97706');

    const rejectedBadge = getScanStatusBadge('rejected');
    expect(rejectedBadge.label).toContain('Từ chối');
    expect(rejectedBadge.color).toBe('#991B1B');

    const errorBadge = getScanStatusBadge('error');
    expect(errorBadge.label).toContain('Fail-closed');

    const pendingBadge = getScanStatusBadge('pending');
    expect(pendingBadge.label).toContain('Chờ quét');
  });

  it('validates decision inputs: rejection requires reason, receipt requires note', () => {
    expect(validateTaskDecisionInput('reject', { reason: '' }).isValid).toBe(false);
    expect(validateTaskDecisionInput('reject', { reason: 'No' }).isValid).toBe(false);
    expect(validateTaskDecisionInput('reject', { reason: 'Không đạt tiêu chuẩn kỹ thuật' }).isValid).toBe(true);

    expect(validateTaskDecisionInput('receive_work', { receiptNote: '' }).isValid).toBe(false);
    expect(validateTaskDecisionInput('receive_work', { receiptNote: 'OK' }).isValid).toBe(false);
    expect(validateTaskDecisionInput('receive_work', { receiptNote: 'Đã nhận bàn giao lúc 14h' }).isValid).toBe(true);

    expect(validateTaskDecisionInput('approve', {}).isValid).toBe(true);
  });

  it('includes standard EICAR test string for safe validation testing', () => {
    expect(EICAR_STANDARD_TEST_STRING).toContain('EICAR-STANDARD-ANTIVIRUS-TEST-FILE');
  });
});

