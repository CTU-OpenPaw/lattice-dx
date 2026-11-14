/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
// Convenience adapters for installed application services, outside Workspace core.
function attachApplicationApi(api) {
  api.logistics=async(operation,payload={})=>(await api.request({url:'dxActions:logistics',method:'post',data:{...payload,operation}})).data;
  api.workflow=async(operation,payload={})=>(await api.request({url:'dxActions:workflow',method:'post',data:{...payload,operation}})).data;
  api.entity=async(operation,payload={})=>(await api.request({url:'dxActions:entity',method:'post',data:{...payload,operation}})).data;
  api.agent=async(operation,payload={})=>(await api.request({url:'dxActions:agent',method:'post',data:{...payload,operation}})).data;
  return api;
}
module.exports={attachApplicationApi};
