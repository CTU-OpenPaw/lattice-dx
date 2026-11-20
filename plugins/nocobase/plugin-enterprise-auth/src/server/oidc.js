/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
// Protocol validation is delegated to openid-client; no custom JWT verification.
function createOidc(deployment){
  let discovered;
  async function configuration(){
    if(!discovered)discovered=(async()=>{
      const oidc=await import('openid-client');
      const transport=async(input,options)=>{
        const target=new URL(String(input));
        // Explicit local Docker transport only. Issuer validation still uses the public URL.
        if(deployment.internal&&target.origin===new URL(deployment.issuer).origin)target.host=new URL(deployment.internal).host;
        return fetch(target,{...options,redirect:'error',signal:AbortSignal.timeout(10000)});
      };
      const config=await oidc.discovery(new URL(deployment.issuer),deployment.clientId,{token_endpoint_auth_method:'none'},oidc.None(),{
        [oidc.customFetch]:transport,
        execute:[...(deployment.insecure?[oidc.allowInsecureRequests]:[]),oidc.enableNonRepudiationChecks],
      });
      return {oidc,config};
    })().catch(error=>{discovered=undefined;throw error;});
    return discovered;
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
  };
}
module.exports={createOidc};
