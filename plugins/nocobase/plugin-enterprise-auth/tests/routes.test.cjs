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
const {readFileSync}=require('node:fs');
const vm=require('node:vm');
const {createRequire}=require('node:module');
const path=require('node:path');
function load(file,overrides){
  const full=path.resolve(__dirname,'../src/server',file),module={exports:{}};
  const req=createRequire(full);
  vm.runInNewContext('(function(require,module,exports){'+readFileSync(full,'utf8')+'\n})',{URL,URLSearchParams,process,console})(name=>overrides[name]||req(name),module,module.exports);
  return module.exports;
}
Object.assign(process.env,{DX_NATIVE_AUTH_ISSUER:'http://localhost:8081/realms/lattice',DX_NATIVE_AUTH_ORIGIN:'http://localhost:13000',DX_NATIVE_AUTH_CLIENT_ID:'dx-native'});
const verified=Symbol('verified');
function fixture(){
  let enabled=true,role='root',signed=0;
  const mappings=[{userId:12,meta:{issuer:'http://localhost:8081/realms/lattice'}}];
  const repo=name=>({findOne:async()=>name==='authenticators'?(enabled?{name:'native-keycloak'}:null):{id:12,userId:12,organizationId:'org-a'},find:async()=>name==='usersAuthenticators'?mappings:name==='users'?[{id:12}]:[{id:1,organizationId:'org-a'}]});
  const items=new Map(),cache={get:async k=>items.get(k),set:async(k,v)=>items.set(k,v),del:async k=>items.delete(k)};
  const app={db:{getRepository:repo},lockManager:{runExclusive:async(k,fn)=>fn()},authManager:{get:async()=>({signIn:async()=>{signed++;return {token:'host-native-token'};}})}};
  const {createActions}=load('routes.js',{'./oidc':{createOidc:()=>({start:async(state,nonce)=>({url:'http://localhost:8081/auth?state='+state,verifier:'verifier'}),finish:async()=>({sub:'subject',iss:'http://localhost:8081/realms/lattice'})})}});
  const actions=createActions(app,cache,verified),cookies=new Map();
  const ctx=()=>({method:'GET',query:{},action:{params:{values:{}}},state:{currentUser:{id:1},currentRole:role},set:()=>{},get:k=>k==='Origin'?'http://localhost:13000':null,is:()=>true,cookies:{get:k=>cookies.get(k),set:(k,v)=>cookies.set(k,v)},redirect(value){this.location=value;},throw(status,message){const e=new Error(message);e.status=status;throw e;}});
  return {ctx,actions,items,cookies,disable:()=>{enabled=false;},nonRoot:()=>{role='ldx_employee';},signed:()=>signed};
}
test('start -> verified callback -> one-time bound finish returns only a native session',async()=>{
  const f=fixture(),start=f.ctx();start.query={authenticator:'native-keycloak',returnTo:'/admin/page'};
  await f.actions.start(start);assert.ok(start.location.startsWith('http://localhost:8081/auth?state='));
  const state=new URL(start.location).searchParams.get('state'),callback=f.ctx();callback.query={state,code:'code'};
  await f.actions.callback(callback);assert.equal(f.signed(),0);assert.ok(!callback.location.includes('host-native-token'));
  const ticket=new URL(callback.location).searchParams.get('ticket'),finish=f.ctx();finish.method='POST';finish.action.params.values={ticket};
  await f.actions.finish(finish);assert.equal(finish.body.token,'host-native-token');assert.equal(finish.body.returnTo,'/admin/page');assert.equal(f.signed(),1);
  await assert.rejects(()=>f.actions.finish(finish));
});
test('wrong browser binding, expired state and callback replay cannot create handoff',async()=>{
  for(const kind of ['binding','expired','replay']){
    const f=fixture(),start=f.ctx();start.query={authenticator:'native-keycloak'};await f.actions.start(start);
    const state=new URL(start.location).searchParams.get('state');
    if(kind==='binding')f.cookies.clear();
    if(kind==='expired')f.items.get('state:'+state).expiresAt=0;
    const cb=f.ctx();cb.query={state,code:'code'};await f.actions.callback(cb);
    if(kind==='replay')await f.actions.callback(cb);
    assert.match(cb.location,/verification_failed/);assert.equal(f.signed(),0);
  }
});
test('disabled provider and unauthorized root mapping/configuration are denied',async()=>{
  const f=fixture();f.disable();const c=f.ctx();c.query={authenticator:'native-keycloak'};await assert.rejects(()=>f.actions.start(c));
  f.nonRoot();const actor=f.ctx();actor.method='POST';await assert.rejects(()=>f.actions.link(actor));await assert.rejects(()=>f.actions.configuration(actor));
});
test('finish requires POST, exact Origin and browser cookie',async()=>{
  const f=fixture();await assert.rejects(()=>f.actions.finish(f.ctx()));
  const c=f.ctx();c.method='POST';c.get=()=> 'https://other.example';await assert.rejects(()=>f.actions.finish(c));
  c.get=()=> 'http://localhost:13000';await assert.rejects(()=>f.actions.finish(c));assert.equal(f.signed(),0);
});
test('authenticator does not accept user-supplied subject or signup through native endpoints',async()=>{
  const {EnterpriseAuth}=load('auth.js',{'@nocobase/auth':{BaseAuth:class{constructor(c){this.ctx=c.ctx;this.authenticator=c.authenticator;}}}});
  const a=new EnterpriseAuth({ctx:{db:{getCollection:()=>({})},state:{subject:'forged'},action:{params:{values:{subject:'forged'}}}},authenticator:{name:'native-keycloak'}});
  await assert.rejects(()=>a.validate());await assert.rejects(()=>a.signUp());
});

