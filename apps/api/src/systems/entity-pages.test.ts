/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import {expect,test,vi} from 'vitest';
import {compileSystem,parseRecipe} from './policy.js';
import {parseManifest} from '../modules/policy.js';
import {parseBundle} from '../workflows/bundles.js';
import {systemDatabase} from './database.js';
import {modulesDatabase} from '../modules/database.js';
const schema={id:'inventory-v1',title:'Inventory',fields:{label:{type:'text',required:true},quantity:{type:'integer'}},relations:{parent:{targetSchemaId:'inventory-v1'}}};
const entityPage={id:'inventory',title:'Inventory',schemaId:schema.id,schemaVersion:1,blocks:['create','list','detail','relations','history'],fields:['label','quantity'],actions:['create','update','archive','link','unlink'],query:{filters:[{field:'quantity',operator:'gte',value:0}],sort:{field:'label',direction:'asc'}}};
const recipe={format:'latticedx.system-recipe',formatVersion:1,id:'inventory',version:'1.0.0',title:'Inventory',pages:[],schemas:[schema],entityPages:[entityPage]};

test('entity page block declarations expose exact read and write roles in module plans',async()=>{
 const db=await modulesDatabase({query:vi.fn(async()=>({rows:[]}))} as never,{} as never);
 const actor={subject:'designer',organizationId:'org-a',roles:['data:design','workflow:design']};
 const manifest=compileSystem({...recipe,entityPages:[entityPage,{...entityPage,id:'inventory-copy'}]});
 expect(manifest.blocks).toEqual(['archive','create','link','query','read','unlink','update'].map(operation=>({id:`entities.${operation}`,version:1})));
 expect((await db.preview(manifest,actor)).requiredRoles).toEqual(['data:read','data:write']);
 const {query:_query,...pageWithoutQuery}=entityPage;
 const readonly=compileSystem({...recipe,entityPages:[{...pageWithoutQuery,blocks:['detail'],actions:[]}]});
 expect(readonly.blocks).toEqual([{id:'entities.read',version:1}]);
 expect((await db.preview(readonly,actor)).requiredRoles).toEqual(['data:read']);
 const {schemas:_schemas,entityPages:_entityPages,...legacyRecipe}=recipe;
 const legacy=compileSystem({...legacyRecipe,pages:[{id:'requests',title:'Requests',requesterRole:'employee',reviewerRole:'reviewer',handlerRole:'handler',fields:[{name:'purpose',label:'Purpose',type:'text',required:true}]}]});
 expect(legacy.blocks).toEqual([]);
});
test('data-only recipe compiles owned schema publication and reusable page with strict bundle compatibility',()=>{
 const manifest=compileSystem(recipe);expect(manifest.schemas).toEqual([schema]);expect(manifest.presentation).toEqual({schemaVersion:1,pages:[],entityPages:[entityPage]});expect(parseManifest(manifest)).toEqual(manifest);expect(()=>parseBundle(manifest.bundle)).toThrow();
});
test('rejects invalid entity page bindings, missing create fields, query types, duplicate pages and empty systems',()=>{
 for(const changes of [{schemaId:'external'},{schemaVersion:2},{fields:['missing']},{fields:['quantity']},{actions:['execute']},{blocks:['script']},{blocks:['list'],actions:['create']},{blocks:['list','detail'],actions:['link']},{query:{filters:[{field:'quantity',operator:'contains',value:'x'}]}},{query:{sort:{field:'missing',direction:'asc'}}},{query:{limit:5}}])expect(()=>parseRecipe({...recipe,entityPages:[{...entityPage,...changes}]})).toThrow();
 expect(()=>parseRecipe({...recipe,entityPages:[]})).toThrow();expect(()=>parseRecipe({...recipe,schemas:[schema,schema]})).toThrow();expect(()=>parseRecipe({...recipe,entityPages:[entityPage,entityPage]})).toThrow();
});
test('runtime independently filters entity pages and projects only visible pinned schemas with tenant SQL',async()=>{
 const query=vi.fn(async(sql:string)=>({rows:sql.includes('SELECT m.id')?[{id:'inventory',version:'1.0.0',title:'Inventory',enabled:true,presentation:{schemaVersion:1,pages:[],entityPages:[entityPage]},definitions:[],schemas:[schema,{...schema,id:'hidden'}]}]:[]}));
 const db=await systemDatabase({query} as never);const actor={subject:'reader',organizationId:'org-a',roles:['data:read']};const page={limit:20,offset:0,q:''};
 const result=await db.runtime(actor,page);expect(result.items[0]?.presentation.entityPages).toEqual([entityPage]);expect(result.items[0]).toHaveProperty('schemas',[{...schema,version:1}]);expect(query.mock.calls.at(-1)?.[0]).toContain("'data:read'=ANY($2::text[])");expect(query.mock.calls.at(-1)?.[0]).toContain('m.organization_id=$1');
 const hidden=await db.runtime({...actor,roles:[]},page);expect(hidden.items[0]?.presentation.entityPages).toEqual([]);expect(hidden.items[0]).toHaveProperty('schemas',[]);
});

test('mixed recipes preserve separate workflow pages and reject cross-kind duplicate page ids',()=>{
 const workflowPage={id:'requests',title:'Requests',requesterRole:'employee',reviewerRole:'reviewer',handlerRole:'handler',fields:[{name:'purpose',label:'Purpose',type:'text',required:true}]};
 const mixed={...recipe,pages:[workflowPage]};const manifest=compileSystem(mixed);expect(manifest.presentation?.pages).toHaveLength(1);expect(manifest.presentation?.entityPages).toEqual([entityPage]);expect(parseManifest(manifest)).toEqual(manifest);
 expect(()=>parseRecipe({...mixed,entityPages:[{...entityPage,id:'requests'}]})).toThrow();
 const raw=structuredClone(manifest);raw.presentation!.entityPages![0]!.schemaId='external';expect(()=>parseManifest(raw)).toThrow();
 const empty=structuredClone(manifest);empty.bundle.definitions=[];empty.presentation!.pages=[];empty.presentation!.entityPages=[];expect(()=>parseManifest(empty)).toThrow();
});
