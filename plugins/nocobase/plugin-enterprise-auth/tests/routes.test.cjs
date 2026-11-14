/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
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
