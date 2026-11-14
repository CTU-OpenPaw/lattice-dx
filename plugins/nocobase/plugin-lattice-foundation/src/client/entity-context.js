/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const {evidenceContext}=require('./evidence');
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const version=n=>Number.isSafeInteger(n)&&n>0;
const date=s=>typeof s==='string'&&Number.isFinite(Date.parse(s));

function extractTelemetryPoints(items){
  if(!Array.isArray(items))return [];
  const points=[];
  for(const item of items){
    if(!item)continue;
    if(item.timestamp&&(item.value!==undefined||item.temperature!==undefined||item.humidity!==undefined||item.batteryLevel!==undefined)){
      const ts=new Date(item.timestamp).getTime();
      if(!Number.isNaN(ts)){
        const val=item.value!==undefined?Number(item.value):null;
        const attr=item.attribute;
        points.push({
          timestamp:new Date(ts).toISOString(),
          timeMs:ts,
          temperature:item.temperature!==undefined?Number(item.temperature):(attr==='temperature'?val:null),
          humidity:item.humidity!==undefined?Number(item.humidity):(attr==='humidity'?val:null),
          batteryLevel:item.batteryLevel!==undefined?Number(item.batteryLevel):(attr==='batteryLevel'?val:null),
          status:item.status||null,
          raw:item
        });
      }
      continue;
    }
    const time=item.occurredAt||item.createdAt;
    const attrs=item.result?.attributes||item.input?.attributes||item.attributes||{};
    const ts=time?new Date(time).getTime():NaN;
    if(!Number.isNaN(ts)){
      const temp=attrs.temperature!==undefined?Number(attrs.temperature):null;
      const hum=attrs.humidity!==undefined?Number(attrs.humidity):null;
      const bat=attrs.batteryLevel!==undefined?Number(attrs.batteryLevel):null;
      const val=attrs.value!==undefined?Number(attrs.value):null;
      const attr=attrs.attribute;
      if(temp!==null||hum!==null||bat!==null||val!==null){
        points.push({
          timestamp:new Date(ts).toISOString(),
          timeMs:ts,
          temperature:Number.isFinite(temp)?temp:(attr==='temperature'?val:null),
          humidity:Number.isFinite(hum)?hum:(attr==='humidity'?val:null),
          batteryLevel:Number.isFinite(bat)?bat:(attr==='batteryLevel'?val:null),
          status:attrs.status||null,
          raw:item
        });
      }
    }
  }
  return points.sort((a,b)=>a.timeMs-b.timeMs);
}

async function loadEntityContext({api,manifest,block,selectedId,run}){
  const source=await evidenceContext({api,manifest,block,selectedId,run});
  if(!source)return null;
  if(source.resource!=='workflows')throw new Error('Context Entity cần nguồn quy trình.');
  if(!source.run.entityContext)return null;
  const link=await api.workflow('entityContext',{id:source.id});
  const {context,current}=link||{};
  if(!context||!current||!uuid.test(context.entityId)||current.id!==context.entityId||typeof context.schemaId!=='string'||current.schemaId!==context.schemaId||!version(context.schemaVersion)||!version(context.entityVersion)||!version(current.version)||!version(current.schemaVersion))throw new Error('Liên kết dữ liệu không hợp lệ.');
  if(['entityId','schemaId','schemaVersion','entityVersion'].some(key=>context[key]!==source.run.entityContext[key]))throw new Error('Liên kết không khớp quy trình đã chọn. Hãy tải lại chi tiết.');
  const entity=await api.entity('detail',{id:context.entityId});
  if(!entity||entity.id!==current.id||entity.schemaId!==current.schemaId||entity.schemaVersion!==current.schemaVersion||entity.version!==current.version||typeof entity.title!=='string'||!date(entity.updatedAt)||!(entity.archivedAt===null||date(entity.archivedAt))||!entity.attributes||typeof entity.attributes!=='object'||Array.isArray(entity.attributes))throw new Error('Dữ liệu đã đổi hoặc phản hồi không khớp liên kết. Hãy tải lại.');
  if(block.entitySchemaId&&entity.schemaId!==block.entitySchemaId)throw new Error('Dữ liệu không thuộc schema đã cấu hình.');
  const fields=(block.entityFields||[]).map(field=>{
    const value=Object.hasOwn(entity.attributes,field.name)?entity.attributes[field.name]:null;
    if(value!==null&&!['string','number','boolean'].includes(typeof value))throw new Error('Giá trị trường dữ liệu không hợp lệ.');
    return {title:field.title,value};
  });
  let sync=null;
  try {
    const syncRes=await api.workflow('sync',{id:source.id});
    if(syncRes&&Array.isArray(syncRes.items))sync=syncRes.items;
  } catch {
    sync=null;
  }

  let brokerContext=null;
  try {
    if(api.entity){
      const bRes=await api.entity('context',{id:context.entityId});
      if(bRes&&(bRes.observation||bRes.mapping||['fresh','stale','no_observation','source_unavailable','not_linked'].includes(bRes.status))){
        brokerContext=bRes;
      }
    }
  } catch {
    brokerContext=null;
  }

  let relations=[];
  try {
    if(api.entity){
      const relRes=await api.entity('relations',{id:context.entityId,query:{limit:'50',offset:'0'}});
      if(relRes&&Array.isArray(relRes.items))relations=relRes.items;
    }
  } catch {
    relations=[];
  }

  let telemetryPoints=[];
  try {
    if(api.entity){
      const histRes=await api.entity('history',{id:context.entityId,query:{limit:'100',offset:'0'}});
      if(histRes&&Array.isArray(histRes.items)){
        telemetryPoints=extractTelemetryPoints(histRes.items);
      }
    }
  } catch {
    telemetryPoints=[];
  }

  return {context,entity,fields,sync,sourceId:source.id,brokerContext,relations,telemetryPoints};
}

