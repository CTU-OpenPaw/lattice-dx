// SPDX-License-Identifier: Apache-2.0
import {expect,test} from 'vitest';
import {generateKeyPair,SignJWT} from 'jose';
import {createApi} from '../app.js';
import type {OrganizationRepository} from './types.js';
test('organization routes enforce signed authority tenant and strict metadata without trusting body roles',async()=>{
 const {privateKey,publicKey}=await generateKeyPair('RS256');const identity={issuer:'https://issuer',audience:'api',key:async()=>publicKey};
 const token=async(roles:string[])=>new SignJWT({organization_id:'org-a',realm_access:{roles}}).setProtectedHeader({alg:'RS256'}).setIssuer(identity.issuer).setAudience(identity.audience).setSubject('alice').setExpirationTime('5m').sign(privateKey);
 let selected='';const organization={async directoryState(org:string){selected=org;return {revision:0,updatedAt:null};}} as OrganizationRepository;
 const app=createApi({workerUrl:'http://localhost',identity,organization});
 expect((await app.inject({url:'/v1/organization/directory-state'})).statusCode).toBe(401);
 expect((await app.inject({url:'/v1/organization/directory-state',headers:{authorization:`Bearer ${await token(['directory:read'])}`}})).statusCode).toBe(403);
 const headers={authorization:`Bearer ${await token(['directory:manage'])}`};expect((await app.inject({url:'/v1/organization/directory-state',headers})).json()).toEqual({revision:0,updatedAt:null});expect(selected).toBe('org-a');
 expect((await app.inject({method:'POST',url:'/v1/organization/directory-snapshot',headers,payload:{expectedRevision:0,people:[],organizationId:'other'}})).statusCode).toBe(400);
 await app.close();
});
