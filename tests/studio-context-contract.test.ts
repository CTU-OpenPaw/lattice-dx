/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import {readFileSync} from 'node:fs';
import {expect,test} from 'vitest';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const {createLocalJWKSet,exportJWK,generateKeyPair,SignJWT}=await import(pathToFileURL(createRequire(new URL('../apps/api/package.json',import.meta.url)).resolve('jose')).href);
import {createApi} from '../apps/api/src/app.js';

const read=(file:string)=>readFileSync(new URL('../'+file,import.meta.url),'utf8');
const endpoints=[['get','/v1/me/capabilities'],['get','/v1/studio/catalog'],['post','/v1/studio/preflight'],['get','/v1/studio/modules/{id}/versions/{version}/dependencies'],['get','/v1/workflows/{id}/history'],['get','/v1/entities/{id}/context-links/ngsi-ld'],['put','/v1/entities/{id}/context-links/ngsi-ld'],['delete','/v1/entities/{id}/context-links/ngsi-ld'],['get','/v1/entities/{id}/context-links/ngsi-ld/history'],['get','/v1/entities/{id}/context']] as const;
type Shape={type?:string|string[];properties?:Record<string,Shape>;required?:string[];additionalProperties?:boolean|Shape;items?:Shape;$ref?:string;oneOf?:Shape[];anyOf?:Shape[];const?:unknown;enum?:unknown[]};
function contract(){return JSON.parse(read('docs/studio-context-api.openapi.json'));}
// Validate the document against independently obtained runtime responses, including missing-field mutations.
function accepts(doc:ReturnType<typeof contract>,schema:Shape,value:unknown):boolean {
 if(schema.$ref)return accepts(doc,schema.$ref.split('/').slice(1).reduce((obj:any,key:string)=>obj[key],doc),value);
 if(schema.oneOf)return schema.oneOf.filter(item=>accepts(doc,item,value)).length===1;
 if(schema.anyOf)return schema.anyOf.some(item=>accepts(doc,item,value));
 if('const' in schema&&value!==schema.const||schema.enum&&!schema.enum.includes(value))return false;
 const types=schema.type===undefined?[]:Array.isArray(schema.type)?schema.type:[schema.type];
 if(types.length&&!types.some(type=>type==='null'?value===null:type==='array'?Array.isArray(value):type==='integer'?Number.isInteger(value):typeof value===type&&(type!=='object'||value!==null&&!Array.isArray(value))))return false;
 if(value&&typeof value==='object'&&!Array.isArray(value)){
  const object=value as Record<string,unknown>;
  if(schema.required?.some(key=>!(key in object)))return false;
  return Object.entries(object).every(([key,val])=>schema.properties?.[key]?accepts(doc,schema.properties[key],val):schema.additionalProperties===false?false:typeof schema.additionalProperties==='object'?accepts(doc,schema.additionalProperties,val):true);
 }
 return !Array.isArray(value)||!schema.items||value.every(item=>accepts(doc,schema.items!,item));
}
test('OpenAPI covers the registered additive endpoints and exact protected gateway families',()=>{
 const doc=contract();expect(doc.openapi).toBe('3.1.0');expect(doc.security).toEqual([{bearerAuth:[]}]);
 expect(doc.components.securitySchemes.bearerAuth).toMatchObject({type:'http',scheme:'bearer'});
 for(const [method,path] of endpoints){const operation=doc.paths[path]?.[method];expect(operation,method+' '+path).toBeDefined();expect(operation.responses['200'].content['application/json'].schema).toBeDefined();for(const code of ['400','401','403','404','503'])expect(operation.responses[code]).toBeDefined();}
 const gateway=read('infra/config/apisix/apisix.yaml');
 const routes=gateway.split(/\n  - id:/).slice(1);
 for(const [path,method] of [['/v1/me/capabilities','GET'],['/v1/studio/catalog','GET'],['/v1/studio/preflight','POST'],['/v1/studio/modules/*/versions/*/dependencies','GET']] as const){
  const route=routes.find(route=>route.includes(path));expect(route,path).toBeDefined();expect(route).toContain('methods: ['+method+']');for(const plugin of ['openid-connect:','request-id:','limit-count:'])expect(route).toContain(plugin);
 }
 expect(gateway).not.toMatch(/\/v1\/studio\/\*(?:[,\]])/);
 expect(read('infra/compose/core.yml')).toContain('NGSI_LD_CONTEXT_READ: ${NGSI_LD_CONTEXT_READ:-false}');
 for(const method of ['put','delete'])expect(doc.paths['/v1/entities/{id}/context-links/ngsi-ld'][method].parameters).toContainEqual(expect.objectContaining({name:'Idempotency-Key',in:'header',required:true}));
 expect(doc.components.schemas.MappingPut.required).toEqual(['externalId','expectedRevision']);
 expect(doc.components.schemas.MappingPut.additionalProperties).toBe(false);
 expect(doc.components.schemas.EntityContext.properties.status.enum).toEqual(['not_linked','source_unavailable','no_observation','fresh','stale']);
 expect(doc.paths['/v1/workflows/{id}/history'].get.responses['200'].content['application/json'].schema.oneOf).toHaveLength(2);
});
test('documented capabilities, catalog and stable errors accept real signed runtime DTOs and require their fields',async()=>{
 const doc=contract(),keys=await generateKeyPair('RS256');
 const identity={issuer:'https://contract.test',audience:'dx-api',key:createLocalJWKSet({keys:[{...await exportJWK(keys.publicKey),kid:'contract',alg:'RS256'}]})};
 const token=await new SignJWT({organization_id:'contract',realm_access:{roles:['data:design','workflow:design','data:read','records:write']}}).setSubject('contract').setIssuer(identity.issuer).setAudience(identity.audience).setExpirationTime('5m').setProtectedHeader({alg:'RS256',kid:'contract'}).sign(keys.privateKey);
 const app=createApi({workerUrl:'http://localhost:1',identity});
 try{for(const path of ['/v1/me/capabilities','/v1/studio/catalog']){
  const result=await app.inject({url:path,headers:{authorization:'Bearer '+token}});expect(result.statusCode).toBe(200);
  const schema=doc.paths[path].get.responses['200'].content['application/json'].schema,value=result.json();expect(accepts(doc,schema,value)).toBe(true);
  delete value.version;expect(accepts(doc,schema,value)).toBe(false);
 }
 const denied=await app.inject({url:'/v1/studio/catalog'});expect(denied.statusCode).toBe(401);expect(accepts(doc,doc.components.schemas.Error,denied.json())).toBe(true);
 expect(accepts(doc,doc.components.schemas.Error,{error:'legacy error'})).toBe(false);
 }finally{await app.close();}
});
test('public examples contain no executable configuration, credentials or broker-success claims',()=>{
 const doc=contract();const examples:unknown[]=[];
 function walk(value:unknown){if(!value||typeof value!=='object')return;for(const [key,item] of Object.entries(value)){if(key==='example'||key==='examples')examples.push(item);else walk(item);}}
 walk(doc);expect(examples.length).toBeGreaterThan(0);expect(JSON.stringify(examples)).not.toMatch(/password|client_secret|access_token|https?:\/\/|javascript:|\bSELECT\b|\bINSERT\b|broker.*success/i);
});

