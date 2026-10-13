// SPDX-License-Identifier: Apache-2.0
import { test, expect } from 'vitest';
import { generateKeyPair, SignJWT, createLocalJWKSet, exportJWK } from 'jose';
import { createApi } from './app';
import { unitDirectory } from './directory-fixture';
import type { TaskInput, FileInput, FileItem, FoundationRepository } from './foundation';

// Real PostgreSQL integration runs separately through the gateway smoke script.
const { privateKey, publicKey } = await generateKeyPair('RS256');
const key = createLocalJWKSet({ keys: [{ ...await exportJWK(publicKey), kid: 'foundation', alg: 'RS256' }] });
async function headers(roles: string[], organizationId = 'org-a') {
  const token = await new SignJWT({ organization_id: organizationId, realm_access: { roles } })
    .setProtectedHeader({ alg: 'RS256', kid: 'foundation' }).setSubject('alice')
    .setIssuer('https://identity.test').setAudience('dx-api').setExpirationTime('5m').sign(privateKey);
  return { authorization: `Bearer ${token}` };
}
test('task API rejects calls without a configured repository', async () => {
  const app = createApi({workerUrl:'http://localhost:1'});
  try { expect((await app.inject({url:'/v1/tasks'})).statusCode).toBe(503); }
  finally { await app.close(); }
});
test('file API fails closed when storage is not configured', async () => {
  const app = createApi({workerUrl:'http://localhost:1'});
  try { expect((await app.inject({method:'POST',url:'/v1/files',payload:{filename:'test.txt',contentBase64:'dGVzdA=='}})).statusCode).toBe(503); }
  finally { await app.close(); }
});

function configured(scan:()=>Promise<'clean'|'rejected'>=async()=> 'clean') {
  let writes = 0;
  let stored:(FileItem & {content:Buffer})|undefined;
  const repository:FoundationRepository = {
    async listTasks() { return []; },
    async createTask(input: TaskInput) { writes++; return {id:'task-1',version:1,status:'pending',...input}; },
    async decideTask() { return undefined; },
    async createFile(input: FileInput) { writes++; stored={id:'file-1',size:input.content.length,scanStatus:'pending',...input}; const {content,...metadata}=stored;return metadata; },
    async markFile(id,status) {if(stored)stored.scanStatus=status;},
    async readFile(id,scope) { return stored?.id===id&&stored.organizationId===scope.organizationId&&stored.ownerId===scope.subject?stored:undefined; },
  };
  return {app:createApi({workerUrl:'http://localhost:1',identity:{key,issuer:'https://identity.test',audience:'dx-api'},foundation:repository,directory:unitDirectory,scan}),writes:()=>writes};
}
test('task assignment requires a specific role and signed organization scope', async()=>{
  const {app,writes}=configured();
  try {
    expect((await app.inject({method:'POST',url:'/v1/tasks',headers:await headers(['records:write']),payload:{title:'Approve',assigneeId:'bob'}})).statusCode).toBe(403);
    expect(writes()).toBe(0);
    const created=await app.inject({method:'POST',url:'/v1/tasks',headers:await headers(['tasks:assign']),payload:{title:'Approve',assigneeId:'alice',organizationId:'org-b'}});
    expect(created.statusCode).toBe(201); expect(created.json().organizationId).toBe('org-a');
  }finally{await app.close();}
});

test.each(['rejected','error'] as const)('files cannot be downloaded after scan %s',async(status)=>{
  const {app}=configured(async()=>{if(status==='error')throw new Error('offline');return 'rejected';});
  try{
    const h=await headers(['files:write','files:read']);
    const upload=await app.inject({method:'POST',url:'/v1/files',headers:h,payload:{filename:'a.txt',contentBase64:'YQ=='}});
    expect(upload.statusCode).toBe(201);expect(upload.json().scanStatus).toBe(status);
    expect(upload.json()).not.toHaveProperty('content');
    expect((await app.inject({url:'/v1/files/file-1/content',headers:h})).statusCode).toBe(409);
  }finally{await app.close();}
});
test('clean file is downloadable only in its signed owner/organization scope',async()=>{
  const {app}=configured();
  try{
    const h=await headers(['files:write','files:read']);
    await app.inject({method:'POST',url:'/v1/files',headers:h,payload:{filename:'a.txt',contentBase64:'YQ=='}});
    const own=await app.inject({url:'/v1/files/file-1/content',headers:h});expect(own.statusCode).toBe(200);expect(own.body).toBe('a');
    expect((await app.inject({url:'/v1/files/file-1/content',headers:await headers(['files:read'],'org-b')})).statusCode).toBe(404);
  }finally{await app.close();}
});

