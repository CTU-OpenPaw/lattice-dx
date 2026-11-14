/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const {assertManifest} = require('../shared/manifest');
const {defaultContracts}=require('../shared/contracts');
class FormActionError extends Error {
  constructor(code, message, status) {super(message); this.code = code; this.status = status;}
}
function createFormActions({apiClient, manifest, blockId, contracts=defaultContracts}) {
  assertManifest(manifest,contracts);
  const block = manifest.blocks.find(b => b.id === blockId);
  if (!block || block.type !== 'form') throw new FormActionError('INVALID_BLOCK', 'Không tìm thấy form.');
  const contract=contracts.action(block.submit.actionId);
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
      if (typeof value !== 'string' || !value.trim() || (contract.lengthMode==='codepoints'?Array.from(value).length:value.length) > field.maxLength) throw new FormActionError('VALIDATION', `${field.title} không hợp lệ.`);
      if(field.type==='positiveInteger') {const maximum=contract.fields[field.name].maximum;if(!/^[1-9][0-9]*$/.test(value)||!Number.isSafeInteger(Number(value))||Number(value)>maximum)throw new FormActionError('VALIDATION',`${field.title} phải là số nguyên dương ≤ ${maximum}.`);input[field.name]=Number(value);continue;}
      if (field.pattern === 'uuid' && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) throw new FormActionError('VALIDATION', `${field.title} phải là UUID hợp lệ.`);
      input[field.name] = contract.fields[field.name].trim ? value.trim() : value;
    }
    if(contract.transport.kind==='command'){uncertain={operation:contract.transport.operation,body:input,key:'ui-'+globalThis.crypto.randomUUID()};return retry();}
    if(contract.transport.idempotent){uncertain={...block.submit,input,key:'ui-'+globalThis.crypto.randomUUID()};return retry();}
    return runCatalog({...block.submit,input});
  }
  async function runCatalog(command) {
    pending = true;
    try {
      const {data: catalog} = await apiClient.request({url: 'dxActions:catalog', method: 'get'});
      const descriptor = catalog?.items?.find(a => a.id === block.submit.actionId && a.version === block.submit.version);
      if (!descriptor) throw new FormActionError('ACTION_UNAVAILABLE', 'Action chưa được cấp quyền hoặc chưa sẵn sàng.');
      const {data: result} = await apiClient.request({url: 'dxActions:run', method: 'post', data: command});
      if (result?.status !== 'succeeded' || result.actionId !== block.submit.actionId || result.version !== block.submit.version || !result.result || typeof result.result.id !== 'string') throw new FormActionError('INVALID_RESPONSE', 'Không xác nhận được kết quả lưu; kiểm tra trước khi gửi lại.');
      uncertain=null;
      return result.result;
    } catch (error) {
      if (error instanceof FormActionError) {if(error.code==='ACTION_UNAVAILABLE')uncertain=null;throw error;}
      const status = error.status || error.response?.status;
      if(status>=400&&status<500&&status!==429)uncertain=null;
      throw new FormActionError(status === 401 ? 'AUTH_REQUIRED' : status === 403 ? 'FORBIDDEN' : 'API_FAILED',
        status === 401 ? 'Hãy kết nối lại tài khoản để tiếp tục.' : status === 403 ? 'Không có quyền thực hiện thao tác.' : 'Gọi API thất bại; kiểm tra kết quả trước khi gửi lại.', status);
    } finally {pending = false;}
  }
  async function retry(){
    if(pending||!uncertain)throw new FormActionError('BUSY','Không có lệnh cần thử lại hoặc lệnh đang chạy.');
    if(contract.transport.kind==='catalog')return runCatalog(uncertain);
    pending=true;
    try{const {data:result}=await apiClient.request({url:contract.transport.url,method:'post',data:uncertain});if((contract.transport.definitionId&&result?.definitionId!==contract.transport.definitionId)||typeof result.id!=='string')throw new FormActionError('INVALID_RESPONSE','Không xác nhận được kết quả đã lưu.');uncertain=null;return result;}
    catch(e){const status=e.status||e.response?.status;if(status>=400&&status<500&&status!==429)uncertain=null;throw e;}finally{pending=false;}
  }
  async function transition(transitionId) {
    const definition = manifest.transitions.find(t => t.id === transitionId);
    throw new FormActionError('TRANSITION_UNAVAILABLE', definition?.reason || 'Không có API cho chuyển trạng thái này.');
  }
  return {submit, transition, retry, get uncertain(){return !!uncertain;}, get pending() {return pending;}};
}
module.exports = {createFormActions, FormActionError};
