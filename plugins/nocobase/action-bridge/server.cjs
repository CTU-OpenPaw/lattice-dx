/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';
const { Plugin } = require('@nocobase/server');
const { createBridge, BridgeError } = require('./bridge.cjs');
const cookieName = 'dx_action_connection';

class ActionBridgePlugin extends Plugin {
  async load() {
    const callbackUrl = process.env.DX_BRIDGE_CALLBACK_URL;
    const publicIssuer = process.env.DX_BRIDGE_ISSUER;
    const internalIssuer = process.env.DX_BRIDGE_INTERNAL_ISSUER;
    const gatewayUrl = process.env.DX_BRIDGE_GATEWAY_URL;
    if (!callbackUrl || !publicIssuer || !internalIssuer || !gatewayUrl) throw new Error('Missing action bridge endpoint configuration.');
    const callback = new URL(callbackUrl);
    if (callback.protocol !== 'https:' && !(callback.protocol === 'http:' && callback.hostname === 'localhost')) throw new Error('Bridge callback requires HTTPS outside localhost.');
    const bridge = createBridge({ callbackUrl, gatewayUrl, clientId: 'dx-nocobase',
      authorizationUrl: `${publicIssuer}/protocol/openid-connect/auth`, tokenUrl: `${internalIssuer}/protocol/openid-connect/token`, userinfoUrl: `${internalIssuer}/protocol/openid-connect/userinfo` });
    const cookies = { httpOnly: true, sameSite: 'lax', secure: callback.protocol === 'https:', signed: false, path: '/api', overwrite: true };
    const methods = { connect: 'POST', callback: 'GET', status: 'GET', catalog: 'GET', list: 'GET', run: 'POST', files: 'POST', workflow: 'POST', studio: 'POST', entity: 'POST', agent: 'POST', logistics: 'POST', disconnect: 'POST' };
    const actions = {};
    for (const [name, method] of Object.entries(methods)) {
      actions[name] = async (ctx, next) => {
        ctx.withoutDataWrapping = true;
        ctx.set('Cache-Control', 'no-store');
        ctx.set('Referrer-Policy', 'no-referrer');
        try {
          if (ctx.method !== method) throw new BridgeError(405, 'Unsupported method.');
          const browserId = ctx.cookies.get(cookieName, { signed: false });
          if (name === 'callback') {
            await bridge.callback(ctx.query, browserId);
            ctx.redirect('/admin');
          } else {
            const currentUser = ctx.state.currentUser;
            if (!currentUser?.id || !ctx.get('Authorization').startsWith('Bearer ')) throw new BridgeError(401, 'NocoBase bearer identity required.');
            const userId = String(currentUser.id);
            if (name === 'connect') {
              const connection = bridge.connect(userId, browserId);
              ctx.cookies.set(cookieName, connection.browserId, { ...cookies, maxAge: 300000 });
              ctx.body = { authorizationUrl: connection.authorizationUrl };
            } else if (name === 'status') ctx.body = bridge.status(userId, browserId);
            else if (name === 'catalog') ctx.body = await bridge.catalog(userId, browserId);
            else if (name === 'list') {const {resource,...query}=ctx.query;ctx.body = await bridge.list(userId, browserId, resource, query);}
            else if (name === 'run') ctx.body = await bridge.run(userId, browserId, ctx.request.body);
            else if (name === 'files') ctx.body = await bridge.files(userId, browserId, ctx.request.body);
            else if (name === 'workflow') ctx.body = await bridge.workflow(userId, browserId, ctx.request.body);
            else if (name === 'studio') ctx.body = await bridge.studio(userId,browserId,ctx.request.body);
            else if (name === 'entity') ctx.body = await bridge.entity(userId, browserId, ctx.request.body);
            else if (name === 'agent') ctx.body = await bridge.agent(userId, browserId, ctx.request.body);
            else if (name === 'logistics') ctx.body = await bridge.logistics(userId, browserId, ctx.request.body);
            else {
              bridge.disconnect(userId, browserId);
              ctx.cookies.set(cookieName, null, cookies);
              ctx.body = { connected: false };
            }
          }
        } catch (error) {
          ctx.status = error instanceof BridgeError ? error.status : 502;
          ctx.body = { error: error instanceof BridgeError ? error.message : 'Action bridge request failed.' };
        }
        await next();
      };
    }
    this.app.resourceManager.define({ name: 'dxActions', actions });
    this.app.acl.allow('dxActions', 'callback', 'public');
    for (const name of ['connect', 'status', 'catalog', 'list', 'run', 'files', 'workflow', 'studio', 'entity', 'agent', 'logistics', 'disconnect']) this.app.acl.allow('dxActions', name, 'loggedIn');
  }
}
module.exports = ActionBridgePlugin;
module.exports.default = ActionBridgePlugin;
