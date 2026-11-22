/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const {randomBytes}=require('node:crypto');
const {denied,deploymentConfig,safeReturnTo,consumeBound,resolveMappedUser,parseGroupRoleMap,syncMappedUserRoles}=require('./policy');
const {createOidc}=require('./oidc');
const TYPE='lattice-keycloak',COOKIE='ldx_enterprise_binding';
const random=()=>randomBytes(32).toString('base64url');
function createActions(app,cache,verifiedIdentity){
  let protocol;
  const config=()=>deploymentConfig(process.env);
  const oidc=()=>protocol??=createOidc(config());
  const cookieOptions=()=>({httpOnly:true,sameSite:'lax',secure:config().origin.startsWith('https:'),path:'/api',maxAge:300000,overwrite:true});
  const protect=ctx=>{ctx.set('Cache-Control','no-store');ctx.set('Referrer-Policy','no-referrer');};
  async function authenticator(name){
    if(typeof name!=='string'||!name.match(/^[\w.-]{1,100}$/))throw denied();
    const row=await app.db.getRepository('authenticators').findOne({filter:{name,enabled:true,authType:TYPE}});
    if(!row)throw denied();return row;
  }
  const root=ctx=>{if(!ctx.state.currentUser||ctx.state.currentRole!=='root')ctx.throw(403,'Root administrator required.');};
  return {
    start:async ctx=>{
      protect(ctx);if(ctx.method!=='GET')ctx.throw(405);
      const name=ctx.query.authenticator;await authenticator(name);
      const state=random(),nonce=random(),binding=random();
      const {url,verifier}=await oidc().start(state,nonce);
      await cache.set('state:'+state,{authenticator:name,state,nonce,verifier,binding,returnTo:safeReturnTo(ctx.query.returnTo),expiresAt:Date.now()+300000},300000);
      ctx.cookies.set(COOKIE,binding,cookieOptions());ctx.redirect(url);
    },
    callback:async ctx=>{
      protect(ctx);if(ctx.method!=='GET')ctx.throw(405);
      try{
        const binding=ctx.cookies.get(COOKIE);
        const flow=await consumeBound(cache,app.lockManager,'state',ctx.query.state,binding);
        await authenticator(flow.authenticator);
        const claims=await oidc().finish(config().callback+'?'+new URLSearchParams(ctx.query),flow);
        const mappedUser=await resolveMappedUser(app.db,flow.authenticator,claims.sub,claims.iss);
        const groupMap=parseGroupRoleMap(process.env);
        if(Object.keys(groupMap).length&&Array.isArray(claims.groups)){
          const uid=typeof mappedUser?.get==='function'?mappedUser.get('id'):mappedUser?.id;
          await syncMappedUserRoles(app.db,uid,claims.groups,groupMap);
        }
        const ticket=random();
        await cache.set('ticket:'+ticket,{authenticator:flow.authenticator,subject:claims.sub,issuer:claims.iss,returnTo:flow.returnTo,binding,expiresAt:Date.now()+60000},60000);
        ctx.redirect(config().origin+'/enterprise-login?ticket='+ticket);
      }catch{
        ctx.cookies.set(COOKIE,null,cookieOptions());ctx.redirect(config().origin+'/signin?enterpriseError=verification_failed');
      }
    },
    finish:async ctx=>{
      protect(ctx);if(ctx.method!=='POST')ctx.throw(405);
      if(ctx.get('Origin')!==config().origin||!ctx.is('application/json'))throw denied();
      const flow=await consumeBound(cache,app.lockManager,'ticket',ctx.action.params.values?.ticket,ctx.cookies.get(COOKIE));
      ctx.cookies.set(COOKIE,null,cookieOptions());
      await authenticator(flow.authenticator);
      ctx.state[verifiedIdentity]=flow;
      const auth=await app.authManager.get(flow.authenticator,ctx);
      const result=await auth.signIn();
      delete ctx.state[verifiedIdentity];
      ctx.body={token:result.token,authenticator:flow.authenticator,returnTo:flow.returnTo};
    },
    configuration:async ctx=>{
      root(ctx);protect(ctx);const c=config();ctx.body={issuer:c.issuer,clientId:c.clientId,callback:c.callback};
    },
    link:async ctx=>{
      root(ctx);protect(ctx);if(ctx.method!=='POST')ctx.throw(405);
      const {authenticator:name,subject,userId}=ctx.action.params.values||{};
      await authenticator(name);
      if(typeof subject!=='string'||!subject.trim()||subject!==subject.trim()||subject.length>255||!/^\d+$/.test(String(userId)))ctx.throw(400,'Subject and native user ID are required.');
      await app.lockManager.runExclusive('enterprise-link:'+name,async()=>{
        const employee=await app.db.getRepository('latticeEmployees').findOne({filter:{userId,active:true}});
        const user=await app.db.getRepository('users').findOne({filter:{id:userId}});
        if(!employee?.organizationId||!user)throw denied();
        const repo=app.db.getRepository('usersAuthenticators');
        const links=await repo.find({filter:{authenticator:name,$or:[{uuid:subject},{userId}]}});
        if(links.length){
          if(links.length!==1||links[0].uuid!==subject||String(links[0].userId)!==String(userId)||links[0].meta?.issuer!==config().issuer)ctx.throw(409,'An identity mapping already exists; remove it explicitly before relinking.');
        }else await repo.create({values:{authenticator:name,uuid:subject,userId,meta:{issuer:config().issuer}},context:ctx});
        ctx.body={linked:true};
      },10000);
    },
    listMappings:async ctx=>{
      root(ctx);protect(ctx);if(ctx.method!=='GET')ctx.throw(405);
      const authRows=(await app.db.getRepository('authenticators').find({filter:{authType:TYPE}}))||[];
      const authNames=authRows.map(a=>typeof a.get==='function'?a.get('name'):a.name).filter(Boolean);
      const rows=authNames.length?(await app.db.getRepository('usersAuthenticators').find({filter:{authenticator:{$in:authNames}},sort:['-id']}))||[]:[];
      ctx.body={
        items:rows.map(r=>({
          id:typeof r.get==='function'?r.get('id'):r.id,
          authenticator:typeof r.get==='function'?r.get('authenticator'):r.authenticator,
          subject:typeof r.get==='function'?r.get('uuid'):r.uuid,
          userId:typeof r.get==='function'?r.get('userId'):r.userId,
          issuer:(typeof r.get==='function'?r.get('meta'):r.meta)?.issuer||null,
          createdAt:typeof r.get==='function'?r.get('createdAt'):r.createdAt,
        })),
      };
    },
    unlink:async ctx=>{
      root(ctx);protect(ctx);if(ctx.method!=='POST')ctx.throw(405);
      const {authenticator:name,subject,userId}=ctx.action.params.values||{};
      await authenticator(name);
      if(typeof subject!=='string'||!subject.trim()||!/^\d+$/.test(String(userId)))ctx.throw(400,'Subject and native user ID are required.');
      await app.lockManager.runExclusive('enterprise-link:'+name,async()=>{
        const repo=app.db.getRepository('usersAuthenticators');
        const existing=await repo.findOne({filter:{authenticator:name,uuid:subject.trim(),userId:Number(userId)}});
        if(!existing)ctx.throw(404,'Identity mapping not found.');
        await repo.destroy({filter:{authenticator:name,uuid:subject.trim(),userId:Number(userId)}});
        await cache.set('revoked:'+String(userId),Date.now(),86400000);
        ctx.body={unlinked:true};
      },10000);
    },
    backchannelLogout:async ctx=>{
      protect(ctx);if(ctx.method!=='POST')ctx.throw(405);
      const rawToken=ctx.request?.body?.logout_token||ctx.action?.params?.values?.logout_token;
      if(typeof rawToken!=='string'||!rawToken.trim())ctx.throw(400,'logout_token is required.');
      let claims;
      try{claims=await oidc().verifyLogoutToken(rawToken.trim());}
      catch(err){ctx.throw(Number(err?.status)===403?400:(Number(err?.status)||400),'Invalid logout_token.');}
      const repo=app.db.getRepository('usersAuthenticators');
      let affectedUsers=0;
      if(claims.sub){
        const links=(await repo.find({filter:{uuid:claims.sub}}))||[];
        const seenUsers=new Set();
        for(const link of links){
          const meta=typeof link.get==='function'?link.get('meta'):link.meta;
          if(claims.iss&&meta?.issuer&&meta.issuer!==claims.iss)continue;
          const uid=typeof link.get==='function'?link.get('userId'):link.userId;
          if(uid&&!seenUsers.has(String(uid))){
            seenUsers.add(String(uid));
            await cache.set('revoked:'+String(uid),Date.now(),86400000);
            affectedUsers+=1;
          }
        }
      }
      if(claims.sid){
        await cache.set('revoked_sid:'+String(claims.sid),Date.now(),86400000);
      }
      ctx.body={revoked:true,affectedUsers};
    },
  };
}
module.exports={createActions,TYPE};
