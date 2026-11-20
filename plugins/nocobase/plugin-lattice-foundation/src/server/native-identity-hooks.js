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
const get=(row,key)=>typeof row?.get==='function'?row.get(key):row?.[key];
const INCIDENT_NOTE_FIELDS={resolved:'resolutionNote',closed:'closeNote'};
function validateIncidentNotes(model) {
  const field=INCIDENT_NOTE_FIELDS[get(model,'status')];
  if(!field)return;
  const raw=get(model,field);
  const trimmed=typeof raw==='string'?raw.trim():'';
  if(!trimmed||trimmed.length>255) {
    throw Object.assign(new Error('NATIVE_INCIDENT_NOTE_INVALID'),{code:'NATIVE_INCIDENT_NOTE_INVALID',status:400});
  }
  if(typeof model?.set==='function')model.set(field,trimmed);
  else model[field]=trimmed;
}
function registerNativeIdentityHooks(db) {
  for(const name of ['latticeRequests','latticeOrders'])db.on(name+'.beforeValidate',applyNativeIdentity);
  db.on('latticeIncidentCases.beforeValidate',validateIncidentNotes);
}
module.exports={applyNativeIdentity,validateIncidentNotes,registerNativeIdentityHooks};
