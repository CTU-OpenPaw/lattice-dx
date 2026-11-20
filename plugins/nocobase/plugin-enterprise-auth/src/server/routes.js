/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const {randomBytes}=require('node:crypto');
const {denied,deploymentConfig,safeReturnTo,consumeBound,resolveMappedUser}=require('./policy');
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
        await resolveMappedUser(app.db,flow.authenticator,claims.sub,claims.iss);
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
  };
}
module.exports={createActions,TYPE};
