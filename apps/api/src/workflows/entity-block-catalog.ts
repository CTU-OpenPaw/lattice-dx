// SPDX-License-Identifier: Apache-2.0
import {blockRole} from './block-policy.js';
import type {WorkflowEntityStep} from '@dx/contracts';
const object=(properties:Record<string,unknown>,required=Object.keys(properties))=>({type:'object',additionalProperties:false,properties,required});
const string={type:'string'},positive={type:'integer',minimum:1};
const binding={oneOf:[object({source:{const:'literal'},value:string}),object({source:{enum:['data','input']},field:string}),object({source:{const:'context'},field:{enum:['recordId','title','ownerId','actorId']}}),object({source:{const:'result'},stepId:string,field:{const:'id'}})]};
const expression={$ref:'#/$defs/expression'};
const scalarTypes=['text','integer','decimal','boolean','date','enum'];
const expressionDefs={expression:{oneOf:[object({op:{const:'literal'},value:{oneOf:[...scalarTypes.map(type=>object({type:{const:type},value:{type:type==='integer'?'integer':type==='boolean'?'boolean':'string'}})),object({type:{const:'null'},value:{type:'null'}})]}}),object({op:{const:'ref'},source:{enum:['data','input']},field:string,as:{enum:scalarTypes}}),object({op:{const:'ref'},source:{enum:['projection','evaluation']},stepId:string,field:string}),object({op:{enum:['add','subtract','multiply','divide','eq','ne','gt','gte','lt','lte','all','any','not','coalesce']},args:{type:'array',minItems:1,maxItems:20,items:expression}})]}};
const typed={oneOf:[object({source:{const:'expression'},expression}),object({source:{const:'literal'},value:{type:['string','number','boolean']}}),object({source:{enum:['data','input']},field:string,as:{enum:['text','integer','decimal','boolean','date','enum']}})]};
const expected={oneOf:[positive,object({source:{const:'result'},stepId:string,field:{const:'version'}}),object({source:{enum:['data','input']},field:string,as:{const:'integer'}})]};
const attributes={type:'object',maxProperties:50,additionalProperties:typed};
const metadata=object({id:{type:'string',format:'uuid'},version:positive,schemaVersion:positive});
const pin={schemaId:{type:'string',pattern:'^[a-z][a-z0-9-]{0,63}$'},schemaVersion:{...positive,maximum:2147483647}};
const inputs:Record<WorkflowEntityStep['action']|'data.evaluate'|'data.assert',ReturnType<typeof object>>={
  'entities.create':object({...pin,title:binding,attributes}),
  'entities.project':object({id:binding,fields:{type:'array',minItems:1,maxItems:20,uniqueItems:true,items:string}}),
  'data.evaluate':object({values:{type:'object',minProperties:1,maxProperties:20,additionalProperties:expression}}),
  'data.assert':object({condition:expression}),
  'entities.read':object({id:binding}),
  'entities.query':object({...pin,filters:{type:'array',maxItems:10,items:{oneOf:[object({field:string,operator:{const:'exists'}}),object({field:string,operator:{enum:['eq','ne','gt','gte','lt','lte','contains']},value:typed})]}},limit:{type:'integer',minimum:1,maximum:100,default:50}},['schemaId','schemaVersion']),
  'entities.update':object({id:binding,expectedVersion:expected,title:binding,attributes}),
  'entities.archive':object({id:binding,expectedVersion:expected}),
  'entities.link':object({id:binding,targetId:binding,name:string,expectedVersion:expected}),
  'entities.unlink':object({id:binding,targetId:binding,name:string,expectedVersion:expected}),
};
export const entityWorkflowBlocks=Object.entries(inputs).map(([id,input])=>({id,version:1,title:id,requiredRole:blockRole(id as WorkflowEntityStep['action']),input:{...input,$defs:expressionDefs},output:id==='data.evaluate'?object({evaluatedKeys:{type:'array',items:string}}):id==='data.assert'?object({asserted:{const:true}}):id==='entities.project'?object({...metadata.properties,projectedFields:{type:'array',items:string}}):id==='entities.query'?object({items:{type:'array',maxItems:100,items:metadata},page:object({limit:positive,offset:{const:0},hasMore:{type:'boolean'},nextOffset:{type:['integer','null']}})}):metadata}));
