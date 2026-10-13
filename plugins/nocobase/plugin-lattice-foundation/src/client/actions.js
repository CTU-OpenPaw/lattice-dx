// SPDX-License-Identifier: Apache-2.0
const {assertManifest} = require('../shared/manifest');
class FormActionError extends Error {
  constructor(code, message, status) {super(message); this.code = code; this.status = status;}
}
function createFormActions({apiClient, manifest, blockId}) {
  assertManifest(manifest);
  const block = manifest.blocks.find(b => b.id === blockId);
  if (!block || block.type !== 'form') throw new FormActionError('INVALID_BLOCK', 'Không tìm thấy form.');
  let pending = false, uncertain=null;
  async function submit(values) {
    if (pending||uncertain) throw new FormActionError('BUSY', 'Kiểm tra hoặc thử lại lệnh cũ trước.');
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
      if (typeof value !== 'string' || !value.trim() || (block.submit.actionId==='logistics.create'?Array.from(value).length:value.length) > field.maxLength) throw new FormActionError('VALIDATION', `${field.title} không hợp lệ.`);
      if(field.type==='positiveInteger') {if(!/^[1-9][0-9]*$/.test(value)||Number(value)>1000000)throw new FormActionError('VALIDATION','Số lượng phải là số nguyên dương ≤ 1000000.');input[field.name]=Number(value);continue;}
      if (field.pattern === 'uuid' && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) throw new FormActionError('VALIDATION', 'recordId phải là UUID của hồ sơ thật.');
      input[field.name] = field.name === 'title' ? value.trim() : value;
    }
    if(block.submit.actionId==='logistics.create'){uncertain={operation:'create',body:input,key:'ui-'+globalThis.crypto.randomUUID()};return retry();}
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
  async function retry(){
    if(pending||!uncertain)throw new FormActionError('BUSY','Không có lệnh cần thử lại hoặc lệnh đang chạy.');
    pending=true;
    try{const {data:result}=await apiClient.request({url:'dxActions:logistics',method:'post',data:uncertain});if(result?.definitionId!=='logistics_order'||typeof result.id!=='string')throw new FormActionError('INVALID_RESPONSE','Không xác nhận được đơn đã lưu.');uncertain=null;return result;}
    catch(e){const status=e.status||e.response?.status;if(status>=400&&status<500&&status!==429)uncertain=null;throw e;}finally{pending=false;}
  }
  async function transition(transitionId) {
    const definition = manifest.transitions.find(t => t.id === transitionId);
    throw new FormActionError('TRANSITION_UNAVAILABLE', definition?.reason || 'Không có API cho chuyển trạng thái này.');
  }
  return {submit, transition, retry, get uncertain(){return !!uncertain;}, get pending() {return pending;}};
}
module.exports = {createFormActions, FormActionError};
