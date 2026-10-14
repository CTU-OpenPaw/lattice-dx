// SPDX-License-Identifier: Apache-2.0
const {createWorkflowComponent}=require('./procurement/workflow');
const {createLogisticsComponent}=require('./logistics/detail');
function registerApplicationViews(runtime,React) {
  runtime.registerView('lattice.procurement.workflow',createWorkflowComponent(React));
  const Detail=createLogisticsComponent(React);
  runtime.registerView('lattice.logistics.detail',props=>React.createElement(Detail,{...props,orderId:props.selectedId}));
}
module.exports={registerApplicationViews};
