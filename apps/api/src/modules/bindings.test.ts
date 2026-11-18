/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import {it,expect} from 'vitest';
import {parseManifest} from './policy.js';
const definition={id:'flow',title:'Flow',startRole:'employee',initialState:'draft',startFields:{},readerRoles:[],transitions:[{id:'go',from:'draft',to:'done',role:'employee',fields:{}}]};
const manifest={format:'latticedx.enterprise-module',formatVersion:1,id:'sample',version:'1.0.0',title:'Sample',schemas:[{id:'data',title:'Data',fields:{},relations:{}}],bundle:{format:'latticedx.workflow-bundle',formatVersion:1,definitions:[definition]},blocks:[],dependencies:[]};
const binding={id:'business',schemaId:'data',schemaVersion:1,definitionId:'flow',allowedTransitions:['go']};
it('preserves omitted binding key and accepts own binding',()=>{expect(parseManifest(manifest)).not.toHaveProperty('bindings');expect(parseManifest({...manifest,bindings:[binding]}).bindings).toEqual([binding]);});
it.each([{...binding,schemaVersion:2},{...binding,definitionId:'external'},{...binding,allowedTransitions:['unknown']},{...binding,allowedTransitions:['go','go']}])('rejects invalid own binding %j',b=>expect(()=>parseManifest({...manifest,bindings:[b]})).toThrow());
it('rejects multiple bindings on one own definition',()=>expect(()=>parseManifest({...manifest,bindings:[binding,{...binding,id:'other'}]})).toThrow());
