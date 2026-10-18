// SPDX-License-Identifier: Apache-2.0
import {test,expect,vi} from 'vitest';
import {validateSteps,blockRole} from './block-policy.js';
import {executeBlocks} from './block-database.js';
const literal=(value:string)=>({source:'literal' as const,value});
const projected={op:'ref',source:'projection',stepId:'project',field:'amount'};
const steps:any[]=[{id:'project',action:'entities.project',input:{id:literal('00000000-0000-4000-8000-000000000010'),fields:['amount','optional']}},{id:'calc',action:'data.evaluate',input:{values:{total:{op:'add',args:[projected,{op:'literal',value:{type:'decimal',value:'0.01'}}]}}}},{id:'assert',action:'data.assert',input:{condition:{op:'eq',args:[{op:'ref',source:'evaluation',stepId:'calc',field:'total'},{op:'literal',value:{type:'decimal',value:'99999999999999999999.02'}}]}}}];
test('private declarations validate earlier references and read roles',()=>{
 expect(()=>validateSteps(steps,new Set(),new Set())).not.toThrow();
 for(const step of steps)expect(blockRole(step.action)).toBe('data:read');
 for(const field of ['unknown','constructor'])expect(()=>validateSteps([steps[0],{...steps[1],input:{values:{total:{...projected,field}}}}],new Set(),new Set())).toThrow();
 expect(()=>validateSteps([steps[1],steps[0]],new Set(),new Set())).toThrow();
 expect(()=>validateSteps([{...steps[0],input:{...steps[0].input,id:{source:'expression',expression:projected}}}],new Set(),new Set())).toThrow();
});
test('projection and evaluation evidence contain only metadata and resolve exact decimal privately',async()=>{
 const row={id:steps[0].input.id.value,schemaId:'invoice',schemaVersion:2,version:3,attributes:{amount:'99999999999999999999.01'},ownerId:'alice',organizationId:'org',archivedAt:null,createdAt:'2026-10-14T00:00:00Z',updatedAt:'2026-10-14T00:00:00Z'};
 const query=vi.fn(async(sql:string)=>({rows:sql.includes('enterprise_schema_versions')?[{version:2,definition:{id:'invoice',fields:{amount:{type:'decimal'},optional:{type:'text'}},relations:{}}}]:sql.startsWith('SELECT')?[row]:[],rowCount:1}));
 await executeBlocks({query} as any,steps,{id:'run',version:2,data:{},organizationId:'org'} as any,{}, {subject:'alice',organizationId:'org',roles:['data:read']});
 const evidence=query.mock.calls.filter(([sql])=>sql.startsWith('INSERT INTO workflow_action_results'));
 expect(evidence).toHaveLength(3);expect(JSON.stringify(evidence)).not.toContain('99999999999999999999');
 expect(query.mock.calls.filter(([sql])=>sql.includes('FOR UPDATE'))).toHaveLength(1);
});
test('assertion failure is sanitized and nonboolean is rejected',async()=>{
 for(const [value,statusCode] of [[{type:'boolean',value:false},409],[{type:'text',value:'secret'},400]] as const){
 const query=vi.fn(async()=>({rows:[],rowCount:1}));
 await expect(executeBlocks({query} as any,[{id:'a',action:'data.assert',input:{condition:{op:'literal',value}}}] as any,{data:{}} as any,{}, {subject:'alice',organizationId:'org',roles:['data:read']})).rejects.toMatchObject({statusCode});
 expect(query).not.toHaveBeenCalled();
 }
});
import {projectFields} from './private-blocks.js';
import {parseBundle,bundlePreview} from './bundles.js';
import {customDefinition} from './registry.test.js';
test('declared missing optional fields become null and required/unknown fields fail',()=>{
 const row={attributes:{amount:4}} as any,schema={fields:{amount:{type:'integer',required:true},optional:{type:'text'},required:{type:'text',required:true}}} as any;
 expect(projectFields(row,schema,['amount','optional'])).toEqual({amount:{type:'integer',value:4},optional:{type:'null',value:null}});
 for(const field of ['required','ownerId','unknown'])expect(()=>projectFields(row,schema,[field])).toThrow();
});
test('projection rechecks current grants before publication or evidence',async()=>{
 const row={id:steps[0].input.id.value,schemaId:'invoice',schemaVersion:2,version:3,attributes:{amount:'secret'},ownerId:'other',organizationId:'org',archivedAt:null,createdAt:'2026-10-14',updatedAt:'2026-10-14'};
 const query=vi.fn(async(sql:string)=>({rows:sql.includes('FROM enterprise_entities')?[row]:[],rowCount:1}));
 await expect(executeBlocks({query} as any,[steps[0]],{id:'run',version:2,data:{}} as any,{}, {subject:'alice',organizationId:'org',roles:['data:read']})).rejects.toMatchObject({statusCode:404});
 expect(query.mock.calls.some(([sql])=>sql.includes('enterprise_schema_versions')||sql.includes('INSERT INTO workflow_action_results'))).toBe(false);
});
test('portable private bundle retains pure literals and advertises data read',()=>{
 const def={...customDefinition,transitions:[{...customDefinition.transitions[0],steps:[{id:'calc',action:'data.evaluate',input:{values:{x:{op:'literal',value:{type:'integer',value:1}}}}}]}]};
 const bundle={format:'latticedx.workflow-bundle',formatVersion:1,definitions:[def]};
 expect(bundlePreview(parseBundle(bundle)).definitions[0]!.requiredRoles).toContain('data:read');
 expect(()=>parseBundle({...bundle,definitions:[{...def,transitions:[{...def.transitions[0],steps:[steps[0]]}]}]})).toThrow();
});
test('expression bindings accept only private scalar attribute values and deny resource/version positions',()=>{
 const update={id:'update',action:'entities.update',input:{id:{source:'result',stepId:'project',field:'id'},expectedVersion:{source:'result',stepId:'project',field:'version'},title:literal('Invoice'),attributes:{amount:{source:'expression',expression:projected}}}};
 expect(()=>validateSteps([steps[0],update],new Set(),new Set())).not.toThrow();
 for(const key of ['id','expectedVersion','title'])expect(()=>validateSteps([steps[0],{...update,input:{...update.input,[key]:{source:'expression',expression:projected}}}],new Set(),new Set())).toThrow();
 for(const fields of [[],['amount','amount'],['constructor']])expect(()=>validateSteps([{...steps[0],input:{...steps[0].input,fields}}],new Set(),new Set())).toThrow();
});
