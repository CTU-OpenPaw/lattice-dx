// SPDX-License-Identifier: Apache-2.0
import {bad,exact,name} from './policy.js';
import {compileEntityQuery,parseEntityQuery,typedFieldExpression} from './query.js';
import type {Field,SchemaPublication} from './types.js';
import type {AggregateMetric,AggregateQuery,ParsedAggregateQuery} from './aggregate-types.js';
export function parseAggregateQuery(input:unknown):ParsedAggregateQuery {
 const body=exact(input,['schemaId','schemaVersion','filters','groupBy','metrics']);
 if(Buffer.byteLength(JSON.stringify(body),'utf8')>16384)bad('Entity data exceeds 16 KiB.');
 const typed=parseEntityQuery({schemaId:body.schemaId,schemaVersion:body.schemaVersion,...(Object.hasOwn(body,'filters')?{filters:body.filters}:{})});
 const groups=body.groupBy===undefined?[]:body.groupBy;
 if(!Array.isArray(groups)||groups.length>2)bad('Invalid aggregate groups.');
 const groupBy=groups.map(name);
 if(new Set(groupBy).size!==groupBy.length)bad('Duplicate aggregate group.');
 if(!Array.isArray(body.metrics)||body.metrics.length<1||body.metrics.length>10)bad('Invalid aggregate metrics.');
 const metrics:AggregateMetric[]=body.metrics.map(value=>{
  const metric=exact(value,['name','operation','field']);
  const metricName=name(metric.name);
  if(metric.operation==='count') {
   if(Object.hasOwn(metric,'field'))bad('Count does not accept a field.');
   return {name:metricName,operation:'count'};
  }
  if(!['sum','min','max','avg'].includes(metric.operation as string))bad('Invalid aggregate operation.');
  return {name:metricName,operation:metric.operation as 'sum'|'min'|'max'|'avg',field:name(metric.field)};
 });
 if(new Set(metrics.map(metric=>metric.name)).size!==metrics.length)bad('Duplicate aggregate metric name.');
 return {schemaId:typed.schemaId,schemaVersion:typed.schemaVersion,filters:typed.filters,groupBy,metrics};
}
export function compileAggregateQuery(input:AggregateQuery,schema:SchemaPublication,start=1) {
 const query=parseAggregateQuery(input);
 if(query.schemaId!==schema.id||query.schemaVersion!==schema.version)bad('Aggregate publication mismatch.');
 const filters=compileEntityQuery({schemaId:query.schemaId,schemaVersion:query.schemaVersion,filters:query.filters},schema,start);
 const values=[...filters.values];
 const bind=(value:unknown)=>{values.push(value);return `$${start+values.length-1}`;};
 const field=(key:string):Field=>{if(!Object.hasOwn(schema.fields,key))bad('Unknown aggregate field.');return schema.fields[key];};
 const groupExpressions=query.groupBy.map(key=>{
  const definition=field(key),parameter=bind(key);
  const expression=typedFieldExpression(parameter,definition);
  if(definition.type==='boolean')return `CASE WHEN jsonb_typeof(attributes -> ${parameter})='boolean' THEN (${expression})::boolean END`;
  return expression;
 });
 const metricExpressions=query.metrics.map(metric=>{
  if(metric.operation==='count')return 'count(*)::text';
  const definition=field(metric.field);
  if(definition.type!=='integer'&&definition.type!=='decimal')bad('Numeric aggregate requires integer or decimal.');
  const expression=typedFieldExpression(bind(metric.field),definition);
  return metric.operation==='avg'?`round(avg(${expression}),18)::text`:`${metric.operation}(${expression})::text`;
 });
 // Group numeric values numerically, so equivalent decimal spellings share a
 // group. Only the projection becomes text, avoiding JavaScript numeric parsing.
 const groupSelections=groupExpressions.map((expression,index)=>{
  const type=schema.fields[query.groupBy[index]].type;
  const projection=type==='integer'||type==='decimal'?`(${expression})::text`:expression;
  return `${projection} AS g${index}`;
 });
 const metricSelections=metricExpressions.map((expression,index)=>`${expression} AS m${index}`);
 return {
  query,values,sourcePredicate:filters.predicate,
  select:[...groupSelections,...metricSelections].join(', '),
  group:groupExpressions.length?`GROUP BY ${groupExpressions.join(', ')}`:''
 };
}
