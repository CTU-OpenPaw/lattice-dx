// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
const rehearsal=process.argv.includes('--rehearsal'),origin=rehearsal?'http://localhost:13001':'http://localhost:13000';
const fixture=JSON.parse(await readFile('output/native-platform/native-auth-lab'+(rehearsal?'-rehearsal':'')+'.json','utf8'));
const checks=[];
async function request(url,options={},cookies=new Map()){
  const r=await fetch(url,{...options,headers:{...options.headers,...(cookies.size?{cookie:[...cookies].map(([k,v])=>k+'='+v).join('; ')}:{})},redirect:'manual',signal:AbortSignal.timeout(15000)});
  for(const cookie of r.headers.getSetCookie()){const part=cookie.split(';')[0],index=part.indexOf('=');cookies.set(part.slice(0,index),part.slice(index+1));}
  return r;
}
const api=(path,options={},jar)=>request(origin+'/api/'+path,options,jar);
const post=values=>({method:'POST',headers:{'content-type':'application/json',Origin:origin},body:JSON.stringify(values)});
async function login(username,password,expectHandoff=true){
  const jar=new Map();
  const start=await api('enterpriseAuth:start?authenticator='+fixture.authenticator+'&returnTo='+encodeURIComponent('/admin/nativeuilabeb8c2601e3'),{},jar);
  assert.equal(start.status,302,'enterprise start must redirect');
  const authorization=start.headers.get('location');assert.equal(new URL(authorization).searchParams.get('code_challenge_method'),'S256');
  const form=await request(authorization,{},jar);assert.equal(form.status,200,'Keycloak login page must load');
  const html=await form.text(),action=html.match(/<form[^>]+action="([^"]+)"/i)?.[1]?.replaceAll('&amp;','&');
  assert.ok(action,'Keycloak login form missing');
  const signed=await request(action,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username,password,credentialId:''}).toString()},jar);
  assert.equal(signed.status,302,'Keycloak fixture credentials rejected');
  const callback=signed.headers.get('location');assert.equal(new URL(callback).origin,origin);
  const result=await request(callback,{},jar);
  assert.equal(result.status,302,'callback must redirect');
  const handoff=result.headers.get('location');
  if(!expectHandoff){assert.equal(new URL(handoff).pathname,'/signin');assert.equal(new URL(handoff).searchParams.get('enterpriseError'),'verification_failed');return;}
  assert.equal(new URL(handoff).pathname,'/enterprise-login','OIDC callback did not verify');
  assert.equal(new URL(handoff).searchParams.has('token'),false,'no bearer token in URL');
  const ticket=new URL(handoff).searchParams.get('ticket');
  return {jar,callback,ticket};
}
const good=await login('alice','local-alice-password');checks.push('real_keycloak_authorization_code_pkce');
await login('bob','local-bob-password',false);checks.push('unmapped_keycloak_user_denied');
const wrongJar=await api('enterpriseAuth:finish',post({ticket:good.ticket}));assert.equal(wrongJar.status,403);checks.push('handoff_requires_browser_cookie');
const crossOrigin=post({ticket:good.ticket});crossOrigin.headers.Origin='https://other.example';
assert.equal((await api('enterpriseAuth:finish',crossOrigin,good.jar)).status,403);checks.push('cross_origin_finish_denied');
const finished=await api('enterpriseAuth:finish',post({ticket:good.ticket}),good.jar);assert.equal(finished.status,200,'native session issuance failed');
const {data:session}=await finished.json();assert.ok(session.token);assert.equal(session.authenticator,fixture.authenticator);checks.push('host_base_auth_session');
const replay=await api('enterpriseAuth:finish',post({ticket:good.ticket}),good.jar);assert.equal(replay.status,403);checks.push('handoff_replay_denied');
const cbReplay=await request(good.callback,{},good.jar);assert.match(cbReplay.headers.get('location'),/verification_failed/);checks.push('callback_replay_denied');
const headers={authorization:'Bearer '+session.token,'X-Authenticator':session.authenticator};
const who=await api('auth:check',{headers});assert.equal(who.status,200);const identity=(await who.json()).data;
assert.equal(String(identity.id),String(fixture.mapped.find(x=>x.keycloakUsername==='alice').nativeUserId));checks.push('native_auth_check_matches_explicit_mapping');
const context=await api('latticeNative:context',{headers});assert.equal(context.status,200);assert.equal((await context.json()).data.organizationId,'native-ui-lab');checks.push('native_organization_scope_retained');
const direct=await api('auth:signIn',{...post({subject:fixture.mapped[0].subject}),headers:{...post({}).headers,'X-Authenticator':fixture.authenticator}});assert.equal(direct.status,403);checks.push('forged_direct_signin_denied');
const linking=await api('enterpriseAuth:link',{...post({authenticator:fixture.authenticator,subject:'forged',userId:1}),headers:{...post({}).headers,...headers}});assert.equal(linking.status,403);checks.push('employee_cannot_link_identity');
const signedOut=await api('auth:signOut',{...post({}),headers:{...post({}).headers,...headers}},good.jar);assert.equal(signedOut.status,200);checks.push('native_logout');
assert.equal((await api('auth:check',{headers})).status,401);checks.push('signed_out_host_token_rejected');
const fallback=await api('auth:signIn',post({email:'native.lab.employee@example.invalid',password:'NativeLab-2026!'}));assert.equal(fallback.status,200);checks.push('native_password_fallback');
await writeFile('output/native-platform/native-auth-acceptance'+(rehearsal?'-rehearsal':'')+'.json',JSON.stringify({at:new Date().toISOString(),origin,checks,scope:'Real HTTP Keycloak browser form/code flow + host native session/ACL; no browser builder interaction claim.'},null,2));
console.log(JSON.stringify({result:'PASS',origin,checks}));
