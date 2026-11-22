/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import {expect,test} from 'vitest';
import {externalId,parseMutation,revision} from './policy.js';
test('mapping identifiers are exact bounded tenant Asset URNs and revision zero is creation',()=>{
 expect(externalId('urn:ngsi-ld:Asset:org:asset_1','org')).toBe('urn:ngsi-ld:Asset:org:asset_1');
 for(const value of ['https://example.com','urn:ngsi-ld:Asset:other:asset','urn:ngsi-ld:Asset:org:a:b','urn:ngsi-ld:Asset:org:'+ 'a'.repeat(129)])expect(()=>externalId(value,'org')).toThrow();
 expect(revision(0)).toBe(0);for(const value of [-1,1.5,2147483647,'0'])expect(()=>revision(value)).toThrow();
 expect(parseMutation({externalId:'urn:ngsi-ld:Asset:org:a',expectedRevision:0},'org',false)).toEqual({externalId:'urn:ngsi-ld:Asset:org:a',expectedRevision:0});
 for(const value of [{expectedRevision:0,actorId:'other'},{expectedRevision:0,externalId:'urn:ngsi-ld:Asset:org:a',extra:true},null])expect(()=>parseMutation(value,'org',true)).toThrow();
});
