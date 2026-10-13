// SPDX-License-Identifier: Apache-2.0
import { expect, test } from 'vitest';
import { getDefinition } from '../solutions/workflows/definitions';
import { planTransition, canReadRun, availableTransitions, parseCreate, parseCommand } from '../apps/api/src/workflows/policy';
import * as policy from '../apps/api/src/workflows/policy';
import type { WorkflowActor, WorkflowRun } from '../packages/contracts/src/workflows';
const actor: WorkflowActor = {subject:'alice',organizationId:'org-a',roles:['workflow:start','employee']};
const run: WorkflowRun = {id:'11111111-1111-4111-8111-111111111111',recordId:'11111111-1111-4111-8111-111111111111',definitionId:'procurement',definitionVersion:1,title:'Laptop',ownerId:'alice',organizationId:'org-a',state:'draft',version:1,data:{},createdAt:'2026-10-12T00:00:00Z',updatedAt:'2026-10-12T00:00:00Z'};
const def=getDefinition('procurement',1)!;
test('owner submits a draft with server-defined next state',()=>{
  expect(planTransition(def,run,actor,{action:'submit',expectedVersion:1,input:{}}).transition.to).toBe('submitted');
});
test('department manager can approve, employee cannot',()=>{
  const submitted={...run,state:'submitted',version:2};
  expect(planTransition(def,submitted,{...actor,subject:'manager',roles:['procurement:manager']},{action:'approve',expectedVersion:2,input:{}}).transition.to).toBe('approved');
  expect(()=>planTransition(def,submitted,actor,{action:'approve',expectedVersion:2,input:{}})).toThrow('Không có quyền');
});
test('another employee cannot submit owner draft',()=>expect(()=>planTransition(def,run,{...actor,subject:'other'},{action:'submit',expectedVersion:1,input:{}})).toThrow('Không có quyền'));
test('wrong state/version cannot receive or approve',()=>{
  const warehouse={...actor,roles:['department:warehouse']};
  expect(()=>planTransition(def,run,warehouse,{action:'receive',expectedVersion:1,input:{receiptAttachmentId:run.id}})).toThrow('Trạng thái');
  expect(()=>planTransition(def,{...run,state:'submitted'}, {...actor,roles:['procurement:manager']},{action:'approve',expectedVersion:2,input:{}})).toThrow('Trạng thái');
});
test('reject reason, clean evidence ID and unknown fields validated',()=>{
  const manager={...actor,roles:['procurement:manager']};
  expect(()=>planTransition(def,{...run,state:'submitted'},manager,{action:'reject',expectedVersion:1,input:{reason:' '}})).toThrow('Dữ liệu');
  expect(()=>planTransition(def,{...run,state:'approved'},{...actor,roles:['department:warehouse']},{action:'receive',expectedVersion:1,input:{receiptAttachmentId:'bad'}})).toThrow('Dữ liệu');
  expect(()=>planTransition(def,run,actor,{action:'submit',expectedVersion:1,input:{organizationId:'org-b'}})).toThrow('Dữ liệu');
});
test('run visibility is scoped to organization and participants',()=>{
  expect(canReadRun(def,run,actor)).toBe(true);
  expect(canReadRun(def,run,{...actor,subject:'other'})).toBe(false);
  expect(canReadRun(def,run,{...actor,subject:'warehouse',roles:['department:warehouse']})).toBe(true);
  expect(canReadRun(def,run,{...actor,organizationId:'org-b',roles:['procurement:manager']})).toBe(false);
  expect(availableTransitions(def,{...run,state:'submitted'},{...actor,roles:['procurement:manager']}).map(t=>t.id)).toEqual(['approve','reject']);
});
test('onboarding uses the same engine across HR, IT and administration',()=>{
  const onboarding=getDefinition('onboarding',1)!;
  const instance={...run,definitionId:'onboarding',state:'approved'};
  expect(planTransition(onboarding,instance,{...actor,roles:['department:it']},{action:'provision',expectedVersion:1,input:{accountRef:'account-1'}}).transition.to).toBe('provisioned');
});
test('catalog pins definitions and write contracts reject scope overrides',()=>{
  expect(getDefinition('procurement',2)).toBeUndefined();
  expect(parseCreate({definitionId:'procurement',title:'A',input:{},organizationId:'org-b'})).toBeUndefined();
  expect(parseCommand({action:'approve',expectedVersion:0,input:{}})).toBeUndefined();
  expect(parseCommand({action:'approve',expectedVersion:1,input:{}})).toEqual({action:'approve',expectedVersion:1,input:{}});
});
test('clean evidence readable through a shared run can be reused by its participant',()=>{
  const file={ownerId:'warehouse-a',organizationId:'org-a',scanStatus:'clean'};
  const warehouse={...actor,subject:'warehouse-b',roles:['department:warehouse']};
  const links=[{definition:def,run}];
  expect(policy.canUseEvidence(file,warehouse,links)).toBe(true);
  expect(policy.canUseEvidence(file,{...warehouse,organizationId:'org-b'},links)).toBe(false);
  expect(policy.canUseEvidence(file,{...actor,subject:'other'},links)).toBe(false);
  expect(policy.canUseEvidence({...file,scanStatus:'rejected'},warehouse,links)).toBe(false);
});
