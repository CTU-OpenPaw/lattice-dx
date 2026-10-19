// SPDX-License-Identifier: Apache-2.0
const {test}=require('node:test');const assert=require('node:assert/strict');
const {loadEntityContext,createEntityContextComponent}=require('../src/client/entity-context');
const {validateManifest}=require('../src/shared/manifest');
const manifest=require('../src/shared/manifests/work.json');const block=manifest.blocks.find(b=>b.type==='context-entity');
const id='11111111-1111-4111-8111-111111111111',entityId='22222222-2222-4222-8222-222222222222';
const context={entityId,schemaId:'asset',schemaVersion:1,entityVersion:1};
const run={id,recordId:id,title:'Review',definitionId:'review',state:'pending',version:1,data:{},availableTransitions:[],entityContext:context};
const entity={id:entityId,title:'Shared Asset',schemaId:'asset',schemaVersion:1,version:2,archivedAt:null,updatedAt:'2026-10-15T10:00:00Z',attributes:{assetCode:'A1',location:'Kho A',status:'ready',other:'Not configured'}};
const link={context,current:{id:entityId,schemaId:'asset',schemaVersion:1,version:2}};
const props={manifest,block,selectedId:id,run,connected:true,actorId:'warehouse'};
const api={workflow:async()=>link,entity:async()=>entity};
test('Context reads current authorized entity, preserves original pin and uses explicit mappings',async()=>{
 const result=await loadEntityContext({...props,api});assert.equal(result.context.entityVersion,1);assert.equal(result.entity.version,2);assert.deepEqual(result.fields.map(f=>f.value),['A1','Kho A','ready']);assert.equal(JSON.stringify(result.fields).includes('Not configured'),false);
 const other=await loadEntityContext({...props,block:{...block,entityFields:[{name:'other',title:'Other domain'}]},api});assert.equal(other.fields[0].value,'Not configured');
});
test('absent association never guesses an entity from run data or record ID',async()=>{
 const noApi={workflow:()=>assert.fail('No context read expected'),entity:()=>assert.fail('No entity read expected')};assert.equal(await loadEntityContext({...props,api:noApi,run:{...run,entityContext:undefined,data:{entityId}}}),null);
});
test('scope, changed versions and denied reads fail closed',async()=>{
 await assert.rejects(loadEntityContext({...props,api,block:{...block,entitySchemaId:'other'}}));
 await assert.rejects(loadEntityContext({...props,api:{...api,workflow:async()=>({...link,context:{...context,entityId:id},current:{...link.current,id}})}}));
 await assert.rejects(loadEntityContext({...props,api:{...api,entity:async()=>({...entity,version:3})}}));
 let reads=0;await assert.rejects(loadEntityContext({...props,api:{workflow:async()=>{throw {status:404}},entity:async()=>reads++}}));assert.equal(reads,0);
});
test('Context configuration rejects cross-scope references, unsafe fields and URLs',()=>{
 assert.deepEqual(validateManifest(manifest),[]);
 for(const change of [{entityFields:[{name:'__proto__',title:'Bad'}]},{entityFields:[{name:'status',title:'State',url:'http://x'}]},{entitySchemaId:'../asset'},{url:'http://x'},{collection:'missing'}]){const m=structuredClone(manifest);Object.assign(m.blocks.find(b=>b.type==='context-entity'),change);assert.ok(validateManifest(m).length);}
 const m=structuredClone(manifest);m.blocks.find(b=>b.type==='context-entity').definitionId='other';assert.ok(validateManifest(m).some(s=>s.includes('scope')));
});
function hooks(){const slots=[];let index=0,queue=[];const same=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]));const react={createElement:(type,props,...children)=>({type,props:props||{},children:children.flat()}),useState(value){const i=index++;if(!slots[i])slots[i]={value};return [slots[i].value,next=>slots[i].value=typeof next==='function'?next(slots[i].value):next]},useRef(value){const i=index++;if(!slots[i])slots[i]={current:value};return slots[i]},useEffect(fn,deps){const i=index++;if(!slots[i]||!same(slots[i].deps,deps))queue.push(()=>{slots[i]?.cleanup?.();slots[i]={deps,cleanup:fn()}})}};return {react,render(fn){index=0;const tree=fn();const effects=queue;queue=[];effects.forEach(f=>f());return tree;}};}
function find(tree,predicate){if(!tree||typeof tree!=='object')return null;if(predicate(tree))return tree;for(const child of tree.children||[]){const result=find(child,predicate);if(result)return result;}return null;}
const tick=()=>new Promise(setImmediate);

