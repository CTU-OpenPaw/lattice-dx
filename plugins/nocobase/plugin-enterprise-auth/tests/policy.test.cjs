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

test('safeReturnTo allows /p and /mobile portal routes while blocking traversal and protocol-relative targets',()=>{
  for(const ok of ['/admin','/admin/test?tab=a','/p','/p/procurement','/p/procurement/orders?tab=pending','/p?view=1','/mobile','/mobile/tasks?filter=mine']){
    assert.equal(safeReturnTo(ok),ok);
  }
  for(const bad of ['/p/../evil','/mobile/../../etc/passwd','/admin/..','/portal','/mobile-web','/p\\evil','/p/%2e%2e','/p/foo\nbar','//evil.test','https://evil.test']){
    assert.equal(safeReturnTo(bad),'/admin');
  }
});

test('syncMappedUserRoles reconciles removed Keycloak groups without touching unmanaged or privileged roles',async()=>{
  const {syncMappedUserRoles}=require('../src/server/policy');
  const groupRoleMap={
    '/lattice-managers':'ldx_manager',
    '/lattice-warehouse':'ldx_warehouse',
    '/lattice-finance':'ldx_finance',
    '/admin-backdoor':'ldx_admin',
  };
  let rows=[
    {userId:12,roleName:'ldx_manager'},
    {userId:12,roleName:'ldx_warehouse'},
    {userId:12,roleName:'ldx_manual_custom'},
    {userId:12,roleName:'root'},
    {userId:12,roleName:'admin'},
    {userId:12,roleName:'ldx_admin'},
  ];
  const destroyed=[];
  const db={
    getRepository:(name)=>{
      if(name==='roles'){
        return {find:async({filter})=>[
          {name:'ldx_manager',allowConfigure:false,snippets:[]},
          {name:'ldx_warehouse',allowConfigure:false,snippets:[]},
          {name:'ldx_finance',allowConfigure:false,snippets:[]},
          {name:'ldx_admin',allowConfigure:true,snippets:['pm']},
        ].filter(r=>!filter?.name?.$in||filter.name.$in.includes(r.name))};
      }
      if(name==='rolesUsers'){
        return {
          find:async()=>rows,
          create:async({values})=>{rows.push(values);return values;},
          destroy:async({filter})=>{
            destroyed.push(filter);
            const names=Array.isArray(filter.roleName?.$in)?filter.roleName.$in:Array.isArray(filter.roleName)?filter.roleName:[filter.roleName];
            rows=rows.filter(r=>!(r.userId===filter.userId&&names.includes(r.roleName)));
            return names.length;
          },
        };
      }
      return null;
    },
  };

  const res1=await syncMappedUserRoles(db,12,['/lattice-finance'],groupRoleMap);
  assert.deepEqual(res1.added,['ldx_finance']);
  assert.deepEqual(res1.removed,['ldx_manager','ldx_warehouse']);
  assert.deepEqual(res1.skippedPrivileged,[]);
  assert.deepEqual(destroyed,[{userId:12,roleName:{$in:['ldx_manager','ldx_warehouse']}}]);
  assert.deepEqual(rows.map(r=>r.roleName),['ldx_manual_custom','root','admin','ldx_admin','ldx_finance']);

  const resNoReconcile=await syncMappedUserRoles(db,12,['/lattice-manager-none'],groupRoleMap,{reconcile:false});
  assert.deepEqual(resNoReconcile.added,[]);
  assert.deepEqual(resNoReconcile.removed,[]);
  assert.equal(destroyed.length,1);
  assert.ok(rows.some(r=>r.roleName==='ldx_finance'));

  const resEmpty=await syncMappedUserRoles(db,12,[],groupRoleMap);
  assert.deepEqual(resEmpty.added,[]);
  assert.deepEqual(resEmpty.removed,['ldx_finance']);
  assert.deepEqual(rows.map(r=>r.roleName),['ldx_manual_custom','root','admin','ldx_admin']);
});

test('syncMappedUserRoles neither adds nor revokes privileged ldx_* roles listed in groupRoleMap',async()=>{
  const {syncMappedUserRoles}=require('../src/server/policy');
  const groupRoleMap={
    '/ops':'ldx_ops',
    '/ops-pm':'ldx_ops_pm',
    '/warehouse':'ldx_warehouse',
  };
  let rows=[
    {userId:12,roleName:'ldx_ops'},
    {userId:12,roleName:'ldx_ops_pm'},
    {userId:12,roleName:'ldx_warehouse'},
  ];
  const destroyed=[];
  const db={
    getRepository:(name)=>{
      if(name==='roles'){
        return {find:async({filter})=>[
          {name:'ldx_ops',allowConfigure:true,snippets:[]},
          {name:'ldx_ops_pm',allowConfigure:false,snippets:['pm.*']},
          {name:'ldx_warehouse',allowConfigure:false,snippets:[]},
        ].filter(r=>!filter?.name?.$in||filter.name.$in.includes(r.name))};
      }
      if(name==='rolesUsers'){
        return {
          find:async()=>rows,
          create:async({values})=>{rows.push(values);return values;},
          destroy:async({filter})=>{
            destroyed.push(filter);
            const names=Array.isArray(filter.roleName?.$in)?filter.roleName.$in:[];
            rows=rows.filter(r=>!(r.userId===filter.userId&&names.includes(r.roleName)));
            return names.length;
          },
        };
      }
      return null;
    },
  };

  const res1=await syncMappedUserRoles(db,12,['/ops'],groupRoleMap);
  assert.deepEqual(res1.added,[]);
  assert.deepEqual(res1.skippedPrivileged,['ldx_ops']);
  assert.deepEqual(res1.removed,['ldx_warehouse']);
  assert.deepEqual(destroyed,[{userId:12,roleName:{$in:['ldx_warehouse']}}]);
  assert.deepEqual(rows.map(r=>r.roleName),['ldx_ops','ldx_ops_pm']);

  const res2=await syncMappedUserRoles(db,12,[],groupRoleMap);
  assert.deepEqual(res2.added,[]);
  assert.deepEqual(res2.removed,[]);
  assert.equal(destroyed.length,1);
  assert.deepEqual(rows.map(r=>r.roleName),['ldx_ops','ldx_ops_pm']);
});
