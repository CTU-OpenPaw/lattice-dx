/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import {test,expect,vi,afterEach} from 'vitest';
import type {PoolClient} from 'pg';
import type {WorkflowDefinition,WorkflowRun,WorkflowActor} from '@dx/contracts';
import {validateDefinition} from './registry.js';
import {availableTransitions,authorizeTransition,planTransition,WorkflowError} from './policy.js';
import {authorizeBlock} from './block-policy.js';
import {resolveServiceActor,scheduleTimer} from './timer-database.js';
import {classifyTimerError,parseTimerRetry,TimerError} from './timer-policy.js';
import {startWorkflowTimerWorker} from './timer-worker.js';
import type {WorkflowRepository} from './types.js';
const actor:WorkflowActor={subject:'owner',organizationId:'org',roles:['employee','automation','workflow:schedule']};
const definition={id:'timer-test',title:'Timer',startRole:'employee',initialState:'draft',startFields:{},readerRoles:['automation'],transitions:[
 {id:'schedule',from:'draft',to:'scheduled',role:'employee',fields:{},steps:[{id:'later',action:'timers.schedule',input:{afterSeconds:1,serviceId:'approval-service',transitionId:'execute',input:{quantity:{source:'literal',value:'1'}}}}]},
 {id:'execute',from:'scheduled',to:'done',role:'automation',execution:'service',fields:{quantity:'positiveInteger'}}
]};
const run={id:'run',recordId:'run',definitionId:'timer-test',definitionVersion:1,title:'Run',ownerId:'owner',organizationId:'org',state:'scheduled',version:2,data:{},status:'active',createdAt:'2026-01-01',updatedAt:'2026-01-01'} as WorkflowRun;
test('valid timer target and bounds, rejecting authority and wait overlaps',()=>{
 expect(validateDefinition(definition)).toEqual(definition);
 for(const change of [0,604801,1.5]) {const copy=structuredClone(definition);copy.transitions[0].steps![0].input.afterSeconds=change;expect(()=>validateDefinition(copy)).toThrow();}
 for(const change of [{execution:'interactive'},{from:'draft'},{ownerOnly:true},{assigneeField:'person'},{fields:{other:'text'}}]) {
  const copy=structuredClone(definition);Object.assign(copy.transitions[1],change);expect(()=>validateDefinition(copy)).toThrow();
 }
 const copy=structuredClone(definition);Object.assign(copy.transitions[0],{wait:{stepId:'later',successState:'done',failureState:'done',resultFields:{},timeoutSeconds:1}});expect(()=>validateDefinition(copy)).toThrow();
});
test('service transitions deny public authorization and stay out of choices',()=>{
 const def={...definition,version:1} as unknown as WorkflowDefinition;
 expect(availableTransitions(def,run,actor)).toEqual([]);
 expect(()=>authorizeTransition(def.transitions[1],run,actor)).toThrow(WorkflowError);
 expect(()=>planTransition(def,run,actor,{action:'execute',expectedVersion:2,input:{quantity:'1'}})).toThrow(WorkflowError);
 expect(()=>authorizeBlock(def.transitions[0].steps![0],{...actor,roles:[]})).toThrow(WorkflowError);
});
test('resolver takes fresh profile and enabled directory authority on supplied client',async()=>{
 const query=vi.fn().mockResolvedValueOnce({rows:[{subject:'service'}]}).mockResolvedValueOnce({rows:[{subject:'service',roles:['workflow:service','automation']} ]});
 expect(await resolveServiceActor({query} as unknown as PoolClient,'org','approval-service')).toEqual({subject:'service',organizationId:'org',roles:['workflow:service','automation']});
 expect(query.mock.calls.every(call=>(call[0] as string).includes('FOR SHARE'))).toBe(true);
 for(const rows of [[],[{subject:'service',roles:['automation']}],[{subject:'service',roles:['workflow:service',123]}]]) {
  const c={query:vi.fn().mockResolvedValueOnce({rows:[{subject:'service'}]}).mockResolvedValueOnce({rows})};
  await expect(resolveServiceActor(c as unknown as PoolClient,'org','approval-service')).rejects.toBeInstanceOf(TimerError);
 }
});
test('schedule snapshot validates against exact target fields before insert',async()=>{
 const query=vi.fn().mockResolvedValue({rows:[],rowCount:1});
 const step=({ ...definition,version:1} as unknown as WorkflowDefinition).transitions[0].steps![0];
 await expect(scheduleTimer({query} as unknown as PoolClient,run,step as Extract<typeof step,{action:'timers.schedule'}>,{quantity:'bad'}, {...definition,version:1} as unknown as WorkflowDefinition)).rejects.toBeInstanceOf(WorkflowError);
 expect(query.mock.calls.some(call=>(call[0] as string).includes('INSERT INTO workflow_timers'))).toBe(false);
});
test('retry body is exact and errors store bounded fixed codes',()=>{
 expect(parseTimerRetry({expectedVersion:2})).toEqual({expectedVersion:2});
 for(const value of [{expectedVersion:0},{expectedVersion:1,subject:'owner'},null,[]])expect(parseTimerRetry(value)).toBeUndefined();
 expect(classifyTimerError({code:'40001',message:'secret'})).toEqual({code:'database_transient',transient:true});
 expect(classifyTimerError(new Error('secret'))).toEqual({code:'execution_failed',transient:false});
 expect(classifyTimerError(new TimerError('service_unavailable'))).toEqual({code:'service_unavailable',transient:false});
});
afterEach(()=>vi.useRealTimers());
test('worker permits one active tick and stop drains it',async()=>{
 vi.useFakeTimers();let finish!:()=>void;const pending=new Promise<void>(resolve=>{finish=resolve;});
 const tickOne=vi.fn(()=>pending);const worker=startWorkflowTimerWorker({tickOne} as unknown as WorkflowRepository,100);
 await vi.advanceTimersByTimeAsync(500);expect(tickOne).toHaveBeenCalledTimes(1);
 let stopped=false;const stopping=worker.stop().then(()=>{stopped=true;});await Promise.resolve();expect(stopped).toBe(false);
 finish();await stopping;await vi.advanceTimersByTimeAsync(500);expect(tickOne).toHaveBeenCalledTimes(1);
});
