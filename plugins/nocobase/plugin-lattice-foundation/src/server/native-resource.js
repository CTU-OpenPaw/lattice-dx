// SPDX-License-Identifier: Apache-2.0
'use strict';
const {resolveNativeActor} = require('./native-scope');
function registerNativeResource(app) {
  app.resourceManager.define({name:'latticeNative',actions:{
    context:async(ctx,next)=>{
      if(ctx.method !== 'GET')ctx.throw(405);
      const actor = await resolveNativeActor(app.db,ctx.state.currentUser);
      ctx.body = actor;
      await next();
    },
  }});
  // Context contains only the caller's own verified membership. No native
  // collection CRUD permission or legacy service role is granted by this call.
  app.acl.allow('latticeNative','context','loggedIn');
}
module.exports = {registerNativeResource};
