/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
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

test('resolveCacheOptions uses redis when REDIS_URL or CACHE_DEFAULT_STORE=redis is set, else memory',()=>{
  const {resolveCacheOptions}=require('../src/server/policy');
  assert.equal(resolveCacheOptions({}).store,'memory');
  assert.equal(resolveCacheOptions({CACHE_DEFAULT_STORE:'redis'}).store,'redis');
  assert.equal(resolveCacheOptions({REDIS_URL:'redis://:secret@redis:6379'}).store,'redis');
  assert.equal(resolveCacheOptions({DX_NATIVE_AUTH_CACHE_STORE:'memory',REDIS_URL:'redis://redis:6379'}).store,'memory');
});

test('validateLogoutTokenClaims validates OIDC backchannel-logout 1.0 tokens strictly',()=>{
  const {validateLogoutTokenClaims}=require('../src/server/policy');
  const nowSec=1795000000;
  const valid={
    iss:'https://sso.example.com/realms/lattice',
    aud:'dx-native',
    sub:'kc-user-uuid-1',
    sid:'kc-sess-1',
    iat:nowSec-10,
    jti:'logout-jti-1',
    events:{'http://schemas.openid.net/event/backchannel-logout':{}},
  };
  assert.deepEqual(validateLogoutTokenClaims(valid,{issuer:valid.iss,clientId:'dx-native',nowSec}).sub,'kc-user-uuid-1');
  assert.deepEqual(validateLogoutTokenClaims({...valid,aud:['other','dx-native']},{issuer:valid.iss,clientId:'dx-native',nowSec}).sid,'kc-sess-1');
  for(const bad of [
    {...valid,nonce:'forbidden-nonce'},
    {...valid,iss:'https://evil.example.com'},
    {...valid,aud:'other-client'},
    {...valid,events:{}},
    {...valid,sub:undefined,sid:undefined},
    {...valid,jti:''},
    {...valid,iat:nowSec-3600},
  ]){
    assert.throws(()=>validateLogoutTokenClaims(bad,{issuer:valid.iss,clientId:'dx-native',nowSec}));
  }
});

test('parseGroupRoleMap and syncMappedUserRoles assign safe ldx_* roles idempotently and block privileged roles',async()=>{
  const {parseGroupRoleMap,syncMappedUserRoles}=require('../src/server/policy');
  const map=parseGroupRoleMap({
    DX_NATIVE_AUTH_GROUP_ROLE_MAP:JSON.stringify({
      '/lattice-managers':'ldx_manager',
      'lattice-warehouse':'ldx_warehouse',
      '/escalate-root':'root',
      '/escalate-admin':'admin',
      '/weird-role':'custom_super',
    }),
  });
  assert.deepEqual(map,{'/lattice-managers':'ldx_manager','lattice-warehouse':'ldx_warehouse'});
  assert.equal(map['/escalate-root'],undefined);
  assert.equal(map['/escalate-admin'],undefined);

  const created=[];
  const db={
    getRepository:(name)=>{
      if(name==='roles'){
        return {find:async({filter})=>[
          {name:'ldx_manager',allowConfigure:false,snippets:[]},
          {name:'ldx_warehouse',allowConfigure:false,snippets:[]},
          {name:'ldx_admin',allowConfigure:true,snippets:['pm']},
        ].filter(r=>!filter?.name?.$in||filter.name.$in.includes(r.name))};
      }
      if(name==='rolesUsers'){
        return {
          find:async()=>[{userId:12,roleName:'ldx_manager'},...created],
          create:async({values})=>{created.push(values);return values;},
        };
      }
      return null;
    },
  };
  const synced=await syncMappedUserRoles(db,12,['/lattice-managers','lattice-warehouse','/admin-backdoor'],{
    ...map,
    '/admin-backdoor':'ldx_admin',
  });
  assert.deepEqual(synced.added,['ldx_warehouse']);
  assert.deepEqual(synced.skippedPrivileged,['ldx_admin']);
  assert.equal(created.length,1);
  assert.deepEqual(created[0],{userId:12,roleName:'ldx_warehouse'});
});
