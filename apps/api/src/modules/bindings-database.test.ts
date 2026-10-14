import {it,expect,vi} from 'vitest';
import type {Pool} from 'pg';
import {modulesDatabase} from './database.js';
const actor={subject:'admin',organizationId:'org',roles:['workflow:design','data:design']};
const definition={id:'flow',title:'Flow',startRole:'employee',initialState:'draft',startFields:{},readerRoles:[],transitions:[{id:'go',from:'draft',to:'done',role:'employee',fields:{}}]};
const manifest={format:'latticedx.enterprise-module',formatVersion:1,id:'sample',version:'1.0.0',title:'Sample',schemas:[],bundle:{format:'latticedx.workflow-bundle',formatVersion:1,definitions:[definition]},blocks:[],dependencies:[{id:'dependency',version:'1.0.0'}],bindings:[{id:'business',schemaId:'data',schemaVersion:2,definitionId:'flow',allowedTransitions:['go']}]};
it.each([{version:'1.0.0',enabled:true,published:true,schemas:['data'],allowed:true},{version:'2.0.0',enabled:true,published:true,schemas:['data'],allowed:false},{version:'1.0.0',enabled:false,published:true,schemas:['data'],allowed:false},{version:'1.0.0',enabled:true,published:false,schemas:['data'],allowed:false},{version:'1.0.0',enabled:true,published:true,schemas:['unrelated'],allowed:false}])('checks dependency ownership and exact published pin %j',async options=>{
 const query=vi.fn(async(sql:string)=>({rows:sql.includes('SELECT id,version,enabled,manifest')?[{id:'dependency',version:options.version,enabled:options.enabled,manifest:{schemas:options.schemas.map(id=>({id})),dependencies:[]}}]:[],rowCount:sql.startsWith('SELECT 1 FROM enterprise_schema_versions')&&options.published?1:0}));
 const repo=await modulesDatabase({query} as unknown as Pool,{} as never);query.mockClear();const preview=await repo.preview(manifest,actor);
 expect(preview.dependencyErrors.length===0).toBe(options.allowed);expect(query.mock.calls.every(([sql])=>sql.startsWith('SELECT'))).toBe(true);
});
