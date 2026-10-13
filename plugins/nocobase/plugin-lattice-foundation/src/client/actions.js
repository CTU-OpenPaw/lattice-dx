// SPDX-License-Identifier: Apache-2.0
const {assertManifest} = require('../shared/manifest');
class FormActionError extends Error {
  constructor(code, message, status) {super(message); this.code = code; this.status = status;}
}
function createFormActions({apiClient, manifest, blockId}) {
  assertManifest(manifest);
  const block = manifest.blocks.find(b => b.id === blockId);
  if (!block || block.type !== 'form') throw new FormActionError('INVALID_BLOCK', 'Không tìm thấy form.');
  let pending = false;
  async function submit(values) {
    if (pending) throw new FormActionError('BUSY', 'Yêu cầu đang được xử lý.');
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw new FormActionError('VALIDATION', 'Dữ liệu form không hợp lệ.');
    const allowed = new Set(block.fields.map(f => f.name));
    if (Object.keys(values).some(key => !allowed.has(key))) throw new FormActionError('VALIDATION', 'Form chứa trường ngoài cấu hình.');
    const input = {};
    for (const field of block.fields) {
      const value = values[field.name];
      if (value === undefined || value === '') {
        if (field.required) throw new FormActionError('VALIDATION', `Thiếu ${field.title}.`);
        continue;
      }
      if (typeof value !== 'string' || !value.trim() || value.length > field.maxLength) throw new FormActionError('VALIDATION', `${field.title} không hợp lệ.`);
      if (field.pattern === 'uuid' && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) throw new FormActionError('VALIDATION', 'recordId phải là UUID của hồ sơ thật.');
      input[field.name] = field.name === 'title' ? value.trim() : value;
    }
    pending = true;
    try {
      const {data: catalog} = await apiClient.request({url: 'dxActions:catalog', method: 'get'});
      const descriptor = catalog?.items?.find(a => a.id === block.submit.actionId && a.version === block.submit.version);
      if (!descriptor) throw new FormActionError('ACTION_UNAVAILABLE', 'Action chưa được cấp quyền hoặc chưa sẵn sàng.');
      const {data: result} = await apiClient.request({url: 'dxActions:run', method: 'post', data: {...block.submit, input}});
      if (result?.status !== 'succeeded' || result.actionId !== block.submit.actionId || result.version !== block.submit.version || !result.result || typeof result.result.id !== 'string') throw new FormActionError('INVALID_RESPONSE', 'Không xác nhận được kết quả lưu; kiểm tra trước khi gửi lại.');
      return result.result;
    } catch (error) {
      if (error instanceof FormActionError) throw error;
      const status = error.response?.status;
      throw new FormActionError(status === 401 ? 'AUTH_REQUIRED' : status === 403 ? 'FORBIDDEN' : 'API_FAILED',
        status === 401 ? 'Hãy kết nối lại tài khoản để tiếp tục.' : status === 403 ? 'Không có quyền thực hiện thao tác.' : 'Gọi API thất bại; kiểm tra kết quả trước khi gửi lại.', status);
    } finally {pending = false;}
  }
  async function transition(transitionId) {
    const definition = manifest.transitions.find(t => t.id === transitionId);
    throw new FormActionError('TRANSITION_UNAVAILABLE', definition?.reason || 'Không có API cho chuyển trạng thái này.');
  }
  return {submit, transition, get pending() {return pending;}};
}
module.exports = {createFormActions, FormActionError};
