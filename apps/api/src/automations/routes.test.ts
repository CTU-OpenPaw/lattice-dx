import {expect,test,vi} from 'vitest';
import {generateKeyPair,exportJWK,createLocalJWKSet,SignJWT} from 'jose';
import {createApi} from '../app.js';
const {privateKey,publicKey}=await generateKeyPair('RS256');
const key=createLocalJWKSet({keys:[{...await exportJWK(publicKey),kid:'automation',alg:'RS256'}]});
async function auth(roles=['workflow:design','data:automate']){return {authorization:'Bearer '+await new SignJWT({organization_id:'org',realm_access:{roles}}).setProtectedHeader({alg:'RS256',kid:'automation'}).setSubject('admin').setIssuer('https://id.test').setAudience('dx-api').setExpirationTime('5m').sign(privateKey)};}
const rule={id:'invoice-start',schemaId:'invoice',schemaVersion:1,operations:['entity.create'],serviceId:'automation',definitionId:'invoice-flow',definitionVersion:1,title:{source:'literal',value:'Invoice'},input:{},enabled:true};
test('signed rules require both capabilities mandatory key strict tenantless bodies and revision',async()=>{
 const create=vi.fn(async()=>({...rule,revision:1}));
 const app=createApi({workerUrl:'http://localhost:1',identity:{issuer:'https://id.test',audience:'dx-api',key},automations:{create} as never} as never);
 try{const req={method:'POST' as const,url:'/v1/entity-automations',payload:rule};
  expect((await app.inject(req)).statusCode).toBe(401);
  expect((await app.inject({...req,headers:await auth(['workflow:design'])})).statusCode).toBe(403);
  expect((await app.inject({...req,headers:await auth()})).statusCode).toBe(400);
  const headers={...await auth(),'idempotency-key':'rule-1'};
  expect((await app.inject({...req,headers,payload:{...rule,organizationId:'other'}})).statusCode).toBe(400);
  expect((await app.inject({...req,headers})).statusCode).toBe(201);
  expect(create).toHaveBeenCalledWith(rule,{subject:'admin',organizationId:'org',roles:['workflow:design','data:automate']},'rule-1');
  expect((await app.inject({method:'PUT',url:req.url+'/invoice-start',headers,payload:rule})).statusCode).toBe(400);
 }finally{await app.close();}
});
test('unconfigured automation endpoints report feature unavailable after authentication',async()=>{
 const app=createApi({workerUrl:'http://localhost:1',identity:{issuer:'https://id.test',audience:'dx-api',key}});
 try{expect((await app.inject({url:'/v1/entity-automations',headers:await auth()})).statusCode).toBe(503);}finally{await app.close();}
});