test('backchannelLogout verifies logout_token, revokes user session timestamp, and revocation guard blocks pre-revocation tokens',async()=>{
  const items=new Map();
  const cache={get:async k=>items.get(k),set:async(k,v)=>items.set(k,v),del:async k=>items.delete(k)};
  const mappings=[{id:5,authenticator:'native-keycloak',uuid:'kc-sub-9',userId:42,meta:{issuer:'http://localhost:8081/realms/lattice'},createdAt:'2026-11-22T00:00:00Z'}];
  const app={
    db:{
      getRepository:name=>({
        findOne:async()=>name==='authenticators'?{name:'native-keycloak'}:{id:42,userId:42,organizationId:'org-a'},
        find:async()=>name==='usersAuthenticators'?mappings:[],
        destroy:async()=>1,
      }),
    },
    lockManager:{runExclusive:async(k,fn)=>fn()},
    authManager:{get:async()=>({signIn:async()=>({token:'t'})})},
  };
  let verifiedCalls=0;
  const {createActions}=load('routes.js',{
    './oidc':{
      createOidc:()=>({
        start:async()=>({url:'x',verifier:'v'}),
        finish:async()=>({sub:'kc-sub-9',iss:'http://localhost:8081/realms/lattice'}),
        verifyLogoutToken:async(tok)=>{
          verifiedCalls+=1;
          if(tok==='bad')throw Object.assign(new Error('invalid sig'),{status:400});
          return {sub:'kc-sub-9',sid:'sid-9',iss:'http://localhost:8081/realms/lattice',jti:'jti-9',iat:Math.floor(Date.now()/1000)};
        },
      }),
    },
  });
  const {createRevocationGuard}=require('../src/server/policy');
  const actions=createActions(app,cache,Symbol('v'));

  const badCtx={method:'POST',headers:{},request:{body:{logout_token:'bad'}},action:{params:{values:{}}},set:()=>{},throw(s,m){throw Object.assign(Error(m),{status:s});}};
  await assert.rejects(()=>actions.backchannelLogout(badCtx),{status:400});

  const okCtx={method:'POST',headers:{},request:{body:{logout_token:'good-jwt'}},action:{params:{values:{}}},set:()=>{},throw(s,m){throw Object.assign(Error(m),{status:s});}};
  await actions.backchannelLogout(okCtx);
  assert.equal(verifiedCalls,2);
  assert.equal(okCtx.body.revoked,true);
  assert.equal(okCtx.body.affectedUsers,1);
  const revokedAt=items.get('revoked:42');
  assert.ok(typeof revokedAt==='number'&&revokedAt>0);

  const guard=createRevocationGuard(cache);
  const b64=o=>Buffer.from(JSON.stringify(o)).toString('base64url');
  const staleJwt=`${b64({alg:'HS256'})}.${b64({userId:42,iat:Math.floor((revokedAt-5000)/1000)})}.sig`;
  const freshJwt=`${b64({alg:'HS256'})}.${b64({userId:42,iat:Math.floor((revokedAt+5000)/1000)})}.sig`;

  const staleReq={state:{currentUser:{id:42}},get:k=>k==='Authorization'?'Bearer '+staleJwt:undefined,throw(s,m){throw Object.assign(Error(m),{status:s});}};
  await assert.rejects(()=>guard(staleReq,async()=>{}),{status:401});

  let passed=false;
  const freshReq={state:{currentUser:{id:42}},get:k=>k==='Authorization'?'Bearer '+freshJwt:undefined,throw(s,m){throw Object.assign(Error(m),{status:s});}};
  await guard(freshReq,async()=>{passed=true;});
  assert.equal(passed,true);
});

