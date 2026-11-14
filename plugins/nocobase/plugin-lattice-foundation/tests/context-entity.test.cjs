/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const {test}=require('node:test');const assert=require('node:assert/strict');
const {loadEntityContext,createEntityContextComponent,extractTelemetryPoints}=require('../src/client/entity-context');
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

test('extractTelemetryPoints parses both direct telemetry events and audit revision snapshots', () => {
  const direct = [
    { timestamp: '2026-10-16T08:00:00Z', attribute: 'temperature', value: '42.5' },
    { timestamp: '2026-10-16T08:15:00Z', temperature: 45, humidity: 60, batteryLevel: 92 }
  ];
  const directPts = extractTelemetryPoints(direct);
  assert.equal(directPts.length, 2);
  assert.equal(directPts[0].temperature, 42.5);
  assert.equal(directPts[1].humidity, 60);
  assert.equal(directPts[1].batteryLevel, 92);

  const audits = [
    {
      occurredAt: '2026-10-16T09:00:00Z',
      operation: 'entity.update',
      result: { attributes: { temperature: 55, humidity: 40, batteryLevel: 88, status: 'in_use' } }
    },
    {
      occurredAt: '2026-10-16T08:30:00Z',
      operation: 'entity.create',
      result: { attributes: { temperature: 38, humidity: 50, batteryLevel: 95, status: 'ready' } }
    }
  ];
  const auditPts = extractTelemetryPoints(audits);
  assert.equal(auditPts.length, 2);
  assert.equal(auditPts[0].temperature, 38);
  assert.equal(auditPts[1].temperature, 55);
});

test('Extended Context Entity renders broker context, quality badge, observedAt and department/location relations', async () => {
  const extendedBrokerContext = {
    version: 1,
    entityId,
    mapping: { provider: 'ngsi-ld', entityId, externalId: 'urn:ngsi-ld:Asset:org-a:laptop-001', revision: 1, updatedAt: '2026-10-16T08:00:00Z' },
    status: 'fresh',
    freshnessThresholdSeconds: 300,
    observation: {
      provider: 'ngsi-ld',
      externalId: 'urn:ngsi-ld:Asset:org-a:laptop-001',
      status: 'in_use',
      observedAt: '2026-10-16T08:00:00Z',
      receivedAt: '2026-10-16T08:00:01Z'
    }
  };
  const relations = [
    { name: 'belongsToDepartment', targetId: 'dept-it-01', createdAt: '2026-10-15T00:00:00Z' },
    { name: 'locatedAt', targetId: 'loc-floor-2', createdAt: '2026-10-15T00:00:00Z' }
  ];
  const extendedEntity = {
    ...entity,
    attributes: { ...entity.attributes, department: 'Phòng Công nghệ Thông tin', location: 'Kho Tổng Tầng 2' }
  };

  const extendedApi = {
    workflow: async (op) => {
      if (op === 'entityContext') return link;
      if (op === 'sync') return { items: [] };
      return link;
    },
    entity: async (op) => {
      if (op === 'detail') return extendedEntity;
      if (op === 'context') return extendedBrokerContext;
      if (op === 'relations') return { items: relations };
      if (op === 'history') return { items: [] };
      return extendedEntity;
    }
  };

  const env = hooks(), Component = createEntityContextComponent(env.react);
  const render = () => env.render(() => Component({ ...props, api: extendedApi }));
  render(); await tick();
  const tree = render();

  const str = JSON.stringify(tree);
  assert.ok(str.includes('Nguồn & Chất lượng Dữ liệu Hiện trường (NGSI-LD)'));
  assert.ok(str.includes('Tốt (Thời gian thực)'));
  assert.ok(str.includes('urn:ngsi-ld:Asset:org-a:laptop-001'));
  assert.ok(str.includes('in_use'));
  assert.ok(str.includes('Quan hệ Quản lý & Vị trí'));
  assert.ok(str.includes('Phòng Công nghệ Thông tin'));
  assert.ok(str.includes('Kho Tổng Tầng 2'));
  assert.ok(str.includes('belongsToDepartment (dept-it-01)'));
  assert.ok(str.includes('locatedAt (loc-floor-2)'));
});

test('Telemetry chart renders points from history API, filters by time range and does not invent points from snapshot broker', async () => {
  const historyTelemetry = [
    { occurredAt: '2026-10-16T06:00:00Z', result: { attributes: { temperature: 30, humidity: 65, batteryLevel: 98 } } },
    { occurredAt: '2026-10-16T07:00:00Z', result: { attributes: { temperature: 35, humidity: 60, batteryLevel: 95 } } },
    { occurredAt: '2026-10-16T08:00:00Z', result: { attributes: { temperature: 48, humidity: 55, batteryLevel: 90 } } }
  ];

  let historyCalled = 0;
  const historyApi = {
    workflow: async (op) => {
      if (op === 'entityContext') return link;
      if (op === 'sync') return { items: [] };
      return link;
    },
    entity: async (op) => {
      if (op === 'detail') return entity;
      if (op === 'context') return { version: 1, entityId, status: 'fresh', observation: { provider: 'ngsi-ld', externalId: 'urn:ngsi-ld:test', status: 'ready', observedAt: '2026-10-16T08:00:00Z', receivedAt: '2026-10-16T08:00:01Z' } };
      if (op === 'history') {
        historyCalled++;
        return { items: historyTelemetry };
      }
      return entity;
    }
  };

  const env = hooks(), Component = createEntityContextComponent(env.react);
  const render = () => env.render(() => Component({ ...props, api: historyApi }));
  render(); await tick();
  const tree = render();

  assert.equal(historyCalled, 1);
  const str = JSON.stringify(tree);
  assert.ok(str.includes('Biểu đồ lịch sử số đo hiện trường'));
  assert.ok(str.includes('Đọc từ API lịch sử'));
  assert.ok(find(tree, n => n.props?.['data-testid'] === 'lattice-telemetry-svg'));
  assert.ok(str.includes('48 °C'));
  assert.ok(str.includes('30 °C'));
  assert.ok(str.includes('1 giờ'));
  assert.ok(str.includes('24 giờ'));
  assert.ok(str.includes('Tất cả'));

  const emptyApi = {
    ...historyApi,
    entity: async (op) => {
      if (op === 'detail') return entity;
      if (op === 'context') return { version: 1, entityId, status: 'fresh', observation: { provider: 'ngsi-ld', externalId: 'urn:ngsi-ld:test', status: 'ready', observedAt: '2026-10-16T08:00:00Z', receivedAt: '2026-10-16T08:00:01Z' } };
      if (op === 'history') return { items: [] };
      return entity;
    }
  };

  const envEmpty = hooks(), ComponentEmpty = createEntityContextComponent(envEmpty.react);
  const renderEmpty = () => envEmpty.render(() => ComponentEmpty({ ...props, api: emptyApi }));
  renderEmpty(); await tick();
  const treeEmpty = renderEmpty();

  const emptySection = find(treeEmpty, n => n.props?.['data-testid'] === 'lattice-telemetry-empty');
  assert.ok(emptySection, 'Must display empty state banner without faking data from broker');
  assert.equal(find(treeEmpty, n => n.props?.['data-testid'] === 'lattice-telemetry-svg'), null);
});

