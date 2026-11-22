/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const {timingSafeEqual}=require('node:crypto');
const LOGOUT_EVENT='http://schemas.openid.net/event/backchannel-logout';
const SAFE_LDX_ROLE_RE=/^ldx_[a-z][a-z0-9_]{1,40}$/;

function resolveCacheOptions(env=process.env){
  const explicit=String(env?.DX_NATIVE_AUTH_CACHE_STORE||'').trim().toLowerCase();
  if(explicit==='memory')return {name:'enterprise-login',prefix:'enterprise-login',store:'memory'};
  const useRedis=explicit==='redis'||String(env?.CACHE_DEFAULT_STORE||'').trim().toLowerCase()==='redis'||Boolean(env?.REDIS_URL);
  if(useRedis){
    return {
      name:'enterprise-login',
      prefix:'enterprise-login',
      store:'redis',
      ...(env?.REDIS_URL?{url:String(env.REDIS_URL).trim()}:{}),
    };
  }
  return {name:'enterprise-login',prefix:'enterprise-login',store:'memory'};
}

function validateLogoutTokenClaims(claims,{issuer,clientId,nowSec=Math.floor(Date.now()/1000)}={}){
  if(!claims||typeof claims!=='object'||Array.isArray(claims))throw denied();
  if(!issuer||claims.iss!==issuer)throw denied();
  const audMatch=Array.isArray(claims.aud)?claims.aud.includes(clientId):claims.aud===clientId;
  if(!clientId||!audMatch)throw denied();
  if(claims.nonce!==undefined)throw denied();
  if(typeof claims.jti!=='string'||!claims.jti.trim())throw denied();
  const hasSubject=(typeof claims.sub==='string'&&claims.sub.trim().length>0)||(typeof claims.sid==='string'&&claims.sid.trim().length>0);
  if(!hasSubject)throw denied();
  const ev=claims.events;
  if(!ev||typeof ev!=='object'||Array.isArray(ev)||typeof ev[LOGOUT_EVENT]!=='object'||ev[LOGOUT_EVENT]===null){
    throw denied();
  }
  if(typeof claims.iat!=='number'||!Number.isFinite(claims.iat)||claims.iat>nowSec+300||claims.iat<nowSec-600){
    throw denied();
  }
  return claims;
}

function parseGroupRoleMap(env=process.env){
  const raw=String(env?.DX_NATIVE_AUTH_GROUP_ROLE_MAP||'').trim();
  if(!raw)return {};
  let parsed;
  try{parsed=JSON.parse(raw);}catch{return {};}
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))return {};
  const out={};
  for(const [group,roleName] of Object.entries(parsed)){
    const g=String(group||'').trim();
    const r=String(roleName||'').trim();
    if(!g||!SAFE_LDX_ROLE_RE.test(r))continue;
    out[g]=r;
  }
  return out;
}

function readAttr(row,key){
  return typeof row?.get==='function'?row.get(key):row?.[key];
}

function isPrivilegedRole(r){
  const name=readAttr(r,'name');
  const allowConfig=readAttr(r,'allowConfigure')===true;
  const snippets=Array.isArray(readAttr(r,'snippets'))?readAttr(r,'snippets'):[];
  const hasPm=snippets.some(s=>s==='pm'||s==='pm.*'||String(s).startsWith('pm.'));
  return name==='ldx_admin'||allowConfig||hasPm;
}

