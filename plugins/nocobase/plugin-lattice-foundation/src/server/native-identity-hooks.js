/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';
function applyNativeIdentity(model,options={}) {
  const actor=options.context?.state?.latticeNativeActor;
  if(!actor)return;
  const values={organizationId:actor.organizationId,...(model.isNewRecord?{requesterId:actor.employeeId,status:'draft',version:1}:{})};
  for(const [field,value] of Object.entries(values))model.set(field,value);
  if(Array.isArray(options.fields))options.fields=[...new Set([...options.fields,...Object.keys(values)])];
}
function registerNativeIdentityHooks(db) {
  for(const name of ['latticeRequests','latticeOrders'])db.on(name+'.beforeValidate',applyNativeIdentity);
}
module.exports={applyNativeIdentity,registerNativeIdentityHooks};