test('listMappings and unlink enforce root access, return mapped identities, and revoke unlinked sessions',async()=>{
  const items=new Map();
  const cache={get:async k=>items.get(k),set:async(k,v)=>items.set(k,v),del:async k=>items.delete(k)};
  const mappings=[
    {id:1,authenticator:'native-keycloak',uuid:'kc-1',userId:12,meta:{issuer:'http://localhost:8081/realms/lattice'},createdAt:'2026-11-22T00:00:00Z'},
  ];
  let role='root';
  const app={
    db:{
      getRepository:name=>{
        if(name==='authenticators')return {find:async()=>[{name:'native-keycloak',title:'SSO'}],findOne:async()=>({name:'native-keycloak',authType:'lattice-keycloak',enabled:true})};
        if(name==='usersAuthenticators')return {
          find:async()=>mappings,
          findOne:async({filter})=>mappings.find(m=>m.authenticator===filter.authenticator&&m.uuid===filter.uuid&&String(m.userId)===String(filter.userId))||null,
          destroy:async({filter})=>{
            const idx=mappings.findIndex(m=>m.authenticator===filter.authenticator&&m.uuid===filter.uuid&&String(m.userId)===String(filter.userId));
            if(idx===-1)return 0;
            mappings.splice(idx,1);
            return 1;
          },
        };
        return {find:async()=>[],findOne:async()=>null};
      },
    },
    lockManager:{runExclusive:async(k,fn)=>fn()},
  };
  const {createActions}=load('routes.js',{'./oidc':{createOidc:()=>({})}});
  const actions=createActions(app,cache,Symbol('v'));

  role='ldx_employee';
  const deniedCtx={method:'GET',query:{},action:{params:{values:{}}},state:{currentUser:{id:2},currentRole:role},set:()=>{},throw(s,m){throw Object.assign(Error(m),{status:s});}};
  await assert.rejects(()=>actions.listMappings(deniedCtx),{status:403});

  role='root';
  const listCtx={method:'GET',query:{},action:{params:{values:{}}},state:{currentUser:{id:1},currentRole:role},set:()=>{},throw(s,m){throw Object.assign(Error(m),{status:s});}};
  await actions.listMappings(listCtx);
  assert.equal(listCtx.body.items.length,1);
  assert.equal(listCtx.body.items[0].subject,'kc-1');

  const unlinkCtx={method:'POST',query:{},action:{params:{values:{authenticator:'native-keycloak',subject:'kc-1',userId:12}}},state:{currentUser:{id:1},currentRole:role},set:()=>{},throw(s,m){throw Object.assign(Error(m),{status:s});}};
  await actions.unlink(unlinkCtx);
  assert.equal(unlinkCtx.body.unlinked,true);
  assert.equal(mappings.length,0);
  assert.ok(items.get('revoked:12')>0);

  await assert.rejects(()=>actions.unlink(unlinkCtx),{status:404});
});

