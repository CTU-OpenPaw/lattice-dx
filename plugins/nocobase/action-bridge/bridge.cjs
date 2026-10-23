// SPDX-License-Identifier: Apache-2.0
'use strict';
const { randomBytes, createHash } = require('node:crypto');
const {studioRequest}=require('./studio.cjs');

class BridgeError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function validatedQuery(query,allowed) {
  if(query===undefined)return '';
  if(!query||typeof query!=='object'||Array.isArray(query)||Object.keys(query).some(k=>!allowed.includes(k)))throw new BridgeError(400,'Invalid list query.');
  const params=new URLSearchParams();
  for(const [key,value] of Object.entries(query)){
    if(typeof value!=='string'||value.length>200||/[\x00-\x1f\x7f]/.test(value))throw new BridgeError(400,'Invalid query value.');
    if(['limit','offset'].includes(key)&&(!/^\d+$/.test(value)||!Number.isSafeInteger(Number(value))||Number(value)<(key==='limit'?1:0)||Number(value)>(key==='limit'?100:Number.MAX_SAFE_INTEGER-101)))throw new BridgeError(400,'Invalid pagination.');
    params.set(key,value);
  }
  return params.toString();
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
    const {timeout = 10000, ...requestOptions} = options;
    try { response = await http(url, { ...requestOptions, signal: AbortSignal.timeout(timeout), redirect: 'error' }); }
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
      // Display hints only: catalogForToken above verifies this exact token at the API.
      // Every subsequent directory request is still authorized by the API.
      let directoryRead=false,organizationId;
      try{const claims=JSON.parse(Buffer.from(token.access_token.split('.')[1],'base64url').toString('utf8'));if(claims.sub===info.sub){directoryRead=Array.isArray(claims.realm_access?.roles)&&claims.realm_access.roles.includes('directory:read');if(typeof claims.organization_id==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(claims.organization_id))organizationId=claims.organization_id;}}catch{}
      if (exchange.cancelled) throw new BridgeError(401, 'Authorization connection was cancelled.');
      store(sessions, browserId, { userId: item.userId, token: token.access_token, capabilities:{directoryRead}, identity: { subject: info.sub, username: typeof info.preferred_username === 'string' ? info.preferred_username : info.sub,...(organizationId?{organizationId}:{}) }, expiresAt: now() + Math.min(token.expires_in, 300) * 1000 });
      return { connected: true };
      } finally { exchanges.delete(browserId); }
    },
    status(userId, browserId) {
      clean();
      const item = sessions.get(browserId);
      return item?.userId === userId ? { connected: true, identity: item.identity,capabilities:item.capabilities, expiresAt: new Date(item.expiresAt).toISOString() } : { connected: false };
    },
    async catalog(userId, browserId) { return catalogForToken(session(userId, browserId).token); },
    async logistics(userId, browserId, input) {
      const item=session(userId,browserId);
      const operations={people:['GET','directory/people'],orders:['GET','logistics/orders'],create:['POST','logistics/orders'],detail:['GET',''],submit:['POST',''],receive:['POST',''],history:['GET',''],task:['GET','']};
      if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['operation','id','body','key','query'].includes(k))||!Object.hasOwn(operations,input.operation))throw new BridgeError(400,'Invalid Logistics operation.');
      const [method,resource]=operations[input.operation];let path=resource;
      if(['detail','submit','receive','history','task'].includes(input.operation)){
        if(typeof input.id!=='string'||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input.id))throw new BridgeError(400,'Invalid Logistics ID.');
        path=input.operation==='history'?`workflows/${input.id}/history`:input.operation==='task'?`tasks/${input.id}`:`logistics/orders/${input.id}`+({detail:'',submit:'/submit',receive:'/receive'}[input.operation]);
      }else if(input.id!==undefined)throw new BridgeError(400,'Unexpected ID.');
      const write=['create','submit','receive'].includes(input.operation);
      if(write){if(typeof input.key!=='string'||!/^[A-Za-z0-9._:-]{1,128}$/.test(input.key)||!input.body||typeof input.body!=='object'||Array.isArray(input.body))throw new BridgeError(400,'Command requires body and idempotency key.');}
      else if(input.body!==undefined||input.key!==undefined)throw new BridgeError(400,'Unexpected command payload.');
      const query=validatedQuery(input.query,input.operation==='people'?['limit','offset','q','role','department']:['limit','offset','q','state']);
      if(input.query!==undefined&&!['people','orders'].includes(input.operation))throw new BridgeError(400,'Unexpected query.');
      if(query)path+='?'+query;
      return request(`${config.gatewayUrl}/v1/${path}`,{method,headers:{authorization:`Bearer ${item.token}`,...(write?{'content-type':'application/json','idempotency-key':input.key}:{})},...(write?{body:JSON.stringify(input.body)}:{})},'Logistics request failed; reload before retrying the same command.',true);
    },
    async workflow(userId, browserId, input) {
      const item=session(userId,browserId);
      const operations={capabilities:['GET','me/capabilities'],definitions:['GET','workflow-definitions'],references:['GET','workflow-references'],people:['GET','directory/people'],member:['POST','workflow-members/me'],list:['GET','workflows'],inbox:['GET','workflows?inbox=true'],create:['POST','workflows'],detail:['GET',''],history:['GET',''],sync:['GET',''],transition:['POST',''],waits:['GET',''],executions:['GET',''],completeWait:['POST',''],retrySync:['POST',''],entityContext:['GET','']};
      if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['operation','id','body','key','query'].includes(k))||!Object.hasOwn(operations,input.operation))throw new BridgeError(400,'Invalid workflow operation.');
      const [method,resource]=operations[input.operation];let path=resource;
      if(['detail','history','sync','transition','waits','executions','completeWait','retrySync','entityContext'].includes(input.operation)){
        if(typeof input.id!=='string'||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input.id))throw new BridgeError(400,'Invalid workflow ID.');
        path=input.operation==='completeWait'?`workflow-waits/${input.id}/complete`:`workflows/${input.id}`+({detail:'',history:'/history',sync:'/sync',transition:'/transitions',waits:'/waits',executions:'/executions',retrySync:'/sync/retry',entityContext:'/entity-context'}[input.operation]);
      }else if(input.id!==undefined)throw new BridgeError(400,'Unexpected workflow ID.');
      const write=['create','transition','completeWait','retrySync'].includes(input.operation);
      if(write){if(typeof input.key!=='string'||!/^[A-Za-z0-9._:-]{1,128}$/.test(input.key)||!input.body||typeof input.body!=='object'||Array.isArray(input.body))throw new BridgeError(400,'Workflow command requires body and idempotency key.');}
      else if(input.key!==undefined||input.body!==undefined)throw new BridgeError(400,'Unexpected workflow command payload.');
      if(input.query!==undefined&&!['list','inbox','waits','executions','people'].includes(input.operation))throw new BridgeError(400,'Unexpected query.');
      const query=validatedQuery(input.query,input.operation==='people'?['limit','offset','q','role','department']:['waits','executions'].includes(input.operation)?['limit','offset']:['limit','offset','q','state','definitionId']);
      if(query)path+=(path.includes('?')?'&':'?')+query;
      const headers={authorization:`Bearer ${item.token}`,...(method==='POST'?{'content-type':'application/json'}:{}),...(write?{'idempotency-key':input.key}:{})};
      return request(`${config.gatewayUrl}/v1/${path}`,{method,headers,...(method==='POST'?{body:JSON.stringify(write?input.body:{})}:{})},'Workflow request failed; reload or retry only the same command key.',true);
    },
    async studio(userId,browserId,input){
      const item=session(userId,browserId),command=studioRequest(input,BridgeError,validatedQuery);
      return request(`${config.gatewayUrl}/v1/${command.path}`,{method:command.method,headers:{authorization:`Bearer ${item.token}`,...(command.body?{'content-type':'application/json','idempotency-key':command.key}:{})},...(command.body?{body:command.body}:{})},'Studio request failed; reload before retrying the same command.',true);
    },
    async entity(userId,browserId,input){
      const item=session(userId,browserId);
      const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
      const invalid=()=>{throw new BridgeError(400,'Invalid entity operation.');};
      const operations={list:'GET',detail:'GET',create:'POST',update:'PATCH',archive:'POST',relations:'GET',link:'POST',unlink:'DELETE'};
      if(!object(input)||Object.keys(input).some(k=>!['operation','id','body','key','query'].includes(k))||typeof input.operation!=='string'||!Object.hasOwn(operations,input.operation))invalid();
      const {operation}=input,write=['create','update','archive','link','unlink'].includes(operation);
      let path='entities';
      if(['detail','update','archive','relations','link','unlink'].includes(operation)){
        if(typeof input.id!=='string'||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input.id))invalid();
        path+='/'+input.id+(operation==='archive'?'/archive':['relations','link','unlink'].includes(operation)?'/relations':'');
      }else if(input.id!==undefined)invalid();
      if(!['list','relations'].includes(operation)&&input.query!==undefined)invalid();
      const query=validatedQuery(input.query,operation==='relations'?['limit','offset']:['schemaId','limit','offset','q']);
      if(input.query?.schemaId!==undefined&&!/^[a-z][a-z0-9-]{0,63}$/.test(input.query.schemaId))invalid();
      if(query)path+='?'+query;
      if(write){
        if(typeof input.key!=='string'||!/^[A-Za-z0-9._:-]{1,128}$/.test(input.key)||!object(input.body))invalid();
        const allowed={create:['schemaId','schemaVersion','title','attributes'],update:['expectedVersion','title','attributes'],archive:['expectedVersion'],link:['expectedVersion','name','targetId'],unlink:['expectedVersion','name','targetId']}[operation];
        if(Object.keys(input.body).some(k=>!allowed.includes(k)))invalid();
        if(['create','update'].includes(operation)&&(typeof input.body.title!=='string'||!input.body.title.trim()||Array.from(input.body.title.trim()).length>200||!object(input.body.attributes)))invalid();
        if(operation==='create'&&(typeof input.body.schemaId!=='string'||!/^[a-z][a-z0-9-]{0,63}$/.test(input.body.schemaId)))invalid();
        if(operation==='create'&&input.body.schemaVersion!==undefined&&(!Number.isInteger(input.body.schemaVersion)||input.body.schemaVersion<1||input.body.schemaVersion>2147483647))invalid();
        if(operation!=='create'&&(!Number.isSafeInteger(input.body.expectedVersion)||input.body.expectedVersion<1))invalid();
        if(['link','unlink'].includes(operation)){
          if(typeof input.body.name!=='string'||!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(input.body.name)||typeof input.body.targetId!=='string'||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input.body.targetId))invalid();
          if(operation==='unlink')path+='/'+input.body.name+'/'+input.body.targetId;
        }
        if(Buffer.byteLength(JSON.stringify(input.body),'utf8')>65536)throw new BridgeError(413,'Entity command too large.');
      }else if(input.body!==undefined||input.key!==undefined)invalid();
      return request(`${config.gatewayUrl}/v1/${path}`,{method:operations[operation],headers:{authorization:`Bearer ${item.token}`,...(write?{'content-type':'application/json','idempotency-key':input.key}:{})},...(write?{body:JSON.stringify(operation==='unlink'?{expectedVersion:input.body.expectedVersion}:input.body)}:{})},'Entity request failed; reload before retrying the same command key.',true);
    },
    async list(userId, browserId, resource, query) {
      if (!['records','tasks'].includes(resource)) throw new BridgeError(400, 'Unsupported list resource.');
      const item = session(userId, browserId);
      const search=validatedQuery(query,resource==='tasks'?['limit','offset','q','status','recordId']:['limit','offset','q']);
      const result = await request(`${config.gatewayUrl}/v1/${resource}${search?'?'+search:''}`, {headers:{authorization:`Bearer ${item.token}`}}, 'List request failed.', true);
      if (!result || !Array.isArray(result.items) || result.items.length > 100) throw new BridgeError(502, 'Invalid list result.');
      return {items:result.items,...(result.page?{page:result.page}:{})};
    },
    async run(userId, browserId, input) {
      const item = session(userId, browserId);
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['actionId', 'version', 'input', 'key'].includes(key))
        || typeof input.actionId !== 'string' || !/^[a-z][a-z0-9_.-]{0,79}$/.test(input.actionId) || input.version !== 1 || !('input' in input)) throw new BridgeError(400, 'Invalid action request.');
      if (input.key !== undefined && (typeof input.key !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(input.key))) throw new BridgeError(400, 'Invalid action idempotency key.');
      const result = await request(`${config.gatewayUrl}/v1/actions/${input.actionId}/run`, { method: 'POST', headers: { authorization: `Bearer ${item.token}`, 'content-type': 'application/json', ...(input.key !== undefined ? {'idempotency-key': input.key} : {}) },
        body: JSON.stringify({ version: input.version, input: input.input }) }, 'Action execution failed; do not automatically retry.', true);
      if (!result || result.actionId !== input.actionId || result.version !== input.version || result.status !== 'succeeded' || !('result' in result)) throw new BridgeError(502, 'Invalid action result.');
      return { actionId: result.actionId, version: result.version, status: result.status, result: result.result };
    },
    async files(userId, browserId, input) {
      const item = session(userId, browserId);
      const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BridgeError(400, 'Invalid file request.');
      const headers = {authorization:`Bearer ${item.token}`};
      if (input.operation === 'upload') {
        if (Object.keys(input).some(k=>!['operation','filename','contentBase64','recordId'].includes(k)) ||
            typeof input.filename !== 'string' || !input.filename.trim() || input.filename.length>200 || /[\x00-\x1f/\\]/.test(input.filename) ||
            typeof input.contentBase64 !== 'string' || !input.contentBase64.length) throw new BridgeError(400, 'Invalid file payload.');
        if (input.contentBase64.length>1398104) throw new BridgeError(413, 'File limit is 1 MiB.');
        const bytes=Buffer.from(input.contentBase64,'base64');
        if (bytes.length>1048576) throw new BridgeError(413, 'File limit is 1 MiB.');
        if (bytes.toString('base64')!==input.contentBase64 || (input.recordId!==undefined&&!uuid.test(input.recordId))) throw new BridgeError(400, 'Invalid file encoding or record ID.');
        const {operation,...payload}=input;
        const result=await request(`${config.gatewayUrl}/v1/files`,{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify(payload),timeout:25000},'File upload failed; check before retrying.',true);
        if (!result || !uuid.test(result.id) || !['clean','pending','error','rejected'].includes(result.scanStatus)) throw new BridgeError(502,'Invalid file metadata.');
        return result;
      }
      if (!['metadata','content'].includes(input.operation) || Object.keys(input).some(k=>!['operation','id'].includes(k)) || typeof input.id!=='string' || !uuid.test(input.id)) throw new BridgeError(400,'Invalid file operation/ID.');
      const url=`${config.gatewayUrl}/v1/files/${input.id}`;
      const metadata=await request(url,{headers},'File metadata request failed.',true);
      if (metadata?.id!==input.id || !Number.isInteger(metadata.size) || metadata.size<1 || metadata.size>1048576) throw new BridgeError(502,'Invalid file metadata.');
      if (input.operation==='metadata') return metadata;
      if (metadata.scanStatus!=='clean') throw new BridgeError(409,'File is quarantined; download is unavailable.');
      let response;
      try {response=await http(url+'/content',{headers,redirect:'error',signal:AbortSignal.timeout(10000)});} catch {throw new BridgeError(502,'File download failed.');}
      if (!response.ok) throw new BridgeError([401,403,404,409].includes(response.status)?response.status:502,'File download denied.');
      if (Number(response.headers.get('content-length'))>1048576) throw new BridgeError(502,'Invalid file size.');
      // Bound the streamed response too: do not trust an absent Content-Length.
      const reader=response.body.getReader(),chunks=[];let size=0;
      try {while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>1048576){await reader.cancel();throw new BridgeError(502,'Invalid file size.');}chunks.push(Buffer.from(value));}} finally {reader.releaseLock();}
      if (size!==metadata.size) throw new BridgeError(502,'File size mismatch.');
      return {...metadata,contentBase64:Buffer.concat(chunks).toString('base64')};
    },
    disconnect(userId, browserId) {
      if (exchanges.get(browserId)?.userId === userId) exchanges.get(browserId).cancelled = true;
      if (sessions.get(browserId)?.userId === userId) remove(sessions, browserId);
      for (const [state, item] of pending) if (item.browserId === browserId && item.userId === userId) remove(pending, state);
    },
  };
}
module.exports = { createBridge, BridgeError };
