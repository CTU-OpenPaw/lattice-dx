// SPDX-License-Identifier: Apache-2.0
import {randomBytes} from 'node:crypto';
// Rebind IDs in a schema exported from the native designer. Rendering and all
// actions stay with the host; no page renderer or event handlers live here.
export function instantiateNativePage(template,rootUid) {
  if(template?.['x-component']!=='Page'||!template['x-uid']||!/^[-a-zA-Z0-9_]+$/.test(rootUid))throw Error('Invalid native page fixture');
  const ids=new Map([[template['x-uid'],rootUid]]);
  const collect=node=>{if(node&&typeof node==='object'){if(node['x-uid']&&!ids.has(node['x-uid']))ids.set(node['x-uid'],'nl'+randomBytes(7).toString('hex'));Object.values(node).forEach(collect);}};collect(template);
  const replace=value=>typeof value==='string'?(ids.get(value)??value):Array.isArray(value)?value.map(replace):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([key])=>!['_isJSONSchemaObject','version','x-app-version'].includes(key)).map(([key,entry])=>[ids.get(key)??key,replace(entry)])):value;
  const schema=replace(template),grid=Object.values(schema.properties??{}).find(node=>node['x-component']==='Grid');
  if(!grid)throw Error('Native page grid is required');
  return {schema,tabUid:grid['x-uid']};
}
