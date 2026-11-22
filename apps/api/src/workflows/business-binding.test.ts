/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import {it,expect} from 'vitest';
import {authorizeTransition,availableTransitions} from './policy.js';
import type {WorkflowDefinition,WorkflowRun} from '@dx/contracts';
const actor={subject:'owner',organizationId:'org',roles:['employee']};
const def:WorkflowDefinition={id:'flow',version:1,title:'Flow',startRole:'employee',initialState:'draft',startFields:{},readerRoles:[],transitions:['allowed','blocked'].map(id=>({id,from:'draft',to:'done',role:'employee',fields:{}}))};
const run={id:'run',ownerId:'owner',organizationId:'org',state:'draft',version:1,data:{},binding:{moduleId:'sample',moduleVersion:'1.0.0',bindingId:'business',allowedTransitions:['allowed']}} as unknown as WorkflowRun;
it('binding filters available actions without granting authority',()=>expect(availableTransitions(def,run,actor).map(t=>t.id)).toEqual(['allowed']));
it('binding denies authorization before an idempotent receipt',()=>expect(()=>authorizeTransition(def.transitions[1],run,actor)).toThrow());