test('callback synchronizes safe ldx_* roles from Keycloak groups claim when DX_NATIVE_AUTH_GROUP_ROLE_MAP is configured',async()=>{
  const prevMap=process.env.DX_NATIVE_AUTH_GROUP_ROLE_MAP;
  process.env.DX_NATIVE_AUTH_GROUP_ROLE_MAP=JSON.stringify({'/lattice-warehouse':'ldx_warehouse','/bad-root':'root'});
  try{
    const createdRoles=[];
    const items=new Map();
    const cache={get:async k=>items.get(k),set:async(k,v)=>items.set(k,v),del:async k=>items.delete(k)};
    const mappings=[{userId:12,meta:{issuer:'http://localhost:8081/realms/lattice'}}];
    const app={
      db:{
        getRepository:name=>{
          if(name==='authenticators')return {findOne:async()=>({name:'native-keycloak'})};
          if(name==='usersAuthenticators')return {find:async()=>mappings};
          if(name==='users')return {find:async()=>[{id:12}]};
          if(name==='latticeEmployees')return {find:async()=>[{id:8,userId:12,active:true,organizationId:'org-a'}]};
          if(name==='roles')return {find:async()=>[{name:'ldx_warehouse',allowConfigure:false,snippets:[]}]};
          if(name==='rolesUsers')return {find:async()=>[],create:async({values})=>{createdRoles.push(values);return values;}};
          return {find:async()=>[]};
        },
      },
      lockManager:{runExclusive:async(k,fn)=>fn()},
      authManager:{get:async()=>({signIn:async()=>({token:'t'})})},
    };
    const {createActions}=load('routes.js',{'./oidc':{createOidc:()=>({start:async(s)=>({url:'http://localhost:8081/auth?state='+s,verifier:'v'}),finish:async()=>({sub:'sub-1',iss:'http://localhost:8081/realms/lattice',groups:['/lattice-warehouse','/bad-root']})})}});
    const actions=createActions(app,cache,Symbol('v')),cookies=new Map();
    const ctx=()=>({method:'GET',query:{},action:{params:{values:{}}},state:{currentUser:{id:1},currentRole:'root'},set:()=>{},get:()=>null,is:()=>true,cookies:{get:k=>cookies.get(k),set:(k,v)=>cookies.set(k,v)},redirect(v){this.location=v;},throw(s,m){throw Object.assign(Error(m),{status:s});}});
    const s=ctx();s.query={authenticator:'native-keycloak'};await actions.start(s);
    const state=new URL(s.location).searchParams.get('state');
    const cb=ctx();cb.query={state,code:'ok'};await actions.callback(cb);
    assert.match(cb.location,/\/enterprise-login\?ticket=/);
    assert.deepEqual(createdRoles,[{userId:12,roleName:'ldx_warehouse'}]);
  }finally{
    if(prevMap===undefined)delete process.env.DX_NATIVE_AUTH_GROUP_ROLE_MAP;
    else process.env.DX_NATIVE_AUTH_GROUP_ROLE_MAP=prevMap;
  }
});

