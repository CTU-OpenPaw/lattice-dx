/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const {createWorkflowComponent}=require('./procurement/workflow');
const {createProcurementDashboardComponent}=require('./procurement/dashboard');
const {createLogisticsComponent}=require('./logistics/detail');
const {createRuleEditorComponent}=require('./incident/rule-editor');
const {createCaseBoardComponent}=require('./incident/case-board');
const {createAgentRunComponent}=require('./incident/agent-run');
const {createEvidenceProposalComponent}=require('./incident/evidence-proposal');
const {createCaseResolutionComponent}=require('./incident/resolution');
function registerApplicationViews(runtime,React) {
  runtime.registerView('lattice.procurement.dashboard',createProcurementDashboardComponent(React));
  runtime.registerView('lattice.procurement.workflow',createWorkflowComponent(React));
  runtime.registerView('lattice.incident.rule-editor',createRuleEditorComponent(React));
  runtime.registerView('lattice.incident.case-board',createCaseBoardComponent(React));
  runtime.registerView('lattice.incident.agent-run',createAgentRunComponent(React));
  runtime.registerView('lattice.incident.evidence-proposal',createEvidenceProposalComponent(React));
  runtime.registerView('lattice.incident.resolution',createCaseResolutionComponent(React));
  const Detail=createLogisticsComponent(React);
  runtime.registerView('lattice.logistics.detail',props=>React.createElement(Detail,{...props,orderId:props.selectedId}));
}

module.exports={registerApplicationViews};
