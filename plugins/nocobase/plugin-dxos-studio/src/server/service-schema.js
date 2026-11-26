/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const SERVICE_TYPES = ['leave', 'it_support', 'facilities', 'hr_request'];
const SERVICE_PRIORITIES = ['low', 'normal', 'medium', 'high', 'urgent', 'critical'];

const serviceTickets = {
  name: 'latticeServiceTickets',
  title: 'Phiếu dịch vụ nội bộ',
  titleField: 'name',
  origin: '@latticedx/plugin-dxos-studio',
  uiManageable: true,
  createdAt: true,
  updatedAt: true,
  fields: [
    { name: 'code', type: 'string', interface: 'input', allowNull: false, uiSchema: { type: 'string', title: 'Mã phiếu', 'x-component': 'Input' } },
    { name: 'name', type: 'string', interface: 'input', allowNull: false, uiSchema: { type: 'string', title: 'Tiêu đề phiếu', 'x-component': 'Input' } },
    { name: 'organizationId', type: 'string', interface: 'input', allowNull: false, uiSchema: { type: 'string', title: 'Mã tổ chức', 'x-component': 'Input' } },
    {
      name: 'serviceType',
      type: 'string',
      interface: 'select',
      defaultValue: 'it_support',
      allowNull: false,
      uiSchema: {
        type: 'string',
        title: 'Loại dịch vụ',
        'x-component': 'Select',
        enum: [
          { value: 'leave', label: 'Nghỉ phép / Công tác' },
          { value: 'it_support', label: 'Hỗ trợ CNTT' },
          { value: 'facilities', label: 'Cơ sở vật chất' },
          { value: 'hr_request', label: 'Hành chính Nhân sự' },
        ],
      },
    },
    {
      name: 'priority',
      type: 'string',
      interface: 'select',
      defaultValue: 'medium',
      allowNull: false,
      uiSchema: {
        type: 'string',
        title: 'Độ ưu tiên',
        'x-component': 'Select',
        enum: [
          { value: 'low', label: 'Thấp' },
          { value: 'normal', label: 'Bình thường' },
          { value: 'medium', label: 'Trung bình' },
          { value: 'high', label: 'Cao' },
          { value: 'urgent', label: 'Khẩn cấp' },
          { value: 'critical', label: 'Nghiêm trọng' },
        ],
      },
    },
    { name: 'description', type: 'text', interface: 'textarea', uiSchema: { type: 'string', title: 'Mô tả chi tiết', 'x-component': 'Input.TextArea' } },
    { name: 'status', type: 'string', interface: 'input', defaultValue: 'draft', allowNull: false, uiSchema: { type: 'string', title: 'Trạng thái', 'x-component': 'Input' } },
    { name: 'resolutionNote', type: 'string', interface: 'textarea', uiSchema: { type: 'string', title: 'Kết quả xử lý', 'x-component': 'Input.TextArea' } },
    { name: 'decisionReason', type: 'string', interface: 'input', uiSchema: { type: 'string', title: 'Ghi chú duyệt', 'x-component': 'Input' } },
    { name: 'version', type: 'integer', defaultValue: 1, allowNull: false },
    { name: 'submittedAt', type: 'date' },
    { name: 'submittedBy', type: 'string', interface: 'input', uiSchema: { type: 'string', title: 'Người trình duyệt', 'x-component': 'Input' } },
    { name: 'cancelledAt', type: 'date' },
    { name: 'cancelledBy', type: 'string', interface: 'input', uiSchema: { type: 'string', title: 'Người hủy chứng từ', 'x-component': 'Input' } },
    { name: 'cancelReason', type: 'string', interface: 'input', uiSchema: { type: 'string', title: 'Lý do hủy chứng từ', 'x-component': 'Input' } },
    { name: 'amendedFromId', type: 'bigInt' },
    { name: 'amendmentNo', type: 'integer', defaultValue: 0, allowNull: false },
    { name: 'active', type: 'boolean', defaultValue: true },
    { name: 'requester', type: 'belongsTo', target: 'latticeEmployees', foreignKey: 'requesterId' },
    { name: 'assignee', type: 'belongsTo', target: 'latticeEmployees', foreignKey: 'assigneeId' },
    { name: 'department', type: 'belongsTo', target: 'latticeDepartments', foreignKey: 'departmentId' },
  ],
  indexes: [
    { name: 'uidx_lattice_service_tickets_org_code', fields: ['organizationId', 'code'], unique: true },
    { name: 'idx_lattice_service_tickets_org_status_priority', fields: ['organizationId', 'status', 'priority'] },
    { name: 'idx_lattice_service_tickets_org_requester_status', fields: ['organizationId', 'requesterId', 'status'] },
    { name: 'idx_lattice_service_tickets_org_assignee', fields: ['organizationId', 'assigneeId'] },
    { name: 'idx_lattice_service_tickets_org_department', fields: ['organizationId', 'departmentId'] },
    { name: 'idx_lattice_tickets_org_amended', fields: ['organizationId', 'amendedFromId'] },
  ],
};

function failValidation(code, message) {
  return Object.assign(new Error(message || code), { code, status: 400 });
}

const getAttr = (model, key) => (typeof model?.get === 'function' ? model.get(key) : model?.[key]);
function setAttr(model, key, val, options) {
  if (typeof model?.set === 'function') model.set(key, val);
  else model[key] = val;
  if (Array.isArray(options?.fields) && !options.fields.includes(key)) options.fields.push(key);
}

function validateServiceTicket(model, options = {}) {
  const actor = options.context?.state?.latticeNativeActor;
  if (actor) {
    setAttr(model, 'organizationId', actor.organizationId, options);
    if (model?.isNewRecord) {
      setAttr(model, 'requesterId', actor.employeeId, options);
      setAttr(model, 'status', 'draft', options);
      setAttr(model, 'version', 1, options);
    }
  }
  for (const field of ['code', 'name', 'resolutionNote', 'decisionReason']) {
    const raw = getAttr(model, field);
    if (typeof raw === 'string') setAttr(model, field, raw.trim(), options);
  }
  const st = getAttr(model, 'serviceType') || (model?.isNewRecord ? 'it_support' : undefined);
  if (st !== undefined) {
    if (!SERVICE_TYPES.includes(st)) throw failValidation('SERVICE_TYPE_INVALID', 'Loại dịch vụ không hợp lệ.');
    setAttr(model, 'serviceType', st, options);
  }
  const prio = getAttr(model, 'priority') || (model?.isNewRecord ? 'medium' : undefined);
  if (prio !== undefined) {
    if (!SERVICE_PRIORITIES.includes(prio)) throw failValidation('SERVICE_PRIORITY_INVALID', 'Mức ưu tiên không hợp lệ.');
    setAttr(model, 'priority', prio, options);
  }
}

module.exports = { SERVICE_TYPES, SERVICE_PRIORITIES, serviceTickets, validateServiceTicket };
