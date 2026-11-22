/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { test, expect } from 'vitest';
import { getDefinition } from '../solutions/workflows/definitions';
import { canReadRun, availableTransitions, planTransition, validateInput } from '../apps/api/src/workflows/policy';
import type { WorkflowRun, WorkflowActor } from '@dx/contracts';
const run:WorkflowRun={id:'11111111-1111-4111-8111-111111111111',recordId:'11111111-1111-4111-8111-111111111111',definitionId:'logistics_order',definitionVersion:1,title:'Order',state:'submitted',version:2,ownerId:'sales',organizationId:'org-a',data:{warehouseAssigneeId:'warehouse'},createdAt:'2026-10-13T00:00:00Z',updatedAt:'2026-10-13T00:00:00Z'};
const actor=(subject:string,roles=['logistics:warehouse'],organizationId='org-a'):WorkflowActor=>({subject,roles,organizationId});
test('order data is visible only to owner or assigned warehouse in shared states',()=>{
  const d=getDefinition('logistics_order')!;expect(d).toBeDefined();
  expect(canReadRun(d,run,actor('warehouse'))).toBe(true);
  expect(canReadRun(d,{...run,state:'draft'},actor('warehouse'))).toBe(false);
  expect(canReadRun(d,run,actor('warehouse2'))).toBe(false);
  expect(canReadRun(d,run,actor('warehouse',[]))).toBe(false);
  expect(canReadRun(d,run,actor('warehouse',['logistics:warehouse'],'org-b'))).toBe(false);
  expect(canReadRun(d,run,actor('sales',['logistics:sales']))).toBe(true);
});
test('only assigned warehouse can receive; work is not offered to every role peer',()=>{
  const d=getDefinition('logistics_order')!;expect(d).toBeDefined();
  const command={action:'receive',expectedVersion:2,input:{receiptNote:'Đã nhận việc'}};
  expect(availableTransitions(d,run,actor('warehouse')).map(t=>t.id)).toEqual(['receive']);
  expect(availableTransitions(d,run,actor('warehouse2'))).toEqual([]);
  expect(()=>planTransition(d,run,actor('warehouse2'),command)).toThrow();
  expect(planTransition(d,run,actor('warehouse'),command).transition.to).toBe('received');
});
test('order quantity must be canonical positive integer and optional evidence is validated',()=>{
  const d=getDefinition('logistics_order')!;expect(d).toBeDefined();
  const input={customerName:'CTU',deliveryAddress:'Can Tho',sku:'BOX-1',quantity:'2',warehouseAssigneeId:'warehouse'};
  expect(validateInput(d.startFields,input,d.optionalStartFields)).toEqual(input);
  for(const quantity of ['0','-1','1.5','1e3','1000001','02'])expect(()=>validateInput(d.startFields,{...input,quantity},d.optionalStartFields)).toThrow();
  expect(()=>validateInput(d.startFields,{...input,attachmentId:'bad'},d.optionalStartFields)).toThrow();
});
