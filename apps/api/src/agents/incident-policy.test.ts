/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import {it,expect} from 'vitest';
import {assertIncidentTransition} from './incident-policy.js';
it('denies authoritative worker directory roles even with a human JWT role',async()=>{
 const client={query:async()=>({rows:[{roles:['incident:manager','connector:agent'],enabled:true}]})};
 await expect(assertIncidentTransition(client as any,{definitionId:'incident-response',organizationId:'org'} as any,{subject:'worker',organizationId:'org',roles:['incident:manager']},{action:'approve',input:{},expectedVersion:1})).rejects.toMatchObject({statusCode:403});
});