test('manifest bindings exclude response-only definition version pins',()=>{
 const doc=contract();
 const binding={id:'asset',schemaId:'asset',schemaVersion:1,definitionId:'asset-review',allowedTransitions:['approve']};
 const input=doc.components.schemas.Manifest.properties.bindings.items;
 expect(input.$ref).toBe('#/components/schemas/ManifestBinding');
 expect(accepts(doc,input,binding)).toBe(true);
 expect(accepts(doc,input,{...binding,definitionVersion:1})).toBe(false);
 expect(accepts(doc,doc.components.schemas.Binding,{...binding,definitionVersion:1})).toBe(true);
});

test('documented command key alphabet matches runtime',()=>{
 const doc=contract();
 for(const method of ['put','delete']){
  const header=doc.paths['/v1/entities/{id}/context-links/ngsi-ld'][method].parameters.find((parameter:{name:string})=>parameter.name==='Idempotency-Key');
  expect(header.schema.pattern).toBe('^[A-Za-z0-9._:-]{1,128}$');
  const valid=new RegExp(header.schema.pattern);
  for(const key of ['decision-1','A_z.0:replay','a'.repeat(128)])expect(valid.test(key)).toBe(true);
  for(const key of ['decision 1','','a'.repeat(129),'decision/1'])expect(valid.test(key)).toBe(false);
 }
});
