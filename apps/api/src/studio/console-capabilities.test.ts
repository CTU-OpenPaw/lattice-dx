// SPDX-License-Identifier: Apache-2.0
import {expect,test} from 'vitest';
import {capabilities,type StudioOptions} from './policy.js';
test('enterprise navigation capabilities require real services and roles',()=>{
 const options={organization:{},operations:{}} as StudioOptions;
 const allowed=capabilities({subject:'a',organizationId:'org',roles:['directory:read','directory:manage','platform:operate']},options);
 expect(allowed).toMatchObject({'organization.read':{available:true},'organization.manage':{available:true},'operations.read':{available:true}});
 const denied=capabilities({subject:'a',organizationId:'org',roles:[]},options);
 expect(denied).toMatchObject({'organization.manage':{available:false},'operations.read':{available:false}});
});