async function syncMappedUserRoles(db,userId,groups,groupRoleMap,options={}){
  const reconcile=options?.reconcile!==false;
  const added=[],removed=[],skippedPrivileged=[];
  if(!db||!userId||!Array.isArray(groups)||!groupRoleMap||typeof groupRoleMap!=='object')return {added,removed,skippedPrivileged};
  const managedRoles=new Set(Object.values(groupRoleMap).filter(r=>SAFE_LDX_ROLE_RE.test(r)&&r!=='ldx_admin'));
  const requested=new Set();
  for(const g of groups){
    const k=String(g||'').trim();
    const mapped=groupRoleMap[k]??groupRoleMap[k.replace(/^\//,'')];
    if(!mapped)continue;
    if(!SAFE_LDX_ROLE_RE.test(mapped)){skippedPrivileged.push(mapped);continue;}
    requested.add(mapped);
  }
  const rolesRepo=db.getRepository?.('roles');
  const ruRepo=db.getRepository?.('rolesUsers');
  if(!rolesRepo||!ruRepo)return {added,removed,skippedPrivileged};
  const safeRoles=new Set();
  if(requested.size>0){
    const roleRows=(await rolesRepo.find({filter:{name:{$in:[...requested]}}}))||[];
    for(const r of roleRows){
      const name=readAttr(r,'name');
      if(isPrivilegedRole(r)){
        skippedPrivileged.push(name);
        continue;
      }
      safeRoles.add(name);
    }
  }
  if(!safeRoles.size&&(!reconcile||!managedRoles.size))return {added,removed,skippedPrivileged};
  const existing=(await ruRepo.find({filter:{userId}}))||[];
  const existingSet=new Set(existing.map(r=>readAttr(r,'roleName')).filter(Boolean));
  for(const roleName of safeRoles){
    if(existingSet.has(roleName))continue;
    await ruRepo.create({values:{userId,roleName}});
    added.push(roleName);
  }
  if(reconcile&&managedRoles.size>0){
    const toRemove=[];
    for(const roleName of existingSet){
      if(managedRoles.has(roleName)&&!safeRoles.has(roleName))toRemove.push(roleName);
    }
    if(toRemove.length>0&&typeof ruRepo.destroy==='function'){
      const removeRoleRows=(await rolesRepo.find({filter:{name:{$in:toRemove}}}))||[];
      const privilegedToKeep=new Set(removeRoleRows.filter(isPrivilegedRole).map(r=>readAttr(r,'name')).filter(Boolean));
      const safeToRemove=toRemove.filter(name=>!privilegedToKeep.has(name));
      if(safeToRemove.length>0){
        await ruRepo.destroy({filter:{userId,roleName:{$in:safeToRemove}}});
        removed.push(...safeToRemove);
      }
    }
  }
  return {added,removed,skippedPrivileged};
}

function decodeJwtPayloadUnsafe(ctx){
  const auth=ctx?.get?.('Authorization')||ctx?.get?.('authorization')||ctx?.headers?.authorization||'';
  const match=String(auth).match(/^Bearer\s+([^.\s]+)\.([^.\s]+)\.([^.\s]+)$/i);
  if(!match)return null;
  try{return JSON.parse(Buffer.from(match[2],'base64url').toString('utf8'));}catch{return null;}
}

function createRevocationGuard(cache){
  return async function enterpriseAuthRevocationGuard(ctx,next){
    const user=ctx?.state?.currentUser;
    const userId=typeof user?.get==='function'?user.get('id'):user?.id;
    if(!userId||!cache?.get)return next();
    const revokedAt=await cache.get('revoked:'+userId);
    const payload=decodeJwtPayloadUnsafe(ctx);
    if(typeof revokedAt==='number'&&revokedAt>0){
      const tokenIatMs=typeof payload?.iat==='number'?payload.iat*1000:0;
      if(!tokenIatMs||tokenIatMs<=revokedAt){
        if(typeof ctx.throw==='function')ctx.throw(401,'Phiên đăng nhập đã bị thu hồi từ hệ thống SSO.');
        throw Object.assign(new Error('SESSION_REVOKED'),{status:401,code:'SESSION_REVOKED'});
      }
    }
    if(payload?.sid&&(await cache.get('revoked_sid:'+payload.sid))){
      if(typeof ctx.throw==='function')ctx.throw(401,'Phiên đăng nhập SSO đã kết thúc.');
      throw Object.assign(new Error('SESSION_REVOKED'),{status:401,code:'SESSION_REVOKED'});
    }
    return next();
  };
}
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
  if(typeof value!=='string'||!/^\/(?:admin|p|mobile)(?:[/?]|$)/.test(value)||/[\\\x00-\x20%]/.test(value)||value.includes('..'))return '/admin';
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
module.exports={
  denied,
  deploymentConfig,
  safeReturnTo,
  consumeBound,
  resolveMappedUser,
  resolveCacheOptions,
  validateLogoutTokenClaims,
  parseGroupRoleMap,
  syncMappedUserRoles,
  createRevocationGuard,
};