test('malformed Unicode filenames are rejected before storing a file',async()=>{
  const {app,writes}=configured();
  try{
    const r=await app.inject({method:'POST',url:'/v1/files',headers:await headers(['files:write']),payload:{filename:'\ud800.txt',contentBase64:'YQ=='}});
    expect(r.statusCode).toBe(400);expect(writes()).toBe(0);
  }finally{await app.close();}
});
test('rejection needs a reason and decisions need an expected version',async()=>{
  const {app}=configured();
  try{
    const h=await headers(['tasks:decide']);
    expect((await app.inject({method:'POST',url:'/v1/tasks/task-1/decisions',headers:h,payload:{decision:'reject',expectedVersion:1}})).statusCode).toBe(400);
    expect((await app.inject({method:'POST',url:'/v1/tasks/task-1/decisions',headers:h,payload:{decision:'approve'}})).statusCode).toBe(400);
    expect((await app.inject({method:'POST',url:'/v1/tasks/task-1/decisions',headers:h,payload:{decision:'approve',expectedVersion:1}})).statusCode).toBe(409);
  }finally{await app.close();}
});
test('file upload requires permission and valid canonical base64',async()=>{
  const {app,writes}=configured();
  try{
    expect((await app.inject({method:'POST',url:'/v1/files',headers:await headers([]),payload:{filename:'a.txt',contentBase64:'YQ=='}})).statusCode).toBe(403);
    expect((await app.inject({method:'POST',url:'/v1/files',headers:await headers(['files:write']),payload:{filename:'a.txt',contentBase64:'@@invalid'}})).statusCode).toBe(400);
    expect(writes()).toBe(0);
  }finally{await app.close();}
});

test.each(['../a.txt','a\\b.txt','a\n.txt',''])('rejects unsafe file name %j',async(filename)=>{
  const {app,writes}=configured();
  try{
    expect((await app.inject({method:'POST',url:'/v1/files',headers:await headers(['files:write']),payload:{filename,contentBase64:'YQ=='}})).statusCode).toBe(400);
    expect(writes()).toBe(0);
  }finally{await app.close();}
});

test('upload rejects bytes over 1 MiB and honors the boundary without leaking metadata content',async()=>{
  const {app,writes}=configured();
  try{
    const h=await headers(['files:write','files:read']);
    const tooLarge=await app.inject({method:'POST',url:'/v1/files',headers:h,payload:{filename:'large.txt',contentBase64:Buffer.alloc(1_048_577,65).toString('base64')}});
    expect(tooLarge.statusCode).toBe(413);expect(writes()).toBe(0);
    const boundary=await app.inject({method:'POST',url:'/v1/files',headers:h,payload:{filename:'boundary.txt',contentBase64:Buffer.alloc(1_048_576,65).toString('base64')}});
    expect(boundary.statusCode).toBe(201);expect(boundary.json().size).toBe(1_048_576);
    const metadata=await app.inject({url:'/v1/files/file-1',headers:h});
    expect(metadata.statusCode).toBe(200);expect(metadata.json()).not.toHaveProperty('content');
  }finally{await app.close();}
});

test.each(['/v1/tasks','/v1/files/file-1','/v1/files/file-1/content'])('foundation read %s requires authentication',async(url)=>{
  const {app}=configured();
  try{expect((await app.inject({url})).statusCode).toBe(401);}finally{await app.close();}
});
