/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import type { WorkflowDefinition } from '../../packages/contracts/src/workflows.js';
// Immutable versions: changing a workflow requires a new version, not editing an active one.
export const workflowDefinitions: WorkflowDefinition[] = [
  {
    id:'logistics_order',version:1,title:'Đơn Logistics và giao kho',startRole:'logistics:sales',initialState:'draft',
    startFields:{customerName:'text',deliveryAddress:'text',sku:'text',quantity:'positiveInteger',warehouseAssigneeId:'subject'},
    optionalStartFields:{attachmentId:'file'},readerRoles:[],
    assignedReader:{field:'warehouseAssigneeId',role:'logistics:warehouse',states:['submitted','received']},
    transitions:[
      {id:'submit',from:'draft',to:'submitted',role:'logistics:sales',ownerOnly:true,fields:{},task:'assign'},
      {id:'receive',from:'submitted',to:'received',role:'logistics:warehouse',assigneeField:'warehouseAssigneeId',fields:{receiptNote:'text'},task:'complete'},
    ],
  },
  {
    id:'procurement',version:1,title:'Mua sắm và bàn giao tài sản',startRole:'employee',initialState:'draft',startFields:{},
    readerRoles:['procurement:manager','department:warehouse','workflow:sync'],
    transitions:[
      {id:'submit',from:'draft',to:'submitted',role:'employee',ownerOnly:true,fields:{}},
      {id:'approve',from:'submitted',to:'approved',role:'procurement:manager',fields:{}},
      {id:'reject',from:'submitted',to:'rejected',role:'procurement:manager',fields:{reason:'text'}},
      {id:'receive',from:'approved',to:'received',role:'department:warehouse',fields:{receiptAttachmentId:'file'}},
      {id:'accept',from:'received',to:'accepted',role:'department:warehouse',fields:{acceptanceNote:'text'}},
      {id:'handover',from:'accepted',to:'handed_over',role:'department:warehouse',fields:{assetId:'text',recipientId:'subject',departmentId:'department',locationId:'location',attachmentId:'file'},eventType:'asset.handed_over'},
    ],
  },
  {
    id:'onboarding',version:1,title:'Tiếp nhận nhân viên liên phòng ban',startRole:'department:hr',initialState:'draft',startFields:{recipientId:'subject'},
    readerRoles:['department:hr','procurement:manager','department:it','department:administration','workflow:sync'],
    transitions:[
      {id:'submit',from:'draft',to:'submitted',role:'department:hr',ownerOnly:true,fields:{}},
      {id:'approve',from:'submitted',to:'approved',role:'procurement:manager',fields:{}},
      {id:'reject',from:'submitted',to:'rejected',role:'procurement:manager',fields:{reason:'text'}},
      {id:'provision',from:'approved',to:'provisioned',role:'department:it',fields:{accountRef:'text'}},
      {id:'complete',from:'provisioned',to:'completed',role:'department:administration',fields:{locationId:'location',attachmentId:'file'},eventType:'employee.onboarded'},
    ],
  },
];
export function getDefinition(id:string,version?:number):WorkflowDefinition|undefined {
  return workflowDefinitions.find(d=>d.id===id&&(version===undefined||d.version===version));
}
