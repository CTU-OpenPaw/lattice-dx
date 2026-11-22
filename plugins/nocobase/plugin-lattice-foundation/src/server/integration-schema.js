/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const field=(name,type,extra={})=>({name,type,...extra});
const base=(name,title,fields,indexes=[])=>({name,title,titleField:'eventId',origin:'@latticedx/plugin-lattice-foundation',uiManageable:true,createdAt:true,updatedAt:true,fields:[
 field('receiptKey','string',{allowNull:false,unique:true}),field('contentHash','string',{allowNull:false}),field('eventId','string',{allowNull:false}),
 field('organizationId','string',{allowNull:false}),field('sourceUserId','bigInt',{allowNull:false}),field('sourceEmployeeId','bigInt',{allowNull:false}),...fields],indexes});
module.exports={
 inbox:base('latticeIntegrationInbox','Lattice — Sự kiện tích hợp',[
  field('kind','string',{allowNull:false}),field('observedAt','date',{allowNull:false}),field('late','boolean',{defaultValue:false}),field('data','json',{allowNull:false}),
 ],[
  {name:'idx_lattice_inbox_org_observed',fields:['organizationId','observedAt']},
  {name:'idx_lattice_inbox_org_kind_observed',fields:['organizationId','kind','observedAt']},
 ]),
 proposals:base('latticeAgentProposals','Lattice — Đề xuất có bằng chứng',[
  field('targetCollection','string',{allowNull:false}),field('targetRecordId','bigInt',{allowNull:false}),field('recordFingerprint','string',{allowNull:false}),
  field('recommendation','text',{allowNull:false}),field('evidence','json',{allowNull:false}),field('state','string',{defaultValue:'proposed',allowNull:false}),
 ],[
  {name:'idx_lattice_proposals_org_state_created',fields:['organizationId','state','createdAt']},
  {name:'idx_lattice_proposals_org_target',fields:['organizationId','targetCollection','targetRecordId']},
 ]),
};
