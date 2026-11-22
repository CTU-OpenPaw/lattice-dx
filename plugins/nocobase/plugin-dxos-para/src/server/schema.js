/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { normalizeSearchText, computeDeterministicEmbedding } = require('./para-hybrid-search');
const PARA_SPACES = ['projects', 'areas', 'resources', 'archives'];
const PARA_STATUSES = ['draft', 'active', 'archived'];

const paraDocuments = {
  name: 'latticeParaDocuments',
  title: 'Kho tri thức P.A.R.A.',
  titleField: 'title',
  origin: '@latticedx/plugin-dxos-para',
  uiManageable: true,
  createdAt: true,
  updatedAt: true,
  fields: [
    { name: 'code', type: 'string', interface: 'input', allowNull: false, uiSchema: { type: 'string', title: 'Mã tài liệu', 'x-component': 'Input' } },
    { name: 'title', type: 'string', interface: 'input', allowNull: false, uiSchema: { type: 'string', title: 'Tiêu đề', 'x-component': 'Input' } },
    { name: 'organizationId', type: 'string', interface: 'input', allowNull: false, uiSchema: { type: 'string', title: 'Mã tổ chức', 'x-component': 'Input' } },
    {
      name: 'paraSpace',
      type: 'string',
      interface: 'select',
      defaultValue: 'projects',
      allowNull: false,
      uiSchema: {
        type: 'string',
        title: 'Phân vùng P.A.R.A.',
        'x-component': 'Select',
        enum: [
          { value: 'projects', label: 'Projects (Dự án)' },
          { value: 'areas', label: 'Areas (Lĩnh vực duy trì)' },
          { value: 'resources', label: 'Resources (Tài nguyên)' },
          { value: 'archives', label: 'Archives (Lưu trữ)' },
        ],
      },
    },
    { name: 'summary', type: 'string', interface: 'textarea', uiSchema: { type: 'string', title: 'Tóm tắt', 'x-component': 'Input.TextArea' } },
    { name: 'contentMarkdown', type: 'text', interface: 'markdown', uiSchema: { type: 'string', title: 'Nội dung tài liệu', 'x-component': 'Markdown' } },
    { name: 'tags', type: 'string', interface: 'input', uiSchema: { type: 'string', title: 'Thẻ phân loại', 'x-component': 'Input' } },
    {
      name: 'status',
      type: 'string',
      interface: 'select',
      defaultValue: 'active',
      allowNull: false,
      uiSchema: {
        type: 'string',
        title: 'Trạng thái',
        'x-component': 'Select',
        enum: [
          { value: 'draft', label: 'Bản nháp' },
          { value: 'active', label: 'Đang sử dụng' },
          { value: 'archived', label: 'Đã lưu trữ' },
        ],
      },
    },
    { name: 'attachmentUrl', type: 'string', interface: 'url', uiSchema: { type: 'string', title: 'Liên kết đính kèm', 'x-component': 'Input' } },
    { name: 'relatedCollection', type: 'string', interface: 'input', uiSchema: { type: 'string', title: 'Bảng liên quan', 'x-component': 'Input' } },
    { name: 'relatedRecordId', type: 'string', interface: 'input', uiSchema: { type: 'string', title: 'ID bản ghi liên quan', 'x-component': 'Input' } },
    { name: 'active', type: 'boolean', defaultValue: true },
    { name: 'version', type: 'integer', defaultValue: 1, allowNull: false },
    { name: 'searchText', type: 'text' },
    { name: 'embeddingJson', type: 'jsonb', defaultValue: [] },
    { name: 'department', type: 'belongsTo', target: 'latticeDepartments', foreignKey: 'departmentId' },
    { name: 'owner', type: 'belongsTo', target: 'latticeEmployees', foreignKey: 'ownerId' },
  ],
  indexes: [
    { fields: ['organizationId', 'code'], unique: true },
    { fields: ['organizationId', 'paraSpace', 'status'] },
    { fields: ['organizationId', 'ownerId', 'active'] },
    { fields: ['organizationId', 'departmentId'] },
  ],
};

function failValidation(code, message) {
  return Object.assign(new Error(message || code), { code, status: 400 });
}

function getAttr(model, key) {
  return typeof model?.get === 'function' ? model.get(key) : model?.[key];
}

function setAttr(model, key, value, options) {
  if (typeof model?.set === 'function') model.set(key, value);
  else model[key] = value;
  if (Array.isArray(options?.fields) && !options.fields.includes(key)) options.fields.push(key);
}

function isSafeAttachmentUrl(raw) {
  if (raw == null || raw === '') return true;
  if (typeof raw !== 'string') return false;
  const trimmed = raw.trim();
  if (!trimmed) return true;
  if (/[\r\n\0]/.test(trimmed)) return false;
  if (trimmed.startsWith('/')) return !trimmed.startsWith('//') && !trimmed.includes('..');
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

function validateParaDocument(model, options = {}) {
  const actor = options.context?.state?.latticeNativeActor;
  if (actor) {
    setAttr(model, 'organizationId', actor.organizationId, options);
    if (model?.isNewRecord) setAttr(model, 'ownerId', actor.employeeId, options);
  }

  for (const field of ['code', 'title', 'summary', 'tags']) {
    const val = getAttr(model, field);
    if (typeof val === 'string') setAttr(model, field, val.trim(), options);
  }

  const paraSpace = getAttr(model, 'paraSpace') || (model?.isNewRecord ? 'projects' : undefined);
  if (paraSpace !== undefined) {
    if (!PARA_SPACES.includes(paraSpace)) throw failValidation('PARA_SPACE_INVALID', 'Phân vùng P.A.R.A. không hợp lệ.');
    setAttr(model, 'paraSpace', paraSpace, options);
  }

  const status = getAttr(model, 'status') || (model?.isNewRecord ? 'active' : undefined);
  if (status !== undefined) {
    if (!PARA_STATUSES.includes(status)) throw failValidation('PARA_STATUS_INVALID', 'Trạng thái tài liệu P.A.R.A. không hợp lệ.');
    setAttr(model, 'status', status, options);
  }

  const attachmentUrl = getAttr(model, 'attachmentUrl');
  if (typeof attachmentUrl === 'string' && attachmentUrl.trim()) {
    const trimmedUrl = attachmentUrl.trim();
    if (!isSafeAttachmentUrl(trimmedUrl)) throw failValidation('PARA_ATTACHMENT_URL_INVALID', 'Liên kết đính kèm không hợp lệ.');
    setAttr(model, 'attachmentUrl', trimmedUrl, options);
  }

  const combinedSearch = [
    getAttr(model, 'code'),
    getAttr(model, 'title'),
    getAttr(model, 'summary'),
    getAttr(model, 'tags'),
    getAttr(model, 'contentMarkdown'),
  ].filter(Boolean).join(' ');
  const normalizedSearch = normalizeSearchText(combinedSearch);
  if (normalizedSearch) {
    setAttr(model, 'searchText', normalizedSearch, options);
    setAttr(model, 'embeddingJson', computeDeterministicEmbedding(normalizedSearch), options);
  }
}

module.exports = {
  PARA_SPACES,
  PARA_STATUSES,
  paraDocuments,
  isSafeAttachmentUrl,
  validateParaDocument,
};
