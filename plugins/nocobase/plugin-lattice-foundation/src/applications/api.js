// SPDX-License-Identifier: Apache-2.0
// Convenience adapters for installed application services, outside Workspace core.
function attachApplicationApi(api) {
  api.logistics=async(operation,payload={})=>(await api.request({url:'dxActions:logistics',method:'post',data:{...payload,operation}})).data;
  api.workflow=async(operation,payload={})=>(await api.request({url:'dxActions:workflow',method:'post',data:{...payload,operation}})).data;
  return api;
}
module.exports={attachApplicationApi};
