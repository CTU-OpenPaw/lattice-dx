/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const {timingSafeEqual}=require('node:crypto');
function denied(){const e=new Error('Enterprise login could not be verified.');e.status=403;return e;}
function validUrl(value){
  const u=new URL(value);
  const local=['localhost','127.0.0.1','[::1]'].includes(u.hostname);
  if(u.username||u.password||u.search||u.hash||!['https:','http:'].includes(u.protocol)||(u.protocol==='http:'&&!local))throw Error('Enterprise authentication requires HTTPS (HTTP is loopback-only).');
  return u;
}
function deploymentConfig(env){
  const issuer=validUrl(env.DX_NATIVE_AUTH_ISSUER),origin=validUrl(env.DX_NATIVE_AUTH_ORIGIN);
  if(origin.pathname!=='/'||!env.DX_NATIVE_AUTH_CLIENT_ID?.match(/^[a-zA-Z0-9._-]{1,100}$/))throw Error('Invalid enterprise login deployment configuration.');
  let internal;
  if(env.DX_NATIVE_AUTH_INTERNAL_ISSUER){
    internal=new URL(env.DX_NATIVE_AUTH_INTERNAL_ISSUER);
    if(issuer.protocol!=='http:'||!['localhost','127.0.0.1'].includes(issuer.hostname)||internal.protocol!=='http:'||internal.hostname!=='keycloak'||internal.port!=='8080'||internal.pathname!==issuer.pathname||internal.username||internal.password||internal.search||internal.hash)throw Error('Internal transport is only supported for the local Keycloak development service.');
  }
  return {issuer:issuer.href.replace(/\/$/,''),origin:origin.origin,clientId:env.DX_NATIVE_AUTH_CLIENT_ID,internal:internal?.origin,callback:origin.origin+'/api/enterpriseAuth:callback',insecure:issuer.protocol==='http:'};
}
function safeReturnTo(value){
  if(typeof value!=='string'||!/^\/admin(?:[/?]|$)/.test(value)||/[\\\x00-\x20%]/.test(value))return '/admin';
  return value;
}
function sameBinding(a,b){return typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));}
async function consumeBound(cache,locks,prefix,key,binding){
  if(typeof key!=='string'||key.length>128||!binding)throw denied();
  return locks.runExclusive('enterprise-auth:'+prefix+':'+key,async()=>{
    const cacheKey=prefix+':'+key,entry=await cache.get(cacheKey);
    if(!entry||entry.expiresAt<Date.now()||!sameBinding(entry.binding,binding))throw denied();
    await cache.del(cacheKey);return entry;
  },10000);
}
async function resolveMappedUser(db,authenticator,subject,issuer){
  if(typeof subject!=='string'||!subject||subject.length>255)throw denied();
  const links=await db.getRepository('usersAuthenticators').find({filter:{authenticator,uuid:subject},limit:2});
  if(links.length!==1||!issuer||links[0].meta?.issuer!==issuer)throw denied();
  const userId=links[0].userId;
  const users=await db.getRepository('users').find({filter:{id:userId},limit:2});
  const employees=await db.getRepository('latticeEmployees').find({filter:{userId,active:true},limit:2});
  if(users.length!==1||employees.length!==1||!employees[0].organizationId)throw denied();
  return users[0];
}
module.exports={denied,deploymentConfig,safeReturnTo,consumeBound,resolveMappedUser};
