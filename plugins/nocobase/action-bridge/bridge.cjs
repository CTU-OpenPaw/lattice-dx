// SPDX-License-Identifier: Apache-2.0
'use strict';
const { randomBytes, createHash } = require('node:crypto');

class BridgeError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function createBridge(config, dependencies = {}) {
  const http = dependencies.fetch || globalThis.fetch;
  const now = dependencies.now || Date.now;
  const schedule = dependencies.schedule || setTimeout;
  const cancelTimer = dependencies.cancelTimer || clearTimeout;
  const pending = new Map(), sessions = new Map();
  const exchanges = new Map();
  const maxConnections = dependencies.maxConnections || 1000;
  const random = () => randomBytes(32).toString('base64url');
  const remove = (map, id) => { cancelTimer(map.get(id)?.timer); map.delete(id); };
  // This closure holds identifiers/map only, never a token or session object.
  const expiryTimer = (map, id, expiresAt) => {
    const timer = schedule(() => { if (map.get(id)?.expiresAt === expiresAt) map.delete(id); }, Math.max(0, expiresAt - now()));
    timer?.unref?.(); return timer;
  };
  const store = (map, id, item) => { map.set(id, item); item.timer = expiryTimer(map, id, item.expiresAt); };
  const clean = () => {
    for (const [id, item] of pending) if (item.expiresAt <= now()) remove(pending, id);
    for (const [id, item] of sessions) if (item.expiresAt <= now()) remove(sessions, id);
  };
  const session = (userId, browserId) => {
    clean();
    const item = sessions.get(browserId);
    if (!item || item.userId !== userId) throw new BridgeError(401, 'Connect your Keycloak account first.');
    return item;
  };
  async function request(url, options, message, preserveStatus = false) {
    let response;
    try { response = await http(url, { ...options, signal: AbortSignal.timeout(10000), redirect: 'error' }); }
    catch { throw new BridgeError(502, message); }
    if (!response.ok) throw new BridgeError(preserveStatus && [400, 401, 403, 404, 409, 413, 429, 503].includes(response.status) ? response.status : 502, message);
    try { return await response.json(); }
    catch { throw new BridgeError(502, 'Upstream returned invalid JSON.'); }
  }
  async function catalogForToken(token) {
    const result = await request(`${config.gatewayUrl}/v1/actions`, { headers: { authorization: `Bearer ${token}` } }, 'Action catalog request failed.', true);
    if (!result || !Array.isArray(result.items)) throw new BridgeError(502, 'Invalid action catalog.');
    return { items: result.items.map(item => {
      if (!item || typeof item.id !== 'string' || item.version !== 1 || typeof item.title !== 'string' || typeof item.requiredRole !== 'string' || !item.inputSchema || item.inputSchema.type !== 'object') throw new BridgeError(502, 'Invalid action catalog.');
      return { id: item.id, version: item.version, title: item.title, requiredRole: item.requiredRole, inputSchema: item.inputSchema };
    }) };
  }
  return {
    connect(userId, oldBrowserId) {
      clean();
      if (typeof userId !== 'string' || !userId) throw new BridgeError(401, 'NocoBase identity required.');
      if (sessions.get(oldBrowserId)?.userId === userId) remove(sessions, oldBrowserId);
      if (exchanges.get(oldBrowserId)?.userId === userId) exchanges.get(oldBrowserId).cancelled = true;
      for (const [state, item] of pending) if (item.browserId === oldBrowserId && item.userId === userId) remove(pending, state);
      if (pending.size + sessions.size + exchanges.size >= maxConnections) throw new BridgeError(503, 'Connection capacity reached.');
      const state = random(), browserId = random(), verifier = random();
      store(pending, state, { browserId, userId, verifier, expiresAt: now() + 120000 });
      const url = new URL(config.authorizationUrl);
      url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.callbackUrl, response_type: 'code', scope: 'openid profile', state,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', prompt: 'login' }).toString();
      return { browserId, authorizationUrl: url.toString() };
    },
    async callback(query, browserId) {
      clean();
      const item = typeof query.state === 'string' ? pending.get(query.state) : undefined;
      if (!item || !browserId || item.browserId !== browserId) throw new BridgeError(400, 'Invalid or expired browser authorization state.');
      // Consume before any outbound work, so concurrent callbacks cannot exchange twice.
      remove(pending, query.state);
      if (query.error || typeof query.code !== 'string' || !query.code || query.code.length > 4096) throw new BridgeError(400, 'Authorization was not completed.');
      const exchange = { userId: item.userId, cancelled: false };
      exchanges.set(browserId, exchange);
      try {
      const token = await request(config.tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: config.clientId, grant_type: 'authorization_code', code: query.code, redirect_uri: config.callbackUrl, code_verifier: item.verifier }) }, 'Keycloak token exchange failed.');
      if (!token || typeof token.access_token !== 'string' || !token.access_token || !Number.isFinite(token.expires_in) || token.expires_in <= 0) throw new BridgeError(502, 'Invalid Keycloak token response.');
      // The gateway AND API verify the access token and signed organization scope.
      await catalogForToken(token.access_token);
      const info = await request(config.userinfoUrl, { headers: { authorization: `Bearer ${token.access_token}` } }, 'Keycloak identity request failed.');
      if (!info || typeof info.sub !== 'string' || !info.sub) throw new BridgeError(502, 'Invalid Keycloak identity.');
      if (exchange.cancelled) throw new BridgeError(401, 'Authorization connection was cancelled.');
      store(sessions, browserId, { userId: item.userId, token: token.access_token, identity: { subject: info.sub, username: typeof info.preferred_username === 'string' ? info.preferred_username : info.sub }, expiresAt: now() + Math.min(token.expires_in, 300) * 1000 });
      return { connected: true };
      } finally { exchanges.delete(browserId); }
    },
    status(userId, browserId) {
      clean();
      const item = sessions.get(browserId);
      return item?.userId === userId ? { connected: true, identity: item.identity, expiresAt: new Date(item.expiresAt).toISOString() } : { connected: false };
    },
    async catalog(userId, browserId) { return catalogForToken(session(userId, browserId).token); },
    async run(userId, browserId, input) {
      const item = session(userId, browserId);
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['actionId', 'version', 'input'].includes(key))
        || typeof input.actionId !== 'string' || !/^[a-z][a-z0-9_.-]{0,79}$/.test(input.actionId) || input.version !== 1 || !('input' in input)) throw new BridgeError(400, 'Invalid action request.');
      const result = await request(`${config.gatewayUrl}/v1/actions/${input.actionId}/run`, { method: 'POST', headers: { authorization: `Bearer ${item.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ version: input.version, input: input.input }) }, 'Action execution failed; do not automatically retry.', true);
      if (!result || result.actionId !== input.actionId || result.version !== input.version || result.status !== 'succeeded' || !('result' in result)) throw new BridgeError(502, 'Invalid action result.');
      return { actionId: result.actionId, version: result.version, status: result.status, result: result.result };
    },
    disconnect(userId, browserId) {
      if (exchanges.get(browserId)?.userId === userId) exchanges.get(browserId).cancelled = true;
      if (sessions.get(browserId)?.userId === userId) remove(sessions, browserId);
      for (const [state, item] of pending) if (item.browserId === browserId && item.userId === userId) remove(pending, state);
    },
  };
}
module.exports = { createBridge, BridgeError };
