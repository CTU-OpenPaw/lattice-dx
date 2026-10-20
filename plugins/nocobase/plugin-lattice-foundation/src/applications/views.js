// SPDX-License-Identifier: Apache-2.0
const {createWorkflowComponent}=require('./procurement/workflow');
const {createProcurementDashboardComponent}=require('./procurement/dashboard');
const {createLogisticsComponent}=require('./logistics/detail');
const {createRuleEditorComponent}=require('./incident/rule-editor');
const {createCaseBoardComponent}=require('./incident/case-board');
function registerApplicationViews(runtime,React) {
  runtime.registerView('lattice.procurement.dashboard',createProcurementDashboardComponent(React));
  runtime.registerView('lattice.procurement.workflow',createWorkflowComponent(React));
  runtime.registerView('lattice.incident.rule-editor',createRuleEditorComponent(React));
  runtime.registerView('lattice.incident.case-board',createCaseBoardComponent(React));
  const Detail=createLogisticsComponent(React);
  runtime.registerView('lattice.logistics.detail',props=>React.createElement(Detail,{...props,orderId:props.selectedId}));
}

module.exports={registerApplicationViews};