function createEntityContextComponent(React){
  const h=React.createElement;
  return function ContextEntityBlock({manifest,block,api,connected,selectedId,run,actorId,refreshKey}){
    const [result,setResult]=React.useState(null),[loading,setLoading]=React.useState(false),[error,setError]=React.useState(''),[reload,setReload]=React.useState(0);
    const [retryLoading,setRetryLoading]=React.useState(false),[retryError,setRetryError]=React.useState(''),[retryMessage,setRetryMessage]=React.useState('');
    const [timeRange,setTimeRange]=React.useState('all');
    const [selectedMetric,setSelectedMetric]=React.useState('temperature');
    const key=selectedId||block.runId,scope=JSON.stringify([actorId,key,run?.version,block]);

    React.useEffect(()=>{let active=true;setResult(null);setError('');
      if(!connected||!key){setLoading(false);return()=>{active=false};}setLoading(true);
      loadEntityContext({api,manifest,block,selectedId,run}).then(value=>{if(active)setResult({scope,value});}).catch(e=>{if(active)setError([403,404].includes(e.status||e.response?.status)?'Không có liên kết được phép xem. Quyền xem quy trình không tự cấp quyền xem dữ liệu.':e.message||'Không tải được dữ liệu liên kết.');}).finally(()=>{if(active)setLoading(false)});
      return()=>{active=false};
    },[api,manifest,block,key,run,connected,actorId,refreshKey,reload]);

    const data=connected&&result?.scope===scope?result.value:null;

    const handleRetry=async()=>{
      const targetId=data?.sourceId||key;
      if(!targetId||retryLoading)return;
      setRetryLoading(true);setRetryError('');setRetryMessage('');
      try{
        const idempotencyKey=(globalThis.crypto?.randomUUID?globalThis.crypto.randomUUID():'retry-'+Date.now());
        const res=await api.workflow('retrySync',{id:targetId,body:{},key:idempotencyKey});
        const count=res?.retried??0;
        setRetryMessage(count>0?`Đã yêu cầu chạy lại đồng bộ (${count} tác vụ).`:'Đã gửi yêu cầu chạy lại đồng bộ.');
        setReload(n=>n+1);
      }catch(e){
        setRetryError([403].includes(e.status||e.response?.status)?'Không có quyền chạy lại đồng bộ.':(e.message||'Chạy lại đồng bộ thất bại.'));
      }finally{setRetryLoading(false);}
    };

    const renderTelemetryChart=()=>{
      const allPoints=data?.telemetryPoints||[];
      const metricsAvailable=[];
      if(allPoints.some(p=>p.temperature!==null))metricsAvailable.push({key:'temperature',label:'Nhiệt độ',unit:'°C'});
      if(allPoints.some(p=>p.humidity!==null))metricsAvailable.push({key:'humidity',label:'Độ ẩm',unit:'%'});
      if(allPoints.some(p=>p.batteryLevel!==null))metricsAvailable.push({key:'batteryLevel',label:'Mức pin',unit:'%'});

      const activeMetric=metricsAvailable.find(m=>m.key===selectedMetric)||metricsAvailable[0]||{key:'temperature',label:'Nhiệt độ',unit:'°C'};

      const rangeDurations={'1h':3600*1000,'6h':6*3600*1000,'24h':24*3600*1000,'7d':7*86400*1000};
      const nowMs=allPoints.length>0?Math.max(Date.now(),allPoints.at(-1).timeMs):Date.now();
      const cutoff=rangeDurations[timeRange]?nowMs-rangeDurations[timeRange]:0;

      const filteredPoints=allPoints.filter(p=>p.timeMs>=cutoff&&p[activeMetric.key]!==null);

      const ranges=[
        {id:'1h',label:'1 giờ'},
        {id:'6h',label:'6 giờ'},
        {id:'24h',label:'24 giờ'},
        {id:'7d',label:'7 ngày'},
        {id:'all',label:'Tất cả'}
      ];

      let chartContent=null;
      if(filteredPoints.length===0){
        chartContent=h('div',{'data-testid':'lattice-telemetry-empty',style:{padding:24,textAlign:'center',color:'#5e6c84',background:'#f8fafc',borderRadius:6,border:'1px dashed #dce3ed',fontSize:13}},
          'Chưa có dữ liệu số đo lịch sử trong khoảng thời gian này (Nguồn: API lịch sử).'
        );
      }else{
        const values=filteredPoints.map(p=>p[activeMetric.key]);
        const minVal=Math.min(...values);
        const maxVal=Math.max(...values);
        const latestVal=values.at(-1);
        const avgVal=(values.reduce((s,v)=>s+v,0)/values.length).toFixed(1);

        const valSpan=maxVal-minVal||10;
        const yMin=Math.floor(minVal-(valSpan*0.1));
        const yMax=Math.ceil(maxVal+(valSpan*0.1));
        const yRange=yMax-yMin||1;

        const svgW=560,svgH=160,padL=45,padR=25,padT=20,padB=28;
        const plotW=svgW-padL-padR;
        const plotH=svgH-padT-padB;

        const minTime=filteredPoints[0].timeMs;
        const maxTime=filteredPoints.at(-1).timeMs;
        const timeSpan=maxTime-minTime||1;

        const coords=filteredPoints.map(p=>{
          const x=filteredPoints.length===1?(padL+plotW/2):padL+((p.timeMs-minTime)/timeSpan)*plotW;
          const y=padT+plotH-((p[activeMetric.key]-yMin)/yRange)*plotH;
          return {x:Number(x.toFixed(1)),y:Number(y.toFixed(1)),p};
        });

        const linePoints=coords.map(c=>`${c.x},${c.y}`).join(' ');
        const areaPoints=`${coords[0].x},${padT+plotH} `+coords.map(c=>`${c.x},${c.y}`).join(' ')+` ${coords.at(-1).x},${padT+plotH}`;

        chartContent=h('div',null,
          h('div',{style:{display:'flex',gap:16,marginBottom:12,flexWrap:'wrap'}},
            h('div',{style:{padding:'6px 12px',background:'#f4f5f7',borderRadius:6,border:'1px solid #dfe1e6',fontSize:12}},
              h('span',{style:{color:'#5e6c84',marginRight:4}},'Mới nhất:'),h('strong',{style:{color:'#172b4d'}},`${latestVal} ${activeMetric.unit}`)
            ),
            h('div',{style:{padding:'6px 12px',background:'#f4f5f7',borderRadius:6,border:'1px solid #dfe1e6',fontSize:12}},
              h('span',{style:{color:'#5e6c84',marginRight:4}},'Cao nhất:'),h('strong',{style:{color:'#006644'}},`${maxVal} ${activeMetric.unit}`)
            ),
            h('div',{style:{padding:'6px 12px',background:'#f4f5f7',borderRadius:6,border:'1px solid #dfe1e6',fontSize:12}},
              h('span',{style:{color:'#5e6c84',marginRight:4}},'Thấp nhất:'),h('strong',{style:{color:'#0052cc'}},`${minVal} ${activeMetric.unit}`)
            ),
            h('div',{style:{padding:'6px 12px',background:'#f4f5f7',borderRadius:6,border:'1px solid #dfe1e6',fontSize:12}},
              h('span',{style:{color:'#5e6c84',marginRight:4}},'Trung bình:'),h('strong',{style:{color:'#172b4d'}},`${avgVal} ${activeMetric.unit}`)
            )
          ),
          h('svg',{'data-testid':'lattice-telemetry-svg',viewBox:`0 0 ${svgW} ${svgH}`,style:{width:'100%',maxWidth:svgW,height:'auto',background:'#fff',borderRadius:6,border:'1px solid #e0e7ef'}},
            h('defs',null,
              h('linearGradient',{id:'telemetryGradient',x1:'0',y1:'0',x2:'0',y2:'1'},
                h('stop',{offset:'0%',stopColor:'#0052cc',stopOpacity:'0.25'}),
                h('stop',{offset:'100%',stopColor:'#0052cc',stopOpacity:'0.0'})
              )
            ),
            h('line',{x1:padL,y1:padT,x2:padL+plotW,y2:padT,stroke:'#ebecf0',strokeDasharray:'3 3'}),
            h('text',{x:padL-6,y:padT+4,fill:'#7a869a',fontSize:10,textAnchor:'end'},`${yMax}${activeMetric.unit}`),
            h('line',{x1:padL,y1:padT+plotH/2,x2:padL+plotW,y2:padT+plotH/2,stroke:'#ebecf0',strokeDasharray:'3 3'}),
            h('text',{x:padL-6,y:padT+plotH/2+4,fill:'#7a869a',fontSize:10,textAnchor:'end'},`${Math.round((yMax+yMin)/2)}${activeMetric.unit}`),
            h('line',{x1:padL,y1:padT+plotH,x2:padL+plotW,y2:padT+plotH,stroke:'#c1c7d0'}),
            h('text',{x:padL-6,y:padT+plotH+4,fill:'#7a869a',fontSize:10,textAnchor:'end'},`${yMin}${activeMetric.unit}`),
            h('polygon',{points:areaPoints,fill:'url(#telemetryGradient)'}),
            h('polyline',{points:linePoints,fill:'none',stroke:'#0052cc',strokeWidth:'2',strokeLinecap:'round',strokeLinejoin:'round'}),
            ...coords.map((c,idx)=>h('g',{key:idx},
              h('circle',{cx:c.x,cy:c.y,r:4,fill:'#0052cc',stroke:'#ffffff',strokeWidth:'1.5'}),
              h('title',null,`${c.p[activeMetric.key]} ${activeMetric.unit} (${new Date(c.p.timestamp).toLocaleString('vi-VN')})`)
            )),
            h('text',{x:coords[0].x,y:svgH-8,fill:'#7a869a',fontSize:10,textAnchor:'start'},new Date(coords[0].p.timestamp).toLocaleTimeString('vi-VN',{hour:'2-digit',minute:'2-digit'})),
            coords.length>1&&h('text',{x:coords.at(-1).x,y:svgH-8,fill:'#7a869a',fontSize:10,textAnchor:'end'},new Date(coords.at(-1).p.timestamp).toLocaleTimeString('vi-VN',{hour:'2-digit',minute:'2-digit'}))
          )
        );
      }

      return h('div',{'data-testid':'lattice-telemetry-chart-section',style:{marginTop:16,padding:14,borderRadius:6,border:'1px solid #dce3ed',background:'#fff'}},
        h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'center',flexWrap:'wrap',gap:8,marginBottom:12}},
          h('div',null,
            h('h5',{style:{margin:0,fontSize:14,color:'#172b4d',display:'inline-block',marginRight:8}},'Biểu đồ lịch sử số đo hiện trường'),
            h('span',{style:{fontSize:11,color:'#5e6c84',background:'#ebecf0',padding:'2px 6px',borderRadius:4}},'Đọc từ API lịch sử')
          ),
          h('div',{'data-testid':'lattice-timerange-filter',style:{display:'flex',gap:4}},
            ...ranges.map(r=>h('button',{
              key:r.id,
              type:'button',
              'data-active':timeRange===r.id?'true':'false',
              onClick:()=>setTimeRange(r.id),
              style:{
                padding:'3px 9px',
                borderRadius:4,
                border:timeRange===r.id?'1px solid #0052cc':'1px solid #dfe1e6',
                background:timeRange===r.id?'#0052cc':'#fff',
                color:timeRange===r.id?'#fff':'#172b4d',
                cursor:'pointer',
                fontSize:12,
                fontWeight:timeRange===r.id?600:400
              }
            },r.label))
          )
        ),
        metricsAvailable.length>1&&h('div',{style:{display:'flex',gap:6,marginBottom:12}},
          ...metricsAvailable.map(m=>h('button',{
            key:m.key,
            type:'button',
            onClick:()=>setSelectedMetric(m.key),
            style:{
              padding:'4px 10px',
              borderRadius:12,
              border:activeMetric.key===m.key?'1px solid #0052cc':'1px solid #dfe1e6',
              background:activeMetric.key===m.key?'#deebff':'#fafbfc',
              color:activeMetric.key===m.key?'#0747a6':'#5e6c84',
              cursor:'pointer',
              fontSize:12,
              fontWeight:activeMetric.key===m.key?600:400
            }
          },`${m.label} (${m.unit})`))
        ),
        chartContent
      );
    };

    const renderBrokerContext=()=>{
      const bc=data?.brokerContext;
      const mapping=bc?.mapping;
      const observation=bc?.observation;
      const status=bc?.status||'not_linked';

      const qualityConfig={
        fresh:{label:'Tốt (Thời gian thực)',color:'#216e4e',bg:'#e3fcef',border:'#baf3db',desc:'Dữ liệu được cập nhật trong vòng 5 phút (≤ 300s).'},
        stale:{label:'Cảnh báo trễ (Dữ liệu cũ)',color:'#974f0c',bg:'#fffae6',border:'#ffe380',desc:'Dữ liệu cũ quá ngưỡng 300 giây.'},
        no_observation:{label:'Chưa có số đo hiện trường',color:'#5e6c84',bg:'#ebecf0',border:'#dfe1e6',desc:'Chưa nhận được số đo từ cảm biến hoặc broker.'},
        source_unavailable:{label:'Nguồn gián đoạn',color:'#ae2a19',bg:'#ffebe6',border:'#ffbdad',desc:'Không kết nối được broker NGSI-LD hoặc bộ thu context.'},
        not_linked:{label:'Chưa liên kết',color:'#5e6c84',bg:'#ebecf0',border:'#dfe1e6',desc:'Tài sản chưa được gán URN định danh NGSI-LD.'}
      };

      const q=qualityConfig[status]||qualityConfig.not_linked;
      const provider=mapping?.provider||observation?.provider||'ngsi-ld';
      const externalId=mapping?.externalId||observation?.externalId||'Chưa gán External URN';
      const observedAt=observation?.observedAt?new Date(observation.observedAt).toLocaleString('vi-VN'):null;
      const receivedAt=observation?.receivedAt?new Date(observation.receivedAt).toLocaleString('vi-VN'):null;
      const obsStatus=observation?.status||'—';

      return h('div',{'data-testid':'lattice-broker-context-section',style:{marginTop:16,padding:14,borderRadius:6,border:'1px solid #dce3ed',background:'#f8fafc'}},
        h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}},
          h('h5',{style:{margin:0,fontSize:14,color:'#172b4d'}},'Nguồn & Chất lượng Dữ liệu Hiện trường (NGSI-LD)'),
          h('span',{'data-testid':'lattice-freshness-badge',style:{padding:'3px 9px',borderRadius:4,fontSize:12,fontWeight:600,color:q.color,background:q.bg,border:`1px solid ${q.border}`}},q.label)
        ),
        h('dl',{style:{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(200px,1fr))',gap:12,margin:0}},
          h('div',null,
            h('dt',{style:{color:'#5e6c84',fontSize:12,marginBottom:4}},'Nguồn Broker (Provider)'),
            h('dd',{style:{margin:0,fontWeight:500,color:'#172b4d'}},String(provider).toUpperCase())
          ),
          h('div',null,
            h('dt',{style:{color:'#5e6c84',fontSize:12,marginBottom:4}},'Mã định danh liên kết (External URN)'),
            h('dd',{style:{margin:0,fontWeight:500,color:'#0052cc',fontFamily:'monospace',fontSize:12,wordBreak:'break-all'}},externalId)
          ),
          h('div',null,
            h('dt',{style:{color:'#5e6c84',fontSize:12,marginBottom:4}},'Thời điểm quan sát (observedAt)'),
            h('dd',{style:{margin:0,color:'#172b4d'}},observedAt||'Chưa có dữ liệu')
          ),
          h('div',null,
            h('dt',{style:{color:'#5e6c84',fontSize:12,marginBottom:4}},'Thời điểm tiếp nhận (receivedAt)'),
            h('dd',{style:{margin:0,color:'#172b4d'}},receivedAt||'Chưa có dữ liệu')
          ),
          h('div',null,
            h('dt',{style:{color:'#5e6c84',fontSize:12,marginBottom:4}},'Trạng thái thiết bị hiện trường'),
            h('dd',{style:{margin:0,color:'#172b4d',fontWeight:500}},obsStatus)
          )
        ),
        h('p',{style:{margin:'8px 0 0 0',color:'#5e6c84',fontSize:11}},q.desc)
      );
    };

    const renderEntityRelations=()=>{
      const rels=data?.relations||[];
      const attrs=data?.entity?.attributes||{};

      const deptRel=rels.find(r=>r.name==='belongsToDepartment'||r.name==='department');
      const locRel=rels.find(r=>r.name==='locatedAt'||r.name==='location');

      const departmentName=attrs.department||attrs.departmentName||(deptRel?`ID: ${deptRel.targetId}`:'Chưa gán đơn vị');
      const locationName=attrs.location||attrs.locationName||(locRel?`ID: ${locRel.targetId}`:'Chưa gán vị trí');

      return h('div',{'data-testid':'lattice-entity-relations-section',style:{marginTop:16,padding:14,borderRadius:6,border:'1px solid #dce3ed',background:'#fdfdfe'}},
        h('h5',{style:{margin:'0 0 10px 0',fontSize:14,color:'#172b4d'}},'Quan hệ Quản lý & Vị trí'),
        h('div',{style:{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(220px,1fr))',gap:12}},
          h('div',{style:{padding:10,background:'#fff',borderRadius:6,border:'1px solid #dfe1e6'}},
            h('div',{style:{fontSize:11,color:'#5e6c84',marginBottom:4}},'🏢 Đơn vị / Phòng ban quản lý'),
            h('div',{style:{fontWeight:600,color:'#172b4d',fontSize:13}},departmentName),
            deptRel&&h('div',{style:{fontSize:11,color:'#7a869a',marginTop:2}},`Quan hệ: belongsToDepartment (${deptRel.targetId})`)
          ),
          h('div',{style:{padding:10,background:'#fff',borderRadius:6,border:'1px solid #dfe1e6'}},
            h('div',{style:{fontSize:11,color:'#5e6c84',marginBottom:4}},'📍 Vị trí / Địa điểm hiện trường'),
            h('div',{style:{fontWeight:600,color:'#172b4d',fontSize:13}},locationName),
            locRel&&h('div',{style:{fontSize:11,color:'#7a869a',marginTop:2}},`Quan hệ: locatedAt (${locRel.targetId})`)
          )
        )
      );
    };

    return h('section',{'data-testid':'lattice-context-entity','data-block-id':block.id,'aria-label':block.title,style:{padding:16,border:'1px solid #dce3ed',borderRadius:8,marginTop:16,background:'#fff',overflowWrap:'anywhere'}},h('h3',null,block.title),
      !connected&&h('p',null,'Kết nối tài khoản nghiệp vụ để xem dữ liệu liên kết.'),connected&&!key&&h('p',null,'Chọn công việc để xem dữ liệu liên kết.'),
      connected&&key&&h('button',{style:{padding:'7px 12px',border:'1px solid #cdd7e5',borderRadius:6,background:'#fff',color:'#172b4d'},type:'button',disabled:loading,onClick:()=>setReload(n=>n+1)},'Tải lại dữ liệu liên kết'),
      loading&&h('p',{role:'status'},'Đang tải dữ liệu liên kết…'),error&&h('p',{role:'alert'},error),connected&&key&&!loading&&!error&&result?.scope===scope&&!data&&h('p',null,'Công việc này chưa liên kết dữ liệu nghiệp vụ.'),
      data&&h('div',null,
        h('h4',null,data.entity.title),
        h('dl',{style:{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(180px,1fr))',gap:16}},
          ...[{title:'ID dữ liệu',value:data.entity.id},{title:'Schema',value:data.entity.schemaId},{title:'Phiên bản hiện tại',value:data.entity.version},{title:'Phiên bản khi tạo quy trình',value:data.context.entityVersion},{title:'Trạng thái lưu trữ',value:data.entity.archivedAt?'Đã lưu trữ':'Đang hoạt động'},...data.fields].map((field,i)=>h('div',{key:i},h('dt',{style:{color:'#5e6c84',fontSize:12,marginBottom:5}},field.title),h('dd',{style:{margin:0}},field.value===null?'Chưa có dữ liệu':String(field.value)))),
          h('div',null,h('dt',{style:{color:'#5e6c84',fontSize:12,marginBottom:5}},'Cập nhật dữ liệu lúc'),h('dd',{style:{margin:0}},h('time',{dateTime:data.entity.updatedAt},new Date(data.entity.updatedAt).toLocaleString('vi-VN'))))),
        (data.context.entityVersion!==data.entity.version||data.context.schemaVersion!==data.entity.schemaVersion)&&h('p',{role:'status'},'Dữ liệu hiện tại đã thay đổi từ lúc tạo quy trình. Liên kết gốc được giữ nguyên.'),
        renderEntityRelations(),
        renderBrokerContext(),
        renderTelemetryChart(),
        (()=>{
          const syncJobs=data.sync||[];
          const hasFailed=syncJobs.some(j=>j.status==='failed');
          const hasPending=syncJobs.some(j=>['pending','processing'].includes(j.status));
          const allSucceeded=syncJobs.length>0&&syncJobs.every(j=>j.status==='succeeded');
          const failedJob=syncJobs.find(j=>j.status==='failed');
          return h('div',{'data-testid':'lattice-sync-section',style:{marginTop:16,padding:12,borderRadius:6,border:'1px solid #dce3ed',background:'#f8fafc'}},
            h('h5',{style:{margin:'0 0 8px 0',fontSize:13,color:'#172b4d'}},'Trạng thái đồng bộ'),
            hasFailed&&h('div',{role:'alert',style:{color:'#ae2a19',marginBottom:8}},
              h('span',{style:{display:'inline-block',padding:'2px 8px',borderRadius:4,background:'#ffebe6',color:'#ae2a19',fontWeight:600,fontSize:12,marginRight:8}},'Lỗi đồng bộ'),
              failedJob?.lastError?`Lỗi: ${failedJob.lastError}`:'Quá trình đồng bộ dữ liệu gặp sự cố.',
              h('div',{style:{marginTop:8}},
                h('button',{
                  type:'button',
                  'data-testid':'lattice-retry-sync-btn',
                  disabled:retryLoading||loading,
                  onClick:handleRetry,
                  style:{padding:'5px 12px',border:'1px solid #cdd7e5',borderRadius:6,background:'#0052cc',color:'#fff',cursor:'pointer',fontSize:12,fontWeight:500}
                },retryLoading?'Đang gửi yêu cầu…':'Chạy lại đồng bộ')
              )
            ),
            hasPending&&h('div',{role:'status',style:{color:'#974f0c'}},
              h('span',{style:{display:'inline-block',padding:'2px 8px',borderRadius:4,background:'#fffae6',color:'#974f0c',fontWeight:600,fontSize:12,marginRight:8}},'Đang chờ đồng bộ'),
              'Hệ thống đang chờ hoặc đang tiến hành đồng bộ dữ liệu…'
            ),
            allSucceeded&&h('div',{role:'status',style:{color:'#216e4e'}},
              h('span',{style:{display:'inline-block',padding:'2px 8px',borderRadius:4,background:'#e3fcef',color:'#216e4e',fontWeight:600,fontSize:12,marginRight:8}},'Đã đồng bộ'),
              'Dữ liệu đã được đồng bộ thành công với hệ thống.'
            ),
            !hasFailed&&!hasPending&&!allSucceeded&&h('p',{style:{margin:0,color:'#5e6c84',fontSize:12}},'Nguồn: dữ liệu nghiệp vụ của LatticeDX. Chưa có trạng thái đồng bộ broker cho liên kết này.'),
            retryMessage&&h('p',{role:'status',style:{color:'#006644',marginTop:8,fontSize:12}},retryMessage),
            retryError&&h('p',{role:'alert',style:{color:'#ae2a19',marginTop:8,fontSize:12}},retryError)
          );
        })()));
  };
}

module.exports={loadEntityContext,createEntityContextComponent,extractTelemetryPoints};
