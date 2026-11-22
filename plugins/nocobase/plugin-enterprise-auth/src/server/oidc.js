/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const {createPublicKey,verify:cryptoVerify}=require('node:crypto');
const {validateLogoutTokenClaims}=require('./policy');

const ALG_MAP={
  RS256:{hash:'RSA-SHA256',dsa:undefined},
  RS384:{hash:'RSA-SHA384',dsa:undefined},
  RS512:{hash:'RSA-SHA512',dsa:undefined},
  PS256:{hash:'RSA-SHA256',padding:4},
  ES256:{hash:'sha256',dsaEncoding:'ieee-p1363'},
  ES384:{hash:'sha384',dsaEncoding:'ieee-p1363'},
  ES512:{hash:'sha512',dsaEncoding:'ieee-p1363'},
};

// Protocol validation is delegated to openid-client; logout_token signatures verify against discovery JWKS via node:crypto.
function createOidc(deployment){
  let discovered;
  let jwksCache={fetchedAt:0,keys:[]};
  const transport=async(input,options={})=>{
    const target=new URL(String(input));
    // Explicit local Docker transport only. Issuer validation still uses the public URL.
    if(deployment.internal&&target.origin===new URL(deployment.issuer).origin)target.host=new URL(deployment.internal).host;
    return fetch(target,{...options,redirect:'error',signal:AbortSignal.timeout(10000)});
  };
  async function configuration(){
    if(!discovered)discovered=(async()=>{
      const oidc=await import('openid-client');
      const config=await oidc.discovery(new URL(deployment.issuer),deployment.clientId,{token_endpoint_auth_method:'none'},oidc.None(),{
        [oidc.customFetch]:transport,
        execute:[...(deployment.insecure?[oidc.allowInsecureRequests]:[]),oidc.enableNonRepudiationChecks],
      });
      return {oidc,config};
    })().catch(error=>{discovered=undefined;throw error;});
    return discovered;
  }
  async function fetchJwks(force=false){
    if(!force&&jwksCache.keys.length&&Date.now()-jwksCache.fetchedAt<300000)return jwksCache.keys;
    const {config}=await configuration();
    const jwksUri=config.serverMetadata?.()?.jwks_uri;
    if(!jwksUri)throw Object.assign(new Error('OIDC discovery missing jwks_uri'),{status:400});
    const res=await transport(jwksUri,{method:'GET',headers:{Accept:'application/json'}});
    if(!res.ok)throw Object.assign(new Error('Failed to fetch OIDC JWKS'),{status:400});
    const body=await res.json();
    const keys=Array.isArray(body?.keys)?body.keys:[];
    jwksCache={fetchedAt:Date.now(),keys};
    return keys;
  }
  return {
    async start(state,nonce){
      const {oidc,config}=await configuration();
      const verifier=oidc.randomPKCECodeVerifier();
      const challenge=await oidc.calculatePKCECodeChallenge(verifier);
      const url=oidc.buildAuthorizationUrl(config,{redirect_uri:deployment.callback,scope:'openid profile',response_type:'code',code_challenge:challenge,code_challenge_method:'S256',state,nonce});
      return {url:url.href,verifier};
    },
    async finish(url,flow){
      const {oidc,config}=await configuration();
      const tokens=await oidc.authorizationCodeGrant(config,new URL(url),{pkceCodeVerifier:flow.verifier,expectedState:flow.state,expectedNonce:flow.nonce,idTokenExpected:true});
      return tokens.claims();
    },
    async verifyLogoutToken(rawToken){
      if(typeof rawToken!=='string')throw Object.assign(new Error('Missing logout_token'),{status:400});
      const parts=rawToken.trim().split('.');
      if(parts.length!==3||parts.some(p=>!p))throw Object.assign(new Error('Malformed logout_token'),{status:400});
      let header,claims;
      try{
        header=JSON.parse(Buffer.from(parts[0],'base64url').toString('utf8'));
        claims=JSON.parse(Buffer.from(parts[1],'base64url').toString('utf8'));
      }catch{
        throw Object.assign(new Error('Unreadable logout_token payload'),{status:400});
      }
      const spec=ALG_MAP[header?.alg];
      if(!spec)throw Object.assign(new Error('Unsupported logout_token alg'),{status:400});
      let keys=await fetchJwks(false);
      let jwk=keys.find(k=>(!header.kid||k.kid===header.kid)&&(!k.use||k.use==='sig'));
      if(!jwk){
        keys=await fetchJwks(true);
        jwk=keys.find(k=>(!header.kid||k.kid===header.kid)&&(!k.use||k.use==='sig'));
      }
      if(!jwk)throw Object.assign(new Error('Unknown signing key for logout_token'),{status:400});
      const pubKey=createPublicKey({key:jwk,format:'jwk'});
      const keyInput=spec.padding?{key:pubKey,padding:spec.padding}:spec.dsaEncoding?{key:pubKey,dsaEncoding:spec.dsaEncoding}:pubKey;
      const valid=cryptoVerify(spec.hash,Buffer.from(`${parts[0]}.${parts[1]}`),keyInput,Buffer.from(parts[2],'base64url'));
      if(!valid)throw Object.assign(new Error('Invalid logout_token signature'),{status:400});
      return validateLogoutTokenClaims(claims,{issuer:deployment.issuer,clientId:deployment.clientId});
    },
  };
}
module.exports={createOidc};
