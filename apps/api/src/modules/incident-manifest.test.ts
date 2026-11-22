/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import {expect,test} from 'vitest';
import manifest from '../../../../solutions/workflows/incident-module.json';
import {parseManifest} from './policy.js';
test('incident reference configuration is installable and pins the human resolution contract',()=>{
 const parsed=parseManifest(manifest),definition=parsed.bundle.definitions[0];
 expect(definition.id).toBe('incident-response');expect(definition.startRole).toBe('incident:create');
 expect(definition.transitions.find(t=>t.id==='approve')?.fields).toEqual({reviewNote:'text'});
 expect(definition.transitions.find(t=>t.id==='record_resolution')).toMatchObject({from:'approved',to:'resolved',role:'incident:handler',assigneeField:'handlerId',fields:{resolutionNote:'text'}});
 expect(definition.transitions.find(t=>t.id==='close')).toMatchObject({from:'resolved',to:'closed',eventType:'incident.closed'});
 expect(parsed.schemas.find(s=>s.id==='incident-asset')?.fields.status.choices).toEqual(['ready','in_use','repair','retired']);
 expect(parsed.schemas.find(s=>s.id==='incident-rule')?.fields.threshold.choices).toContain('40');
});
