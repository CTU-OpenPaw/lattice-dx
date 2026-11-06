// SPDX-License-Identifier: Apache-2.0
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {deploymentConfig,safeReturnTo,consumeBound,resolveMappedUser}=require('../src/server/policy');
const env={DX_NATIVE_AUTH_ISSUER:'http://localhost:8081/realms/lattice',DX_NATIVE_AUTH_INTERNAL_ISSUER:'http://keycloak:8080/realms/lattice',DX_NATIVE_AUTH_ORIGIN:'http://localhost:13000',DX_NATIVE_AUTH_CLIENT_ID:'dx-native'};
test('deployment config requires explicit URLs, fixed callback and safe internal issuer',()=>{
  const c=deploymentConfig(env);assert.equal(c.callback,'http://localhost:13000/api/enterpriseAuth:callback');
  for(const change of [{DX_NATIVE_AUTH_ISSUER:'http://example.com'},{DX_NATIVE_AUTH_ORIGIN:'http://example.com'},{DX_NATIVE_AUTH_ORIGIN:'http://localhost:13000/path'},{DX_NATIVE_AUTH_ISSUER:'https://user:pass@example.com'},{DX_NATIVE_AUTH_INTERNAL_ISSUER:'http://keycloak:8080/other'}])assert.throws(()=>deploymentConfig({...env,...change}));
  assert.throws(()=>deploymentConfig({}));
});
test('return target cannot navigate outside native app or expose login callback',()=>{
  assert.equal(safeReturnTo('/admin/test?tab=a'),'/admin/test?tab=a');
  for(const v of ['//evil.test','https://evil.test','/\\evil.test','/%2f%2fevil.test','/api/enterpriseAuth:callback','/signin','/enterprise-login','/admin\nLocation:evil','/lattice'])assert.equal(safeReturnTo(v),'/admin');
});
test('browser-bound cache token is consumed once under native lock',async()=>{
  const items=new Map([['state:x',{binding:'bound',expiresAt:Date.now()+10000}]]);
  const cache={get:async k=>items.get(k),del:async k=>items.delete(k)};
  let locked=0;const locks={runExclusive:async(k,fn)=>{locked++;return fn();}};
  await assert.rejects(()=>consumeBound(cache,locks,'state','x','wrong'));
  assert.ok(await consumeBound(cache,locks,'state','x','bound'));
  await assert.rejects(()=>consumeBound(cache,locks,'state','x','bound'));assert.equal(locked,3);
  items.set('state:x',{binding:'bound',expiresAt:Date.now()-1});await assert.rejects(()=>consumeBound(cache,locks,'state','x','bound'));
});
test('only explicit subject mapping with one active native membership may log in',async()=>{
  const rows={usersAuthenticators:[{userId:12,meta:{issuer:'issuer'}}],users:[{id:12}],latticeEmployees:[{id:8,userId:12,active:true,organizationId:'org-a'}]};
  const db={getRepository:name=>({find:async()=>rows[name]})};
  assert.equal((await resolveMappedUser(db,'native-keycloak','sub-1','issuer')).id,12);
  await assert.rejects(()=>resolveMappedUser(db,'native-keycloak','sub-1','different-issuer'));
  rows.latticeEmployees=[];await assert.rejects(()=>resolveMappedUser(db,'native-keycloak','sub-1','issuer'));
  rows.usersAuthenticators=[];await assert.rejects(()=>resolveMappedUser(db,'native-keycloak','sub-1','issuer'));
  rows.usersAuthenticators=[{userId:12},{userId:13}];await assert.rejects(()=>resolveMappedUser(db,'native-keycloak','sub-1','issuer'));
});