test('Context clears private values immediately on session change and after permission revocation',async()=>{
 let denied=false;const env=hooks(),Component=createEntityContextComponent(env.react),service={...api,entity:async()=>{if(denied)throw {status:404};return entity;}};
 const render=(override={})=>env.render(()=>Component({...props,api:service,...override}));render();await tick();assert.ok(JSON.stringify(render()).includes('Shared Asset'));
 assert.equal(JSON.stringify(render({actorId:'another'})).includes('Shared Asset'),false);await tick();assert.equal(JSON.stringify(render({connected:false})).includes('Shared Asset'),false);
 render();await tick();let tree=render();denied=true;find(tree,n=>n.type==='button').props.onClick();render();await tick();tree=render();assert.equal(JSON.stringify(tree).includes('Shared Asset'),false);assert.ok(find(tree,n=>n.props.role==='alert'));
});
test('late context response cannot reappear after disconnect or selection change',async()=>{
 let finish;const env=hooks(),Component=createEntityContextComponent(env.react),service={...api,entity:()=>new Promise(r=>finish=r)};
 const render=(override={})=>env.render(()=>Component({...props,api:service,...override}));render();await tick();render({connected:false});finish(entity);await tick();assert.equal(JSON.stringify(render({connected:false})).includes('Shared Asset'),false);
});
test('Context Entity renders sync pending, failed error banner and runs authorized retry',async()=>{
 let retriedCalls=[];let syncJobs=[{id:'job-1',status:'pending',attempts:0,lastError:null}];
 const syncApi={
  workflow:async(op,arg)=>{
   if(op==='entityContext')return link;
   if(op==='sync')return {items:syncJobs};
   if(op==='retrySync'){
    retriedCalls.push(arg);syncJobs=[{id:'job-1',status:'pending',attempts:0,lastError:null}];
    return {retried:1};
   }
   return link;
  },
  entity:async()=>entity
 };
 const env=hooks(),Component=createEntityContextComponent(env.react);
 const render=(override={})=>env.render(()=>Component({...props,api:syncApi,...override}));
 render();await tick();let tree=render();
 assert.ok(JSON.stringify(tree).includes('Đang chờ đồng bộ'));

 syncJobs=[{id:'job-1',status:'failed',attempts:3,lastError:'Broker connection timeout'}];
 find(tree,n=>n.type==='button'&&n.children?.includes?.('Tải lại dữ liệu liên kết')).props.onClick();
 render();await tick();tree=render();
 assert.ok(JSON.stringify(tree).includes('Lỗi đồng bộ'));
 assert.ok(JSON.stringify(tree).includes('Broker connection timeout'));
 const retryBtn=find(tree,n=>n.props?.['data-testid']==='lattice-retry-sync-btn');
 assert.ok(retryBtn,'retry button exists when failed');

 await retryBtn.props.onClick();
 render();await tick();tree=render();
 assert.equal(retriedCalls.length,1);assert.equal(retriedCalls[0].id,id);assert.ok(retriedCalls[0].key.length>0);assert.deepEqual(retriedCalls[0].body,{});
 assert.ok(JSON.stringify(tree).includes('Đã yêu cầu chạy lại đồng bộ'));

 const deniedApi={
  ...syncApi,
  workflow:async(op,arg)=>{
   if(op==='entityContext')return link;
   if(op==='sync')return {items:[{id:'job-1',status:'failed',attempts:3,lastError:'Failed'}]};
   if(op==='retrySync')throw {status:403};
   return link;
  }
 };
 const env2=hooks(),Component2=createEntityContextComponent(env2.react);
 const render2=()=>env2.render(()=>Component2({...props,api:deniedApi}));
 render2();await tick();let tree2=render2();
 const retryBtn2=find(tree2,n=>n.props?.['data-testid']==='lattice-retry-sync-btn');
 await retryBtn2.props.onClick();
 render2();await tick();tree2=render2();
 assert.ok(JSON.stringify(tree2).includes('Không có quyền chạy lại đồng bộ.'));

 syncJobs=[{id:'job-1',status:'succeeded',attempts:1,lastError:null}];
 const env3=hooks(),Component3=createEntityContextComponent(env3.react);
 const render3=()=>env3.render(()=>Component3({...props,api:syncApi}));
 render3();await tick();let tree3=render3();
 assert.ok(JSON.stringify(tree3).includes('Đã đồng bộ'));
});

