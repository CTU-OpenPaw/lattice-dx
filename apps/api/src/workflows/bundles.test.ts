// SPDX-License-Identifier: Apache-2.0
import { expect, test } from 'vitest';
import { validateDefinition } from './registry.js';
import { parseBundle, bundlePreview } from './bundles.js';
const definition = {id:'portable-request',title:'Request',startRole:'employee',initialState:'draft',startFields:{request:'text'},readerRoles:['manager'],transitions:[{id:'submit',from:'draft',to:'done',role:'employee',fields:{}}]};
const bundle = {format:'latticedx.workflow-bundle',formatVersion:1,definitions:[definition]};
test('strict portable bundles and preview',()=>{
 expect(parseBundle(bundle)).toEqual(bundle);
 expect(bundlePreview(parseBundle(bundle))).toMatchObject({workflowCount:1,definitions:[{id:definition.id,requiredRoles:['employee','manager','workflow:start'],connectors:[]}]});
 for(const value of [{...bundle,formatVersion:2},{...bundle,actor:'x'},{...bundle,definitions:[]},{...bundle,definitions:[definition,definition]},{...bundle,definitions:[{...definition,id:'procurement'}]},{...bundle,definitions:[{...definition,version:1}]},{...bundle,definitions:[{...definition,title:'x'.repeat(13000)}]}]) expect(()=>parseBundle(value)).toThrow();
});
test('reject source resource literals but retain useful literals',()=>{
 const task={id:'task',action:'tasks.create',input:{title:{source:'literal',value:'Review'},assigneeId:{source:'context',field:'actorId'}}};
 const withStep=(step:unknown)=>({...bundle,definitions:[{...definition,transitions:[{...definition.transitions[0],steps:[step]}]}]});
 expect(parseBundle(withStep(task))).toBeTruthy();
 for(const key of ['assigneeId','recordId']) expect(()=>parseBundle(withStep({...task,input:{...task.input,[key]:{source:'literal',value:'source-id'}}}))).toThrow();
 expect(()=>parseBundle(withStep({...task,input:{title:task.input.title},assignment:{kind:'department',role:'manager',department:{source:'literal',value:'source-department'}}}))).toThrow();
});


test('preview derives action, assignment and callback permissions and typed inputs',()=>{
 const send={id:'send',action:'connectors.dispatch',input:{connectorId:{source:'literal',value:'agent'},operation:{source:'literal',value:'review'}}};
 const config={...definition,optionalStartFields:{assignee:'subject'},transitions:[{...definition.transitions[0],steps:[send],wait:{stepId:'send',successState:'accepted',failureState:'failed',timeoutSeconds:60,resultFields:{answer:'text'}}}]};
 expect(bundlePreview(parseBundle({...bundle,definitions:[config]})).definitions[0]).toMatchObject({
 requiredRoles:['connector:agent','employee','manager','workflow:callback','workflow:integrate','workflow:start'],connectors:['agent'],
 inputFields:{start:{request:'text'},optionalStart:{assignee:'subject'},transitions:{submit:{}}}
 });
});

test('definition UTF-8 bounds apply to otherwise valid configuration',()=>{
 const config={...definition,transitions:[{...definition.transitions[0],steps:[{id:'send',action:'connectors.dispatch',input:{connectorId:{source:'literal',value:'agent'},operation:{source:'literal',value:'review'},payload:Object.fromEntries(['one','two','three','four'].map(key=>[key,{source:'literal',value:'x'.repeat(3500)}]))}}]}]};
 expect(validateDefinition(config)).toEqual(config);
 expect(()=>parseBundle({...bundle,definitions:[config]})).toThrow();
 const unicode={...config,transitions:[{...definition.transitions[0],steps:[{...config.transitions[0].steps[0],input:{...config.transitions[0].steps[0].input,payload:{message:{source:'literal',value:'界'.repeat(4000)},extra:{source:'literal',value:'extra'.repeat(50)}}}}]}]};
 expect(()=>parseBundle({...bundle,definitions:[unicode]})).toThrow();
});
