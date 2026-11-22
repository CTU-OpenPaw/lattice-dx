/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { expect,test } from 'vitest';
import { parseMutation,parseQueueInput,normalizeDueAt,assertAuthority,assertWorkflow } from './policy.js';
const actor={subject:'bob',organizationId:'org-a'};
const task={id:'11111111-1111-4111-8111-111111111111',title:'Task',createdBy:'alice',assigneeId:'',departmentId:'warehouse',organizationId:'org-a',status:'pending',version:1};
test('strict mutation body rejects injected scopes and invalid versions',()=>{
 expect(()=>parseMutation('cancel',{expectedVersion:1,reason:'ok',organizationId:'org-b'})).toThrow();
 expect(()=>parseMutation('claim',{expectedVersion:0})).toThrow();
 expect(parseMutation('reassign',{expectedVersion:1,assigneeId:'carol',reason:'  change  '})).toEqual({expectedVersion:1,assigneeId:'carol',reason:'change'});
});
test('queue canonical title and UUID, Unicode limits and exact fields',()=>{
 expect(parseQueueInput({title:' Queue ',departmentId:'warehouse',recordId:'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'})).toEqual({title:'Queue',departmentId:'warehouse',recordId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'});
 expect(()=>parseQueueInput({title:'x',departmentId:'warehouse',assigneeId:'bob'})).toThrow();
 expect(()=>parseQueueInput({title:'😀'.repeat(201),departmentId:'warehouse'})).toThrow();
});
test('deadline strict calendar and future bound normalized independently of replay time',()=>{
 const now=Date.parse('2026-01-01T00:00:00Z');
 expect(normalizeDueAt('2026-01-02T00:00:00Z',now)).toBe('2026-01-02T00:00:00.000Z');
 for(const value of ['2026-02-30T00:00:00Z','2025-12-31T00:00:00Z','2027-01-03T00:00:00Z','2026-01-02'])expect(()=>normalizeDueAt(value,now)).toThrow();
});
test('current membership and owner enforced before replay',()=>{
 expect(()=>assertAuthority(task,actor,'claim',false)).toThrow();
 expect(()=>assertAuthority(task,actor,'cancel',true)).toThrow();
 expect(()=>assertAuthority({...task,assigneeId:'carol'},actor,'claim',true)).toThrow();
 expect(()=>assertAuthority({...task,assigneeId:'bob'},actor,'claim',false)).not.toThrow();
 expect(()=>assertAuthority(task,{...actor,organizationId:'org-b'},'claim',true)).toThrow();
});
test('generic workflow mutation guard rejects either linkage',()=>{
 expect(()=>assertWorkflow(true)).toThrow(); expect(()=>assertWorkflow(false)).not.toThrow();
});
test('queue title uses existing raw 200 code point title contract',()=>{
 expect(()=>parseQueueInput({title:' '.repeat(201)+'x',departmentId:'warehouse'})).toThrow();
 expect(parseQueueInput({title:'A\nB',departmentId:'warehouse'}).title).toBe('A\nB');
});
