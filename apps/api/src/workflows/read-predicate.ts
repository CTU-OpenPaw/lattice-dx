// SPDX-License-Identifier: Apache-2.0
import type {WorkflowActor,WorkflowDefinition} from '@dx/contracts';
export function workflowReadPredicate(definitions:WorkflowDefinition[],actor:WorkflowActor,bind:(value:unknown)=>string,alias='',subject='$2'){
 const prefix=alias?alias+'.':'';
 const readers=[`${prefix}owner_id=${subject}`,`(${prefix}definition_id||':'||${prefix}definition_version)=ANY(${bind(definitions.filter(d=>d.readerRoles.some(r=>actor.roles.includes(r))).map(d=>`${d.id}:${d.version}`))}::text[])`];
 for(const d of definitions){const a=d.assignedReader;if(a&&actor.roles.includes(a.role))readers.push(`(${prefix}definition_id=${bind(d.id)} AND ${prefix}definition_version=${bind(d.version)} AND ${prefix}state=ANY(${bind(a.states)}::text[]) AND ${prefix}data->>${bind(a.field)}=${subject})`);}
 return `(${readers.join(' OR ')})`;
}