test('start -> callback -> finish preserves /p/*, /mobile/*, and /v/mobile/* portal returnTo targets',async()=>{
  for(const target of ['/p/procurement?tab=orders','/mobile/inbox','/v/mobile/inbox']){
    const f=fixture(),start=f.ctx();start.query={authenticator:'native-keycloak',returnTo:target};
    await f.actions.start(start);
    const state=new URL(start.location).searchParams.get('state'),callback=f.ctx();callback.query={state,code:'code'};
    await f.actions.callback(callback);
    const ticket=new URL(callback.location).searchParams.get('ticket'),finish=f.ctx();finish.method='POST';finish.action.params.values={ticket};
    await f.actions.finish(finish);
    assert.equal(finish.body.returnTo,target);
  }
});

test('callback reconciles and removes managed ldx_* roles when Keycloak user has empty groups claim',async()=>{
  const prevMap=process.env.DX_NATIVE_AUTH_GROUP_ROLE_MAP;
  process.env.DX_NATIVE_AUTH_GROUP_ROLE_MAP=JSON.stringify({'/lattice-warehouse':'ldx_warehouse','/lattice-managers':'ldx_manager'});
  try{
    let roleRows=[
      {userId:12,roleName:'ldx_warehouse'},
      {userId:12,roleName:'ldx_manual_extra'},
      {userId:12,roleName:'root'},
    ];
    const destroyedFilters=[];
    const items=new Map();
    const cache={get:async k=>items.get(k),set:async(k,v)=>items.set(k,v),del:async k=>items.delete(k)};
    const mappings=[{userId:12,meta:{issuer:'http://localhost:8081/realms/lattice'}}];
    const app={
      db:{
        getRepository:name=>{
          if(name==='authenticators')return {findOne:async()=>({name:'native-keycloak'})};
          if(name==='usersAuthenticators')return {find:async()=>mappings};
          if(name==='users')return {find:async()=>[{id:12}]};
          if(name==='latticeEmployees')return {find:async()=>[{id:8,userId:12,active:true,organizationId:'org-a'}]};
          if(name==='roles')return {find:async()=>[]};
          if(name==='rolesUsers')return {
            find:async()=>roleRows,
            create:async({values})=>{roleRows.push(values);return values;},
            destroy:async({filter})=>{
              destroyedFilters.push(filter);
              const names=Array.isArray(filter.roleName?.$in)?filter.roleName.$in:[];
              roleRows=roleRows.filter(r=>!(r.userId===filter.userId&&names.includes(r.roleName)));
              return names.length;
            },
          };
          return {find:async()=>[]};
        },
      },
      lockManager:{runExclusive:async(k,fn)=>fn()},
      authManager:{get:async()=>({signIn:async()=>({token:'t'})})},
    };
    const {createActions}=load('routes.js',{'./oidc':{createOidc:()=>({start:async(s)=>({url:'http://localhost:8081/auth?state='+s,verifier:'v'}),finish:async()=>({sub:'sub-1',iss:'http://localhost:8081/realms/lattice',groups:[]})})}});
    const actions=createActions(app,cache,Symbol('v')),cookies=new Map();
    const ctx=()=>({method:'GET',query:{},action:{params:{values:{}}},state:{currentUser:{id:1},currentRole:'root'},set:()=>{},get:()=>null,is:()=>true,cookies:{get:k=>cookies.get(k),set:(k,v)=>cookies.set(k,v)},redirect(v){this.location=v;},throw(s,m){throw Object.assign(Error(m),{status:s});}});
    const s=ctx();s.query={authenticator:'native-keycloak'};await actions.start(s);
    const state=new URL(s.location).searchParams.get('state');
    const cb=ctx();cb.query={state,code:'ok'};await actions.callback(cb);
    assert.match(cb.location,/\/enterprise-login\?ticket=/);
    assert.deepEqual(destroyedFilters,[{userId:12,roleName:{$in:['ldx_warehouse']}}]);
    assert.deepEqual(roleRows.map(r=>r.roleName),['ldx_manual_extra','root']);
  }finally{
    if(prevMap===undefined)delete process.env.DX_NATIVE_AUTH_GROUP_ROLE_MAP;
    else process.env.DX_NATIVE_AUTH_GROUP_ROLE_MAP=prevMap;
  }
});
