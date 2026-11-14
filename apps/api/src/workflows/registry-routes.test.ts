/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { expect,test } from 'vitest';
import { generateKeyPair,exportJWK,createLocalJWKSet,SignJWT } from 'jose';
import { createApi } from '../app.js';
import { sourceRegistry,validateDefinition,type DefinitionRegistry,type WorkflowDraft } from './registry.js';
import { WorkflowError } from './policy.js';
import type { WorkflowRepository } from './types.js';
const definition={id:'hr-request',title:'HR request',startRole:'employee',initialState:'draft',startFields:{request:'text'},readerRoles:['manager'],transitions:[{id:'submit',from:'draft',to:'done',role:'employee',ownerOnly:true,fields:{}}]};
const {privateKey,publicKey}=await generateKeyPair('RS256');
const key=createLocalJWKSet({keys:[{...await exportJWK(publicKey),kid:'studio',alg:'RS256'}]});
async function auth(roles=['workflow:design','employee','workflow:start'],org='org-a') {return {authorization:'Bearer '+await new SignJWT({organization_id:org,realm_access:{roles}}).setProtectedHeader({alg:'RS256',kid:'studio'}).setSubject('alice').setIssuer('https://identity.test').setAudience('dx-api').setExpirationTime('5m').sign(privateKey)};}
function setup(){
  const drafts=new Map<string,WorkflowDraft>(),published=new Map<string,ReturnType<typeof validateDefinition>&{version:number}>();
  const registry:DefinitionRegistry={...sourceRegistry,
    async create(value,actor){const d=validateDefinition(value),k=actor.organizationId+':'+d.id;if(drafts.has(k))throw new WorkflowError(409,'exists');const draft={id:d.id,revision:1,definition:d,createdBy:actor.subject,updatedBy:actor.subject,createdAt:'2026-10-13',updatedAt:'2026-10-13'};drafts.set(k,draft);return draft;},
    async createMany(values,actor){const definitions=values.map(validateDefinition),ids=definitions.map(d=>d.id);if(new Set(ids).size!==ids.length||ids.some(id=>drafts.has(actor.organizationId+':'+id)))throw new WorkflowError(409,'exists');return Promise.all(definitions.map(value=>this.create(value,actor)));},
    async getDraft(id,actor){const d=drafts.get(actor.organizationId+':'+id);if(!d)throw new WorkflowError(404,'hidden');return d;},
    async updateDraft(id,revision,value,actor){const d=await this.getDraft(id,actor);if(d.revision!==revision)throw new WorkflowError(409,'changed');const next={...d,definition:validateDefinition(value),revision:revision+1};drafts.set(actor.organizationId+':'+id,next);return next;},
    async publish(id,revision,actor){const d=await this.getDraft(id,actor);if(d.revision!==revision)throw new WorkflowError(409,'changed');const p={...d.definition,version:revision};published.set(actor.organizationId+':'+id,p);return p;},
    async listDrafts(actor,page){const all=[...drafts.entries()].filter(([k])=>k.startsWith(actor.organizationId+':')).map(([,v])=>v);return {items:all.slice(page.offset,page.offset+page.limit),page:{...page,hasMore:false,nextOffset:null}};},
    async get(org,id,version){const p=published.get(org+':'+id);return p&&(!version||p.version===version)?p:sourceRegistry.get(org,id,version);},
    async list(org){return [...await sourceRegistry.list(org),...[...published.entries()].filter(([k])=>k.startsWith(org+':')).map(([,v])=>v)];},
  };
  const run={id:'11111111-1111-4111-8111-111111111111',recordId:'11111111-1111-4111-8111-111111111111',definitionId:definition.id,definitionVersion:1,title:'Request',ownerId:'alice',organizationId:'org-a',state:'draft',version:1,data:{request:'hi'},createdAt:'2026-10-13',updatedAt:'2026-10-13'};
  const workflows={async create(){return run;},async get(){return run;},async list(){return [run];}} as unknown as WorkflowRepository;
  return createApi({workerUrl:'http://localhost:1',identity:{issuer:'https://identity.test',audience:'dx-api',key},definitionRegistry:registry,workflows});
}
test('draft API enforces signed design scope, strict payloads, conflicts and isolation',async()=>{
  const app=setup();try{
    const headers=await auth(),payload={definition};
    expect((await app.inject({method:'POST',url:'/v1/workflow-drafts',payload})).statusCode).toBe(401);
    expect((await app.inject({method:'POST',url:'/v1/workflow-drafts',headers:await auth(['employee']),payload})).statusCode).toBe(403);
    expect((await app.inject({method:'POST',url:'/v1/workflow-drafts',headers,payload:{...payload,organizationId:'org-b'}})).statusCode).toBe(400);
    expect((await app.inject({method:'POST',url:'/v1/workflow-drafts',headers,payload})).statusCode).toBe(201);
    expect((await app.inject({url:'/v1/workflow-drafts/hr-request',headers:await auth(undefined,'org-b')})).statusCode).toBe(404);
    expect((await app.inject({method:'PUT',url:'/v1/workflow-drafts/hr-request',headers,payload:{expectedRevision:2,definition}})).statusCode).toBe(409);
    expect((await app.inject({method:'POST',url:'/v1/workflow-drafts/hr-request/publish',headers,payload:{expectedRevision:1}})).json().version).toBe(1);
    expect((await app.inject({url:'/v1/workflow-drafts?limit=0',headers})).statusCode).toBe(400);
  }finally{await app.close();}
});
test('tenant publication appears in catalogue and resolves runtime views',async()=>{
  const app=setup();try{
    const headers=await auth();await app.inject({method:'POST',url:'/v1/workflow-drafts',headers,payload:{definition}});await app.inject({method:'POST',url:'/v1/workflow-drafts/hr-request/publish',headers,payload:{expectedRevision:1}});
    expect((await app.inject({url:'/v1/workflow-definitions',headers})).json().items.map((d:{id:string})=>d.id)).toContain('hr-request');
    expect((await app.inject({url:'/v1/workflow-definitions',headers:await auth(undefined,'org-b')})).json().items.map((d:{id:string})=>d.id)).not.toContain('hr-request');
    const created=await app.inject({method:'POST',url:'/v1/workflows',headers:{...headers,'idempotency-key':'hr-start'},payload:{definitionId:'hr-request',title:'Request',input:{request:'hi'}}});
    expect(created.statusCode).toBe(201);expect(created.json().availableTransitions.map((t:{id:string})=>t.id)).toEqual(['submit']);
    expect((await app.inject({url:'/v1/workflows',headers})).json().items[0].availableTransitions[0].id).toBe('submit');
  }finally{await app.close();}
});


test('batch registry fixture leaves no early draft after a later ID collision',async()=>{
 const app=setup();try{
 const headers=await auth();
 expect((await app.inject({method:'POST',url:'/v1/workflow-drafts',headers,payload:{definition}})).statusCode).toBe(201);
 const first={...definition,id:'first-new'};
 const result=await app.inject({method:'POST',url:'/v1/workflow-bundles/import',headers,payload:{bundle:{format:'latticedx.workflow-bundle',formatVersion:1,definitions:[first,definition]}}});
 expect(result.statusCode).toBe(409);
 expect((await app.inject({url:'/v1/workflow-drafts/first-new',headers})).statusCode).toBe(404);
 }finally{await app.close();}
});
