/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { test, expect } from 'vitest';
import { generateKeyPair, SignJWT, createLocalJWKSet, exportJWK } from 'jose';
import { createApi } from './app';
import type { TaskInput } from './foundation';
import { requireAssignee } from './directory';
const { privateKey, publicKey } = await generateKeyPair('RS256');
const key = createLocalJWKSet({ keys: [{ ...await exportJWK(publicKey), kid: 'directory', alg: 'RS256' }] });
async function auth(roles=['tasks:assign','directory:read'],organizationId: string|undefined='org-a') {
  return {authorization:`Bearer ${await new SignJWT({organization_id:organizationId,realm_access:{roles}}).setProtectedHeader({alg:'RS256',kid:'directory'}).setSubject('alice').setIssuer('https://identity.test').setAudience('dx-api').setExpirationTime('5m').sign(privateKey)}`};
}
function setup(directory?: any) {
  let writes=0;
  const app=createApi({workerUrl:'http://localhost:1',identity:{key,issuer:'https://identity.test',audience:'dx-api'},directory,
    foundation:{async listTasks(){return []},async createTask(input:TaskInput){writes++;return {...input,id:'task',status:'pending',version:1}},async decideTask(){return undefined},async createFile(){throw Error('unused')},async markFile(){},async readFile(){return undefined}}} as any);
  return {app,writes:()=>writes};
}
test.each(['/v1/tasks','/v1/actions/tasks.create/run'])('assignment %s fails closed without directory even without recordId',async url=>{
  const {app,writes}=setup();try {const input={title:'Review',assigneeId:'unknown'};expect((await app.inject({method:'POST',url,headers:await auth(),payload:url.includes('actions')?{version:1,input}:input})).statusCode).toBe(503);expect(writes()).toBe(0);}finally{await app.close();}
});
test.each(['unknown','foreign','disabled'])('both assignment paths reject %s from signed organization without writes',async subject=>{
  const {app,writes}=setup({async find(){return subject==='foreign'?{subject,organizationId:'org-b',displayName:'Foreign',roles:[]}:undefined}});
  try{for(const url of ['/v1/tasks','/v1/actions/tasks.create/run']){const input={title:'Review',assigneeId:subject};expect((await app.inject({method:'POST',url,headers:await auth(),payload:url.includes('actions')?{version:1,input}:input})).statusCode).toBe(400);}expect(writes()).toBe(0);}finally{await app.close();}
});
test('directory requires a real signed role/scope, parses pagination, and strips internal fields',async()=>{
  const person={subject:'bob',organizationId:'org-a',displayName:'Bob',departmentId:'warehouse',roles:['logistics:warehouse']};let observed:unknown;
  const {app}=setup({async list(org: string,query:unknown){observed={org,query};return {items:[{...person,enabled:true,password:'secret'}],page:{limit:1,offset:2,hasMore:true,nextOffset:3}}}});
  try{
    expect((await app.inject({url:'/v1/directory/people'})).statusCode).toBe(401);
    expect((await app.inject({url:'/v1/directory/people',headers:await auth([])})).statusCode).toBe(403);
    const r=await app.inject({url:'/v1/directory/people?limit=1&offset=2&role=logistics%3Awarehouse&department=warehouse&q=Bob',headers:await auth()});expect(r.statusCode).toBe(200);expect(r.json().items).toEqual([person]);expect(observed).toEqual({org:'org-a',query:{limit:1,offset:2,role:'logistics:warehouse',department:'warehouse',q:'Bob'}});
    for(const query of ['limit=0','limit=101','offset=-1','offset=1.5','limit=1&limit=2',`q=${'a'.repeat(201)}`])expect((await app.inject({url:`/v1/directory/people?${query}`,headers:await auth()})).statusCode).toBe(400);
  }finally{await app.close();}
});
test('directory and assignment map repository outage to 503',async()=>{
  const {app,writes}=setup({async find(){throw Error('database password')},async list(){throw Error('database password')}});try{
    for(const url of ['/v1/tasks','/v1/actions/tasks.create/run']){const input={title:'Review',assigneeId:'bob'};const r=await app.inject({method:'POST',url,headers:await auth(),payload:url.includes('actions')?{version:1,input}:input});expect(r.statusCode).toBe(503);expect(r.body).not.toContain('password');}
    expect((await app.inject({url:'/v1/directory/people',headers:await auth()})).statusCode).toBe(503);expect(writes()).toBe(0);
  }finally{await app.close();}
});
test('shared verifier requires the configured role from the verified recipient',async()=>{
  const scope={subject:'alice',organizationId:'org-a'};
  const directory={async find(subject:string,organizationId:string){return {subject,organizationId,displayName:'Bob',roles:['employee']}},async list(){throw Error('unused')}};
  await expect(requireAssignee('bob',scope,directory,'logistics:warehouse')).rejects.toMatchObject({statusCode:400});
  expect(await requireAssignee('bob',scope,directory,'employee')).toMatchObject({subject:'bob',roles:['employee']});
  await expect(requireAssignee(' bob ',scope,directory)).rejects.toMatchObject({statusCode:400});
});
test('directory denies missing signed organization and invalid JWT despite caller query scope',async()=>{
  const {app}=setup({async list(){throw Error('should not reach directory')}});try{
    const token=await new SignJWT({realm_access:{roles:['directory:read']}}).setProtectedHeader({alg:'RS256',kid:'directory'}).setSubject('alice').setIssuer('https://identity.test').setAudience('dx-api').setExpirationTime('5m').sign(privateKey);
    expect((await app.inject({url:'/v1/directory/people?organizationId=org-a',headers:{authorization:`Bearer ${token}`}})).statusCode).toBe(403);
    expect((await app.inject({url:'/v1/directory/people',headers:{authorization:'Bearer invalid'}})).statusCode).toBe(401);
  }finally{await app.close();}
});

test('department catalogue requires directory permission and uses signed organization',async()=>{
  let observed:unknown;
  const {app}=setup({async departments(org:string,query:unknown){observed={org,query};return {items:[{id:'it',name:'IT',memberCount:1,internal:'secret'}],page:{limit:1,offset:0,hasMore:false,nextOffset:null}}}});
  try{
    expect((await app.inject({url:'/v1/directory/departments'})).statusCode).toBe(401);
    expect((await app.inject({url:'/v1/directory/departments',headers:await auth([])})).statusCode).toBe(403);
    const result=await app.inject({url:'/v1/directory/departments?limit=1&role=tasks%3Adecide',headers:await auth()});
    expect(result.statusCode).toBe(200);expect(result.json().items).toEqual([{id:'it',name:'IT',memberCount:1}]);
    expect(observed).toEqual({org:'org-a',query:{limit:1,offset:0,role:'tasks:decide'}});
  }finally{await app.close();}
});
