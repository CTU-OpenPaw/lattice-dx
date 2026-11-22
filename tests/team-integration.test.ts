/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import {test,expect} from 'vitest';
import {freshManifest,validateArtifact,localConfig,requestJson} from '../scripts/lib/team-integration.mjs';
test('fresh fixtures use isolated UUID namespaces and fixed declarative policy',()=>{
 const a=freshManifest(),b=freshManifest();expect(a.id).not.toBe(b.id);expect(a.id).toMatch(/^team-asset-[a-f0-9]{32}$/);
 expect(a.bundle.definitions[0].readerRoles).toEqual(['logistics:warehouse']);expect(a.bindings[0].schemaId).toBe(a.schemas[0].id);
 expect(a.bundle.definitions[0].transitions.every(t=>t.role==='logistics:warehouse')).toBe(true);
});
test('artifact whitelist rejects credentials, foreign namespace, invalid IDs and tenant',()=>{
 const runId='11111111-1111-4111-8111-111111111111',tag='1'.repeat(32);
 const a={format:'latticedx.team-integration',version:1,namespace:tag,organizationId:'org-a',moduleId:'team-asset-'+tag,schemaId:'team-asset-data-'+tag,definitionId:'team-asset-review-'+tag,moduleVersion:'1.0.0',entityId:runId,workflowId:runId,ownerSubject:'owner',warehouseSubject:'warehouse',shared:false,urls:{entity:'http://localhost:8080/v1/entities/'+runId,workflow:'http://localhost:8080/v1/workflows/'+runId,context:'http://localhost:8080/v1/workflows/'+runId+'/entity-context'}};
 expect(validateArtifact(a)).toEqual(a);
 for(const patch of [{token:'secret'},{entityId:'bad'},{organizationId:'org-b'},{moduleId:'existing'},{urls:{...a.urls,entity:'https://evil.test'}}])expect(()=>validateArtifact({...a,...patch})).toThrow();
});
test('configuration never forwards credentials to remote endpoints',()=>{
 expect(localConfig({}).gateway).toBe('http://localhost:8080');
 expect(()=>localConfig({TEAM_INTEGRATION_GATEWAY:'https://example.com'})).toThrow();
 expect(()=>localConfig({TEAM_INTEGRATION_IDENTITY:'http://localhost:8081@evil.test'})).toThrow();
});
test('HTTP errors omit token and body even for non JSON gateway responses',async()=>{
 await expect(requestJson('http://localhost:8080/v1/entities',{fetchImpl:async()=>new Response('sensitive-token',{status:502,headers:{'content-type':'text/html'}})})).rejects.toThrow('HTTP 502 (non-JSON response)');
});
import {parseManifest} from '../apps/api/src/modules/policy.ts';
test('fixture parses through production manifest policy with UI text fields',()=>{
 const m=parseManifest(freshManifest());expect(m.schemas).toHaveLength(1);expect(m.bundle.definitions[0].transitions.map(t=>t.fields)).toEqual([{reason:'text'},{reason:'text'}]);
});
test('request helper rejects remote hosts before sending credentials',async()=>{
 let called=false;await expect(requestJson('https://example.com',{token:'secret',fetchImpl:async()=>{called=true;return new Response('{}');}})).rejects.toThrow();expect(called).toBe(false);
});
