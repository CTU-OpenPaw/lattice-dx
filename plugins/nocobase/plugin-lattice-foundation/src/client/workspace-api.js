// SPDX-License-Identifier: Apache-2.0
class WorkspaceApiError extends Error {
  constructor(message, status, source) {super(message); this.status = status; this.source = source; this.response = {status};}
}
function createWorkspaceApi({apiClient, onExpired = () => {}, notify = () => {}}) {
  const request = async options => {
    const source = options.url.startsWith('dxActions:') ? 'bridge' : 'nocobase';
    try {return await apiClient.request({timeout: 15000, ...options});}
    catch (cause) {
      const status = cause.response?.status;
      if (status === 401) onExpired(source);
      const message = status === 401 ? (source === 'bridge' ? 'Kết nối tài khoản nghiệp vụ đã hết hạn. Hãy kết nối lại.' : 'Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại.')
        : status === 403 ? 'Tài khoản không có quyền thực hiện thao tác này.'
        : status === 409 ? 'Dữ liệu đã thay đổi. Hãy tải lại trước khi tiếp tục.'
        : status === 404 ? 'Chức năng chưa được cài hoặc không tìm thấy.'
        : 'Không thể liên lạc với dịch vụ. Kiểm tra kết quả trước khi gửi lại.';
      notify({type:'error', message});
      throw new WorkspaceApiError(message, status, source);
    }
  };
  return {
    request,
    async user() {return (await request({url:'auth:check',method:'get'})).data.data;},
    async applications() {return (await request({url:'latticeApps:list',method:'get'})).data.data.items;},
    async connection() {return (await request({url:'dxActions:status',method:'get'})).data;},
    async catalog() {return (await request({url:'dxActions:catalog',method:'get'})).data.items;},
    async list(resource) {
      if (!['records','tasks'].includes(resource)) throw new WorkspaceApiError('Nguồn danh sách không được hỗ trợ.',400,'bridge');
      const result=(await request({url:'dxActions:list',method:'get',params:{resource}})).data;
      if (!Array.isArray(result?.items) || result.items.length>100) throw new WorkspaceApiError('Dữ liệu danh sách không hợp lệ.',502,'bridge');
      return result.items;
    },
    async file(operation, payload) {
      if (!['upload','metadata','content'].includes(operation)) throw new WorkspaceApiError('Thao tác tệp không hợp lệ.',400,'bridge');
      return (await request({url:'dxActions:files',method:'post',timeout:30000,data:{...payload,operation}})).data;
    },
    async connect() {
      const result = (await request({url:'dxActions:connect',method:'post'})).data;
      const url = new URL(result.authorizationUrl);
      // Current local fixture. Production deployment must configure a trusted origin explicitly.
      if (url.origin !== 'http://localhost:8081' || url.pathname !== '/realms/lattice/protocol/openid-connect/auth') {
        throw new WorkspaceApiError('Địa chỉ đăng nhập nghiệp vụ không hợp lệ.', 502, 'bridge');
      }
      return url.href;
    },
    async disconnect() {await request({url:'dxActions:disconnect',method:'post'}); notify({type:'success',message:'Đã ngắt kết nối tài khoản nghiệp vụ.'});},
    async signOut() {
      await request({url:'dxActions:disconnect',method:'post'});
      try {await apiClient.auth.signOut();}
      catch (cause) {notify({type:'error',message:'Đăng xuất thất bại. Hãy thử lại.'}); throw cause;}
    },
  };
}
module.exports = {createWorkspaceApi, WorkspaceApiError};
